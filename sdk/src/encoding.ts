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
 * Convert a single JavaScript value to its Soroban `ScVal` representation.
 *
 * **Encoding rules (in order):**
 *
 * | JS value                  | ScVal type         |
 * |---------------------------|--------------------|
 * | String starting with C/G  | `Address`          |
 * | Numeric string (digits)   | `i128`             |
 * | Other string              | `string` (Symbol)  |
 * | `number` or `bigint`      | `i128`             |
 * | `Address` instance        | `Address`          |
 * | `null` / `undefined`      | `Void`             |
 * | `Array`                   | `Vec` (recursive)  |
 * | Everything else           | `nativeToScVal`    |
 *
 * @param arg - A JavaScript value to encode.
 * @returns The encoded `xdr.ScVal`.
 */
export function toSingleScVal(arg: any): xdr.ScVal {
  if (typeof arg === 'string') {
    if (arg.startsWith('C') || arg.startsWith('G')) {
      return new Address(arg).toScVal();
    }
    if (/^\d+$/.test(arg)) {
      return nativeToScVal(BigInt(arg), { type: 'i128' });
    }
    return nativeToScVal(arg, { type: 'string' });
  }
  if (typeof arg === 'number' || typeof arg === 'bigint') {
    return nativeToScVal(arg, { type: 'i128' });
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
 * {@link toSingleScVal}.
 *
 * @param args - Array of values to encode.
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
 * @param args             - JavaScript values to encode and pass as arguments.
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
