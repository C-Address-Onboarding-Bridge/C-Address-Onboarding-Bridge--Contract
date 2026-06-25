const { Keypair, Networks } = require("@stellar/stellar-sdk");
const { OnboardingBridgeSDK, OffRampIntegration } = require("../../../sdk/dist");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing required environment variable: " + name);
  }
  return value;
}

function optionalEnv(name) {
  return process.env[name] && process.env[name].length > 0 ? process.env[name] : undefined;
}

async function run() {
  const sourceKeypair = Keypair.fromSecret(requireEnv("SOURCE_SECRET_KEY"));
  const feeCollectorKeypair = Keypair.fromSecret(requireEnv("FEE_COLLECTOR_SECRET_KEY"));
  const source = sourceKeypair.publicKey();
  const target = requireEnv("TARGET_C_ADDRESS");
  const secondTarget = requireEnv("SECOND_TARGET_C_ADDRESS");
  const asset = requireEnv("ASSET_CONTRACT_ID");

  const bridge = new OnboardingBridgeSDK({
    contractId: requireEnv("CONTRACT_ID"),
    rpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.NETWORK_PASSPHRASE || Networks.TESTNET,
  });

  const isInitialized = await bridge.isInitialized();
  if (!isInitialized) {
    throw new Error("Bridge contract is not initialized. Run npx ts-node scripts/deploy.ts all first.");
  }

  const singleFunding = await bridge.fundCAddress(
    { source, target, asset, amount: "1000000" },
    sourceKeypair,
  );
  console.log("single funding", singleFunding);

  const batchFunding = await bridge.batchFundCAddresses(
    { source, targets: [target, secondTarget], amounts: ["1000000", "2500000"], asset },
    sourceKeypair,
  );
  console.log("batch funding", batchFunding);

  const offRamp = new OffRampIntegration({
    moonpayApiKey: optionalEnv("MOONPAY_API_KEY"),
    transakApiKey: optionalEnv("TRANSAK_API_KEY"),
    testMode: true,
  });

  console.log("moonpay", offRamp.getMoonpayUrl({ targetCAddress: target, amount: "25", currency: "USD", assetCode: "USDC" }));
  console.log("transak", offRamp.getTransakUrl({ targetCAddress: target, amount: "25", currency: "USDC", fiatCurrency: "USD" }));

  const memo = offRamp.generateCEXDepositMemo(target);
  console.log("cex memo", memo, offRamp.decodeCEXDepositMemo(memo));

  const feeWithdrawal = await bridge.withdrawFees(
    { asset, amount: "100000" },
    feeCollectorKeypair,
  );
  console.log("fee withdrawal", feeWithdrawal);
}

run().catch((error) => {
  console.error("full integration flow failed", error);
  process.exitCode = 1;
});
