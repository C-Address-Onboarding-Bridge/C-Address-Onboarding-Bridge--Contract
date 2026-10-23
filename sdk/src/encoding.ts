/**
 * Shared ScVal-encoding and simulation-transaction helpers used by both
 * {@link OnboardingBridgeSDK} and the internal {@link ContractClient} inside
 * {@link CachedContractClient}.
 *
 * Extracting these prevents bugs from silently drifting between the two copies.
 *
 * @module encoding
 */

import {
  xdr,
  Address,
  nativeToScVal,
  Account,
  Contract,
  TransactionBuilder,
  MuxedAccount,
} from '@stellar/stellar-sdk';

/**
 * Account ID used for simulation-only transactions.
 * Matches the well-known contract provider key accepted by Soroban RPC.
 */
const SIMULATION_SOURCE =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

export interface TypeOptions {
  type: string;
  elementType?: TypeOptions | { type: string };
}

/**
 * A contract argument paired with its explicit Soroban ABI type.
 *
 * Callers must declare the type of every argument instead of relying on the
 * value's string contents, so that e.g. a `u32` parameter is never encoded as
 * an `i128`, and a non-address string that happens to start with `G` is not
 * forced into an `Address`.
 */
export interface TypedArg {
  /** The JavaScript value to encode. */
  value: any;
  /**
   * The Soroban ABI type to encode `value` as. When omitted, the value is
   * encoded with `nativeToScVal`'s default inference (no string heuristics).
   */
  type?: string;
  elementType?: TypeOptions | { type: string };
}

/**
 * Convert a single JavaScript value to its Soroban `ScVal` representation.
 *
 * Encoding is explicit: when a {@link TypedArg} or a second `options` parameter
 * is supplied, the value is encoded according to the declared ABI `type`;
 * otherwise `nativeToScVal`'s default inference is used. No type is ever
 * guessed from the string contents.
 *
 * @param arg - A JavaScript value, or a `{ value, type }` pair.
 * @param options - Optional ABI type descriptor, e.g. `{ type: 'u32' }`.
 * @returns The encoded `xdr.ScVal`.
 */
export function toSingleScVal(
  arg: any,
  options?: TypeOptions | { type: string; elementType?: any },
): xdr.ScVal {
  let val: any;
  let type: string | undefined;
  let elementType: any;

  if (options && typeof options === 'object' && 'type' in options) {
    val = arg;
    type = options.type;
    elementType = options.elementType;
  } else if (arg !== null && typeof arg === 'object' && 'value' in arg) {
    val = (arg as TypedArg).value;
    type = (arg as TypedArg).type;
    elementType = (arg as TypedArg).elementType;
  } else {
    val = arg;
  }

  if (type) {
    switch (type) {
      case 'u32':
      case 'i32': {
        const num = typeof val === 'number' ? val : Number(val);
        return nativeToScVal(num, { type });
      }

      case 'u64':
      case 'i64':
      case 'u128':
      case 'i128':
      case 'u256':
      case 'i256': {
        const bi = typeof val === 'bigint' ? val : BigInt(val);
        return nativeToScVal(bi, { type });
      }

      case 'timepoint': {
        const bi = typeof val === 'bigint' ? val : BigInt(val);
        return xdr.ScVal.scvTimepoint(xdr.Uint64.fromString(String(bi)));
      }

      case 'duration': {
        const bi = typeof val === 'bigint' ? val : BigInt(val);
        return xdr.ScVal.scvDuration(xdr.Uint64.fromString(String(bi)));
      }

      case 'string': {
        return nativeToScVal(String(val), { type: 'string' });
      }

      case 'symbol': {
        return nativeToScVal(String(val), { type: 'symbol' });
      }

      case 'bool': {
        const b = typeof val === 'boolean' ? val : val === 'true' || val === 1 || val === '1';
        return nativeToScVal(b, { type: 'bool' });
      }

      case 'bytes': {
        const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'hex');
        return nativeToScVal(buf, { type: 'bytes' });
      }

      case 'address': {
        if (val instanceof Address) {
          return val.toScVal();
        }
        let str = String(val);
        if (str.startsWith('M')) {
          const m = MuxedAccount.fromAddress(str, '0');
          str = m.baseAccount().accountId();
        }
        return new Address(str).toScVal();
      }

      case 'vec': {
        if (!Array.isArray(val)) {
          throw new Error('Expected array for vec type');
        }
        return xdr.ScVal.scvVec(
          val.map((item) => toSingleScVal(item, elementType)),
        );
      }

      case 'option': {
        if (val === null || val === undefined) {
          return xdr.ScVal.scvVoid();
        }
        return elementType ? toSingleScVal(val, elementType) : toSingleScVal(val);
      }

      default:
        return nativeToScVal(val, { type });
    }
  }

  if (val === null || val === undefined) {
    return xdr.ScVal.scvVoid();
  }
  if (val instanceof Address) {
    return val.toScVal();
  }
  if (Array.isArray(val)) {
    return xdr.ScVal.scvVec(val.map((item) => toSingleScVal(item)));
  }
  return nativeToScVal(val);
}

/**
 * Convert an array of JavaScript values to an array of `xdr.ScVal` instances.
 *
 * `null` / `undefined` values are encoded as `ScVal.scvVoid()`, and nested
 * arrays are recursively encoded as `ScVal.scvVec(...)` via
 * {@link toSingleScVal}. Each element may be a {@link TypedArg} to declare its
 * ABI type explicitly.
 *
 * @param args - Array of values (or `{ value, type }` pairs) to encode.
 * @returns Array of encoded `xdr.ScVal`.
 */
export function toScVals(args: any[]): xdr.ScVal[] {
  return args.map((arg) => {
    if (arg === null || arg === undefined) {
      return xdr.ScVal.scvVoid();
    }

    if (Array.isArray(arg)) {
      return xdr.ScVal.scvVec(arg.map((item) => toSingleScVal(item)));
    }

    return toSingleScVal(arg);
  });
}

/**
 * Build a simulation-only transaction for a Soroban contract read call.
 *
 * Uses the well-known simulation source account so the RPC accepts the
 * transaction for fee-free simulation.
 *
 * @param contract         - The Soroban {@link Contract} instance.
 * @param method           - Contract method name to invoke.
 * @param args             - Values (or `{ value, type }` pairs) to encode and
 *                           pass as arguments.
 * @param networkPassphrase - Stellar network passphrase.
 * @param timeout          - Transaction timeout in seconds.
 * @returns A built (but unsigned) transaction ready for simulation.
 */
export function buildSimulationTx(
  contract: Contract,
  method: string,
  args: any[],
  networkPassphrase: string,
  timeout: number,
) {
  const account = new Account(SIMULATION_SOURCE, '0');
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...toScVals(args)))
    .setTimeout(timeout)
    .build();
}
