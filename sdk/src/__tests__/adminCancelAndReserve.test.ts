/**
 * clearPendingAdmin / clearPendingFeeCollector (#1134) and the cross-chain
 * reserve wrappers (#1135). Real @stellar/stellar-sdk objects: the contract
 * function name and ScVal argument types are read back from the built tx.
 */
import { Account, Keypair, StrKey, Transaction, xdr } from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const admin = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5));

function setup() {
  const sent: Transaction[] = [];
  const provider = {
    getAccount: jest.fn(async () => new Account(admin.publicKey(), '10')),
    prepareTransaction: jest.fn(async (tx: Transaction) => tx),
    sendTransaction: jest.fn(async (tx: Transaction) => {
      sent.push(tx);
      return { hash: 'h', status: 'PENDING' };
    }),
    simulateTransaction: jest.fn(),
  };
  const sdk = new OnboardingBridgeSDK({
    contractId: CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  } as any);
  (sdk as any).provider = provider;
  return { sdk, provider, sent };
}

function invoked(tx: Transaction) {
  const invoke = (tx.operations[0] as any).func.invokeContract();
  const args: xdr.ScVal[] = invoke.args();
  return { fn: invoke.functionName().toString(), args, types: args.map((a) => a.switch().name) };
}

describe('clearPendingAdmin / clearPendingFeeCollector (#1134)', () => {
  it.each([
    ['clearPendingAdmin', 'clear_pending_admin'],
    ['clearPendingFeeCollector', 'clear_pending_fee_collector'],
  ] as const)('%s sends %s with one void nonce argument', async (method, fn) => {
    const { sdk, sent } = setup();
    const result = await (sdk as any)[method](admin);
    expect(result.status).toBe('pending');
    expect(invoked(sent[0])).toMatchObject({ fn, types: ['scvVoid'] });
  });

  it.each([
    ['clearPendingAdmin', 'clear_pending_admin'],
    ['clearPendingFeeCollector', 'clear_pending_fee_collector'],
  ] as const)('%s encodes a supplied nonce as u64', async (method, fn) => {
    const { sdk, sent } = setup();
    await (sdk as any)[method](admin, 7n);
    const call = invoked(sent[0]);
    expect(call).toMatchObject({ fn, types: ['scvU64'] });
    expect(call.args[0].u64().toString()).toBe('7');
  });
});

describe('cross-chain reserve (#1135)', () => {
  it.each([
    ['fundCrosschainReserve', 'fund_crosschain_reserve'],
    ['withdrawCrosschainReserve', 'withdraw_crosschain_reserve'],
  ] as const)('%s sends exactly (Address, i128) and no nonce', async (method, fn) => {
    const { sdk, sent } = setup();
    const result = await (sdk as any)[method]({ asset: ASSET, amount: '5000' }, admin);
    expect(result.status).toBe('pending');
    const call = invoked(sent[0]);
    expect(call).toMatchObject({ fn, types: ['scvAddress', 'scvI128'] });
    expect(call.args[1].i128().lo().toString()).toBe('5000');
  });

  it.each(['0', '-1'])('rejects amount %s before any RPC call', async (amount) => {
    const { sdk, provider } = setup();
    const result = await sdk.fundCrosschainReserve({ asset: ASSET, amount }, admin);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/positive i128/);
    expect(provider.getAccount).not.toHaveBeenCalled();
  });

  it('getCrosschainReserve queries query_crosschain_reserve(asset) and returns a string', async () => {
    const { sdk, provider } = setup();
    provider.simulateTransaction.mockResolvedValue({
      results: [{ retval: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('123456') })) }],
    });

    await expect(sdk.getCrosschainReserve(ASSET)).resolves.toBe('123456');
    const tx: Transaction = provider.simulateTransaction.mock.calls[0][0];
    expect(invoked(tx)).toMatchObject({ fn: 'query_crosschain_reserve', types: ['scvAddress'] });
  });
});
