import { Keypair, Networks } from "@stellar/stellar-sdk";
import { OnboardingBridgeSDK, OffRampIntegration } from "../../../sdk/src";

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error("Missing required environment variable: " + name);
  }
  return value;
}

function optionalEnv(env: Env, name: string): string | undefined {
  return env[name] && env[name]!.length > 0 ? env[name] : undefined;
}

async function run(): Promise<void> {
  const env = process.env;
  const sourceKeypair = Keypair.fromSecret(requireEnv(env, "SOURCE_SECRET_KEY"));
  const feeCollectorKeypair = Keypair.fromSecret(requireEnv(env, "FEE_COLLECTOR_SECRET_KEY"));
  const source = sourceKeypair.publicKey();
  const target = requireEnv(env, "TARGET_C_ADDRESS");
  const secondTarget = requireEnv(env, "SECOND_TARGET_C_ADDRESS");
  const asset = requireEnv(env, "ASSET_CONTRACT_ID");

  const bridge = new OnboardingBridgeSDK({
    contractId: requireEnv(env, "CONTRACT_ID"),
    rpcUrl: env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: env.NETWORK_PASSPHRASE || Networks.TESTNET,
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
    moonpayApiKey: optionalEnv(env, "MOONPAY_API_KEY"),
    transakApiKey: optionalEnv(env, "TRANSAK_API_KEY"),
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
