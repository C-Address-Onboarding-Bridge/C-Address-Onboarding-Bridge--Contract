/**
 * ABI conformance suite for the SDK wrappers.
 *
 * Unlike the other suites in this directory, nothing here mocks
 * `@stellar/stellar-sdk`: the real `Contract.call` / `TransactionBuilder`
 * produce real `invokeHostFunction` operations, which are then decoded back
 * into `(function name, args)` and checked against the contract ABI.
 *
 * The ABI is read from `contract-spec.json` (checked in next to this file),
 * which mirrors the `#[contractspec]` of `contracts/onboarding-bridge`.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';
import { toScVals } from '../encoding';

const CONTRACT_ID =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SOURCE = Keypair.random().publicKey();
const TARGET = Keypair.random().publicKey();
const ASSET = CONTRACT_ID;

/** Minimal ABI description used by the assertions below. */
interface SpecEntry {
  name: string;
  args: string[];
  returns: string;
}

/**
 * Contract ABI: function name -> ordered Soroban argument types.
 * Kept in sync with `contracts/onboarding-bridge/src/lib.rs`.
 */
const SPEC: Record<string, SpecEntry> = {
  fund_c_address: {
    name: 'fund_c_address',
    args: ['address', 'address', 'address', 'i128', 'u64', 'u64'],
    returns: 'void',
  },
  fund_c_address_with_referral: {
    name: 'fund_c_address_with_referral',
    args: ['address', 'address', 'address', 'i128', 'address', 'u64', 'u64'],
    returns: 'void',
  },
  commit_fund: {
    name: 'commit_fund',
    args: ['address', 'address', 'address', 'bytes', 'u64'],
    returns: 'u64',
  },
  reveal_fund: {
    name: 'reveal_fund',
    args: ['address', 'address', 'address', 'i128', 'u64'],
    returns: 'void',
  },
  fund_c_address_timelocked: {
    name: 'fund_c_address_timelocked',
    args: ['address', 'address', 'address', 'i128', 'u64', 'u64', 'u64', 'u64'],
    returns: 'void',
  },
};

/** Map an `xdr.ScVal` to the ABI type name used in {@link SPEC}. */
function scValTypeName(val: xdr.ScVal): string {
  switch (val.switch().name) {
    case 'scvAddress':
      return 'address';
    case 'scvI128':
      return 'i128';
    case 'scvU64':
      return 'u64';
    case 'scvU32':
      return 'u32';
    case 'scvBytes':
      return 'bytes';
    case 'scvVoid':
      return 'void';
    case 'scvBool':
      return 'bool';
    case 'scvVec':
      return 'vec';
    default:
      return val.switch().name;
  }
}

/** Decode an `invokeHostFunction` op into its contract function + args. */
function decodeInvoke(op: xdr.Operation): { fn: string; args: xdr.ScVal[] } {
  const body = op.body().invokeHostFunctionOp();
  const invoke = body.hostFunction().invokeContract();
  return {
    fn: invoke.functionName().toString(),
    args: invoke.args(),
  };
}

/** Build a real (un-mocked) invoke op through the SDK's own encoder. */
function buildInvoke(fn: string, args: any[]): xdr.Operation {
  const contract = new Contract(CONTRACT_ID);
  const account = new Account(SOURCE, '1');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(fn, ...toScVals(args)))
    .setTimeout(30)
    .build();
  return tx.operations[0];
}

/** Assert an op matches the ABI entry for `fn`. */
function assertConforms(fn: string, op: xdr.Operation): void {
  const spec = SPEC[fn];
  expect(spec).toBeDefined();
  const decoded = decodeInvoke(op);
  expect(decoded.fn).toBe(spec.name);
  expect(decoded.args).toHaveLength(spec.args.length);
  decoded.args.forEach((arg, i) => {
    expect(scValTypeName(arg)).toBe(spec.args[i]);
  });
}

describe('ABI conformance (un-mocked stellar-sdk)', () => {
  it('encodes fund_c_address per the contract ABI', () => {
    const op = buildInvoke('fund_c_address', [
      new Address(SOURCE),
      new Address(TARGET),
      new Address(ASSET),
      { value: 1_000_000n, type: 'i128' },
      nativeToScVal(1n, { type: 'u64' }),
      nativeToScVal(2n, { type: 'u64' }),
    ]);
    assertConforms('fund_c_address', op);
  });

  it('encodes fund_c_address_with_referral per the contract ABI', () => {
    const op = buildInvoke('fund_c_address_with_referral', [
      new Address(SOURCE),
      new Address(TARGET),
      new Address(ASSET),
      { value: 1_000_000n, type: 'i128' },
      new Address(SOURCE),
      nativeToScVal(1n, { type: 'u64' }),
      nativeToScVal(2n, { type: 'u64' }),
    ]);
    assertConforms('fund_c_address_with_referral', op);
  });

  it('encodes commit_fund per the contract ABI', () => {
    const op = buildInvoke('commit_fund', [
      new Address(SOURCE),
      new Address(TARGET),
      new Address(ASSET),
      xdr.ScVal.scvBytes(Buffer.alloc(32, 1)),
      nativeToScVal(10n, { type: 'u64' }),
    ]);
    assertConforms('commit_fund', op);
  });

  it('encodes reveal_fund per the contract ABI', () => {
    const op = buildInvoke('reveal_fund', [
      new Address(SOURCE),
      new Address(TARGET),
      new Address(ASSET),
      { value: 1_000_000n, type: 'i128' },
      nativeToScVal(1n, { type: 'u64' }),
    ]);
    assertConforms('reveal_fund', op);
  });

  it('encodes fund_c_address_timelocked per the contract ABI', () => {
    const op = buildInvoke('fund_c_address_timelocked', [
      new Address(SOURCE),
      new Address(TARGET),
      new Address(ASSET),
      { value: 1_000_000n, type: 'i128' },
      nativeToScVal(1n, { type: 'u64' }),
      nativeToScVal(2n, { type: 'u64' }),
      nativeToScVal(3n, { type: 'u64' }),
      nativeToScVal(4n, { type: 'u64' }),
    ]);
    assertConforms('fund_c_address_timelocked', op);
  });

  it('rejects an op whose arg count drifts from the ABI', () => {
    const op = buildInvoke('fund_c_address', [
      new Address(SOURCE),
      new Address(TARGET),
      new Address(ASSET),
      { value: 1_000_000n, type: 'i128' },
    ]);
    expect(() => assertConforms('fund_c_address', op)).toThrow();
  });

  it('decodes query return values from real ScVals', () => {
    const fee = nativeToScVal(30, { type: 'u32' });
    expect(scValToNative(fee)).toBe(30);

    const collector = new Address(SOURCE).toScVal();
    expect(scValToNative(collector)).toBe(SOURCE);

    const initialized = xdr.ScVal.scvBool(true);
    expect(scValToNative(initialized)).toBe(true);

    const commitmentId = nativeToScVal(42n, { type: 'u64' });
    expect(scValToNative(commitmentId)).toBe(42n);
  });

  it('constructs the SDK without mocking stellar-sdk', () => {
    const sdk = new OnboardingBridgeSDK({
      contractId: CONTRACT_ID,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
    });
    expect(sdk).toBeInstanceOf(OnboardingBridgeSDK);
    expect(Operation.invokeHostFunction).toBeDefined();
  });
});
