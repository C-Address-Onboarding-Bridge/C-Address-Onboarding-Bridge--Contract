import { CachedContractClient } from '../cachedBridge';
import { InMemoryCache } from '../cache';
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
    (scValToNative as jest.Mock).mockReset();

    mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'mock_tx_hash', status: 'PENDING' }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
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

  it('invalidates cache again after confirmation if a racing read repopulates it', async () => {
    let confirm!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    mockProvider.getTransaction.mockImplementation(() =>
      confirmation.then(() => ({ status: 'SUCCESS' })),
    );

    (scValToNative as jest.Mock)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(60);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    await wrapper.getFee();
    await wrapper.client.setAdmin(MOCK_ADDRESS, { publicKey: () => MOCK_ADDRESS, sign: jest.fn() });
    await wrapper.getFee();
    expect(await cache.get('getFee')).toBe(50);

    confirm();
    await confirmation;
    await Promise.resolve();
    await Promise.resolve();

    expect(await cache.get('getFee')).toBeUndefined();
    await expect(wrapper.getFee()).resolves.toBe(60);
  });

  it('allows manual invalidation via invalidateCache', async () => {
    (scValToNative as jest.Mock).mockReturnValue(50);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    await wrapper.getFee();
    expect(await cache.get('getFee')).toBe(50);

    await wrapper.invalidateCache('getFee');
    expect(await cache.get('getFee')).toBeUndefined();
  });

  it('forwards the configured timeout to transaction builders', async () => {
    (SorobanRpc.Server as jest.Mock).mockClear();
    (TransactionBuilder as unknown as jest.Mock).mockClear();

    const setTimeoutSpy = jest.fn().mockReturnThis();
    (TransactionBuilder as unknown as jest.Mock).mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: setTimeoutSpy,
      build: jest.fn().mockReturnValue({}),
    }));

    const mockAccountProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'h', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };
    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockAccountProvider);

    const customWrapper = new CachedContractClient({ ...CONFIG, timeout: 45 }, { provider: cache });

    await customWrapper.client.setAdmin(
      MOCK_ADDRESS,
      { publicKey: () => MOCK_ADDRESS, sign: jest.fn() },
    );

    const calls = setTimeoutSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((call: any[]) => {
      expect(call[0]).toBe(45);
    });
  });

  it('ContractClient exposes the documented transaction methods', () => {
    const client = wrapper.client;

    // Methods documented in CachedContractClient.get client()
    const documentedMethods = [
      'fundCAddress',
      'fundCAddressWithSwap',
      'withdrawFees',
      'setFee',
      'setFeeCollector',
      'setAdmin',
      'upgrade',
    ];

    for (const method of documentedMethods) {
      expect(typeof client[method]).toBe('function');
    }
  });

  it('caches getFeeCollector result and avoids a second RPC call', async () => {
    const FEE_COLLECTOR = 'GCCD6AJOYZCUAQLXX32ZJF2NKFFAU6TYPVWLZSE3GGSOOD5GVPJGZZ5B';
    (scValToNative as jest.Mock).mockReturnValue(FEE_COLLECTOR);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await wrapper.getFeeCollector();
    const second = await wrapper.getFeeCollector();

    expect(first).toBe(FEE_COLLECTOR);
    expect(second).toBe(FEE_COLLECTOR);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('expires getFeeCollector after TTL and refreshes via new RPC call', async () => {
    const feeCollWrapper = new CachedContractClient(CONFIG, {
      provider: cache,
      ttlMs: { getFeeCollector: 1000 },
    });
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    (scValToNative as jest.Mock)
      .mockReturnValueOnce('GCCD6AJOYZCUAQLXX32ZJF2NKFFAU6TYPVWLZSE3GGSOOD5GVPJGZZ5B')
      .mockReturnValueOnce('GDJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await feeCollWrapper.getFeeCollector();
    expect(first).toBe('GCCD6AJOYZCUAQLXX32ZJF2NKFFAU6TYPVWLZSE3GGSOOD5GVPJGZZ5B');

    nowSpy.mockImplementation(() => now + 1100);
    const second = await feeCollWrapper.getFeeCollector();

    expect(second).toBe('GDJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('caches getAdmin result and avoids a second RPC call', async () => {
    const ADMIN = 'GAHJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3';
    (scValToNative as jest.Mock).mockReturnValue(ADMIN);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await wrapper.getAdmin();
    const second = await wrapper.getAdmin();

    expect(first).toBe(ADMIN);
    expect(second).toBe(ADMIN);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('expires getAdmin after TTL and refreshes via new RPC call', async () => {
    const adminWrapper = new CachedContractClient(CONFIG, {
      provider: cache,
      ttlMs: { getAdmin: 1000 },
    });
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    (scValToNative as jest.Mock)
      .mockReturnValueOnce('GAHJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3')
      .mockReturnValueOnce('GDJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await adminWrapper.getAdmin();
    expect(first).toBe('GAHJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');

    nowSpy.mockImplementation(() => now + 1100);
    const second = await adminWrapper.getAdmin();

    expect(second).toBe('GDJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('caches isInitialized result and avoids a second RPC call', async () => {
    (scValToNative as jest.Mock).mockReturnValue(true);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await wrapper.isInitialized();
    const second = await wrapper.isInitialized();

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('caches isInitialized false and correctly reuses the cached value', async () => {
    (scValToNative as jest.Mock).mockReturnValue(false);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await wrapper.isInitialized();
    const second = await wrapper.isInitialized();

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('expires isInitialized after TTL and refreshes via new RPC call', async () => {
    const initWrapper = new CachedContractClient(CONFIG, {
      provider: cache,
      ttlMs: { isInitialized: 1000 },
    });
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    (scValToNative as jest.Mock)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

    const first = await initWrapper.isInitialized();
    expect(first).toBe(true);

    nowSpy.mockImplementation(() => now + 1100);
    const second = await initWrapper.isInitialized();

    expect(second).toBe(false);
    expect(mockProvider.simulateTransaction).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('clears all cached entries when invalidateCache is called with no arguments', async () => {
    await cache.set('getFee', 100);
    await cache.set('getFeeCollector', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    await cache.set('getAdmin', 'GAHJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    await cache.set('isInitialized', true);

    await wrapper.invalidateCache();

    expect(await cache.get('getFee')).toBeUndefined();
    expect(await cache.get('getFeeCollector')).toBeUndefined();
    expect(await cache.get('getAdmin')).toBeUndefined();
    expect(await cache.get('isInitialized')).toBeUndefined();
  });

  it('deletes only the specified keys when invalidateCache is called with an array', async () => {
    await cache.set('getFee', 100);
    await cache.set('getFeeCollector', 'GCCD6AJOYZCUAQLXX32ZJF2NKFFAU6TYPVWLZSE3GGSOOD5GVPJGZZ5B');
    await cache.set('getAdmin', 'GAHJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    await cache.set('isInitialized', true);

    await wrapper.invalidateCache(['getFee', 'getFeeCollector']);

    expect(await cache.get('getFee')).toBeUndefined();
    expect(await cache.get('getFeeCollector')).toBeUndefined();
    // Untouched keys remain
    expect(await cache.get('getAdmin')).toBe('GAHJZ6Y2Z5AM6ZAUOVGQ3XK6YKP6SAJSE3ZGJHNUZFXZMNZ5NRX5NHJY3');
    expect(await cache.get('isInitialized')).toBe(true);
  });
});
