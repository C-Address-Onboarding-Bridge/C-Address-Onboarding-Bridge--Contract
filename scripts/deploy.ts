/**
 * deploy.ts — Environment-aware deployment script for the Onboarding Bridge contract.
 *
 * Usage:
 *   npx ts-node scripts/deploy.ts <command> [options]
 *
 * Commands:
 *   all          Deploy WASM, create contract instance, and initialize
 *   deploy       Deploy and create contract instance only (no init)
 *   init <id>    Initialize an already-deployed contract by its C-address
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
  BASE_FEE,
  nativeToScVal,
  Keypair,
  Address,
  Networks,
} from '@stellar/stellar-sdk';
import * as fs from 'fs';
import * as path from 'path';

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

// ---------------------------------------------------------------------------
// Deploy steps
// ---------------------------------------------------------------------------

async function deployContract(
  provider: SorobanRpc.Server,
  cfg: DeployConfig,
  admin: Keypair,
): Promise<string> {
  const wasm = fs.readFileSync(cfg.wasmPath);

  console.log('Installing WASM…');
  const installResp = await provider.installContractCode(wasm);
  const installTx = TransactionBuilder.fromXdr(installResp, cfg.networkPassphrase);
  installTx.sign(admin);
  const installSend = await provider.sendTransaction(installTx);
  console.log(`  Install tx: ${installSend.hash}`);
  await poll(provider, installSend.hash);
  console.log('  WASM installed ✓');

  console.log('Creating contract instance…');
  const createResp = await provider.createContract(wasm, admin.publicKey(), '0'.repeat(64));
  const createTx = TransactionBuilder.fromXdr(createResp, cfg.networkPassphrase);
  createTx.sign(admin);
  const createSend = await provider.sendTransaction(createTx);
  console.log(`  Create tx: ${createSend.hash}`);
  const createResult = await poll(provider, createSend.hash);

  if (!createResult.contractId) {
    throw new Error('Contract deployment succeeded but returned no contractId');
  }
  console.log(`  Contract ID: ${createResult.contractId} ✓`);
  return createResult.contractId;
}

async function initialize(
  provider: SorobanRpc.Server,
  cfg: DeployConfig,
  admin: Keypair,
  contractId: string,
): Promise<void> {
  console.log(`Initializing contract ${contractId}…`);
  const contract = new Contract(contractId);
  const account = await provider.getAccount(admin.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      contract.call(
        'initialize',
        Address.fromString(admin.publicKey()).toScVal(),
        Address.fromString(cfg.feeCollectorPublicKey).toScVal(),
        nativeToScVal(cfg.feeBps, { type: 'u32' }),
        nativeToScVal(null),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await provider.prepareTransaction(tx);
  prepared.sign(admin);
  const resp = await provider.sendTransaction(prepared);
  console.log(`  Init tx: ${resp.hash}`);
  await poll(provider, resp.hash);
  console.log('  Initialized successfully ✓');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Strip --network and its value from argv so we can parse positional args cleanly.
  const networkIdx = process.argv.indexOf('--network');
  const filteredArgv = process.argv.slice(2).filter((_, i, arr) => {
    if (arr[i - 1] === '--network') return false;
    if (arr[i] === '--network') return false;
    return true;
  });

  const [command, customId] = filteredArgv;
  const network = parseNetworkArg();
  const cfg = loadConfig(network);

  if (!cfg.adminSecretKey || cfg.adminSecretKey.startsWith('S...')) {
    console.error('adminSecretKey is not set in your deploy-config file. Aborting.');
    process.exit(1);
  }

  const admin = Keypair.fromSecret(cfg.adminSecretKey);
  const provider = new SorobanRpc.Server(cfg.rpcUrl, { allowHttp: cfg.network === 'dev' });

  console.log(`\n=== C-Address Onboarding Bridge Deployment ===`);
  console.log(`Network:  ${cfg.network}`);
  console.log(`RPC:      ${cfg.rpcUrl}`);
  console.log(`Admin:    ${admin.publicKey()}`);
  console.log(`FeeBps:   ${cfg.feeBps}\n`);

  if (command === 'deploy' || command === 'all') {
    const contractId = await deployContract(provider, cfg, admin);
    if (command === 'all') {
      await initialize(provider, cfg, admin, contractId);
      console.log(`\nDeployment complete. CONTRACT_ID=${contractId}`);
    } else {
      console.log(`\nDeploy complete. Run init with: npx ts-node scripts/deploy.ts init ${contractId} --network ${network}`);
    }
    return;
  }

  if (command === 'init') {
    if (!customId) {
      console.error('Usage: npx ts-node scripts/deploy.ts init <contract_id> [--network <network>]');
      process.exit(1);
    }
    await initialize(provider, cfg, admin, customId);
    return;
  }

  console.error(`Unknown command "${command}". Valid commands: all, deploy, init`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
