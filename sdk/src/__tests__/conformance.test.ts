/* eslint-disable @typescript-eslint/no-var-requires, no-constant-condition */
import * as fs from 'fs';
import * as path from 'path';
import {
  rpc,
  contract,
  Account,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
  Networks,
} from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';
import { FeeTier, MetaFundParams } from '../types';

describe('SDK <-> Soroban Contract ABI Conformance Suite (Issue #893)', () => {
  let spec: any;
  let client: OnboardingBridgeSDK;
  let keypair: Keypair;
  let interceptedTx: any = null;

  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  const MOCK_ASSET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  const MOCK_TARGET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const MOCK_HEX32 = 'ab'.repeat(32);
  const MOCK_HEX64 = 'cd'.repeat(64);

  beforeAll(() => {
    // Load spec: prefer built WASM if present, otherwise checked-in contract-spec.json
    const wasmPath = path.resolve(__dirname, '../../../../target/wasm32-unknown-unknown/release/onboarding_bridge.wasm');
    const jsonPath = path.resolve(__dirname, '../../contract-spec.json');

    if (fs.existsSync(wasmPath)) {
      try {
        const { XdrReader } = require('@stellar/js-xdr');
        const buf = fs.readFileSync(wasmPath);
        let offset = 8;
        let payload: Buffer | null = null;
        while (offset < buf.length) {
          const id = buf[offset++];
          let len = 0, shift = 0;
          while (true) {
            const byte = buf[offset++];
            len |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
          }
          const sectionEnd = offset + len;
          if (id === 0) {
            let nameLen = 0, nameShift = 0;
            while (true) {
              const byte = buf[offset++];
              nameLen |= (byte & 0x7f) << nameShift;
              if ((byte & 0x80) === 0) break;
              nameShift += 7;
            }
            const name = buf.subarray(offset, offset + nameLen).toString('utf-8');
            if (name === 'contractspecv0') {
              payload = buf.subarray(offset + nameLen, sectionEnd);
              break;
            }
          }
          offset = sectionEnd;
        }

        if (payload) {
          const reader = new XdrReader(payload);
          const entries: any[] = [];
          while (reader._index < payload.length) {
            entries.push(xdr.ScSpecEntry.read(reader));
          }
          spec = new contract.Spec(entries);
        }
      } catch (e) {
        // Fall back to JSON
      }
    }

    if (!spec && fs.existsSync(jsonPath)) {
      const base64List = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      spec = new contract.Spec(base64List);
    }

    if (!spec) {
      throw new Error('Could not load contract spec from WASM or contract-spec.json');
    }
  });

  beforeEach(() => {
    keypair = Keypair.random();
    interceptedTx = null;

    client = new OnboardingBridgeSDK({
      contractId: CONTRACT_ID,
      rpcUrl: 'https://testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
    });

    client['provider'] = {
      getAccount: jest.fn().mockImplementation(async (addr: string) => new Account(addr || keypair.publicKey(), '100')),
      prepareTransaction: jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { sign: jest.fn() };
      }),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'mock_tx_hash', status: 'PENDING' }),
      simulateTransaction: jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvVoid() }] };
      }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', returnValue: xdr.ScVal.scvVoid() }),
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [], latestLedger: 1 }),
      getFeeStats: jest.fn().mockResolvedValue({ sorobanInclusionFee: { p50: 100 } }),
    } as any;
  });

  function verifyInvoke(expectedFn: string) {
    expect(interceptedTx).toBeDefined();
    const op = interceptedTx.operations[0];
    expect(op.type).toBe('invokeHostFunction');

    const invoke = op.func.invokeContract();
    const fnName = invoke.functionName().toString();
    expect(fnName).toBe(expectedFn);

    const specFunc = spec.getFunc(fnName);
    expect(specFunc).toBeDefined();

    const actualArgs = invoke.args();
    const expectedInputs = specFunc.inputs();
    expect(actualArgs.length).toBe(expectedInputs.length);

    for (let i = 0; i < expectedInputs.length; i++) {
      const actualArg = actualArgs[i];
      const expectedType = expectedInputs[i].type();
      const match = matchesSpecType(actualArg, expectedType);
      if (!match) {
        throw new Error(
          `Argument #${i} (${expectedInputs[i].name().toString()}) type mismatch for ${fnName}: ` +
          `actual ScVal=${actualArg.switch().name}, expected specType=${expectedType.switch().name}`
        );
      }
      expect(match).toBe(true);
    }
  }

  function matchesSpecType(scVal: any, specType: any): boolean {
    const actual = scVal.switch().name;
    const expected = specType.switch().name;

    if (expected === 'scSpecTypeOption') {
      if (actual === 'scvVoid') return true;
      const inner = specType.value().valueType();
      return matchesSpecType(scVal, inner);
    }

    switch (expected) {
      case 'scSpecTypeAddress':
        return actual === 'scvAddress';
      case 'scSpecTypeI128':
        return actual === 'scvI128';
      case 'scSpecTypeU32':
        return actual === 'scvU32';
      case 'scSpecTypeI32':
        return actual === 'scvI32';
      case 'scSpecTypeU64':
        return actual === 'scvU64';
      case 'scSpecTypeI64':
        return actual === 'scvI64';
      case 'scSpecTypeBool':
        return actual === 'scvBool';
      case 'scSpecTypeBytesN':
      case 'scSpecTypeBytes':
        return actual === 'scvBytes';
      case 'scSpecTypeString':
        return actual === 'scvString';
      case 'scSpecTypeSymbol':
        return actual === 'scvSymbol';
      case 'scSpecTypeVec':
        return actual === 'scvVec';
      case 'scSpecTypeMap':
        return actual === 'scvMap';
      case 'scSpecTypeUdt':
        return actual === 'scvMap' || actual === 'scvVec';
      case 'scSpecTypeTuple':
        return actual === 'scvVec';
      default:
        return true;
    }
  }

  describe('Mutator Wrappers Conformance against Spec', () => {
    it('fundCAddress -> fund_c_address (6 args)', async () => {
      await client.fundCAddress(
        {
          source: keypair.publicKey(),
          target: MOCK_TARGET,
          asset: MOCK_ASSET,
          amount: '1000000',
          nonce: 1,
          deadline: 12345678,
        },
        keypair,
      );
      verifyInvoke('fund_c_address');
    });

    it('fundCAddressWithReferral -> fund_c_address_with_referral (7 args)', async () => {
      await client.fundCAddressWithReferral(
        {
          source: keypair.publicKey(),
          target: MOCK_TARGET,
          asset: MOCK_ASSET,
          amount: '1000000',
          referrer: MOCK_ADDRESS,
          nonce: 2,
          deadline: 12345678,
        },
        keypair,
      );
      verifyInvoke('fund_c_address_with_referral');
    });

    it('batchFundCAddresses -> batch_fund_c_address (6 args)', async () => {
      await client.batchFundCAddresses(
        {
          source: keypair.publicKey(),
          targets: [MOCK_TARGET],
          amounts: ['5000000'],
          asset: MOCK_ASSET,
          nonce: 3,
          deadline: 12345678,
        },
        keypair,
      );
      verifyInvoke('batch_fund_c_address');
    });

    it('fundCAddressTimelocked -> fund_c_address_timelocked (8 args)', async () => {
      await client.fundCAddressTimelocked(
        {
          source: keypair.publicKey(),
          target: MOCK_TARGET,
          asset: MOCK_ASSET,
          amount: '2000000',
          releaseTime: 1800000000,
          cliffTime: 1750000000,
          nonce: 4,
          deadline: 12345678,
        },
        keypair,
      );
      verifyInvoke('fund_c_address_timelocked');
    });

    it('fundCAddressWithSwap -> fund_c_address_with_swap (9 args)', async () => {
      await client.fundCAddressWithSwap(
        {
          source: keypair.publicKey(),
          target: MOCK_TARGET,
          sourceAsset: MOCK_ASSET,
          targetAsset: MOCK_ASSET,
          sourceAmount: '1000000',
          minTargetAmount: '950000',
          swapRoute: [MOCK_ASSET],
          nonce: 5,
          deadline: 12345678,
        },
        keypair,
      );
      verifyInvoke('fund_c_address_with_swap');
    });

    it('fundCrosschain -> fund_c_address_crosschain (6 args)', async () => {
      await client.fundCrosschain(
        {
          chainId: 1,
          txHash: MOCK_HEX32,
          target: MOCK_TARGET,
          asset: MOCK_ASSET,
          amount: '1000000',
          sigs: [{ pubkey: MOCK_HEX32, signature: MOCK_HEX64 }],
        },
        keypair,
      );
      verifyInvoke('fund_c_address_crosschain');
    });

    it('commitFund -> commit_fund (5 args)', async () => {
      await client.commitFund(
        {
          source: keypair.publicKey(),
          target: MOCK_TARGET,
          asset: MOCK_ASSET,
          amountHash: MOCK_HEX32,
          deadline: 12345678,
        },
        keypair,
      );
      verifyInvoke('commit_fund');
    });

    it('revealFund -> reveal_fund (6 args)', async () => {
      await client.revealFund(
        {
          commitmentId: 10,
          source: keypair.publicKey(),
          target: MOCK_TARGET,
          asset: MOCK_ASSET,
          amount: '1000000',
          nonce: 100,
        },
        keypair,
      );
      verifyInvoke('reveal_fund');
    });

    it('claimTimelocked -> claim_timelocked (1 arg)', async () => {
      await client.claimTimelocked(42, keypair);
      verifyInvoke('claim_timelocked');
    });

    it('executeMetaFund -> execute_meta_fund (3 args: params struct, pubkey, sig)', async () => {
      const params: MetaFundParams = {
        source: keypair.publicKey(),
        target: MOCK_TARGET,
        asset: MOCK_ASSET,
        amount: '1000000',
        networkId: MOCK_HEX32,
        nonce: 1,
        deadline: 9999999999,
      };
      await client.executeMetaFund(
        {
          params,
          pubkey: MOCK_HEX32,
          signature: MOCK_HEX64,
        },
        keypair,
      );
      verifyInvoke('execute_meta_fund');
    });

    it('setFee -> set_fee_bps (2 args)', async () => {
      await client.setFee(150, keypair, 10);
      verifyInvoke('set_fee_bps');
    });

    it('setFeeCollector -> set_fee_collector (2 args)', async () => {
      await client.setFeeCollector(MOCK_ADDRESS, keypair, 11);
      verifyInvoke('set_fee_collector');
    });

    it('setAdmin -> set_admin (2 args)', async () => {
      await client.setAdmin(MOCK_ADDRESS, keypair, 12);
      verifyInvoke('set_admin');
    });

    it('proposeNewAdmin -> propose_new_admin (2 args)', async () => {
      await client.proposeNewAdmin(MOCK_ADDRESS, keypair, 13);
      verifyInvoke('propose_new_admin');
    });

    it('acceptAdmin -> accept_admin (0 args)', async () => {
      await client.acceptAdmin(keypair);
      verifyInvoke('accept_admin');
    });

    it('proposeNewFeeCollector -> propose_new_fee_collector (2 args)', async () => {
      await client.proposeNewFeeCollector(MOCK_ADDRESS, keypair, 14);
      verifyInvoke('propose_new_fee_collector');
    });

    it('acceptFeeCollector -> accept_fee_collector (0 args)', async () => {
      await client.acceptFeeCollector(keypair);
      verifyInvoke('accept_fee_collector');
    });

    it('withdrawFees -> withdraw_fees (3 args)', async () => {
      await client.withdrawFees({ asset: MOCK_ASSET, amount: '500000', nonce: 15 }, keypair);
      verifyInvoke('withdraw_fees');
    });

    it('setReferralRate -> set_referral_rate (2 args)', async () => {
      await client.setReferralRate(200, keypair, 16);
      verifyInvoke('set_referral_rate');
    });

    it('setLoyaltyToken -> set_loyalty_token (3 args)', async () => {
      await client.setLoyaltyToken(MOCK_ASSET, '100', keypair, 17);
      verifyInvoke('set_loyalty_token');
    });

    it('setFeeTiers -> set_fee_tiers (2 args)', async () => {
      const tiers: FeeTier[] = [
        { fee_bps: 100, min_volume: '0', max_volume: '1000000' },
        { fee_bps: 50, min_volume: '1000001', max_volume: '10000000' },
      ];
      await client.setFeeTiers(tiers, keypair, 18);
      verifyInvoke('set_fee_tiers');
    });

    it('addRelayer -> add_relayer (2 args)', async () => {
      await client.addRelayer({ pubkey: MOCK_HEX32, nonce: 19 }, keypair);
      verifyInvoke('add_relayer');
    });

    it('removeRelayer -> remove_relayer (2 args)', async () => {
      await client.removeRelayer({ pubkey: MOCK_HEX32, nonce: 20 }, keypair);
      verifyInvoke('remove_relayer');
    });

    it('setRelayerThreshold -> set_relayer_threshold (2 args)', async () => {
      await client.setRelayerThreshold(2, keypair, 21);
      verifyInvoke('set_relayer_threshold');
    });

    it('upgrade -> upgrade (2 args)', async () => {
      await client.upgrade({ newWasmHash: MOCK_HEX32, nonce: 22 }, keypair);
      verifyInvoke('upgrade');
    });

    it('scheduleUpgrade -> schedule_upgrade (2 args)', async () => {
      await client.scheduleUpgrade({ newWasmHash: MOCK_HEX32, nonce: 23 }, keypair);
      verifyInvoke('schedule_upgrade');
    });

    it('executeUpgrade -> execute_upgrade (2 args)', async () => {
      await client.executeUpgrade({ expectedHash: MOCK_HEX32, nonce: 24 }, keypair);
      verifyInvoke('execute_upgrade');
    });

    it('cancelUpgrade -> cancel_upgrade (1 arg)', async () => {
      await client.cancelUpgrade({ nonce: 25 }, keypair);
      verifyInvoke('cancel_upgrade');
    });

    it('reclaimTokens -> reclaim_tokens (4 args)', async () => {
      await client.reclaimTokens({ asset: MOCK_ASSET, amount: '1000', to: MOCK_ADDRESS, nonce: 26 }, keypair);
      verifyInvoke('reclaim_tokens');
    });
  });

  describe('Query Wrappers: Call Conformance & Return Decoding from Real ScVals', () => {
    it('getFee: verifies query_fee_bps and decodes u32', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvU32(250) }] };
      });
      const res = await client.getFee();
      verifyInvoke('query_fee_bps');
      expect(res).toBe(250);
    });

    it('getFeeCollector: verifies query_fee_collector and decodes Address', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: new Address(MOCK_ADDRESS).toScVal() }] };
      });
      const res = await client.getFeeCollector();
      verifyInvoke('query_fee_collector');
      expect(res).toBe(MOCK_ADDRESS);
    });

    it('getAdmin: verifies query_admin and decodes Address', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: new Address(MOCK_ADDRESS).toScVal() }] };
      });
      const res = await client.getAdmin();
      verifyInvoke('query_admin');
      expect(res).toBe(MOCK_ADDRESS);
    });

    it('getPendingAdmin: verifies query_pending_admin and decodes Option<Address>', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvVoid() }] };
      });
      const resNull = await client.getPendingAdmin();
      verifyInvoke('query_pending_admin');
      expect(resNull).toBeNull();

      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: new Address(MOCK_ADDRESS).toScVal() }] };
      });
      const resAddr = await client.getPendingAdmin();
      expect(resAddr).toBe(MOCK_ADDRESS);
    });

    it('getCAddressBalance: verifies query_balance and decodes i128', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: nativeToScVal(1234567n, { type: 'i128' }) }] };
      });
      const res = await client.getCAddressBalance(MOCK_TARGET, MOCK_ASSET);
      verifyInvoke('query_balance');
      expect(res).toBe('1234567');
    });

    it('getAllBalances: verifies query_all_balances and decodes Map<Address, i128>', async () => {
      const mapScVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: new Address(MOCK_ASSET).toScVal(),
          val: nativeToScVal(987654n, { type: 'i128' }),
        }),
      ]);
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: mapScVal }] };
      });
      const res = await client.getAllBalances([MOCK_ASSET]);
      verifyInvoke('query_all_balances');
      expect(res[MOCK_ASSET]).toBe('987654');
    });

    it('getContractBalance: verifies query_contract_balance and decodes i128', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: nativeToScVal(555555n, { type: 'i128' }) }] };
      });
      const res = await client.getContractBalance(MOCK_ASSET);
      verifyInvoke('query_contract_balance');
      expect(res).toBe('555555');
    });

    it('getFeeBalance: verifies query_fee_balance and decodes i128', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: nativeToScVal(333333n, { type: 'i128' }) }] };
      });
      const res = await client.getFeeBalance(MOCK_ASSET);
      verifyInvoke('query_accrued_fees');
      expect(res).toBe('333333');
    });

    it('isInitialized: verifies query_is_initialized and decodes bool', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvBool(true) }] };
      });
      const res = await client.isInitialized();
      verifyInvoke('query_is_initialized');
      expect(res).toBe(true);
    });

    it('isBlocked: verifies query_is_blocked and decodes bool', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvBool(false) }] };
      });
      const res = await client.isBlocked(MOCK_ADDRESS);
      verifyInvoke('query_is_blocked');
      expect(res).toBe(false);
    });

    it('isAllowlisted: verifies query_is_allowlisted and decodes bool', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvBool(true) }] };
      });
      const res = await client.isAllowlisted(MOCK_ASSET);
      verifyInvoke('query_is_allowlisted');
      expect(res).toBe(true);
    });

    it('queryReferralRate: verifies query_referral_rate and decodes u32', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvU32(50) }] };
      });
      const res = await client.queryReferralRate();
      verifyInvoke('query_referral_rate');
      expect(res).toBe(50);
    });

    it('queryLoyaltyToken: verifies query_loyalty_token and decodes tuple (Address, i128)', async () => {
      const tupleScVal = xdr.ScVal.scvVec([
        new Address(MOCK_ASSET).toScVal(),
        nativeToScVal(200n, { type: 'i128' }),
      ]);
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: tupleScVal }] };
      });
      const res = await client.queryLoyaltyToken();
      verifyInvoke('query_loyalty_token');
      expect(res).toEqual({ token: MOCK_ASSET, amount_per_fund: '200' });
    });

    it('queryCurrentTier: verifies query_current_tier and decodes struct/map FeeTier', async () => {
      const tierMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('fee_bps'), val: xdr.ScVal.scvU32(50) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('max_volume'), val: nativeToScVal(1000000n, { type: 'i128' }) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('min_volume'), val: nativeToScVal(0n, { type: 'i128' }) }),
      ]);
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: tierMap }] };
      });
      const res = await client.queryCurrentTier(MOCK_ADDRESS, MOCK_ASSET);
      verifyInvoke('query_current_tier');
      expect(res).toBeDefined();
      expect(res?.fee_bps).toBe(50);
    });

    it('queryRelayerThreshold: verifies query_relayer_threshold and decodes u32', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvU32(2) }] };
      });
      const res = await client.queryRelayerThreshold();
      verifyInvoke('query_relayer_threshold');
      expect(res).toBe(2);
    });

    it('queryIsRelayer: verifies query_is_relayer and decodes bool', async () => {
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: xdr.ScVal.scvBool(true) }] };
      });
      const res = await client.queryIsRelayer(MOCK_HEX32);
      verifyInvoke('query_is_relayer');
      expect(res).toBe(true);
    });

    it('getWhitelistedAssets: verifies query_whitelisted_assets and decodes Vec<Address>', async () => {
      const vecScVal = xdr.ScVal.scvVec([new Address(MOCK_ASSET).toScVal()]);
      client['provider'].simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
        interceptedTx = tx;
        return { results: [{ retval: vecScVal }] };
      });
      const res = await client.getWhitelistedAssets(undefined, 10);
      verifyInvoke('query_whitelisted_assets');
      expect(res.items).toEqual([MOCK_ASSET]);
    });
  });
});
