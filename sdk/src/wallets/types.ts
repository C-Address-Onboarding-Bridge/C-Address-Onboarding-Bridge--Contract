import type { Transaction, xdr } from '@stellar/stellar-sdk';

export interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAuthEntry(entry: xdr.SorobanAuthorizationEntry): Promise<xdr.SorobanAuthorizationEntry>;
}
