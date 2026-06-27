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

export interface ReclaimTokensOptions {
  /** Asset contract address */
  asset: string;
  /** Amount to reclaim */
  amount: string;
  /** Destination address to receive the reclaimed tokens */
  to: string;
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

// --- Cross-chain types ---

/** A single relayer attestation: ed25519 pubkey (hex) + signature (hex) over the payload hash */
export interface RelayerSig {
  /** 32-byte Ed25519 public key as hex string */
  pubkey: string;
  /** 64-byte Ed25519 signature as hex string */
  signature: string;
}

/** Options for funding a C-address from a cross-chain event */
export interface CrossChainFundOptions {
  /** Numeric source chain id (1 = Ethereum, 101 = Solana, etc.) */
  chainId: number;
  /** 32-byte source-chain transaction hash as hex string */
  txHash: string;
  /** Destination Soroban C-address */
  target: string;
  /** Whitelisted token contract address on Stellar */
  asset: string;
  /** Gross amount (fee deducted before crediting target) */
  amount: string;
  /** At least `threshold` relayer signatures over the canonical payload hash */
  sigs: RelayerSig[];
}

/** Options for adding/removing a relayer */
export interface RelayerManagementOptions {
  /** 32-byte Ed25519 public key as hex string */
  pubkey: string;
}

/** Options for creating a new C-address (smart contract account) */
export interface CreateCOptions {
  /** Keypair used to deploy the C-address contract */
  deployerKeypair: any;
  /** Optional salt for deterministic address derivation */
  salt?: string;
  /** Optional initial funds to transfer to the new C-address after creation */
  initialFunds?: {
    /** Asset contract address */
    asset: string;
    /** Amount in smallest unit */
    amount: string;
  };
}

/** Result of creating a C-address */
export interface CreateCAddressResult {
  /** The newly created C-address */
  cAddress: string;
  /** Transaction hash of the creation */
  txHash: string;
}
