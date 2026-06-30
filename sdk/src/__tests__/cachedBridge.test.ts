import { CachedContractClient, InMemoryCache } from '../cachedBridge';
import { SorobanRpc, scValToNative, xdr, Contract, TransactionBuilder, Address, Account } from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn(),
  },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue({}),
  })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  Account: jest.fn().mockImplementation(() => ({})),
  xdr: {
    ScVal: {
      scvVoid: jest.fn().mockReturnValue({}),
      scvVec: jest.fn().mockReturnValue({}),
      scvBytes: jest.fn().mockReturnValue({}),
      scvMap: jest.fn().mockReturnValue({}),
      scvSymbol: jest.fn().mockReturnValue({}),
    },
    ScMapEntry: jest.fn().mockImplementation(() => ({})),
  },
  Address: jest.fn().mockImplementation(() => ({
    toScVal: jest.fn().mockReturnValue({}),
  })),
  nativeToScVal: jest.fn().mockReturnValue({}),
  scValToNative: jest.fn(),
  BASE_FEE: '100',
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn((addr: string) => addr?.startsWith('G') && addr.length === 56),
    isValidContract: jest.fn((addr: string) => addr?.startsWith('C') && addr.length === 56),
  },
}));

const CONFIG = {
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  retry: { baseDelayMs: 0, maxDelayMs: 0 },
};

const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('CachedContractClient', () => {
  let mockProvider: any;
  let mockKeypair: any;
  let wrapper: any;
  let cache: InMemoryCache;

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'mock_tx_hash', status: 'PENDING' }),
      simulateTransaction: jest.fn(),
    };

    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);
    cache = new InMemoryCache();
    wrapper = new CachedContractClient(CONFIG, { provider: cache, ttlMs: { getFee: 1000 } });
  });

  it('caches getFee result and avoids a second RPC call', async () => {
    (scValToNative as jest.Mock).mockReturnValue(50);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await wrapper.getFee();
    const second = await wrapper.getFee();

    expect(first).toBe(50);
    expect(second).toBe(50);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('expires getFee after TTL and refreshes via new RPC call', async () => {
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    (scValToNative as jest.Mock).mockReturnValueOnce(50).mockReturnValueOnce(60);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await wrapper.getFee();
    expect(first).toBe(50);

    nowSpy.mockImplementation(() => now + 1100);
    const second = await wrapper.getFee();

    expect(second).toBe(60);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('invalidates cache automatically after a state-changing transaction', async () => {
    (scValToNative as jest.Mock).mockReturnValue(50);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    await wrapper.getFee();
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(1);

    await wrapper.client.setAdmin(MOCK_ADDRESS, { publicKey: () => MOCK_ADDRESS, sign: jest.fn() });
    expect(mockProvider.sendTransaction).toHaveBeenCalledTimes(1);

    await wrapper.getFee();
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('allows manual invalidation via invalidateCache', async () => {
    (scValToNative as jest.Mock).mockReturnValue(50);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    await wrapper.getFee();
    expect(await cache.get('getFee')).toBe(50);

    await wrapper.invalidateCache('getFee');
    expect(await cache.get('getFee')).toBeUndefined();
  });
});
