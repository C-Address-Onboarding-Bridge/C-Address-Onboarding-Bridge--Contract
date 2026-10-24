import {
  Account,
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';
import { ObservabilityHooks } from '../observability';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ADMIN_KEYPAIR = Keypair.random();
const TARGET_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const TARGET_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('Pause and Allowlist/Blocklist Administration Wrappers (#884)', () => {
  let sdk: OnboardingBridgeSDK;
  let mockProvider: any;
  let lastContractCall: { method: string; args: xdr.ScVal[] } | null;
  let hooksTriggered: string[];

  beforeEach(() => {
    lastContractCall = null;
    hooksTriggered = [];

    const hooks: ObservabilityHooks = {
      onTransactionStart: (method: string) => {
        hooksTriggered.push(`start:${method}`);
      },
      onTransactionSuccess: (method: string) => {
        hooksTriggered.push(`success:${method}`);
      },
      onRpcCall: (method: string) => {
        hooksTriggered.push(`rpc:${method}`);
      },
    };

    mockProvider = {
      getAccount: jest.fn().mockImplementation(async (pubkey: string) => {
        return new Account(pubkey, '100');
      }),
      prepareTransaction: jest.fn().mockImplementation(async (tx: any) => {
        return tx;
      }),
      sendTransaction: jest.fn().mockImplementation(async () => {
        return { hash: 'mock-tx-hash-123', status: 'PENDING' };
      }),
      simulateTransaction: jest.fn().mockImplementation(async () => {
        return {
          results: [{ retval: nativeToScVal(true, { type: 'bool' }) }],
        };
      }),
    };

    sdk = new OnboardingBridgeSDK({
      contractId: CONTRACT_ID,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      hooks,
    });

    (sdk as any).provider = mockProvider;

    // Spy on contract call to capture exact method name and argument ScVals
    const realContract = (sdk as any).contract;
    const originalCall = realContract.call.bind(realContract);
    jest.spyOn(realContract, 'call').mockImplementation((...callArgs: any[]) => {
      const [method, ...args] = callArgs;
      lastContractCall = { method, args };
      return originalCall(method, ...args);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isPaused', () => {
    it('queries query_is_paused via simulation and returns true', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: nativeToScVal(true, { type: 'bool' }) }],
      });

      const paused = await sdk.isPaused();
      expect(paused).toBe(true);
      expect(hooksTriggered).toContain('rpc:simulateTransaction');
    });

    it('queries query_is_paused and returns false', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: nativeToScVal(false, { type: 'bool' }) }],
      });

      const paused = await sdk.isPaused();
      expect(paused).toBe(false);
    });
  });

  describe('getAllowlistMode', () => {
    it('queries query_allowlist_mode via simulation and returns true', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: nativeToScVal(true, { type: 'bool' }) }],
      });

      const enabled = await sdk.getAllowlistMode();
      expect(enabled).toBe(true);
      expect(hooksTriggered).toContain('rpc:simulateTransaction');
    });

    it('queries query_allowlist_mode and returns false', async () => {
      mockProvider.simulateTransaction.mockResolvedValueOnce({
        results: [{ retval: nativeToScVal(false, { type: 'bool' }) }],
      });

      const enabled = await sdk.getAllowlistMode();
      expect(enabled).toBe(false);
    });
  });

  describe('pause', () => {
    it('calls pause with optional nonce when provided', async () => {
      const result = await sdk.pause(ADMIN_KEYPAIR, 42n);

      expect(result.status).toBe('pending');
      expect(result.hash).toBe('mock-tx-hash-123');
      expect(lastContractCall).not.toBeNull();
      expect(lastContractCall!.method).toBe('pause');
      expect(lastContractCall!.args).toHaveLength(1);
      expect(lastContractCall!.args[0].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[0].u64().toBigInt()).toBe(42n);
      expect(hooksTriggered).toContain('start:pause');
      expect(hooksTriggered).toContain('success:pause');
    });

    it('calls pause without nonce as scvVoid', async () => {
      const result = await sdk.pause(ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('pause');
      expect(lastContractCall!.args).toHaveLength(1);
      expect(lastContractCall!.args[0].switch().name).toBe('scvVoid');
    });

    it('supports options object signature { nonce }', async () => {
      const result = await sdk.pause({ nonce: 99n }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('pause');
      expect(lastContractCall!.args[0].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[0].u64().toBigInt()).toBe(99n);
    });
  });

  describe('unpause', () => {
    it('calls unpause with optional nonce when provided', async () => {
      const result = await sdk.unpause(ADMIN_KEYPAIR, 123n);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('unpause');
      expect(lastContractCall!.args).toHaveLength(1);
      expect(lastContractCall!.args[0].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[0].u64().toBigInt()).toBe(123n);
      expect(hooksTriggered).toContain('start:unpause');
      expect(hooksTriggered).toContain('success:unpause');
    });

    it('calls unpause without nonce as scvVoid', async () => {
      const result = await sdk.unpause(ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('unpause');
      expect(lastContractCall!.args).toHaveLength(1);
      expect(lastContractCall!.args[0].switch().name).toBe('scvVoid');
    });

    it('supports options object signature { nonce }', async () => {
      const result = await sdk.unpause({ nonce: 77n }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('unpause');
      expect(lastContractCall!.args[0].u64().toBigInt()).toBe(77n);
    });
  });

  describe('addToBlocklist', () => {
    it('calls add_to_blocklist with address and nonce ScVals', async () => {
      const result = await sdk.addToBlocklist(TARGET_ADDRESS, ADMIN_KEYPAIR, 5n);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('add_to_blocklist');
      expect(lastContractCall!.args).toHaveLength(2);
      expect(lastContractCall!.args[0].switch().name).toBe('scvAddress');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_ADDRESS).toScVal());
      expect(lastContractCall!.args[1].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(5n);
      expect(hooksTriggered).toContain('start:addToBlocklist');
      expect(hooksTriggered).toContain('success:addToBlocklist');
    });

    it('supports contract C-address and void nonce', async () => {
      const result = await sdk.addToBlocklist(TARGET_CONTRACT, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('add_to_blocklist');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_CONTRACT).toScVal());
      expect(lastContractCall!.args[1].switch().name).toBe('scvVoid');
    });

    it('supports options object { address, nonce }', async () => {
      const result = await sdk.addToBlocklist({ address: TARGET_ADDRESS, nonce: 8n }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('add_to_blocklist');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_ADDRESS).toScVal());
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(8n);
    });

    it('throws when address is invalid', async () => {
      await expect(sdk.addToBlocklist('invalid-addr', ADMIN_KEYPAIR)).rejects.toThrow();
    });
  });

  describe('removeFromBlocklist', () => {
    it('calls remove_from_blocklist with address and nonce ScVals', async () => {
      const result = await sdk.removeFromBlocklist(TARGET_ADDRESS, ADMIN_KEYPAIR, 9n);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('remove_from_blocklist');
      expect(lastContractCall!.args).toHaveLength(2);
      expect(lastContractCall!.args[0].switch().name).toBe('scvAddress');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_ADDRESS).toScVal());
      expect(lastContractCall!.args[1].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(9n);
      expect(hooksTriggered).toContain('start:removeFromBlocklist');
      expect(hooksTriggered).toContain('success:removeFromBlocklist');
    });

    it('supports void nonce and options object', async () => {
      const result = await sdk.removeFromBlocklist({ address: TARGET_ADDRESS }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('remove_from_blocklist');
      expect(lastContractCall!.args[1].switch().name).toBe('scvVoid');
    });

    it('throws when address is invalid', async () => {
      await expect(sdk.removeFromBlocklist('invalid-addr', ADMIN_KEYPAIR)).rejects.toThrow();
    });
  });

  describe('addToAllowlist', () => {
    it('calls add_to_allowlist with address and nonce ScVals', async () => {
      const result = await sdk.addToAllowlist(TARGET_ADDRESS, ADMIN_KEYPAIR, 12n);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('add_to_allowlist');
      expect(lastContractCall!.args).toHaveLength(2);
      expect(lastContractCall!.args[0].switch().name).toBe('scvAddress');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_ADDRESS).toScVal());
      expect(lastContractCall!.args[1].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(12n);
      expect(hooksTriggered).toContain('start:addToAllowlist');
      expect(hooksTriggered).toContain('success:addToAllowlist');
    });

    it('supports contract C-address and void nonce', async () => {
      const result = await sdk.addToAllowlist(TARGET_CONTRACT, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('add_to_allowlist');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_CONTRACT).toScVal());
      expect(lastContractCall!.args[1].switch().name).toBe('scvVoid');
    });

    it('supports options object { address, nonce }', async () => {
      const result = await sdk.addToAllowlist({ address: TARGET_ADDRESS, nonce: 15n }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('add_to_allowlist');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_ADDRESS).toScVal());
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(15n);
    });

    it('throws when address is invalid', async () => {
      await expect(sdk.addToAllowlist('not-valid-address', ADMIN_KEYPAIR)).rejects.toThrow();
    });
  });

  describe('removeFromAllowlist', () => {
    it('calls remove_from_allowlist with address and nonce ScVals', async () => {
      const result = await sdk.removeFromAllowlist(TARGET_ADDRESS, ADMIN_KEYPAIR, 20n);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('remove_from_allowlist');
      expect(lastContractCall!.args).toHaveLength(2);
      expect(lastContractCall!.args[0].switch().name).toBe('scvAddress');
      expect(lastContractCall!.args[0]).toEqual(new Address(TARGET_ADDRESS).toScVal());
      expect(lastContractCall!.args[1].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(20n);
      expect(hooksTriggered).toContain('start:removeFromAllowlist');
      expect(hooksTriggered).toContain('success:removeFromAllowlist');
    });

    it('supports void nonce and options object', async () => {
      const result = await sdk.removeFromAllowlist({ address: TARGET_ADDRESS }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('remove_from_allowlist');
      expect(lastContractCall!.args[1].switch().name).toBe('scvVoid');
    });

    it('throws when address is invalid', async () => {
      await expect(sdk.removeFromAllowlist('invalid-address-string', ADMIN_KEYPAIR)).rejects.toThrow();
    });
  });

  describe('setAllowlistMode', () => {
    it('calls set_allowlist_mode with boolean true and nonce ScVals', async () => {
      const result = await sdk.setAllowlistMode(true, ADMIN_KEYPAIR, 30n);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('set_allowlist_mode');
      expect(lastContractCall!.args).toHaveLength(2);
      expect(lastContractCall!.args[0].switch().name).toBe('scvBool');
      expect(lastContractCall!.args[0].b()).toBe(true);
      expect(lastContractCall!.args[1].switch().name).toBe('scvU64');
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(30n);
      expect(hooksTriggered).toContain('start:setAllowlistMode');
      expect(hooksTriggered).toContain('success:setAllowlistMode');
    });

    it('calls set_allowlist_mode with boolean false and void nonce', async () => {
      const result = await sdk.setAllowlistMode(false, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('set_allowlist_mode');
      expect(lastContractCall!.args[0].switch().name).toBe('scvBool');
      expect(lastContractCall!.args[0].b()).toBe(false);
      expect(lastContractCall!.args[1].switch().name).toBe('scvVoid');
    });

    it('supports options object { enabled, nonce }', async () => {
      const result = await sdk.setAllowlistMode({ enabled: true, nonce: 35n }, ADMIN_KEYPAIR);

      expect(result.status).toBe('pending');
      expect(lastContractCall!.method).toBe('set_allowlist_mode');
      expect(lastContractCall!.args[0].b()).toBe(true);
      expect(lastContractCall!.args[1].u64().toBigInt()).toBe(35n);
    });
  });
});
