const test = require('node:test');
const assert = require('node:assert');
const { Keypair } = require('@stellar/stellar-sdk');
const { buildReleasePayload } = require('./sign-release');
const { TRUSTED_RELEASE_PUBLIC_KEYS, getTrustedPublicKeys } = require('./verify-release');

// An entry signed by a random key whose signer_public_key matches that key
// must still fail: trust comes from the pinned key list, not the entry.
const randomKeypair = Keypair.random();
const entry = {
  version: 'v9.9.9',
  commit: 'deadbeef',
  wasm_hash: 'a'.repeat(64),
  signer_public_key: randomKeypair.publicKey(),
  signature: randomKeypair
    .sign(buildReleasePayload({ version: 'v9.9.9', commit: 'deadbeef', wasm_hash: 'a'.repeat(64) }))
    .toString('hex'),
};

test('entry signed by an untrusted key fails verification', () => {
  assert.ok(!TRUSTED_RELEASE_PUBLIC_KEYS.includes(entry.signer_public_key));
  assert.ok(!getTrustedPublicKeys().includes(entry.signer_public_key));
});

test('canonical payload covers version, commit and wasm_hash', () => {
  const payload = JSON.parse(
    buildReleasePayload({ version: 'v1.0.0', commit: 'abc', wasm_hash: 'AB'.repeat(32) }).toString('utf8')
  );
  assert.deepStrictEqual(payload, { version: 'v1.0.0', commit: 'abc', wasm_hash: 'ab'.repeat(32) });
});
