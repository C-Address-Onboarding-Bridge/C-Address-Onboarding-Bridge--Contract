/**
 * Configuration required to connect the SDK to one deployed bridge contract.
 *
 * @example
 * const config: BridgeConfig = { contractId: 'CA...', rpcUrl: 'https://soroban-testnet.stellar.org', networkPassphrase: Networks.TESTNET };
 */
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

/**
 * Options for funding one C-address through the bridge contract.
 *
 * @example
 * const options: FundCOptions = { source: 'GA...', target: 'CC...', asset: 'CD...', amount: '10000000' };
 */
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

/**
 * Options for funding multiple C-addresses in one transaction.
 *
 * @example
 * const options: BatchFundCOptions = { source: 'GA...', targets: ['CC...'], amounts: ['10000000'], asset: 'CD...' };
 */
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

/**
 * Options for withdrawing accumulated bridge fees.
 *
 * @example
 * const options: WithdrawFeesOptions = { asset: 'CD...', amount: '5000000' };
 */
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

/**
 * Normalized result returned by SDK methods that submit Soroban transactions.
 *
 * @example
 * if (result.status === 'failed') console.error(result.error);
 */
export interface TransactionResult {
  /** Transaction hash */
  hash: string;
  /** Status of the transaction */
  status: 'success' | 'pending' | 'failed';
  /** Error message if failed */
  error?: string;
}
