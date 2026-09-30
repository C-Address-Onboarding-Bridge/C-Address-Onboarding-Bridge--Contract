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
} from '@stellar/stellar-sdk';

/**
 * Account ID used for simulation-only transactions.
 * Matches the well-known contract provider key accepted by Soroban RPC.
 */
const SIMULATION_SOURCE =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

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
}

/**
 * Convert a single JavaScript value to its Soroban `ScVal` representation.
 *
 * Encoding is explicit: when a {@link TypedArg} is supplied the value is
 * encoded with the declared ABI `type`; otherwise `nativeToScVal`'s default
 * inference is used. No type is ever guessed from the string contents.
 *
 * @param arg - A JavaScript value, or a `{ value, type }` pair.
 * @returns The encoded `xdr.ScVal`.
 */
export function toSingleScVal(arg: any): xdr.ScVal {
  if (arg !== null && typeof arg === 'object' && 'value' in arg) {
    const { value, type } = arg as TypedArg;
    if (value === null || value === undefined) {
      return xdr.ScVal.scvVoid();
    }
    if (value instanceof Address) {
      return value.toScVal();
    }
    return type ? nativeToScVal(value, { type }) : nativeToScVal(value);
  }

  if (arg === null || arg === undefined) {
    return xdr.ScVal.scvVoid();
  }
  if (arg instanceof Address) {
    return arg.toScVal();
  }
  return nativeToScVal(arg);
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
