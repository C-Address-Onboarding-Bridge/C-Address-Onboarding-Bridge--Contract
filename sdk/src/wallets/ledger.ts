import { TransactionBuilder, StrKey, xdr, hash } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter } from './types';

const DEFAULT_PATH = "44'/148'/0'";

export class LedgerWallet implements WalletAdapter {
  constructor(
    private readonly networkPassphrase: string,
    private readonly path: string = DEFAULT_PATH,
  ) {}

  private async openDevice() {
    const TransportWebUSB = (await import('@ledgerhq/hw-transport-webusb')).default;
    const Str = (await import('@ledgerhq/hw-app-str')).default;
    const transport = await TransportWebUSB.create();
    return { str: new Str(transport), transport };
  }

  async getPublicKey(): Promise<string> {
    const { str, transport } = await this.openDevice();
    try {
      const { rawPublicKey } = await str.getPublicKey(this.path, true);
      return StrKey.encodeEd25519PublicKey(rawPublicKey);
    } finally {
      await transport.close();
    }
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const { str, transport } = await this.openDevice();
    try {
      const publicKey = await this.getPublicKey();
      const { signature } = await str.signTransaction(this.path, tx.signatureBase());

      const cloned = TransactionBuilder.fromXDR(tx.toXDR(), this.networkPassphrase) as Transaction;
      const rawKey = StrKey.decodeEd25519PublicKey(publicKey);

      cloned.signatures.push(
        new xdr.DecoratedSignature({
          hint: rawKey.slice(-4),
          signature: Buffer.from(signature),
        }),
      );
      return cloned;
    } finally {
      await transport.close();
    }
  }

  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const { str, transport } = await this.openDevice();
    try {
      const publicKey = await this.getPublicKey();
      const cloned = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
      const credentials = cloned.credentials().address();

      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(this.networkPassphrase)),
          nonce: credentials.nonce(),
          signatureExpirationLedger: credentials.signatureExpirationLedger(),
          invocation: cloned.rootInvocation(),
        }),
      );

      // signSorobanAuthorization signs the HashIdPreimage XDR directly.
      const { signature } = await str.signSorobanAuthorization(this.path, preimage.toXDR());

      const rawKey = StrKey.decodeEd25519PublicKey(publicKey);
      credentials.signature(
        xdr.ScVal.scvVec([
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol('public_key'),
              val: xdr.ScVal.scvBytes(rawKey),
            }),
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol('signature'),
              val: xdr.ScVal.scvBytes(Buffer.from(signature)),
            }),
          ]),
        ]),
      );

      return cloned;
    } finally {
      await transport.close();
    }
  }
}
