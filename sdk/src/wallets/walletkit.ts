import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter } from './types';

export interface StellarWalletsKitLike {
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdrBase64: string,
    opts?: { networkPassphrase?: string },
  ): Promise<{ signedTxXdr: string }>;
  signAuthEntry(
    entryXdr: string,
    opts?: { networkPassphrase?: string },
  ): Promise<{ signedAuthEntry: string }>;
}

export class WalletKitWallet implements WalletAdapter {
  constructor(
    private readonly kit: StellarWalletsKitLike,
    private readonly networkPassphrase: string,
  ) {}

  async getPublicKey(): Promise<string> {
    const { address } = await this.kit.getAddress();
    return address;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const { signedTxXdr } = await this.kit.signTransaction(tx.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    return TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;
  }

  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const { signedAuthEntry } = await this.kit.signAuthEntry(entry.toXDR('base64'), {
      networkPassphrase: this.networkPassphrase,
    });
    return xdr.SorobanAuthorizationEntry.fromXDR(signedAuthEntry, 'base64');
  }
}

export async function createWalletKitWallet(
  networkPassphrase: string,
): Promise<WalletKitWallet> {
  const {
    StellarWalletsKit,
    WalletNetwork,
    FREIGHTER_ID,
    FreighterModule,
    xBullModule,
    LobstrModule,
    AlbedoModule,
  } = await import('@creit.tech/stellar-wallets-kit');

  const isMainnet =
    (networkPassphrase as string) === 'Public Global Stellar Network ; September 2015';
  const network = isMainnet ? WalletNetwork.PUBLIC : WalletNetwork.TESTNET;

  const kit = new StellarWalletsKit({
    network,
    selectedWalletId: FREIGHTER_ID,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new LobstrModule(),
      new AlbedoModule(),
    ],
  });

  return new WalletKitWallet(kit as unknown as StellarWalletsKitLike, networkPassphrase);
}
