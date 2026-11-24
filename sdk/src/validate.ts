/**
 * @fileoverview Input-validation helpers for the C-Address Onboarding Bridge SDK.
 *
 * These functions throw descriptive errors early — before any RPC call is made —
 * so callers receive clear feedback rather than a cryptic Soroban error deep in
 * the transaction-submission flow.
 *
 * @module validate
 */

import { StrKey } from '@stellar/stellar-sdk';

/**
 * Assert that `address` is a valid Stellar G-address (Ed25519 public key,
 * starts with the letter `G`).
 *
 * Throws an {@link Error} with a descriptive message including `field` if
 * validation fails.
 *
 * @param address - The address string to validate.
 * @param field   - A human-readable field name used in the error message
 *                  (e.g. `'source'`, `'newAdmin'`).
 *
 * @throws {Error} When `address` is not a valid Ed25519 public key.
 *
 * @example
 * ```ts
 * assertAccountAddress('GABC...', 'source');   // passes silently
 * assertAccountAddress('CC...', 'source');      // throws
 * ```
 */
export function assertAccountAddress(address: string, field: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(
      `Invalid account address for "${field}": expected a G-address (ed25519 public key), got "${address}"`,
    );
  }
}

/**
 * Assert that `address` is a valid Stellar account or contract address.
 *
 * Throws a descriptive error when `address` is not a valid StrKey address.
 */
export function assertAddress(address: string, field: string): void {
  if (
    !StrKey.isValidEd25519PublicKey(address) &&
    !StrKey.isValidContract(address)
  ) {
    throw new Error(
      `Invalid address for "${field}": expected a G-address or C-address, got "${address}"`,
    );
  }
}

/**
 * Assert that `address` is a valid Stellar contract address (C-address,
 * starts with the letter `C`).
 *
 * Throws an {@link Error} with a descriptive message including `field` if
 * validation fails.
 *
 * @param address - The address string to validate.
 * @param field   - A human-readable field name used in the error message
 *                  (e.g. `'contractId'`, `'target'`, `'asset'`).
 *
 * @throws {Error} When `address` is not a valid Stellar contract address.
 *
 * @example
 * ```ts
 * assertContractAddress('CA...', 'contractId');  // passes silently
 * assertContractAddress('GABC...', 'target');    // throws
 * ```
 */
export function assertContractAddress(address: string, field: string): void {
  if (!StrKey.isValidContract(address)) {
    throw new Error(
      `Invalid contract address for "${field}": expected a C-address (contract), got "${address}"`,
    );
  }
}

/**
 * Assert that `pubkeyHex` is a valid 32-byte Ed25519 public key as a lowercase
 * hex string (64 hex characters).
 *
 * Throws an {@link Error} with a descriptive message including `field` if
 * validation fails.
 *
 * @param pubkeyHex - The hex-encoded public key to validate.
 * @param field     - A human-readable field name used in the error message
 *                    (e.g. `'pubkey'`).
 *
 * @throws {Error} When `pubkeyHex` is not a 64-character lowercase hex string.
 *
 * @example
 * ```ts
 * assertRelayerPubkey('00'.repeat(32), 'pubkey');   // passes silently
 * assertRelayerPubkey('short', 'pubkey');            // throws
 * assertRelayerPubkey('GG...invalid...', 'pubkey');  // throws
 * ```
 */
export function assertRelayerPubkey(pubkeyHex: string, field: string): void {
  if (typeof pubkeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(pubkeyHex)) {
    throw new Error(
      `Invalid relayer pubkey for "${field}": expected a 64-character lowercase hex string (32 bytes), got "${pubkeyHex}"`,
    );
  }
}

/**
 * Assert that a swap route contains exactly one pool.
 *
 * The bridge contract only supports single-hop swaps: `fund_c_address_with_swap`
 * returns `MultiHopNotSupported` (`Error(Contract, #43)`) for any route whose
 * length is not exactly 1. Checking here fails fast, before the caller signs
 * and pays for a transaction that cannot succeed.
 *
 * @param route - The `swapRoute` array passed to `fundCAddressWithSwap`.
 *
 * @throws {Error} When `route` does not contain exactly one entry.
 */
export function assertSingleHopSwapRoute(route: readonly string[]): void {
  if (!Array.isArray(route) || route.length !== 1) {
    const len = Array.isArray(route) ? route.length : 0;
    throw new Error(
      `swapRoute must contain exactly one whitelisted pool; the contract rejects any other length with MultiHopNotSupported (Error(Contract, #43)), got ${len}`,
    );
  }
}
