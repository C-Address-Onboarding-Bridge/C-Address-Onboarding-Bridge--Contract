/**
 * Standalone per-operator signer service.
 *
 * Holds exactly ONE relayer Ed25519 private key (from this process's own
 * `SIGNER_PRIVATE_KEY` env var) and exposes a single HTTP endpoint that signs
 * a payload hash with it. It never receives or stores any other signer's
 * key material.
 *
 * Run one of these per relayer operator, on infrastructure that operator
 * controls, and point the main relayer's `RELAYER_SIGNER_URLS` at each
 * instance's URL. See `adr/ADR-007-signer-key-isolation.md` for the trust
 * model this establishes and what is intentionally left as follow-up.
 *
 * This is deliberately minimal (stdlib + @stellar/stellar-sdk only, no TLS
 * termination, no auth). Deploy it behind mTLS or a private network — see the
 * ADR's "Remaining follow-up" section.
 */

import * as http from 'http';
import { Keypair } from '@stellar/stellar-sdk';

export interface SignRequestBody {
  /** Hex-encoded 32-byte payload hash to sign. */
  payloadHash: string;
}

export interface SignResponseBody {
  pubkey: string;
  signature: string;
}

/**
 * Sign a hex-encoded payload hash with the given raw Ed25519 seed (hex).
 * Exported for unit testing without spinning up an HTTP server.
 */
export function signHex(privateKeyHex: string, payloadHashHex: string): SignResponseBody {
  if (!/^[0-9a-fA-F]{64}$/.test(payloadHashHex)) {
    throw new Error('payloadHash must be a 32-byte hex string');
  }
  const seed = Buffer.from(privateKeyHex, 'hex');
  const keypair = Keypair.fromRawEd25519Seed(seed);
  const payloadHash = Buffer.from(payloadHashHex, 'hex');
  return {
    pubkey: keypair.rawPublicKey().toString('hex'),
    signature: keypair.sign(payloadHash).toString('hex'),
  };
}

/**
 * Start the signer HTTP server. `privateKeyHex` is held only in this
 * process's memory — it is never logged or echoed back in any response.
 */
export function startSignerService(privateKeyHex: string, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/sign') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Basic guard against unbounded request bodies.
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as SignRequestBody;
        const result = signHex(privateKeyHex, parsed.payloadHash);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(port, () => {
    console.log(`[signer-service] listening on :${port} (holds one signing key only)`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Self-tests (run with: npx ts-node relayer/signer-service.ts --self-test)
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function test_sign_hex_produces_verifiable_signature(): void {
  const crypto = require('crypto');
  const seed = '11'.repeat(32);
  const payloadHash = crypto.createHash('sha256').update('payload').digest('hex');

  const { pubkey, signature } = signHex(seed, payloadHash);

  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(pubkey, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  const isValid = crypto.verify(null, Buffer.from(payloadHash, 'hex'), publicKey, Buffer.from(signature, 'hex'));
  assert(isValid, 'signature returned by signHex must verify against its own pubkey');
}

export function test_sign_hex_rejects_malformed_payload_hash(): void {
  let threw = false;
  try {
    signHex('11'.repeat(32), 'not-hex');
  } catch {
    threw = true;
  }
  assert(threw, 'a malformed payloadHash must be rejected, not silently signed');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    test_sign_hex_produces_verifiable_signature();
    test_sign_hex_rejects_malformed_payload_hash();
    console.log('[signer-service] self-tests passed');
  } else {
    const privateKeyHex = process.env.SIGNER_PRIVATE_KEY;
    if (!privateKeyHex) {
      console.error('SIGNER_PRIVATE_KEY is required');
      process.exit(1);
    }
    const port = parseInt(process.env.SIGNER_PORT ?? '4000', 10);
    startSignerService(privateKeyHex, port);
  }
}
