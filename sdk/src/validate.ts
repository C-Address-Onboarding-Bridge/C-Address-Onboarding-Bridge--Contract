import { StrKey } from '@stellar/stellar-sdk';

export function assertAccountAddress(address: string, field: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(
      `Invalid account address for "${field}": expected a G-address (ed25519 public key), got "${address}"`,
    );
  }
}

export function assertContractAddress(address: string, field: string): void {
  if (!StrKey.isValidContract(address)) {
    throw new Error(
      `Invalid contract address for "${field}": expected a C-address (contract), got "${address}"`,
    );
  }
}
