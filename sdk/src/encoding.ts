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
  StrKey,
} from '@stellar/stellar-sdk';

// Support muxed (M...) addresses in Address by extracting the underlying Ed25519 public key
const origIsValidEd25519 = StrKey.isValidEd25519PublicKey;
const origDecodeEd25519 = StrKey.decodeEd25519PublicKey;

StrKey.isValidEd25519PublicKey = function (addr: string): boolean {
  if (typeof addr === 'string' && StrKey.isValidMed25519PublicKey(addr)) {
    return true;
  }
  return origIsValidEd25519.call(this, addr);
};

StrKey.decodeEd25519PublicKey = function (addr: string): Buffer {
  if (typeof addr === 'string' && StrKey.isValidMed25519PublicKey(addr)) {
    return StrKey.decodeMed25519PublicKey(addr).subarray(0, 32);
  }
  return origDecodeEd25519.call(this, addr);
};

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
  /** Element type for composite types like vec or option. */
  elementType?: any;
}

/**
 * Convert a single JavaScript value to its Soroban `ScVal` representation.
 *
 * Encoding is explicit: when a {@link TypedArg} is supplied (or when options
 * are provided) the value is encoded with the declared ABI `type`; otherwise
 * `nativeToScVal`'s default inference is used. No type is ever guessed from
 * the string contents.
 *
 * @param arg - A JavaScript value, or a `{ value, type }` pair.
 * @param options - Optional ABI type information.
 * @returns The encoded `xdr.ScVal`.
 */
export function toSingleScVal(
  arg: any,
  options?: { type?: string; elementType?: any },
): xdr.ScVal {
  let value = arg;
  let type = options?.type;
  let elementType = options?.elementType;

  if (arg !== null && typeof arg === 'object' && 'value' in arg && !options) {
    const typed = arg as TypedArg;
    value = typed.value;
    type = typed.type;
    elementType = typed.elementType;
  }

  if (value === null || value === undefined) {
    return xdr.ScVal.scvVoid();
  }

  if (value instanceof Address) {
    return value.toScVal();
  }

  if (type === 'address') {
    if (typeof value === 'string') {
      return new Address(value).toScVal();
    }
    if (value instanceof Address) {
      return value.toScVal();
    }
  }

  if (type === 'bool') {
    const boolVal = typeof value === 'string' ? value === 'true' : Boolean(value);
    return nativeToScVal(boolVal, { type: 'bool' });
  }

  if (type === 'bytes') {
    const buf = typeof value === 'string' ? Buffer.from(value, 'hex') : value;
    return nativeToScVal(buf, { type: 'bytes' });
  }

  if (type === 'timepoint') {
    return xdr.ScVal.scvTimepoint(new xdr.Uint64(BigInt(value)));
  }

  if (type === 'duration') {
    return xdr.ScVal.scvDuration(new xdr.Uint64(BigInt(value)));
  }

  if (type === 'option') {
    if (value === null || value === undefined) {
      return xdr.ScVal.scvVoid();
    }
    if (elementType) {
      return toSingleScVal(value, elementType);
    }
    return toSingleScVal(value);
  }

  if (type === 'vec') {
    if (Array.isArray(value)) {
      return xdr.ScVal.scvVec(
        value.map((item) =>
          elementType ? toSingleScVal(item, elementType) : toSingleScVal(item),
        ),
      );
    }
  }

  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map((item) => toSingleScVal(item)));
  }

  return type ? nativeToScVal(value, { type }) : nativeToScVal(value);
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
