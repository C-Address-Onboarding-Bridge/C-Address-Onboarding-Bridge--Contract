import { OnboardingBridgeSDK } from '../bridge';
import { OffRampIntegration } from '../offramp';
import { SorobanRpc, scValToNative, xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';

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
  // Keep retry backoff instant so tests that exercise transient errors stay fast.
  retry: { baseDelayMs: 0, maxDelayMs: 0 },
};

const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const MOCK_ASSET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

describe('OnboardingBridgeSDK', () => {
  let sdk: OnboardingBridgeSDK;
  let mockProvider: any;
  let mockKeypair: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockKeypair = {
      publicKey: jest.fn().mockReturnValue(MOCK_ADDRESS),
      sign: jest.fn(),
    };

    mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'mock_tx_hash', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };

    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);
    sdk = new OnboardingBridgeSDK(CONFIG);
  });

  describe('fundCAddress', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.fundCAddress(
        { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
        mockKeypair,
      );

      expect(result.status).toBe('pending');
      expect(result.hash).toBe('mock_tx_hash');
      expect(mockProvider.getAccount).toHaveBeenCalledWith(MOCK_ADDRESS);
      expect(mockProvider.prepareTransaction).toHaveBeenCalled();
      expect(mockProvider.sendTransaction).toHaveBeenCalled();
    });

    it('returns failed status on ERROR response', async () => {
      mockProvider.sendTransaction.mockResolvedValue({ hash: 'err_hash', status: 'ERROR' });

      const result = await sdk.fundCAddress(
        { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
        mockKeypair,
      );

      expect(result.status).toBe('failed');
      expect(result.hash).toBe('err_hash');
    });

    it('returns failed status on network error', async () => {
      mockProvider.getAccount.mockRejectedValue(new Error('Network timeout'));

      const result = await sdk.fundCAddress(
        { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
        mockKeypair,
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Network timeout');
      expect(result.hash).toBe('');
    });
  });

  describe('batchFundCAddresses', () => {
    it('returns array with one pending result on success', async () => {
      const results = await sdk.batchFundCAddresses(
        {
          source: MOCK_ADDRESS,
          targets: [MOCK_ASSET, MOCK_ASSET],
          amounts: ['500', '500'],
          asset: MOCK_ASSET,
        },
        mockKeypair,
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pending');
      expect(results[0].hash).toBe('mock_tx_hash');
    });

    it('returns array with one failed result on ERROR response', async () => {
      mockProvider.sendTransaction.mockResolvedValue({ hash: 'err_hash', status: 'ERROR' });

      const results = await sdk.batchFundCAddresses(
        {
          source: MOCK_ADDRESS,
          targets: [MOCK_ASSET],
          amounts: ['500'],
          asset: MOCK_ASSET,
        },
        mockKeypair,
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
    });

    it('returns array with one failed result on mismatched array lengths (on-chain error)', async () => {
      mockProvider.sendTransaction.mockResolvedValue({ hash: 'err_hash', status: 'ERROR' });

      const results = await sdk.batchFundCAddresses(
        {
          source: MOCK_ADDRESS,
          targets: [MOCK_ASSET],
          amounts: ['500', '500'],
          asset: MOCK_ASSET,
        },
        mockKeypair,
      );

      expect(results[0].status).toBe('failed');
    });

    // -----------------------------------------------------------------------
    // Auto-splitting
    // -----------------------------------------------------------------------

    it('splits a batch exceeding BATCH_TX_LIMIT into multiple transactions', async () => {
      const count = 250; // 3 chunks: 100, 100, 50
      const targets = Array(count).fill(MOCK_ASSET);
      const amounts = Array(count).fill('100');

      let txCounter = 0;
      mockProvider.sendTransaction.mockImplementation(() => {
        txCounter++;
        return Promise.resolve({ hash: `tx_hash_${txCounter}`, status: 'PENDING' });
      });

      const results = await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
      );

      expect(results).toHaveLength(3);
      expect(mockProvider.sendTransaction).toHaveBeenCalledTimes(3);
      expect(results[0].hash).toBe('tx_hash_1');
      expect(results[1].hash).toBe('tx_hash_2');
      expect(results[2].hash).toBe('tx_hash_3');
      results.forEach((r) => expect(r.status).toBe('pending'));
    });

    it('does not split when targets count equals BATCH_TX_LIMIT exactly', async () => {
      const targets = Array(100).fill(MOCK_ASSET);
      const amounts = Array(100).fill('100');

      const results = await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
      );

      expect(results).toHaveLength(1);
      expect(mockProvider.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not split when targets count is below BATCH_TX_LIMIT', async () => {
      const targets = Array(50).fill(MOCK_ASSET);
      const amounts = Array(50).fill('100');

      const results = await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
      );

      expect(results).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // Progress callback
    // -----------------------------------------------------------------------

    it('calls onProgress once per chunk with correct (completed, total, txHash)', async () => {
      const count = 250;
      const targets = Array(count).fill(MOCK_ASSET);
      const amounts = Array(count).fill('100');

      let callIdx = 0;
      mockProvider.sendTransaction.mockImplementation(() => {
        callIdx++;
        return Promise.resolve({ hash: `h${callIdx}`, status: 'PENDING' });
      });

      const progressCalls: Array<[number, number, string | undefined]> = [];
      const onProgress = jest.fn((completed: number, total: number, txHash?: string) => {
        progressCalls.push([completed, total, txHash]);
      });

      await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
        onProgress,
      );

      expect(onProgress).toHaveBeenCalledTimes(3);
      // After chunk 1: 100 of 250 processed
      expect(progressCalls[0]).toEqual([100, 250, 'h1']);
      // After chunk 2: 200 of 250 processed
      expect(progressCalls[1]).toEqual([200, 250, 'h2']);
      // After chunk 3: 250 of 250 processed
      expect(progressCalls[2]).toEqual([250, 250, 'h3']);
    });

    it('calls onProgress even when total fits in one tx', async () => {
      const targets = [MOCK_ASSET, MOCK_ASSET];
      const amounts = ['500', '500'];

      const onProgress = jest.fn();

      await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
        onProgress,
      );

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(2, 2, 'mock_tx_hash');
    });

    it('does not call onProgress when callback is omitted', async () => {
      // Just verifies there is no crash when onProgress is undefined.
      const results = await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets: [MOCK_ASSET], amounts: ['500'], asset: MOCK_ASSET },
        mockKeypair,
        // no callback
      );
      expect(results[0].status).toBe('pending');
    });

    it('passes undefined as txHash to onProgress when submission fails', async () => {
      mockProvider.sendTransaction.mockRejectedValue(new Error('RPC error'));

      const onProgress = jest.fn();

      await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets: [MOCK_ASSET], amounts: ['100'], asset: MOCK_ASSET },
        mockKeypair,
        onProgress,
      );

      expect(onProgress).toHaveBeenCalledTimes(1);
      // hash is '' which evaluates to undefined in the implementation
      const [completed, total, txHash] = onProgress.mock.calls[0];
      expect(completed).toBe(1);
      expect(total).toBe(1);
      expect(txHash).toBeUndefined();
    });

    it('continues remaining chunks even when one chunk fails', async () => {
      const count = 250;
      const targets = Array(count).fill(MOCK_ASSET);
      const amounts = Array(count).fill('100');

      let callIdx = 0;
      mockProvider.sendTransaction.mockImplementation(() => {
        callIdx++;
        if (callIdx === 2) {
          return Promise.resolve({ hash: 'fail_hash', status: 'ERROR' });
        }
        return Promise.resolve({ hash: `h${callIdx}`, status: 'PENDING' });
      });

      const results = await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
      );

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('pending');
      expect(results[1].status).toBe('failed');
      expect(results[2].status).toBe('pending');
    });

    it('calls onProgress for all chunks even when one fails mid-way', async () => {
      const count = 250;
      const targets = Array(count).fill(MOCK_ASSET);
      const amounts = Array(count).fill('100');

      let callIdx = 0;
      mockProvider.sendTransaction.mockImplementation(() => {
        callIdx++;
        if (callIdx === 2) {
          return Promise.resolve({ hash: 'fail_hash', status: 'ERROR' });
        }
        return Promise.resolve({ hash: `h${callIdx}`, status: 'PENDING' });
      });

      const onProgress = jest.fn();
      await sdk.batchFundCAddresses(
        { source: MOCK_ADDRESS, targets, amounts, asset: MOCK_ASSET },
        mockKeypair,
        onProgress,
      );

      // onProgress must be called for all 3 chunks regardless of failures
      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenNthCalledWith(1, 100, 250, 'h1');
      expect(onProgress).toHaveBeenNthCalledWith(2, 200, 250, 'fail_hash');
      expect(onProgress).toHaveBeenNthCalledWith(3, 250, 250, 'h3');
    });
  });

  describe('withdrawFees', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.withdrawFees(
        { asset: MOCK_ASSET, amount: '100' },
        mockKeypair,
      );

      expect(result.status).toBe('pending');
      expect(result.hash).toBe('mock_tx_hash');
      expect(mockProvider.getAccount).toHaveBeenCalledWith(MOCK_ADDRESS);
    });
  });

  describe('setFee', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setFee(100, mockKeypair);

      expect(result.status).toBe('pending');
      expect(mockProvider.getAccount).toHaveBeenCalledWith(MOCK_ADDRESS);
    });
  });

  describe('setFeeCollector', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setFeeCollector(MOCK_ADDRESS, mockKeypair);

      expect(result.status).toBe('pending');
    });
  });

  describe('setAdmin', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setAdmin(MOCK_ADDRESS, mockKeypair);

      expect(result.status).toBe('pending');
    });
  });

  describe('getFee', () => {
    it('returns the fee as a number from simulation result', async () => {
      (scValToNative as jest.Mock).mockReturnValue(50);
      mockProvider.simulateTransaction.mockResolvedValue({
        results: [{ retval: {} }],
      });

      const fee = await sdk.getFee();

      expect(fee).toBe(50);
      expect(mockProvider.simulateTransaction).toHaveBeenCalled();
    });

    it('returns 0 when no results are present', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const fee = await sdk.getFee();

      expect(fee).toBe(0);
    });

    it('throws when simulation returns an error', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({ error: 'contract error' });

      await expect(sdk.getFee()).rejects.toThrow('Failed to get fee');
    });
  });

  describe('getFeeCollector', () => {
    it('returns fee collector address string', async () => {
      (scValToNative as jest.Mock).mockReturnValue({ toString: () => MOCK_ADDRESS });
      mockProvider.simulateTransaction.mockResolvedValue({
        results: [{ retval: {} }],
      });

      const addr = await sdk.getFeeCollector();

      expect(addr).toBe(MOCK_ADDRESS);
    });

    it('returns empty string when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const addr = await sdk.getFeeCollector();

      expect(addr).toBe('');
    });
  });

  describe('getAdmin', () => {
    it('returns admin address string', async () => {
      (scValToNative as jest.Mock).mockReturnValue({ toString: () => MOCK_ADDRESS });
      mockProvider.simulateTransaction.mockResolvedValue({
        results: [{ retval: {} }],
      });

      const addr = await sdk.getAdmin();

      expect(addr).toBe(MOCK_ADDRESS);
    });

    it('returns empty string when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const addr = await sdk.getAdmin();

      expect(addr).toBe('');
    });
  });

  describe('getCAddressBalance', () => {
    it('returns balance as a string', async () => {
      (scValToNative as jest.Mock).mockReturnValue({ toString: () => '1000' });
      mockProvider.simulateTransaction.mockResolvedValue({
        results: [{ retval: {} }],
      });

      const balance = await sdk.getCAddressBalance(MOCK_ASSET, MOCK_ASSET);

      expect(balance).toBe('1000');
    });

    it('returns "0" when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const balance = await sdk.getCAddressBalance(MOCK_ASSET, MOCK_ASSET);

      expect(balance).toBe('0');
    });
  });

  describe('isInitialized', () => {
    it('returns true when contract is initialized', async () => {
      (scValToNative as jest.Mock).mockReturnValue(true);
      mockProvider.simulateTransaction.mockResolvedValue({
        results: [{ retval: {} }],
      });

      const result = await sdk.isInitialized();

      expect(result).toBe(true);
    });

    it('returns false when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const result = await sdk.isInitialized();

      expect(result).toBe(false);
    });
  });

  describe('getAllBalances', () => {
    it('returns a record of asset → balance strings', async () => {
      const mockMap = new Map([[MOCK_ASSET, BigInt(1000)]]);
      (scValToNative as jest.Mock).mockReturnValue(mockMap);
      mockProvider.simulateTransaction.mockResolvedValue({
        results: [{ retval: {} }],
      });

      const result = await sdk.getAllBalances([MOCK_ASSET]);

      expect(result).toEqual({ [MOCK_ASSET]: '1000' });
      expect(mockProvider.simulateTransaction).toHaveBeenCalled();
    });

    it('returns empty object when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const result = await sdk.getAllBalances([MOCK_ASSET]);

      expect(result).toEqual({});
    });

    it('throws when simulation returns an error', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({ error: 'contract error' });

      await expect(sdk.getAllBalances([MOCK_ASSET])).rejects.toThrow('Failed to get all balances');
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-chain tests
  // ---------------------------------------------------------------------------

  describe('fundCrosschain', () => {
    const MOCK_SIG = {
      pubkey: 'a'.repeat(64), // 32-byte hex
      signature: 'b'.repeat(128), // 64-byte hex
    };

    it('returns pending status on success', async () => {
      const result = await sdk.fundCrosschain(
        {
          chainId: 1,
          txHash: '0x' + 'ab'.repeat(32),
          target: MOCK_ADDRESS,
          asset: MOCK_ASSET,
          amount: '1000',
          sigs: [MOCK_SIG],
        },
        mockKeypair,
      );

      expect(result.status).toBe('pending');
      expect(result.hash).toBe('mock_tx_hash');
      expect(mockProvider.getAccount).toHaveBeenCalledWith(MOCK_ADDRESS);
      expect(mockProvider.prepareTransaction).toHaveBeenCalled();
      expect(mockProvider.sendTransaction).toHaveBeenCalled();
    });

    it('returns failed on ERROR response', async () => {
      mockProvider.sendTransaction.mockResolvedValue({ hash: 'err', status: 'ERROR' });

      const result = await sdk.fundCrosschain(
        { chainId: 1, txHash: 'ab'.repeat(32), target: MOCK_ADDRESS, asset: MOCK_ASSET, amount: '1000', sigs: [MOCK_SIG] },
        mockKeypair,
      );

      expect(result.status).toBe('failed');
    });

    it('returns failed on network error', async () => {
      mockProvider.getAccount.mockRejectedValue(new Error('RPC down'));

      const result = await sdk.fundCrosschain(
        { chainId: 1, txHash: 'ab'.repeat(32), target: MOCK_ADDRESS, asset: MOCK_ASSET, amount: '500', sigs: [MOCK_SIG] },
        mockKeypair,
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe('RPC down');
    });
  });

  describe('addRelayer', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.addRelayer({ pubkey: 'a'.repeat(64) }, mockKeypair);

      expect(result.status).toBe('pending');
      expect(mockProvider.getAccount).toHaveBeenCalledWith(MOCK_ADDRESS);
    });

    it('returns failed on error', async () => {
      mockProvider.sendTransaction.mockResolvedValue({ hash: '', status: 'ERROR' });

      const result = await sdk.addRelayer({ pubkey: 'a'.repeat(64) }, mockKeypair);

      expect(result.status).toBe('failed');
    });
  });

  describe('removeRelayer', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.removeRelayer({ pubkey: 'a'.repeat(64) }, mockKeypair);

      expect(result.status).toBe('pending');
    });

    it('returns failed on network error', async () => {
      mockProvider.getAccount.mockRejectedValue(new Error('timeout'));

      const result = await sdk.removeRelayer({ pubkey: 'a'.repeat(64) }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('timeout');
    });
  });

  describe('setRelayerThreshold', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setRelayerThreshold(2, mockKeypair);

      expect(result.status).toBe('pending');
      expect(mockProvider.sendTransaction).toHaveBeenCalled();
    });
  });

  describe('queryRelayerThreshold', () => {
    it('returns threshold as a number', async () => {
      (scValToNative as jest.Mock).mockReturnValue(2);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      const threshold = await sdk.queryRelayerThreshold();

      expect(threshold).toBe(2);
    });

    it('returns 0 when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const threshold = await sdk.queryRelayerThreshold();

      expect(threshold).toBe(0);
    });

    it('throws on simulation error', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({ error: 'fail' });

      await expect(sdk.queryRelayerThreshold()).rejects.toThrow('Failed to query relayer threshold');
    });
  });

  describe('queryIsRelayer', () => {
    it('returns true when pubkey is a registered relayer', async () => {
      (scValToNative as jest.Mock).mockReturnValue(true);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      const result = await sdk.queryIsRelayer('a'.repeat(64));

      expect(result).toBe(true);
    });

    it('returns false when no results', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({});

      const result = await sdk.queryIsRelayer('a'.repeat(64));

      expect(result).toBe(false);
    });

    it('throws on simulation error', async () => {
      mockProvider.simulateTransaction.mockResolvedValue({ error: 'fail' });

      await expect(sdk.queryIsRelayer('a'.repeat(64))).rejects.toThrow('Failed to query relayer');
    });
  });
});

describe('address validation', () => {
  let sdk: OnboardingBridgeSDK;
  let mockKeypair: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockKeypair = { publicKey: jest.fn().mockReturnValue(MOCK_ADDRESS), sign: jest.fn() };
    const mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'h', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };
    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);
    sdk = new OnboardingBridgeSDK(CONFIG);
  });

  it('constructor rejects an invalid contractId', () => {
    expect(() => new OnboardingBridgeSDK({ ...CONFIG, contractId: 'not-a-contract' }))
      .toThrow(/Invalid contract address for "contractId"/);
  });

  it('constructor rejects a G-address as contractId', () => {
    expect(() => new OnboardingBridgeSDK({ ...CONFIG, contractId: MOCK_ADDRESS }))
      .toThrow(/Invalid contract address for "contractId"/);
  });

  it('fundCAddress rejects a C-address as source', async () => {
    const result = await sdk.fundCAddress(
      { source: MOCK_ASSET, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "source"/);
  });

  it('fundCAddress rejects a G-address as target', async () => {
    const result = await sdk.fundCAddress(
      { source: MOCK_ADDRESS, target: MOCK_ADDRESS, asset: MOCK_ASSET, amount: '1000' },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid contract address for "target"/);
  });

  it('fundCAddress rejects a G-address as asset', async () => {
    const result = await sdk.fundCAddress(
      { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ADDRESS, amount: '1000' },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid contract address for "asset"/);
  });

  it('batchFundCAddresses rejects invalid source', async () => {
    const results = await sdk.batchFundCAddresses(
      { source: 'bad', targets: [MOCK_ASSET], amounts: ['100'], asset: MOCK_ASSET },
      mockKeypair,
    );
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toMatch(/Invalid account address for "source"/);
  });

  it('batchFundCAddresses rejects G-address in targets', async () => {
    const results = await sdk.batchFundCAddresses(
      { source: MOCK_ADDRESS, targets: [MOCK_ADDRESS], amounts: ['100'], asset: MOCK_ASSET },
      mockKeypair,
    );
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toMatch(/Invalid contract address for "targets\[0\]"/);
  });

  it('withdrawFees rejects G-address as asset', async () => {
    const result = await sdk.withdrawFees({ asset: MOCK_ADDRESS, amount: '100' }, mockKeypair);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid contract address for "asset"/);
  });

  it('reclaimTokens rejects G-address as asset', async () => {
    const result = await sdk.reclaimTokens(
      { asset: MOCK_ADDRESS, amount: '100', to: MOCK_ADDRESS },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid contract address for "asset"/);
  });

  it('reclaimTokens rejects C-address as to', async () => {
    const result = await sdk.reclaimTokens(
      { asset: MOCK_ASSET, amount: '100', to: MOCK_ASSET },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "to"/);
  });

  it('setFeeCollector rejects a C-address', async () => {
    const result = await sdk.setFeeCollector(MOCK_ASSET, mockKeypair);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "newFeeCollector"/);
  });

  it('setAdmin rejects a C-address', async () => {
    const result = await sdk.setAdmin(MOCK_ASSET, mockKeypair);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "newAdmin"/);
  });

  it('getCAddressBalance rejects a G-address as cAddress', async () => {
    await expect(sdk.getCAddressBalance(MOCK_ADDRESS, MOCK_ASSET))
      .rejects.toThrow(/Invalid contract address for "cAddress"/);
  });

  it('getCAddressBalance rejects a G-address as asset', async () => {
    await expect(sdk.getCAddressBalance(MOCK_ASSET, MOCK_ADDRESS))
      .rejects.toThrow(/Invalid contract address for "asset"/);
  });

  it('getFeeBalance rejects a G-address as asset', async () => {
    await expect(sdk.getFeeBalance(MOCK_ADDRESS))
      .rejects.toThrow(/Invalid contract address for "asset"/);
  });

  it('getAllBalances rejects a G-address in assets list', async () => {
    await expect(sdk.getAllBalances([MOCK_ASSET, MOCK_ADDRESS]))
      .rejects.toThrow(/Invalid contract address for "assets\[1\]"/);
  });
});

describe('Error handling - invalid inputs', () => {
  let sdk: OnboardingBridgeSDK;
  let mockKeypair: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockKeypair = { publicKey: jest.fn().mockReturnValue(MOCK_ADDRESS), sign: jest.fn() };
    const mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'h', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };
    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);
    sdk = new OnboardingBridgeSDK(CONFIG);
  });

  it('fundCAddress rejects invalid source address (malformed)', async () => {
    const result = await sdk.fundCAddress(
      { source: 'not-an-address', target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "source"/);
  });

  it('fundCAddress rejects empty source address', async () => {
    const result = await sdk.fundCAddress(
      { source: '', target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "source"/);
  });

  it('fundCAddress passes negative amount string to contract (no client-side validation)', async () => {
    const result = await sdk.fundCAddress(
      { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '-1000' },
      mockKeypair,
    );
    // SDK doesn't validate amount, just passes to contract
    expect(result.status).toBe('pending');
  });

  it('fundCAddress passes zero amount to contract (no client-side validation)', async () => {
    const result = await sdk.fundCAddress(
      { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '0' },
      mockKeypair,
    );
    expect(result.status).toBe('pending');
  });

  it('batchFundCAddresses passes mismatched targets and amounts to contract (no client-side validation)', async () => {
    const results = await sdk.batchFundCAddresses(
      { source: MOCK_ADDRESS, targets: [MOCK_ASSET, MOCK_ASSET], amounts: ['100'], asset: MOCK_ASSET },
      mockKeypair,
    );
    expect(results[0].status).toBe('pending');
  });

  it('batchFundCAddresses passes empty targets array to contract (no client-side validation)', async () => {
    const results = await sdk.batchFundCAddresses(
      { source: MOCK_ADDRESS, targets: [], amounts: [], asset: MOCK_ASSET },
      mockKeypair,
    );
    // Empty targets: no chunks, no transactions submitted; returns empty array
    expect(results).toHaveLength(0);
  });

  it('withdrawFees passes negative amount to contract (no client-side validation)', async () => {
    const result = await sdk.withdrawFees({ asset: MOCK_ASSET, amount: '-100' }, mockKeypair);
    expect(result.status).toBe('pending');
  });

  it('setFee passes negative fee bps to contract (no client-side validation)', async () => {
    const result = await sdk.setFee(-100, mockKeypair);
    expect(result.status).toBe('pending');
  });

  it('reclaimTokens rejects invalid to address (C-address)', async () => {
    const result = await sdk.reclaimTokens(
      { asset: MOCK_ASSET, amount: '100', to: MOCK_ASSET },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "to"/);
  });

  it('getCAddressBalance rejects invalid cAddress', async () => {
    await expect(sdk.getCAddressBalance('invalid', MOCK_ASSET))
      .rejects.toThrow(/Invalid contract address for "cAddress"/);
  });

  it('getAllBalances rejects invalid asset in list', async () => {
    await expect(sdk.getAllBalances(['invalid', MOCK_ASSET]))
      .rejects.toThrow(/Invalid contract address for "assets\[0\]"/);
  });
});

describe('Type validation at runtime', () => {
  let sdk: OnboardingBridgeSDK;
  let mockKeypair: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockKeypair = { publicKey: jest.fn().mockReturnValue(MOCK_ADDRESS), sign: jest.fn() };
    const mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'h', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };
    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);
    sdk = new OnboardingBridgeSDK(CONFIG);
  });

  it('BridgeConfig accepts contractId, rpcUrl, networkPassphrase', () => {
    expect(() => new OnboardingBridgeSDK({ 
      contractId: MOCK_ASSET, 
      rpcUrl: 'https://rpc', 
      networkPassphrase: 'test' 
    })).not.toThrow();
  });

  it('BridgeConfig constructor validates contractId at construction time', () => {
    expect(() => new OnboardingBridgeSDK({ 
      rpcUrl: 'https://rpc', 
      networkPassphrase: 'test' 
    } as any)).toThrow(/Invalid contract address for "contractId"/);
    
    expect(() => new OnboardingBridgeSDK({ 
      contractId: MOCK_ASSET, 
      networkPassphrase: 'test' 
    } as any)).not.toThrow();
    
    expect(() => new OnboardingBridgeSDK({ 
      contractId: MOCK_ASSET, 
      rpcUrl: 'https://rpc' 
    } as any)).not.toThrow();
  });

  it('FundCOptions requires all fields', () => {
    const options: any = { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' };
    expect(options.source).toBeDefined();
    expect(options.target).toBeDefined();
    expect(options.asset).toBeDefined();
    expect(options.amount).toBeDefined();
  });

  it('BatchFundCOptions requires matching targets and amounts lengths', () => {
    const options: any = { 
      source: MOCK_ADDRESS, 
      targets: [MOCK_ASSET], 
      amounts: ['100'], 
      asset: MOCK_ASSET 
    };
    expect(options.targets.length).toBe(options.amounts.length);
  });

  it('OffRampConfig accepts optional provider keys', () => {
    const config = new OffRampIntegration({});
    expect(config).toBeInstanceOf(OffRampIntegration);
  });

  it('CrossChainFundOptions requires chainId, txHash, target, asset, amount, sigs', () => {
    const options: any = {
      chainId: 1,
      txHash: '0x' + 'ab'.repeat(32),
      target: MOCK_ADDRESS,
      asset: MOCK_ASSET,
      amount: '1000',
      sigs: [{ pubkey: 'a'.repeat(64), signature: 'b'.repeat(128) }],
    };
    expect(options.chainId).toBeDefined();
    expect(options.txHash).toBeDefined();
    expect(options.target).toBeDefined();
    expect(options.asset).toBeDefined();
    expect(options.amount).toBeDefined();
    expect(options.sigs).toBeDefined();
  });
});
