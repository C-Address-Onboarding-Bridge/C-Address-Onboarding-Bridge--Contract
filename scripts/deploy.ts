/**
 * deploy.ts — Environment-aware deployment script for the Onboarding Bridge contract.
 *
 * Usage:
 *   npx ts-node scripts/deploy.ts <command> [options]
 *
 * Commands:
 *   all          Deploy WASM, create contract instance, and initialize
 *   deploy       Deploy and initialize atomically
 *   init <id>    Initialize a legacy uninitialized contract by its C-address
 *
 * Options:
 *   --network <mainnet|testnet|dev>   Select deployment environment (default: testnet)
 *
 * Config files (checked in order, first found wins):
 *   deploy-config.<network>.json     e.g. deploy-config.testnet.json
 *   deploy-config.json               fallback / legacy name
 *
 * Each config file must contain a DeployConfig object (see interface below).
 * The script will generate a template if no config file is found.
 */

import {
  SorobanRpc,
  Contract,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  nativeToScVal,
  Keypair,
  Address,
  Networks,
  xdr,
} from '@stellar/stellar-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported deployment environments. */
export type NetworkName = 'mainnet' | 'testnet' | 'dev';

/** Per-environment deployment configuration. */
export interface DeployConfig {
  /** Target network — governs defaults for rpcUrl and networkPassphrase. */
  network: NetworkName;
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase (must match the RPC node). */
  networkPassphrase: string;
  /** Secret key of the admin account used to deploy and initialize. */
  adminSecretKey: string;
  /** Public key that will be set as fee collector on initialization. */
  feeCollectorPublicKey: string;
  /** Initial fee in basis points (0–1000). 50 = 0.5%. */
  feeBps: number;
  /** Path to the compiled WASM artifact. */
  wasmPath: string;
}

// ---------------------------------------------------------------------------
// Defaults per network
// ---------------------------------------------------------------------------

const NETWORK_DEFAULTS: Record<NetworkName, Pick<DeployConfig, 'rpcUrl' | 'networkPassphrase'>> = {
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: Networks.PUBLIC,
  },
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  dev: {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: Networks.STANDALONE,
  },
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Parse the --network flag from argv.  Defaults to 'testnet'.
 */
function parseNetworkArg(): NetworkName {
  const idx = process.argv.indexOf('--network');
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = process.argv[idx + 1] as NetworkName;
    if (!['mainnet', 'testnet', 'dev'].includes(n)) {
      console.error(`Unknown network "${n}". Valid options: mainnet, testnet, dev`);
      process.exit(1);
    }
    return n;
  }
  return 'testnet';
}

/**
 * Load and return the DeployConfig for the given network.
 *
 * Lookup order:
 *   1. deploy-config.<network>.json  (preferred)
 *   2. deploy-config.json            (legacy fallback)
 *
 * If neither exists a template is written and the process exits so the user
 * can fill in real values before re-running.
 */
function loadConfig(network: NetworkName): DeployConfig {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, `deploy-config.${network}.json`),
    path.resolve(cwd, 'deploy-config.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Partial<DeployConfig>;
      // Back-fill network-specific defaults for any omitted fields.
      const defaults = NETWORK_DEFAULTS[network];
      return {
        network,
        rpcUrl: raw.rpcUrl ?? defaults.rpcUrl,
        networkPassphrase: raw.networkPassphrase ?? defaults.networkPassphrase,
        adminSecretKey: raw.adminSecretKey ?? '',
        feeCollectorPublicKey: raw.feeCollectorPublicKey ?? '',
        feeBps: raw.feeBps ?? 50,
        wasmPath: raw.wasmPath ?? './target/wasm32-unknown-unknown/release/onboarding_bridge.wasm',
      };
    }
  }

  // Neither file found — write a template and exit.
  const templatePath = path.resolve(cwd, `deploy-config.${network}.json`);
  const defaults = NETWORK_DEFAULTS[network];
  const template: DeployConfig = {
    network,
    rpcUrl: defaults.rpcUrl,
    networkPassphrase: defaults.networkPassphrase,
    adminSecretKey: 'S...YOUR_ADMIN_SECRET_KEY',
    feeCollectorPublicKey: 'G...YOUR_FEE_COLLECTOR_PUBLIC_KEY',
    feeBps: 50,
    wasmPath: './target/wasm32-unknown-unknown/release/onboarding_bridge.wasm',
  };
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
  console.log(`No config found. Created template at ${templatePath}`);
  console.log('Edit it with real values and re-run.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(
  provider: SorobanRpc.Server,
  hash: string,
  retries = 20,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  for (let i = 0; i < retries; i++) {
    const r = await provider.getTransaction(hash);
    if (r.status !== 'NOT_FOUND') return r;
    await sleep(2000);
  }
  throw new Error(`Transaction ${hash} was not confirmed after ${retries * 2}s`);
}

/**
 * Build, prepare, sign, and submit a transaction, then poll until confirmed.
 * Returns the confirmed transaction response.
 */
async function submitAndConfirm(
  provider: SorobanRpc.Server,
  cfg: DeployConfig,
  admin: Keypair,
  build: (account: SorobanRpc.Api.AccountResponse) => ReturnType<TransactionBuilder['build']>,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  const account = await provider.getAccount(admin.publicKey());
  const tx = build(account);
  const prepared = await provider.prepareTransaction(tx);
  prepared.sign(admin);
  const send = await provider.sendTransaction(prepared);
  console.log(`  Tx: ${send.hash}`);
  const result = await poll(provider, send.hash);
  if (result.status === 'FAILED') {
    throw new Error(`Transaction ${send.hash} failed: ${JSON.stringify(result)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deploy steps
// ---------------------------------------------------------------------------

async function deployContract(
  provider: SorobanRpc.Server,
  cfg: DeployConfig,
  admin: Keypair,
  wasmHash: Buffer,
): Promise<string> {
  const wasm = fs.readFileSync(cfg.wasmPath);

  console.log('Installing WASM…');
  const installResult = await submitAndConfirm(provider, cfg, admin, (account) =>
    new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(30)
      .build(),
  );
  console.log('  WASM installed ✓');

  console.log('Creating contract instance…');
  const salt = randomBytes(32);
  const constructorArgs = [
    Address.fromString(admin.publicKey()).toScVal(),
    Address.fromString(cfg.feeCollectorPublicKey).toScVal(),
    nativeToScVal(cfg.feeBps, { type: 'u32' }),
    nativeToScVal(null),
    nativeToScVal(wasmHash, { type: 'bytes' }),
  ];
  const createResult = await submitAndConfirm(provider, cfg, admin, (account) =>
    new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(
        Operation.createCustomContract({
          address: Address.fromString(admin.publicKey()),
          wasmHash,
          salt,
          constructorArgs,
        }),
      )
      .setTimeout(30)
      .build(),
  );

  const contractId = extractContractId(createResult);
  if (!contractId) {
    throw new Error('Contract deployment succeeded but returned no contractId');
  }
  console.log(`  Contract ID: ${contractId} ✓`);
  return contractId;
}

/**
 * Extract the created contract ID from a createCustomContract result.
 * The contract address is returned as the operation's return value.
 */
function extractContractId(result: SorobanRpc.Api.GetTransactionResponse): string | undefined {
  if (result.status !== 'SUCCESS') return undefined;
  const meta = result.resultMetaXdr;
  if (!meta) return undefined;
  const txMeta = xdr.TransactionMeta.fromXDR(meta, 'base64');
  const sorobanMeta = txMeta.v3().sorobanMeta();
  if (!sorobanMeta) return undefined;
  const returnValue = sorobanMeta.returnValue();
  if (!returnValue) return undefined;
  return Address.fromScVal(returnValue).toString();
}

async function initialize(
  provider: SorobanRpc.Server,
  cfg: DeployConfig,
  admin: Keypair,
  contractId: string,
  wasmHash: Buffer,
): Promise<void> {
  console.log(`Initializing contract ${contractId}…`);
  const contract = new Contract(contractId);
  const account = await provider.getAccount(admin.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    net

/* … truncated 2866 chars — edit only what you need near the top … */
