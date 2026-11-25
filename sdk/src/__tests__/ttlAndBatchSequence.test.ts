/**
 * Uses the real @stellar/stellar-sdk (no module mock) so the transactions are
 * actually built: sequence numbers and encoded ScVal argument types are read
 * back from the built transaction.
 */
import { Account, Keypair, StrKey, Transaction, xdr } from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';

const NETWORK = 'Test SDF Network ; September 2015';
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

function makeSdk(provider: any): OnboardingBridgeSDK {
  const sdk = new OnboardingBridgeSDK({
    contractId: CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: NETWORK,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  } as any);
  (sdk as any).provider = provider;
  return sdk;
}

function makeProvider(sendStatus: (n: number) => string = () => 'PENDING') {
  const sent: Transaction[] = [];
  const provider = {
    getAccount: jest.fn(async () => new Account(signer.publicKey(), '100')),
    prepareTransaction: jest.fn(async (tx: Transaction) => tx),
    sendTransaction: jest.fn(async (tx: Transaction) => {
      sent.push(tx);
      return { hash: `h${sent.length}`, status: sendStatus(sent.length) };
    }),
    getTransaction: jest.fn(async () => ({ status: 'SUCCESS' })),
    simulateTransaction: jest.fn(),
  };
  return { provider, sent };
}

function invokeArgs(tx: Transaction): { fn: string; types: string[] } {
  const op: any = tx.operations[0];
  const invoke = op.func.invokeContract();
  return {
    fn: invoke.functionName().toString(),
    types: invoke.args().map((a: xdr.ScVal) => a.switch().name),
  };
}

describe('batchFundCAddresses without a nonce (#1123)', () => {
  const targets = Array.from({ length: 250 }, (_, i) => {
    const raw = Buffer.alloc(32);
    raw.writeUInt32BE(i + 10);
    return StrKey.encodeContract(raw);
  });
  const amounts = targets.map(() => '10');

  it('builds the three chunks with consecutive sequence numbers from one account read', async () => {
    const { provider, sent } = makeProvider();
    const sdk = makeSdk(provider);

    const results = await sdk.batchFundCAddresses(
      { source: signer.publicKey(), targets, amounts, asset: ASSET },
      signer,
    );

    expect(results.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
    expect(sent.map((tx) => tx.sequence)).toEqual(['101', '102', '103']);
    expect(provider.getAccount).toHaveBeenCalledTimes(1);
  });

  it('re-reads the account after a rejected chunk so later chunks are not stuck', async () => {
    const { provider, sent } = makeProvider((n) => (n === 1 ? 'ERROR' : 'PENDING'));
    const sdk = makeSdk(provider);

    const results = await sdk.batchFundCAddresses(
      { source: signer.publicKey(), targets, amounts, asset: ASSET },
      signer,
    );

    expect(results.map((r) => r.status)).toEqual(['failed', 'pending', 'pending']);
    // Chunk 1 never consumed seq 101, so chunk 2 restarts from the ledger value.
    expect(sent.map((tx) => tx.sequence)).toEqual(['101', '101', '102']);
    expect(provider.getAccount).toHaveBeenCalledTimes(2);
  });
});

describe('TTL maintenance wrappers (#1136)', () => {
  const relayer = 'ab'.repeat(32);
  const cases: Array<[string, (sdk: OnboardingBridgeSDK) => Promise<unknown>, string, string[]]> = [
    ['extendInstanceTtl', (s) => s.extendInstanceTtl(1000, signer), 'extend_instance_ttl', ['scvU32', 'scvVoid']],
    ['extendInstanceTtl with nonce', (s) => s.extendInstanceTtl(1000, signer, 4), 'extend_instance_ttl', ['scvU32', 'scvU64']],
    ['extendPersistentTtl', (s) => s.extendPersistentTtl(ASSET, 1000, signer), 'extend_persistent_ttl', ['scvAddress', 'scvU32', 'scvVoid']],
    [
      'extendSourcePersistentTtl',
      (s) => s.extendSourcePersistentTtl(signer.publicKey(), ASSET, 1000, signer, 1n),
      'extend_source_persistent_ttl',
      ['scvAddress', 'scvAddress', 'scvU32', 'scvU64'],
    ],
    ['extendTimelockTtl', (s) => s.extendTimelockTtl(7, 1000, signer), 'extend_timelock_ttl', ['scvU64', 'scvU32']],
    ['extendCommitmentTtl', (s) => s.extendCommitmentTtl('7', 1000, signer), 'extend_commitment_ttl', ['scvU64', 'scvU32']],
    ['extendRelayerTtl', (s) => s.extendRelayerTtl(relayer, 1000, signer), 'extend_relayer_ttl', ['scvBytes', 'scvU32']],
    ['setMaxInstanceTtl', (s) => s.setMaxInstanceTtl(500000, signer), 'set_max_instance_ttl', ['scvU32', 'scvVoid']],
    ['setMaxPersistentTtl', (s) => s.setMaxPersistentTtl(500000, signer, 2), 'set_max_persistent_ttl', ['scvU32', 'scvU64']],
  ];

  it.each(cases)('%s calls the contract with the right name and argument types', async (_n, call, fn, types) => {
    const { provider, sent } = makeProvider();
    const result: any = await call(makeSdk(provider));

    expect(result.status).toBe('pending');
    expect(sent).toHaveLength(1);
    expect(invokeArgs(sent[0])).toEqual({ fn, types });
  });

  it('extendRelayerTtl rejects a malformed pubkey before any RPC call', async () => {
    const { provider } = makeProvider();
    const result = await makeSdk(provider).extendRelayerTtl('xyz', 1000, signer);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/relayer pubkey/);
    expect(provider.getAccount).not.toHaveBeenCalled();
  });

  it('rejects a ttl that is not a u32', async () => {
    const { provider } = makeProvider();
    const result = await makeSdk(provider).extendInstanceTtl(-1, signer);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/u32/);
  });

  it('queryTtlConfig returns a named object', async () => {
    const { provider } = makeProvider();
    provider.simulateTransaction.mockResolvedValue({
      results: [{
        retval: xdr.ScVal.scvVec([
          xdr.ScVal.scvU32(518400),
          xdr.ScVal.scvU32(1036800),
          xdr.ScVal.scvU32(3110400),
          xdr.ScVal.scvU32(100000),
        ]),
      }],
    });

    await expect(makeSdk(provider).queryTtlConfig()).resolves.toEqual({
      maxInstanceTtl: 518400,
      maxPersistentTtl: 1036800,
      hardCeiling: 3110400,
      criticalThreshold: 100000,
    });
  });
});
