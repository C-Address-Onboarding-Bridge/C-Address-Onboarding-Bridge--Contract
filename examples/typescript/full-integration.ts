/**
 * Full integration example - TypeScript
 *
 * Demonstrates every major SDK operation against the testnet:
 *   1. Setting up the SDK
 *   2. Deploying the contract (via deploy script)
 *   3. Initializing the contract
 *   4. Funding a C-address from a G-address
 *   5. Batch funding multiple C-addresses
 *   6. Withdrawing accumulated fees
 *   7. Generating off-ramp URLs (MoonPay, Transak)
 *   8. CEX deposit memo helpers
 *   9. Error handling patterns
 *
 * Prerequisites:
 *   - Node.js >= 18
 *   - A funded testnet G-address (get XLM from https://laboratory.stellar.org/#account-creator)
 *   - A deployed and initialized OnboardingBridge contract on testnet
 *     (run: npx ts-node scripts/deploy.ts all --network testnet)
 *
 * Usage:
 *   npx ts-node examples/typescript/full-integration.ts
 *
 * Environment variables (or edit the CONFIG block below):
 *   SOURCE_SECRET        - secret key of the source/admin account
 *   FEE_COLLECTOR_SECRET - secret key of the fee collector account
 *   CONTRACT_ID          - C-address of the deployed bridge contract
 *   USDC_ASSET           - C-address of the USDC token contract on testnet
 */

import {
  OnboardingBridgeSDK,
  OffRampIntegration,
  type TransactionResult,
} from '@stellar/c-address-onboarding-bridge-sdk';
import { Keypair, Networks, SorobanRpc } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Configuration - replace with real values or set environment variables
// ---------------------------------------------------------------------------
const CONFIG = {
  contractId:  process.env.CONTRACT_ID         ?? 'CA_REPLACE_WITH_CONTRACT_ID',
  rpcUrl:      'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  sourceSecret:      process.env.SOURCE_SECRET          ?? 'S_REPLACE_WITH_SOURCE_SECRET',
  feeCollectorSecret: process.env.FEE_COLLECTOR_SECRET  ?? 'S_REPLACE_WITH_FEE_COLLECTOR_SECRET',
  // A whitelisted token contract address on testnet (e.g. Stellar testnet USDC)
  usdcAsset:   process.env.USDC_ASSET          ?? 'CA_REPLACE_WITH_USDC_ASSET',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until a submitted transaction is confirmed or times out. */
async function waitForConfirmation(
  server: SorobanRpc.Server,
  hash: string,
  label: string,
): Promise<void> {
  process.stdout.write(`  Waiting for ${label} (${hash.slice(0, 8)}...`);
  for (let i = 0; i < 30; i++) {
    const tx = await server.getTransaction(hash);
    if (tx.status === 'SUCCESS') {
      console.log(' OK)');
      return;
    }
    if (tx.status === 'FAILED') {
      console.log(' FAILED)');
      throw new Error(`Transaction ${hash} failed`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for ${hash}`);
}

/** Assert a TransactionResult succeeded and wait for confirmation. */
async function submitAndConfirm(
  server: SorobanRpc.Server,
  result: TransactionResult,
  label: string,
): Promise<void> {
  if (result.status === 'failed') {
    throw new Error(`${label} submission failed: ${result.error ?? 'unknown error'}`);
  }
  await waitForConfirmation(server, result.hash, label);
}

/**
 * Assert every TransactionResult in a batch succeeded and wait for confirmation
 * on each submitted transaction.
 *
 * `batchFundCAddresses` auto-splits large batches across multiple transactions
 * (one per chunk) and returns one `TransactionResult` per submitted
 * transaction, so a single `submitAndConfirm(result)` is not sufficient.
 */
async function submitBatchAndConfirm(
  server: SorobanRpc.Server,
  results: TransactionResult[],
  label: string,
): Promise<void> {
  if (results.length === 0) {
    throw new Error(`${label} returned no transactions`);
  }
  for (let i = 0; i < results.length; i++) {
    await submitAndConfirm(server, results[i], `${label}[${i + 1}/${results.length}]`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== C-Address Onboarding Bridge - TypeScript Integration Example ===\n');

  const sourceKeypair       = Keypair.fromSecret(CONFIG.sourceSecret);
  const feeCollectorKeypair = Keypair.fromSecret(CONFIG.feeCollectorSecret);
  const server              = new SorobanRpc.Server(CONFIG.rpcUrl);

  // -------------------------------------------------------------------------
  // 1. Set up the SDK
  // -------------------------------------------------------------------------
  console.log('1. Setting up SDK...');
  const sdk = new OnboardingBridgeSDK({
    contractId:        CONFIG.contractId,
    rpcUrl:            CONFIG.rpcUrl,
    networkPassphrase: CONFIG.networkPassphrase,
    retry: { maxRetries: 3 },
  });
  console.log(`   Contract: ${CONFIG.contractId}`);
  console.log(`   Source:   ${sourceKeypair.publicKey()}\n`);

  // -------------------------------------------------------------------------
  // 2. Verify contract is initialized
  // -------------------------------------------------------------------------
  console.log('2. Verifying contract state...');
  const initialized = await sdk.isInitialized();
  if (!initialized) {
    throw new Error(
      'Contract is not initialized. Run: npx ts-node scripts/deploy.ts all --network testnet',
    );
  }
  const feeBps       = await sdk.getFee();
  const admin        = await sdk.getAdmin();
  const feeCollector = await sdk.getFeeCollector();
  console.log(`   Initialized: OK`);
  console.log(`   Fee:         ${feeBps} bps (${feeBps / 100}%)`);
  console.log(`   Admin:       ${admin}`);
  console.log(`   FeeCollector: ${feeCollector}\n`);

  // -------------------------------------------------------------------------
  // 3. Fund a single C-address
  // -------------------------------------------------------------------------
  console.log('3. Funding a single C-address...');
  // In a real scenario this would be a deployed smart account C-address.
  // For this example we derive a deterministic placeholder from a known seed.
  const TARGET_C_ADDRESS = CONFIG.contractId; // reuse contract address as a demo target

  const amount = '1000000'; // 0.1 USDC (7 decimal places)
  const fundResult = await sdk.fundCAddress(
    {
      source: sourceKeypair.publicKey(),
      target: TARGET_C_ADDRESS,
      asset:  CONFIG.usdcAsset,
      amount,
    },
    sourceKeypair,
  );

  await submitAndConfirm(server, fundResult, 'fundCAddress');

  const balance = await sdk.getCAddressBalance(TARGET_C_ADDRESS, CONFIG.usdcAsset);
  console.log(`   Target balance after fund: ${balance}\n`);

  // -------------------------------------------------------------------------
  // 4. Batch fund multiple C-addresses
  // -------------------------------------------------------------------------
  console.log('4. Batch funding multiple C-addresses...');
  // Using the same target three times as a demonstration.
  const batchResults = await sdk.batchFundCAddresses(
    {
      source:  sourceKeypair.publicKey(),
      targets: [TARGET_C_ADDRESS, TARGET_C_ADDRESS, TARGET_C_ADDRESS],
      amounts: ['500000', '300000', '200000'],
      asset:   CONFIG.usdcAsset,
    },
    sourceKeypair,
  );

  // batchFundCAddresses returns one TransactionResult per chunk.
  await submitBatchAndConfirm(server, batchResults, 'batchFundCAddresses');
  console.log(`   Batch fund complete (${batchResults.length} transaction(s)) OK\n`);

  // -------------------------------------------------------------------------
  // 5. Withdraw accumulated fees
  // -------------------------------------------------------------------------
  console.log('5. Withdrawing accumulated fees...');
  const feeBalance = await sdk.getFeeBalance(CONFIG.usdcAsset);
  console.log(`   Accrued fees: ${feeBalance}`);

  if (BigInt(feeBalance) > 0n) {
    const withdrawResult = await sdk.withdrawFees(
      { asset: CONFIG.usdcAsset, amount: feeBalance },
      feeCollectorKeypair,
    );
    await submitAndConfirm(server, withdrawResult, 'withdrawFees');
    console.log('   Fees withdrawn OK');
  } else {
    console.log('   No fees to withdraw.');
  }
  console.log();

  // -------------------------------------------------------------------------
  // 6. Off-ramp integrations - URL generation (no network calls)
  // -------------------------------------------------------------------------
  console.log('6. Generating off-ramp / on-ramp URLs...');

  const offramp = new OffRampIntegration({
    moonpayApiKey: process.env.MOONPAY_KEY ?? 'pk_test_demo',
    transakApiKey: process.env.TRANSAK_KEY ?? 'demo-key',
    testMode: true, // sandbox URLs
  });

  // MoonPay on-ramp: user pays $50 USD, receives XLM at their C-address
  const moonpayUrl = offramp.getOnRampUrl({
    provider:     'moonpay',
    amount:       '50',
    fiatCurrency: 'USD',
    asset:        'XLM',
    cAddress:     TARGET_C_ADDRESS,
  });
  console.log('   MoonPay on-ramp URL:');
  console.log(`     ${moonpayUrl}\n`);

  // Transak on-ramp: user pays 100 EUR, receives USDC at their C-address
  const transakUrl = offramp.getOnRampUrl({
    provider:     'transak',
    amount:       '100',
    fiatCurrency: 'EUR',
    asset:        'USDC',
    cAddress:     TARGET_C_ADDRESS,
  });
  console.log('   Transak on-ramp URL:');
  console.log(`     ${transakUrl}\n`);

  // Provider comparison for $100 USD -> XLM
  const comparison = offramp.compareProviders('100', 'XLM', 'USD');
  console.log('   Provider fee comparison for $100 -> XLM:');
  for (const [provider, info] of Object.entries(comparison)) {
    console.log(`     ${provider}: fee=$${info.feeAmount} net=$${info.netAmount} (~${info.settlementTime}h)`);
  }
  console.log();

  // -------------------------------------------------------------------------
  // 7. CEX deposit memo helpers
  // -------------------------------------------------------------------------
  console.log('7. CEX deposit memo helpers...');
  const memo = offramp.generateCEXDepositMemo(TARGET_C_ADDRESS);
  console.log(`   Generated memo: "${memo}"`);

  const decoded = offramp.decodeCEXDepositMemo(memo);
  console.log(`   Decoded target: ${decoded}`);

  const invalid = offramp.decodeCEXDepositMemo('some-other-memo');
  console.log(`   Invalid memo decode: ${invalid}\n`); // null

  // -------------------------------------------------------------------------
  // 8. Error handling patterns
  // -------------------------------------------------------------------------
  console.log('8. Demonstrating error handling...');

  // Mutating methods never throw - check status
  const badResult = await sdk.fundCAddress(
    {
      source: sourceKeypair.publicKey(),
      target: TARGET_C_ADDRESS,
      asset:  CONFIG.usdcAsset,
      amount: '0', // zero amount -> contract returns InvalidAmount
    },
    sourceKeypair,
  );

  if (badResult.status === 'failed') {
    console.log(`   Expected failure caught: ${badResult.error}`);
  }

  // Read-only methods throw on error - use try/catch
  try {
    await sdk.getCAddressBalance('INVALID_ADDRESS', CONFIG.usdcAsset);
  } catch (err: any) {
    console.log(`   Validation error caught: ${err.message}`);
  }

  console.log('\n=== Example complete ===');
}

main().catch((err) => {
  console.error('\nFatal error:', err.message ?? err);
  process.exit(1);
});
