const { Address, rpc, xdr, Keypair } = require('@stellar/stellar-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index > -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function printUsage() {
  console.log(`
Usage: node scripts/verify-release.js [options]

Options:
  -c, --contract <CONTRACT_ID>    Verify a deployed on-chain contract
  -w, --wasm <WASM_PATH>          Verify a local compiled WASM file
  -n, --network <network>         Stellar network: 'testnet', 'public', 'standalone' (default: 'testnet')
  --rpc-url <URL>                 Custom Soroban RPC URL
  -k, --public-key <PUB_KEY>      Override/specify the expected release signer public key
  -h, --help                      Show this help message
  `);
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h') || process.argv.length === 2) {
    printUsage();
    process.exit(0);
  }

  const contractId = getArgValue('--contract') || getArgValue('-c');
  const wasmPath = getArgValue('--wasm') || getArgValue('-w');
  const network = getArgValue('--network') || getArgValue('-n') || 'testnet';
  const rpcUrlOverride = getArgValue('--rpc-url');
  const expectedPublicKey = getArgValue('--public-key') || getArgValue('-k');

  const registryPath = path.join(__dirname, '../registry/releases.json');
  if (!fs.existsSync(registryPath)) {
    console.error(`Error: Verification registry not found at ${registryPath}`);
    process.exit(1);
  }

  let registry = [];
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    console.error(`Error parsing registry: ${err.message}`);
    process.exit(1);
  }

  let hashToVerify = '';
  let sourceDescription = '';

  if (contractId) {
    // 1. Verify an on-chain contract
    let rpcUrl = '';
    if (rpcUrlOverride) {
      rpcUrl = rpcUrlOverride;
    } else if (network === 'public' || network === 'mainnet') {
      rpcUrl = 'https://soroban-rpc.stellar.org';
    } else if (network === 'testnet') {
      rpcUrl = 'https://soroban-testnet.stellar.org';
    } else if (network === 'standalone' || network === 'local') {
      rpcUrl = 'http://localhost:8000/soroban/rpc';
    } else {
      console.error(`Error: Unknown network '${network}'. Please specify --rpc-url.`);
      process.exit(1);
    }

    console.log(`Connecting to Soroban RPC: ${rpcUrl}`);
    console.log(`Fetching ledger entry for contract: ${contractId}`);

    const server = new rpc.Server(rpcUrl);
    try {
      const contractAddress = Address.fromString(contractId);
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddress.toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        })
      );

      const response = await server.getLedgerEntries([ledgerKey]);
      if (!response.entries || response.entries.length === 0) {
        console.error(`Error: Contract ${contractId} not found on-chain.`);
        process.exit(1);
      }

      const entry = response.entries[0];
      const ledgerEntry = xdr.LedgerEntry.fromXDR(entry.xdr, 'base64');
      const contractData = ledgerEntry.data().contractData();
      const instanceVal = contractData.val();

      if (instanceVal.arm() !== 'instance') {
        console.error('Error: Ledger entry is not a contract instance.');
        process.exit(1);
      }

      const instance = instanceVal.instance();
      const executable = instance.executable();

      if (executable.arm() !== 'wasm') {
        console.error(`Error: Contract executable is not WASM (type: ${executable.arm()}).`);
        process.exit(1);
      }

      const wasmHashBuffer = executable.wasmId();
      hashToVerify = wasmHashBuffer.toString('hex');
      sourceDescription = `On-chain contract (${contractId} on ${network})`;
    } catch (err) {
      console.error(`Error fetching contract from blockchain: ${err.message}`);
      process.exit(1);
    }
  } else if (wasmPath) {
    // 2. Verify a local WASM file
    if (!fs.existsSync(wasmPath)) {
      console.error(`Error: Local WASM file not found at ${wasmPath}`);
      process.exit(1);
    }
    const wasmBytes = fs.readFileSync(wasmPath);
    const wasmHash = crypto.createHash('sha256').update(wasmBytes).digest();
    hashToVerify = wasmHash.toString('hex');
    sourceDescription = `Local WASM file (${wasmPath})`;
  } else {
    console.error('Error: You must specify either --contract or --wasm to verify.');
    printUsage();
    process.exit(1);
  }

  console.log(`\n==============================================`);
  console.log(`Verification Source: ${sourceDescription}`);
  console.log(`SHA-256 WASM Hash:   ${hashToVerify}`);
  console.log(`==============================================\n`);

  // Search for the hash in the registry
  const registryEntry = registry.find((entry) => entry.wasm_hash === hashToVerify);

  if (!registryEntry) {
    console.log(`❌ VERIFICATION FAILED: The WASM hash is NOT present in the registry.`);
    console.log(`This means the contract code does not match any official, audited release.`);
    process.exit(1);
  }

  console.log(`✓ Hash found in registry!`);
  console.log(`  Release Version: ${registryEntry.version}`);
  console.log(`  Commit SHA:      ${registryEntry.commit}`);
  console.log(`  Timestamp:       ${registryEntry.timestamp}`);

  // Verify the signature
  const signerPubKey = expectedPublicKey || registryEntry.signer_public_key;
  if (expectedPublicKey && expectedPublicKey !== registryEntry.signer_public_key) {
    console.warn(`WARNING: Overriding registry signer public key with user-supplied key: ${expectedPublicKey}`);
  }

  try {
    const keypair = Keypair.fromPublicKey(signerPubKey);
    const hashBuffer = Buffer.from(hashToVerify, 'hex');
    const signatureBuffer = Buffer.from(registryEntry.signature, 'hex');

    const isSignatureValid = keypair.verify(hashBuffer, signatureBuffer);

    if (isSignatureValid) {
      console.log(`✓ Cryptographic signature is VALID!`);
      console.log(`  Signed by: ${signerPubKey}`);
      if (registryEntry.is_transient) {
        console.log(`\n⚠️ NOTE: This release was signed with a transient development key.`);
      } else {
        console.log(`\n🎉 SUCCESS: The contract is VERIFIED against audited release ${registryEntry.version}!`);
      }
    } else {
      console.log(`\n❌ SIGNATURE VERIFICATION FAILED!`);
      console.log(`The signature in the registry does not match the public key: ${signerPubKey}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error verifying signature: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
