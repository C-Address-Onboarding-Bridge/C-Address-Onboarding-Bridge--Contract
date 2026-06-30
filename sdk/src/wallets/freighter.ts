import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter } from './types';

function freighterErr(error: unknown): Error {
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error((error as { message: string }).message);
  }
  return new Error(String(error));
}

export class FreighterWallet implements WalletAdapter {
  constructor(private readonly networkPassphrase: string) {}

  async getPublicKey(): Promise<string> {
    const { isConnected, getAddress, requestAccess } = await import('@stellar/freighter-api');
    const status = await isConnected();
    if (!status.isConnected) {
      throw new Error('Freighter extension is not installed. Install it from stellar.org/freighter.');
    }
    await requestAccess();
    const result = await getAddress();
    if (result.error) throw freighterErr(result.error);
    return result.address;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const { signTransaction } = await import('@stellar/freighter-api');
    const result = await signTransaction(tx.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    if (result.error) throw freighterErr(result.error);
    return TransactionBuilder.fromXDR(result.signedTxXdr, this.networkPassphrase) as Transaction;
  }

  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const { signAuthEntry } = await import('@stellar/freighter-api');
    const result = await signAuthEntry(entry.toXDR('base64'), {
      networkPassphrase: this.networkPassphrase,
    });
    if (result.error) throw freighterErr(result.error);
    if (!result.signedAuthEntry) throw new Error('Freighter returned no signed auth entry.');
    return xdr.SorobanAuthorizationEntry.fromXDR(result.signedAuthEntry, 'base64');
  }
}
