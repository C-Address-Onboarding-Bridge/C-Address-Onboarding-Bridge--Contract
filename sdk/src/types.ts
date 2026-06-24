export interface BridgeConfig {
  /** Contract ID of the deployed OnboardingBridge Soroban contract */
  contractId: string;
  /** Soroban RPC URL (e.g. https://soroban-testnet.stellar.org) */
  rpcUrl: string;
  /** Network passphrase */
  networkPassphrase: string;
  /** Optional timeout in seconds for Soroban operations */
  timeout?: number;
}

export interface FundCOptions {
  /** Source account (G-address or C-address) sending the funds */
  source: string;
  /** Target C-address to receive funds */
  target: string;
  /** Asset contract address to use for the transfer */
  asset: string;
  /** Amount in smallest unit (stroops for XLM, or asset's native unit) */
  amount: string;
}

export interface BatchFundCOptions {
  /** Source account sending the funds */
  source: string;
  /** Target C-addresses to receive funds */
  targets: string[];
  /** Corresponding amounts for each target */
  amounts: string[];
  /** Asset contract address */
  asset: string;
}

export interface WithdrawFeesOptions {
  /** Asset contract address to withdraw fees from */
  asset: string;
  /** Amount to withdraw */
  amount: string;
}

export interface UpgradeOptions {
  /** New wasm hash (32-byte hex string) to upgrade the contract to */
  newWasmHash: string;
}

export interface OffRampConfig {
  /** Your Moonpay API key */
  moonpayApiKey?: string;
  /** Your Transak API key */
  transakApiKey?: string;
  /** Whether to use sandbox/test environment */
  testMode?: boolean;
}

export interface TransactionResult {
  /** Transaction hash */
  hash: string;
  /** Status of the transaction */
  status: 'success' | 'pending' | 'failed';
  /** Error message if failed */
  error?: string;
}
