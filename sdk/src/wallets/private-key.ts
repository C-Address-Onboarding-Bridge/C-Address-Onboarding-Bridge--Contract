import { Keypair, TransactionBuilder, xdr, hash } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter } from './types';

export class PrivateKeyWallet implements WalletAdapter {
  private readonly keypair: Keypair;

  constructor(
    secretKeyOrKeypair: string | Keypair,
    private readonly networkPassphrase: string,
  ) {
    this.keypair =
      typeof secretKeyOrKeypair === 'string'
        ? Keypair.fromSecret(secretKeyOrKeypair)
        : secretKeyOrKeypair;
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const cloned = TransactionBuilder.fromXDR(tx.toXDR(), this.networkPassphrase) as Transaction;
    cloned.sign(this.keypair);
    return cloned;
  }

  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<xdr.SorobanAuthorizationEntry> {
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

    const payload = hash(preimage.toXDR());
    const signature = this.keypair.sign(payload);

    credentials.signature(
      xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('public_key'),
            val: xdr.ScVal.scvBytes(Buffer.from(this.keypair.rawPublicKey())),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('signature'),
            val: xdr.ScVal.scvBytes(Buffer.from(signature)),
          }),
        ]),
      ]),
    );

    return cloned;
  }
}
