import { Keypair, xdr, Address, Contract } from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const MOCK_G_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const MOCK_C_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

describe('SDK pause and allowlist/blocklist administration wrappers (#884)', () => {
  let sdk: OnboardingBridgeSDK;
  let mockProvider: any;
  let callSpy: jest.SpyInstance;
  const adminKeypair = Keypair.random();

  beforeEach(() => {
    mockProvider = {
      getAccount: jest.fn().mockResolvedValue({
        accountId: () => adminKeypair.publicKey(),
        sequenceNumber: () => '100',
        incrementSequenceNumber: () => {},
      }),
      prepareTransaction: jest.fn().mockImplementation(async (tx: any) => ({
        sign: jest.fn(),
        toXDR: () => 'mock_xdr',
      })),
      sendTransaction: jest.fn().mockResolvedValue({
        hash: 'txhash123',
        status: 'PENDING',
      }),
      simulateTransaction: jest.fn(),
    };

    sdk = new OnboardingBridgeSDK({
      contractId: CONTRACT_ID,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    (sdk as any).provider = mockProvider;
    callSpy = jest.spyOn((sdk as any).contract, 'call');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('pause', () => {
    it('invokes contract pause without nonce', async () => {
      const res = await sdk.pause(adminKeypair);
      expect(res.status).toBe('pending');
      expect(res.hash).toBe('txhash123');
      expect(callSpy).toHaveBeenCalledWith(
        'pause',
        xdr.ScVal.scvVoid(),
      );
    });

    it('invokes contract pause with sequential nonce', async () => {
      const res = await sdk.pause(adminKeypair, 42);
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'pause',
        expect.objectContaining({ _arm: 'u64' }),
      );
    });
  });

  describe('unpause', () => {
    it('invokes contract unpause without nonce', async () => {
      const res = await sdk.unpause(adminKeypair);
      expect(res.status).toBe('pending');
      expect(res.hash).toBe('txhash123');
      expect(callSpy).toHaveBeenCalledWith(
        'unpause',
        xdr.ScVal.scvVoid(),
      );
    });

    it('invokes contract unpause with sequential nonce', async () => {
      const res = await sdk.unpause(adminKeypair, '100');
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'unpause',
        expect.objectContaining({ _arm: 'u64' }),
      );
    });
  });

  describe('isPaused', () => {
    it('queries query_is_paused and decodes true', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: xdr.ScVal.scvBool(true) }],
      });
      const paused = await sdk.isPaused();
      expect(paused).toBe(true);
      expect(callSpy).toHaveBeenCalledWith('query_is_paused');
    });

    it('queries query_is_paused and decodes false', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: xdr.ScVal.scvBool(false) }],
      });
      const paused = await sdk.isPaused();
      expect(paused).toBe(false);
      expect(callSpy).toHaveBeenCalledWith('query_is_paused');
    });

    it('throws when simulation fails', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        error: 'Simulation failed',
      });
      await expect(sdk.isPaused()).rejects.toThrow(/Failed to query paused status/);
    });
  });

  describe('addToBlocklist and removeFromBlocklist', () => {
    it('addToBlocklist validates address and calls add_to_blocklist with Address ScVal', async () => {
      const res = await sdk.addToBlocklist(MOCK_G_ADDRESS, adminKeypair, 5);
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'add_to_blocklist',
        expect.objectContaining({ _arm: 'address' }),
        expect.objectContaining({ _arm: 'u64' }),
      );
    });

    it('addToBlocklist rejects invalid address', async () => {
      const res = await sdk.addToBlocklist('invalid_addr', adminKeypair);
      expect(res.status).toBe('failed');
      expect(res.error).toMatch(/Invalid address/);
    });

    it('removeFromBlocklist calls remove_from_blocklist with Address ScVal', async () => {
      const res = await sdk.removeFromBlocklist(MOCK_C_ADDRESS, adminKeypair);
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'remove_from_blocklist',
        expect.objectContaining({ _arm: 'address' }),
        xdr.ScVal.scvVoid(),
      );
    });
  });

  describe('addToAllowlist and removeFromAllowlist', () => {
    it('addToAllowlist validates address and calls add_to_allowlist', async () => {
      const res = await sdk.addToAllowlist(MOCK_G_ADDRESS, adminKeypair);
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'add_to_allowlist',
        expect.objectContaining({ _arm: 'address' }),
        xdr.ScVal.scvVoid(),
      );
    });

    it('removeFromAllowlist calls remove_from_allowlist with nonce', async () => {
      const res = await sdk.removeFromAllowlist(MOCK_G_ADDRESS, adminKeypair, 99n);
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'remove_from_allowlist',
        expect.objectContaining({ _arm: 'address' }),
        expect.objectContaining({ _arm: 'u64' }),
      );
    });
  });

  describe('setAllowlistMode and getAllowlistMode', () => {
    it('setAllowlistMode calls set_allowlist_mode with boolean ScVal and nonce', async () => {
      const res = await sdk.setAllowlistMode(true, adminKeypair, 1);
      expect(res.status).toBe('pending');
      expect(callSpy).toHaveBeenCalledWith(
        'set_allowlist_mode',
        xdr.ScVal.scvBool(true),
        expect.objectContaining({ _arm: 'u64' }),
      );
    });

    it('getAllowlistMode queries query_allowlist_mode and decodes boolean', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: xdr.ScVal.scvBool(true) }],
      });
      const mode = await sdk.getAllowlistMode();
      expect(mode).toBe(true);
      expect(callSpy).toHaveBeenCalledWith('query_allowlist_mode');
    });

    it('getAllowlistMode throws on simulation error', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        error: 'Host error',
      });
      await expect(sdk.getAllowlistMode()).rejects.toThrow(/Failed to query allowlist mode/);
    });
  });
});
