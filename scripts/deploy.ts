import {
  SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Keypair,
  Address,
} from '@stellar/stellar-sdk';
import * as fs from 'fs';
import * as path from 'path';

interface DeployConfig {
  rpcUrl: string;
  networkPassphrase: string;
  adminSecretKey: string;
  feeCollectorPublicKey: string;
  feeBps: number;
  wasmPath: string;
}

function loadConfig(): DeployConfig {
  const configPath = path.resolve(process.cwd(), 'deploy-config.json');
  if (!fs.existsSync(configPath)) {
    const template: DeployConfig = {
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      adminSecretKey: 'S...SECRET_KEY',
      feeCollectorPublicKey: 'G...FEE_COLLECTOR',
      feeBps: 50,
      wasmPath: './target/wasm32-unknown-unknown/release/onboarding_bridge.wasm',
    };
    fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
    console.log(`Created template at ${configPath}. Edit it and re-run.`);
    process.exit(0);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(
  provider: SorobanRpc.Server,
  hash: string,
  retries = 15,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  for (let i = 0; i < retries; i++) {
    const r = await provider.getTransaction(hash);
    if (r.status !== 'NOT_FOUND') return r;
    await sleep(2000);
  }
  throw new Error(`Tx ${hash} not confirmed`);
}

async function main() {
  const [command, customId] = process.argv.slice(2);
  const cfg = loadConfig();
  const provider = new SorobanRpc.Server(cfg.rpcUrl, { allowHttp: true });
  const admin = Keypair.fromSecret(cfg.adminSecretKey);
  const adminPub = admin.publicKey();

  console.log(`Admin: ${adminPub}`);
  console.log(`Network: ${cfg.networkPassphrase}`);

  if (command === 'deploy' || command === 'all') {
    const wasm = fs.readFileSync(cfg.wasmPath);
    console.log('Installing WASM...');
    const installResp = await provider.installContractCode(wasm);
    const installTx = TransactionBuilder.fromXdr(installResp, cfg.networkPassphrase);
    installTx.sign(admin);
    const installSend = await provider.sendTransaction(installTx);
    console.log(`Install tx: ${installSend.hash}`);
    await poll(provider, installSend.hash);

    console.log('Creating contract...');
    const createResp = await provider.createContract(
      wasm,
      adminPub,
      '0'.repeat(64),
    );
    const createTx = TransactionBuilder.fromXdr(createResp, cfg.networkPassphrase);
    createTx.sign(admin);
    const createSend = await provider.sendTransaction(createTx);
    console.log(`Create tx: ${createSend.hash}`);
    const createResult = await poll(provider, createSend.hash);

    if (!createResult.contractId) {
      throw new Error('No contractId returned');
    }
    console.log(`Contract ID: ${createResult.contractId}`);

    if (command === 'all') {
      await initialize(provider, cfg, admin, createResult.contractId);
    }
  }

  if (command === 'init') {
    if (!customId) {
      console.error('Usage: npx ts-node scripts/deploy.ts init <contract_id>');
      process.exit(1);
    }
    await initialize(provider, cfg, admin, customId);
  }
}

async function initialize(
  provider: SorobanRpc.Server,
  cfg: DeployConfig,
  admin: Keypair,
  contractId: string,
) {
  console.log(`Initializing ${contractId}...`);
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
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await provider.prepareTransaction(tx);
  prepared.sign(admin);
  const resp = await provider.sendTransaction(prepared);
  console.log(`Init tx: ${resp.hash}`);
  await poll(provider, resp.hash);
  console.log('Initialized successfully');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
