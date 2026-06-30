const { Keypair } = require('@stellar/stellar-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function main() {
  const version = process.env.VERSION || 'v0.0.0-dev';
  const commit = process.env.COMMIT_SHA || 'unknown';

  const wasmPath = path.join(__dirname, '../target/wasm32-unknown-unknown/release/onboarding_bridge.wasm');
  const registryDir = path.join(__dirname, '../registry');
  const registryPath = path.join(registryDir, 'releases.json');

  if (!fs.existsSync(wasmPath)) {
    console.error(`Error: WASM file not found at: ${wasmPath}`);
    console.error('Please run "cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown" first.');
    process.exit(1);
  }

  // Compute SHA-256 hash of the WASM file
  const wasmBytes = fs.readFileSync(wasmPath);
  const wasmHash = crypto.createHash('sha256').update(wasmBytes).digest();
  const wasmHashHex = wasmHash.toString('hex');

  console.log(`WASM Path: ${wasmPath}`);
  console.log(`Computed WASM SHA-256 Hash: ${wasmHashHex}`);

  // Load or generate signing key
  let keypair;
  let isTransient = false;

  if (process.env.RELEASE_SIGNING_KEY) {
    try {
      keypair = Keypair.fromSecret(process.env.RELEASE_SIGNING_KEY);
    } catch (err) {
      console.error(`Error parsing RELEASE_SIGNING_KEY: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.warn('WARNING: RELEASE_SIGNING_KEY is not set. Generating a transient keypair for testing/development.');
    keypair = Keypair.random();
    isTransient = true;
  }

  // Sign the raw 32-byte hash
  const signature = keypair.sign(wasmHash);
  const signatureHex = signature.toString('hex');
  const publicKey = keypair.publicKey();

  console.log(`Signed by Public Key: ${publicKey}`);
  console.log(`Signature (Hex):      ${signatureHex}`);

  // Update verification registry
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }

  let registry = [];
  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (e) {
      console.warn(`Could not parse existing registry at ${registryPath}. Starting a new one.`);
    }
  }

  const entryIndex = registry.findIndex((entry) => entry.version === version);
  const newEntry = {
    version,
    commit,
    wasm_hash: wasmHashHex,
    signature: signatureHex,
    signer_public_key: publicKey,
    timestamp: new Date().toISOString(),
    is_transient: isTransient ? true : undefined,
  };

  if (entryIndex >= 0) {
    registry[entryIndex] = newEntry;
  } else {
    registry.push(newEntry);
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log(`Successfully published release ${version} to registry: ${registryPath}`);

  // Also write a standalone verification metadata file for the release
  const releaseMetadataPath = path.join(registryDir, `onboarding_bridge-${version}-verification.json`);
  fs.writeFileSync(releaseMetadataPath, JSON.stringify(newEntry, null, 2) + '\n');
  console.log(`Saved standalone verification metadata: ${releaseMetadataPath}`);
}

main().catch((err) => {
  console.error('Fatal error in sign-release script:', err);
  process.exit(1);
});
