/**
 * Full integration example - JavaScript (CommonJS)
 *
 * Same flow as the TypeScript version but usable without a build step.
 * Requires the SDK to be built first: cd sdk && npm run build
 *
 * Usage:
 *   node examples/javascript/full-integration.js
 *
 * Environment variables:
 *   SOURCE_SECRET        - secret key of the source/admin account
 *   FEE_COLLECTOR_SECRET - secret key of the fee collector account
 *   CONTRACT_ID          - C-address of the deployed bridge contract
 *   USDC_ASSET           - C-address of the USDC token contract on testnet
 */

'use strict';

const {
  OnboardingBridgeSDK,
  OffRampIntegration,
} = require('@stellar/c-address-onboarding-bridge-sdk');
const { Keypair, Networks, SorobanRpc } = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  contractId:         process.env.CONTRACT_ID          || 'CA_REPLACE_WITH_CONTRACT_ID',
  rpcUrl:             'https://soroban-testnet.stellar.org',
  networkPassphrase:  Networks.TESTNET,
  sourceSecret:       process.env.SOURCE_SECRET         || 'S_REPLACE_WITH_SOURCE_SECRET',
  feeCollectorSecret: process.env.FEE_COLLECTOR_SECRET  || 'S_REPLACE_WITH_FEE_COLLECTOR_SECRET',
  usdcAsset:          process.env.USDC_ASSET            || 'CA_REPLACE_WITH_USDC_ASSET',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForConfirmation(server, hash, label) {
  process.stdout.write(`  Waiting for ${label} (${hash.slice(0, 8)}...`);
  for (let i = 0; i < 30; i++) {
    const tx = await server.getTransaction(hash);
    if (tx.status === 'SUCCESS') { console.log(' OK)'); return; }
    if (tx.status === 'FAILED')  { console.log(' FAILED)'); throw new Error(`Transaction ${hash} failed`); }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for ${hash}`);
}

async function submitAndConfirm(server, result, label) {
  if (result.status === 'failed') {
    throw new Error(`${label} submission failed: ${result.error || 'unknown error'}`);
  }
  await waitForConfirmation(server, result.hash, label);
}

/**
 * Assert every TransactionResult in a batch succeeded and wait for
 * confirmation on each submitted transaction.
 *
 * `batchFundCAddresses` auto-splits large batches across multiple transactions
 * (one per chunk) and returns one TransactionResult per submitted transaction,
 * so a single `submitAndConfirm(result)` is not sufficient.
 */
async function submitBatchAndConfirm(server, results, label) {
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

async function main() {
  console.log('=== C-Address Onboarding Bridge - JavaScript Integration Example ===\n');

  const sourceKeypair       = Keypair.fromSecret(CONFIG.sourceSecret);
  const feeCollectorKeypair = Keypair.fromSecret(CONFIG.feeCollectorSecret);
  const server              = new SorobanRpc.Server(CONFIG.rpcUrl);

  // 1. Set up SDK
  console.log('1. Setting up SDK...');
  const sdk = new OnboardingBridgeSDK({
    contractId:        CONFIG.contractId,
    rpcUrl:            CONFIG.rpcUrl,
    networkPassphrase: CONFIG.networkPassphrase,
    retry: { maxRetries: 3 },
  });
  console.log(`   Source: ${sourceKeypair.publicKey()}\n`);

  // 2. Verify contract state
  console.log('2. Verifying contract state...');
  const initialized = await sdk.isInitialized();
  if (!initialized) {
    throw new Error('Contract not initialized. Run: npx ts-node scripts/deploy.ts all --network testnet');
  }
  const feeBps = await sdk.getFee();
  console.log(`   Fee: ${feeBps} bps (${feeBps / 100}%)\n`);

  // 3. Fund a single C-address
  console.log('3. Funding a single C-address...');
  const TARGET = CONFIG.contractId; // demo: use contract address as target
  const fundResult = await sdk.fundCAddress(
    {
      source: sourceKeypair.publicKey(),
      target: TARGET,
      asset:  CONFIG.usdcAsset,
      amount: '1000000',
    },
    sourceKeypair,
  );
  await submitAndConfirm(server, fundResult, 'fundCAddress');

  const balance = await sdk.getCAddressBalance(TARGET, CONFIG.usdcAsset);
  console.log(`   Target balance: ${balance}\n`);

  // 4. Batch fund
  console.log('4. Batch funding...');
  const batchResults = await sdk.batchFundCAddresses(
    {
      source:  sourceKeypair.publicKey(),
      targets: [TARGET, TARGET],
      amounts: ['400000', '600000'],
      asset:   CONFIG.usdcAsset,
    },
    sourceKeypair,
  );
  // batchFundCAddresses returns one TransactionResult per chunk.
  await submitBatchAndConfirm(server, batchResults, 'batchFundCAddresses');
  console.log(`   Batch complete (${batchResults.length} transaction(s)) OK\n`);

  // 5. Withdraw fees
  console.log('5. Withdrawing fees...');
  const feeBalance = await sdk.getFeeBalance(CONFIG.usdcAsset);
  console.log(`   Accrued fees: ${feeBalance}`);
  if (BigInt(feeBalance) > 0n) {
    const wResult = await sdk.withdrawFees(
      { asset: CONFIG.usdcAsset, amount: feeBalance },
      feeCollectorKeypair,
    );
    await submitAndConfirm(server, wResult, 'withdrawFees');
    console.log('   Fees withdrawn OK');
  }
  console.log();

  // 6. Off-ramp URL generation
  console.log('6. Off-ramp URL generation...');
  const offramp = new OffRampIntegration({
    moonpayApiKey: process.env.MOONPAY_KEY || 'pk_test_demo',
    transakApiKey: process.env.TRANSAK_KEY || 'demo-key',
    testMode: true,
  });

  const moonpayUrl = offramp.getOnRampUrl({
    provider: 'moonpay', amount: '50', fiatCurrency: 'USD', asset: 'XLM', cAddress: TARGET,
  });
  console.log(`   MoonPay: ${moonpayUrl}\n`);

  const transakUrl = offramp.getOnRampUrl({
    provider: 'transak', amount: '100', fiatCurrency: 'EUR', asset: 'USDC', cAddress: TARGET,
  });
  console.log(`   Transak: ${transakUrl}\n`);

  // 7. CEX memo
  console.log('7. CEX deposit memo...');
  const memo    = offramp.generateCEXDepositMemo(TARGET);
  const decoded = offramp.decodeCEXDepositMemo(memo);
  console.log(`   Memo: "${memo}"`);
  console.log(`   Decoded: ${decoded}\n`);

  // 8. Error handling
  console.log('8. Error handling...');
  const badResult = await sdk.fundCAddress(
    { source: sourceKeypair.publicKey(), target: TARGET, asset: CONFIG.usdcAsset, amount: '0' },
    sourceKeypair,
  );
  if (badResult.status === 'failed') {
    console.log(`   Expected failure: ${badResult.error}`);
  }

  try {
    await sdk.getCAddressBalance('INVALID', CONFIG.usdcAsset);
  } catch (err) {
    console.log(`   Validation error: ${err.message}`);
  }

  console.log('\n=== Example complete ===');
}

main().catch((err) => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
