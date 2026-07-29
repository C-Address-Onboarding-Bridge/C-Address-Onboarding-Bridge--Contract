import { OnboardingBridgeSDK } from '../bridge';
import { OffRampIntegration } from '../offramp';
import { SorobanRpc, Contract, scValToNative, xdr, Address, nativeToScVal, TransactionBuilder } from '@stellar/stellar-sdk';

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

    it('passes nonce and deadline to contract.call when provided', async () => {
      const contract = (Contract as jest.Mock).mock.results[0].value;

      const result = await sdk.fundCAddress(
        {
          source: MOCK_ADDRESS,
          target: MOCK_ASSET,
          asset: MOCK_ASSET,
          amount: '1000',
          nonce: 42,
          deadline: 1234567890,
        },
        mockKeypair,
      );

      expect(result.status).toBe('pending');
      // 1 method name + 4 base args + 2 optional args = 7 total
      expect(contract.call).toHaveBeenCalledWith(
        'fund_c_address',
        expect.anything(), // source
        expect.anything(), // target
        expect.anything(), // asset
        expect.anything(), // amount
        expect.anything(), // nonce
        expect.anything(), // deadline
      );
    });

    it('omits nonce and deadline (scvVoid) when not provided', async () => {
      const contract = (Contract as jest.Mock).mock.results[0].value;

      const result = await sdk.fundCAddress(
        { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
        mockKeypair,
      );

      expect(result.status).toBe('pending');
      // 1 method name + 4 base args + 2 void optionals = 7 total
      expect(contract.call).toHaveBeenCalledWith(
        'fund_c_address',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('fundCAddressWithReferral', () => {
    it('submits fund_c_address_with_referral', async () => {
      const result = await sdk.fundCAddressWithReferral(
        { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000', referrer: MOCK_ADDRESS },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'fund_c_address_with_referral',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('commitFund', () => {
    it('submits commit_fund', async () => {
      const result = await sdk.commitFund(
        {
          source: MOCK_ADDRESS,
          target: MOCK_ASSET,
          asset: MOCK_ASSET,
          amount: '1000',
          amountHash: 'ab'.repeat(32),
          deadline: 123456,
        },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'commit_fund',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('revealFund', () => {
    it('submits reveal_fund', async () => {
      const result = await sdk.revealFund(
        {
          commitmentId: 1,
          source: MOCK_ADDRESS,
          target: MOCK_ASSET,
          asset: MOCK_ASSET,
          amount: '1000',
          nonce: 42,
        },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'reveal_fund',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('batchFundCAddresses', () => {
    it('passes nonce and deadline to contract.call when provided', async () => {
      const contract = (Contract as jest.Mock).mock.results[0].value;

      const results = await sdk.batchFundCAddresses(
        {
          source: MOCK_ADDRESS,
          targets: [MOCK_ASSET],
          amounts: ['500'],
          asset: MOCK_ASSET,
          nonce: 7,
          deadline: 987654321,
        },
        mockKeypair,
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pending');
      // 1 method name + 4 base args + 2 optional args = 7 total
      expect(contract.call).toHaveBeenCalledWith(
        'batch_fund_c_address',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(), // nonce
        expect.anything(), // deadline
      );
    });

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

    it('passes nonce argument when provided', async () => {
      const result = await sdk.withdrawFees(
        { asset: MOCK_ASSET, amount: '100', nonce: 42 },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'withdraw_fees',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('setFee', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setFee(100, mockKeypair);

      expect(result.status).toBe('pending');
      expect(mockProvider.getAccount).toHaveBeenCalledWith(MOCK_ADDRESS);
    });

    it('rejects fee bps outside the documented range before RPC', async () => {
      await expect(sdk.setFee(-1, mockKeypair)).rejects.toThrow(
        'Fee basis points must be between 0 and 1000',
      );
      await expect(sdk.setFee(1001, mockKeypair)).rejects.toThrow(
        'Fee basis points must be between 0 and 1000',
      );
      expect(mockProvider.getAccount).not.toHaveBeenCalled();
    });

    it('passes nonce to contract.call when provided', async () => {
      const contract = (Contract as jest.Mock).mock.results[0].value;

      const result = await sdk.setFee(50, mockKeypair, 99);

      expect(result.status).toBe('pending');
      // 1 method name + newFeeBps + nonce = 3 total
      expect(contract.call).toHaveBeenCalledWith(
        'set_fee_bps',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('setReferralRate', () => {
    it('submits set_referral_rate', async () => {
      const result = await sdk.setReferralRate(2000, mockKeypair);

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'set_referral_rate',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('setLoyaltyToken', () => {
    it('submits set_loyalty_token', async () => {
      const result = await sdk.setLoyaltyToken(MOCK_ASSET, '10', mockKeypair);

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'set_loyalty_token',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('setFeeTiers', () => {
    it('submits set_fee_tiers', async () => {
      const result = await sdk.setFeeTiers(
        [{ min_volume: '0', max_volume: '1000', fee_bps: 50 }],
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith('set_fee_tiers', expect.anything());
    });
  });

  describe('setFeeCollector', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setFeeCollector(MOCK_ADDRESS, mockKeypair);

      expect(result.status).toBe('pending');
    });

    it('passes nonce to contract.call when provided', async () => {
      const contract = (Contract as jest.Mock).mock.results[0].value;

      const result = await sdk.setFeeCollector(MOCK_ADDRESS, mockKeypair, 123);

      expect(result.status).toBe('pending');
      // 1 method name + newFeeCollector + nonce = 3 total
      expect(contract.call).toHaveBeenCalledWith(
        'set_fee_collector',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('setAdmin', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.setAdmin(MOCK_ADDRESS, mockKeypair);

      expect(result.status).toBe('pending');
    });

    it('passes nonce to contract.call when provided', async () => {
      const contract = (Contract as jest.Mock).mock.results[0].value;

      const result = await sdk.setAdmin(MOCK_ADDRESS, mockKeypair, 456);

      expect(result.status).toBe('pending');
      // 1 method name + newAdmin + nonce = 3 total
      expect(contract.call).toHaveBeenCalledWith(
        'set_admin',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('timelocked upgrades', () => {
    const wasmHash = 'a'.repeat(64);

    it('submits schedule_upgrade', async () => {
      const result = await sdk.scheduleUpgrade({ newWasmHash: wasmHash, nonce: 1 }, mockKeypair);

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'schedule_upgrade',
        expect.anything(),
        expect.anything(),
      );
    });

    it('submits execute_upgrade', async () => {
      const result = await sdk.executeUpgrade({ expectedHash: wasmHash }, mockKeypair);

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'execute_upgrade',
        expect.anything(),
        expect.anything(),
      );
    });

    it('submits cancel_upgrade', async () => {
      const result = await sdk.cancelUpgrade({}, mockKeypair);

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith('cancel_upgrade', expect.anything());
    });

    it('queries pending upgrade', async () => {
      (scValToNative as jest.Mock).mockReturnValue({
        new_wasm_hash: Buffer.from(wasmHash, 'hex'),
        executable_after_ledger: 123,
      });
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      const pending = await sdk.queryPendingUpgrade();

      expect(pending).toEqual({
        newWasmHash: wasmHash,
        executableAfterLedger: 123,
      });
    });
  });

  describe('executeMetaFund', () => {
    it('submits execute_meta_fund', async () => {
      const result = await sdk.executeMetaFund(
        {
          params: {
            source: MOCK_ADDRESS,
            target: MOCK_ASSET,
            asset: MOCK_ASSET,
            amount: '1000',
            nonce: 1,
            deadline: 9999999999,
          },
          pubkey: 'b'.repeat(64),
          signature: 'c'.repeat(128),
        },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'execute_meta_fund',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('upgrade', () => {
    it('submits upgrade with wasm hash and optional nonce', async () => {
      const result = await sdk.upgrade(
        { newWasmHash: 'a'.repeat(64) },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'upgrade',
        expect.anything(),
        expect.anything(),
      );
    });

    it('passes nonce argument when provided', async () => {
      const result = await sdk.upgrade(
        { newWasmHash: 'a'.repeat(64), nonce: 99 },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'upgrade',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('reclaimTokens', () => {
    it('returns pending status on success', async () => {
      const result = await sdk.reclaimTokens(
        { asset: MOCK_ASSET, amount: '100', to: MOCK_ADDRESS },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(result.hash).toBe('mock_tx_hash');
      expect(contract.call).toHaveBeenCalledWith(
        'reclaim_tokens',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('passes nonce argument when provided', async () => {
      const result = await sdk.reclaimTokens(
        { asset: MOCK_ASSET, amount: '100', to: MOCK_ADDRESS, nonce: 7 },
        mockKeypair,
      );

      const contract = (Contract as jest.Mock).mock.results[0].value;
      expect(result.status).toBe('pending');
      expect(contract.call).toHaveBeenCalledWith(
        'reclaim_tokens',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
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

  describe('queryReferralRate', () => {
    it('returns referral rate as a number', async () => {
      (scValToNative as jest.Mock).mockReturnValue(2000);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      await expect(sdk.queryReferralRate()).resolves.toBe(2000);
    });
  });

  describe('queryCommitment', () => {
    it('returns commitment entry from simulation result', async () => {
      const entry = { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, revealed: false };
      (scValToNative as jest.Mock).mockReturnValue(entry);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      await expect(sdk.queryCommitment(1)).resolves.toBe(entry);
    });
  });

  describe('queryLoyaltyToken', () => {
    it('returns loyalty token config from simulation result', async () => {
      const config = { token: MOCK_ASSET, amount_per_fund: '10' };
      (scValToNative as jest.Mock).mockReturnValue(config);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      await expect(sdk.queryLoyaltyToken()).resolves.toBe(config);
    });
  });

  describe('queryFeeTiers', () => {
    it('returns configured fee tiers from simulation result', async () => {
      const tiers = [{ min_volume: '0', max_volume: '1000', fee_bps: 50 }];
      (scValToNative as jest.Mock).mockReturnValue(tiers);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      await expect(sdk.queryFeeTiers()).resolves.toBe(tiers);
    });
  });

  describe('queryCurrentTier', () => {
    it('returns current fee tier from simulation result', async () => {
      const tier = { min_volume: '0', max_volume: '1000', fee_bps: 50 };
      (scValToNative as jest.Mock).mockReturnValue(tier);
      mockProvider.simulateTransaction.mockResolvedValue({ results: [{ retval: {} }] });

      await expect(sdk.queryCurrentTier(MOCK_ADDRESS)).resolves.toBe(tier);
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

  describe('addRelayer / removeRelayer pubkey validation', () => {
    it('addRelayer rejects pubkey shorter than 32 bytes', async () => {
      const result = await sdk.addRelayer({ pubkey: 'a'.repeat(32) }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/expected a 64-character lowercase hex string/);
    });

    it('addRelayer rejects pubkey longer than 32 bytes', async () => {
      const result = await sdk.addRelayer({ pubkey: 'a'.repeat(66) }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/expected a 64-character lowercase hex string/);
    });

    it('addRelayer rejects non-hex characters in pubkey', async () => {
      const result = await sdk.addRelayer({ pubkey: 'z'.repeat(64) }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/expected a 64-character lowercase hex string/);
    });

    it('addRelayer rejects uppercase hex pubkey', async () => {
      const result = await sdk.addRelayer({ pubkey: 'A'.repeat(64) }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/expected a 64-character lowercase hex string/);
    });

    it('addRelayer rejects empty pubkey', async () => {
      const result = await sdk.addRelayer({ pubkey: '' }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/expected a 64-character lowercase hex string/);
    });

    it('removeRelayer rejects malformed pubkey', async () => {
      const result = await sdk.removeRelayer({ pubkey: 'deadbeef' }, mockKeypair);

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/expected a 64-character lowercase hex string/);
    });

    it('addRelayer accepts valid 64-char lowercase hex pubkey', async () => {
      const result = await sdk.addRelayer({ pubkey: 'a'.repeat(64) }, mockKeypair);

      // Should not fail on validation; proceeds to RPC
      expect(result.status).toBe('pending');
      expect(mockProvider.getAccount).toHaveBeenCalled();
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
  let mockProvider: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockKeypair = { publicKey: jest.fn().mockReturnValue(MOCK_ADDRESS), sign: jest.fn() };
    mockProvider = {
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

  it('setFee rejects negative fee bps before RPC', async () => {
    await expect(sdk.setFee(-100, mockKeypair)).rejects.toThrow(
      'Fee basis points must be between 0 and 1000',
    );
    expect(mockProvider.getAccount).not.toHaveBeenCalled();
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

  it('uses the configured timeout instead of the default 30 seconds', async () => {
    (SorobanRpc.Server as jest.Mock).mockClear();
    (TransactionBuilder as unknown as jest.Mock).mockClear();

    const setTimeoutSpy = jest.fn().mockReturnThis();
    (TransactionBuilder as unknown as jest.Mock).mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: setTimeoutSpy,
      build: jest.fn().mockReturnValue({}),
    }));

    const customSdk = new OnboardingBridgeSDK({ ...CONFIG, timeout: 60 });

    const mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'h', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };
    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);

    await customSdk.fundCAddress(
      { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
      mockKeypair,
    );

    // The last TransactionBuilder instance should have been called with timeout 60
    const calls = setTimeoutSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Every setTimeout call should be with 60 (the custom timeout)
    calls.forEach((call: any[]) => {
      expect(call[0]).toBe(60);
    });
  });

  it('falls back to 30-second timeout when config.timeout is omitted', async () => {
    (SorobanRpc.Server as jest.Mock).mockClear();
    (TransactionBuilder as unknown as jest.Mock).mockClear();

    const setTimeoutSpy = jest.fn().mockReturnThis();
    (TransactionBuilder as unknown as jest.Mock).mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: setTimeoutSpy,
      build: jest.fn().mockReturnValue({}),
    }));

    const defaultSdk = new OnboardingBridgeSDK(CONFIG);

    const mockProvider = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'h', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
    };
    (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);

    await (defaultSdk as any).fundCAddress(
      { source: MOCK_ADDRESS, target: MOCK_ASSET, asset: MOCK_ASSET, amount: '1000' },
      mockKeypair,
    );

    const calls = setTimeoutSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((call: any[]) => {
      expect(call[0]).toBe(30);
    });
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
