import { OnboardingBridgeSDK } from '../bridge';
import { SorobanRpc, scValToNative } from '@stellar/stellar-sdk';

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
    },
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
    isValidEd25519PublicKey: jest.fn((addr: string) => addr.startsWith('G') && addr.length === 56),
    isValidContract: jest.fn((addr: string) => addr.startsWith('C') && addr.length === 56),
  },
}));

const CONFIG = {
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
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
    it('returns pending status on success', async () => {
      const result = await sdk.batchFundCAddresses(
        {
          source: MOCK_ADDRESS,
          targets: [MOCK_ASSET, MOCK_ASSET],
          amounts: ['500', '500'],
          asset: MOCK_ASSET,
        },
        mockKeypair,
      );

      expect(result.status).toBe('pending');
      expect(result.hash).toBe('mock_tx_hash');
    });

    it('returns failed status when transaction errors (e.g. mismatched arrays on-chain)', async () => {
      mockProvider.sendTransaction.mockResolvedValue({ hash: 'err_hash', status: 'ERROR' });

      const result = await sdk.batchFundCAddresses(
        {
          source: MOCK_ADDRESS,
          targets: [MOCK_ASSET],
          amounts: ['500', '500'],
          asset: MOCK_ASSET,
        },
        mockKeypair,
      );

      expect(result.status).toBe('failed');
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
    const result = await sdk.batchFundCAddresses(
      { source: 'bad', targets: [MOCK_ASSET], amounts: ['100'], asset: MOCK_ASSET },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid account address for "source"/);
  });

  it('batchFundCAddresses rejects G-address in targets', async () => {
    const result = await sdk.batchFundCAddresses(
      { source: MOCK_ADDRESS, targets: [MOCK_ADDRESS], amounts: ['100'], asset: MOCK_ASSET },
      mockKeypair,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Invalid contract address for "targets\[0\]"/);
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
