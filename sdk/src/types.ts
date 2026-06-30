/**
 * @fileoverview Type definitions for the C-Address Onboarding Bridge SDK.
 *
 * All public-facing interfaces, option bags, and result types used by
 * {@link OnboardingBridgeSDK} and {@link OffRampIntegration} are defined here
 * and re-exported from the package root (`index.ts`).
 *
 * @module types
 */

import type { RpcRetryOptions } from './retry';

// ---------------------------------------------------------------------------
// SDK configuration
// ---------------------------------------------------------------------------

/**
 * Configuration object passed to the {@link OnboardingBridgeSDK} constructor.
 *
 * @example
 * ```ts
 * import { OnboardingBridgeSDK } from '@stellar/c-address-onboarding-bridge-sdk';
 * import { Networks } from '@stellar/stellar-sdk';
 *
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...deployed_contract_address',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 * });
 * ```
 */
export interface BridgeConfig {
  /**
   * C-address (contract ID) of the deployed OnboardingBridge Soroban contract.
   * Must start with `C` and be a valid Stellar contract address.
   */
  contractId: string;

  /**
   * Soroban-compatible RPC endpoint URL.
   * @example 'https://soroban-testnet.stellar.org'
   * @example 'https://mainnet.sorobanrpc.com'
   */
  rpcUrl: string;

  /**
   * Network passphrase matching the RPC node.
   * Use `Networks.PUBLIC` for mainnet and `Networks.TESTNET` for testnet.
   * Mismatched passphrases cause all transactions to be rejected.
   */
  networkPassphrase: string;

  /**
   * Optional timeout in seconds for Soroban operations (simulation and send).
   * Defaults to 30 seconds when omitted.
   */
  timeout?: number;

  /**
   * Optional retry configuration for automatic exponential-backoff retries on
   * transient RPC failures (network errors, timeouts, rate limits, 502/503/504).
   *
   * Read-only calls (simulation, getAccount, etc.) use up to `maxRetries`
   * attempts. State-changing calls (`sendTransaction`) use at most 1 retry to
   * avoid double-submission.
   *
   * Omit to use the defaults (3 retries for reads). Set `maxRetries: 0` to
   * disable automatic retries entirely.
   *
   * @example
   * ```ts
   * const sdk = new OnboardingBridgeSDK({
   *   // ...
   *   retry: {
   *     maxRetries: 5,
   *     baseDelayMs: 500,
   *     onRetry: ({ attempt, delayMs, error }) =>
   *       console.warn(`RPC retry ${attempt} in ${delayMs}ms`, error),
   *   },
   * });
   * ```
   */
  retry?: RpcRetryOptions;
}

// ---------------------------------------------------------------------------
// Fund operations
// ---------------------------------------------------------------------------

/**
 * Options for funding a single C-address via {@link OnboardingBridgeSDK.fundCAddress}.
 *
 * @example
 * ```ts
 * const result = await sdk.fundCAddress(
 *   {
 *     source: keypair.publicKey(),   // G-address of the sender
 *     target: 'CC...',               // destination C-address
 *     asset:  'CD...',               // token contract (e.g. USDC)
 *     amount: '10000000',            // 1 USDC (7 decimal places)
 *   },
 *   keypair,
 * );
 * ```
 */
export interface FundCOptions {
  /**
   * Source account that authorises the token transfer.
   * Must be a valid G-address (Ed25519 public key).
   */
  source: string;

  /**
   * Destination C-address (smart contract account) to receive the net funds.
   * Must start with `C` and be a valid Stellar contract address.
   */
  target: string;

  /**
   * Token contract address for the asset being transferred.
   * The asset must be whitelisted on the bridge contract.
   */
  asset: string;

  /**
   * Gross transfer amount in the token's smallest unit.
   * For a token with 7 decimal places, `"10000000"` equals 1 token.
   * The protocol fee is deducted from this before crediting the target.
   */
  amount: string;
}

/**
 * Options for funding multiple C-addresses in one or more transactions via
 * {@link OnboardingBridgeSDK.batchFundCAddresses}.
 *
 * The source account is charged the sum of all `amounts` in one transfer per
 * transaction chunk.  For any target that fails (blocked, not allowlisted), the
 * corresponding amount is refunded to `source`.
 *
 * When the number of targets exceeds {@link BATCH_TX_LIMIT} the SDK automatically
 * splits the list into chunks of at most `BATCH_TX_LIMIT` and submits one
 * transaction per chunk.  The optional `onProgress` callback (passed as the
 * third argument to `batchFundCAddresses`) is called after each transaction
 * with the running total of recipients processed.
 *
 * @example
 * ```ts
 * await sdk.batchFundCAddresses(
 *   {
 *     source: keypair.publicKey(),
 *     targets: ['CC...1', 'CC...2', 'CC...3'],
 *     amounts: ['5000000', '3000000', '2000000'],
 *     asset:   'CD...',
 *   },
 *   keypair,
 *   (completed, total, txHash) => {
 *     console.log(`Progress: ${completed}/${total} — tx: ${txHash}`);
 *   },
 * );
 * ```
 */
export interface BatchFundCOptions {
  /** Source account (G-address) providing all the funds. */
  source: string;

  /**
   * Ordered list of destination C-addresses.
   * Must be the same length as `amounts`.
   */
  targets: string[];

  /**
   * Corresponding amounts for each target, in the token's smallest unit.
   * Must be the same length as `targets`.
   */
  amounts: string[];

  /**
   * Token contract address for all transfers in this batch.
   * The asset must be whitelisted on the bridge contract.
   */
  asset: string;
}

/**
 * Progress callback invoked by {@link OnboardingBridgeSDK.batchFundCAddresses}
 * after each on-chain transaction completes (or fails).
 *
 * @param completed - Number of individual recipients processed so far across
 *                    all submitted transactions (whether each transfer succeeded
 *                    inside the contract or was refunded due to access-control).
 * @param total     - Total number of recipients in the original request.
 * @param txHash    - Transaction hash of the just-submitted transaction.
 *                    `undefined` when the transaction failed before submission.
 */
export type BatchProgressCallback = (
  completed: number,
  total: number,
  txHash?: string,
) => void;

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

/**
 * Options for withdrawing accumulated protocol fees via
 * {@link OnboardingBridgeSDK.withdrawFees}.
 *
 * Only the configured fee-collector address may call this.
 *
 * @example
 * ```ts
 * const balance = await sdk.getFeeBalance('CD...');
 * await sdk.withdrawFees({ asset: 'CD...', amount: balance }, feeCollectorKeypair);
 * ```
 */
export interface WithdrawFeesOptions {
  /** Token contract address to withdraw fees for. */
  asset: string;

  /** Amount to withdraw, in the token's smallest unit. Must not exceed accrued fees. */
  amount: string;
}

/**
 * Options for upgrading the bridge contract to a new WASM implementation via
 * {@link OnboardingBridgeSDK.upgrade}.
 *
 * Admin only. The new WASM hash must already be uploaded to the network with
 * `stellar contract install`. All instance storage (admin, fees, etc.) is
 * preserved across the upgrade.
 *
 * @example
 * ```ts
 * await sdk.upgrade({ newWasmHash: 'abcdef0123456789...' }, adminKeypair);
 * ```
 */
export interface UpgradeOptions {
  /**
   * 32-byte WASM hash as a lowercase hex string (64 characters).
   * Obtained from `stellar contract install --network <net> ...`.
   */
  newWasmHash: string;
}

/**
 * Options for reclaiming tokens accidentally sent directly to the contract
 * address via {@link OnboardingBridgeSDK.reclaimTokens}.
 *
 * Admin only. Intended as an emergency recovery mechanism — reclaims the
 * contract's raw token balance minus any accrued fees for that asset.
 *
 * @example
 * ```ts
 * await sdk.reclaimTokens(
 *   { asset: 'CD...', amount: '1000000', to: 'G...safeAddress' },
 *   adminKeypair,
 * );
 * ```
 */
export interface ReclaimTokensOptions {
  /** Token contract address to reclaim from. */
  asset: string;

  /** Amount to reclaim, in the token's smallest unit. */
  amount: string;

  /** Destination G-address that will receive the reclaimed tokens. */
  to: string;
}

// ---------------------------------------------------------------------------
// Off-ramp / on-ramp configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link OffRampIntegration} class.
 *
 * Provide API keys for the providers you intend to use. Keys are optional so
 * that you can construct the integration with only the providers you need.
 *
 * @example
 * ```ts
 * const offramp = new OffRampIntegration({
 *   moonpayApiKey: process.env.MOONPAY_KEY,
 *   transakApiKey: process.env.TRANSAK_KEY,
 *   testMode: process.env.NODE_ENV !== 'production',
 * });
 * ```
 */
export interface OffRampConfig {
  /** Moonpay publishable API key. Required for Moonpay URLs. */
  moonpayApiKey?: string;

  /** Transak API key. Required for Transak URLs. */
  transakApiKey?: string;

  /** Ramp Network host API key. Required for Ramp URLs. */
  rampApiKey?: string;

  /** Banxa API key. Required for Banxa URLs. */
  banxaApiKey?: string;

  /**
   * When `true`, sandbox/staging endpoints are used for all providers that
   * support a test mode (Moonpay, Transak). Defaults to `false`.
   */
  testMode?: boolean;
}

/**
 * Supported off-ramp / on-ramp provider identifiers.
 *
 * - `'moonpay'`  — [MoonPay](https://www.moonpay.com/) — available in 160+ countries.
 * - `'transak'`  — [Transak](https://transak.com/) — strong coverage in emerging markets.
 * - `'ramp'`     — [Ramp Network](https://ramp.network/) — low fees, EU focus.
 * - `'banxa'`    — [Banxa](https://banxa.com/) — supports multiple blockchains.
 */
export type OffRampProvider = 'moonpay' | 'transak' | 'ramp' | 'banxa';

/**
 * Capability and configuration data for a single off-ramp/on-ramp provider.
 * Returned by {@link OffRampIntegration.getProviderConfig}.
 */
export interface ProviderConfig {
  /** Provider identifier. */
  provider: OffRampProvider;

  /**
   * Cryptocurrency asset codes supported by this provider on Stellar.
   * @example ['XLM', 'USDC', 'ETH', 'BTC']
   */
  supportedAssets: string[];

  /**
   * ISO 4217 fiat currency codes accepted by this provider.
   * @example ['USD', 'EUR', 'GBP']
   */
  supportedFiatCurrencies: string[];

  /**
   * ISO 3166-1 alpha-2 country codes where this provider operates.
   * @example ['US', 'GB', 'DE']
   */
  supportedCountries: string[];

  /**
   * Minimum transaction amount in fiat (as a decimal string, e.g. `"20"`).
   */
  minAmount: string;

  /**
   * Maximum transaction amount in fiat (as a decimal string, e.g. `"50000"`).
   */
  maxAmount: string;

  /**
   * Provider fee as a percentage string (e.g. `"4.5"` means 4.5%).
   * Does not include network fees.
   */
  feePercentage: string;

  /** Whether this provider's sandbox/test environment is available. */
  testModeAvailable: boolean;
}

/**
 * Per-provider comparison result for a given transaction.
 * Returned as a value in the record from {@link OffRampIntegration.compareProviders}.
 */
export interface ProviderComparison {
  /**
   * Total fee amount for the transaction in fiat (decimal string).
   * @example '4.50' for a $100 transaction at 4.5% fee
   */
  feeAmount: string;

  /**
   * Fee as a percentage string, matching {@link ProviderConfig.feePercentage}.
   */
  feePercentage: string;

  /**
   * Net fiat amount the user receives or spends after fees (decimal string).
   */
  netAmount: string;

  /**
   * Approximate settlement time in hours.
   * How long until the crypto (on-ramp) or fiat (off-ramp) arrives.
   */
  settlementTime: number;
}

/**
 * Parameters for generating an on-ramp URL via
 * {@link OffRampIntegration.getOnRampUrl}.
 *
 * An on-ramp URL redirects the user to a provider's checkout page where they
 * pay with a credit card or bank transfer and receive crypto at `cAddress`.
 */
export interface OnRampUrlParams {
  /** Provider to use for this transaction. */
  provider: OffRampProvider;

  /**
   * Fiat amount the user intends to spend (as a decimal string).
   * @example '100' for $100 USD
   */
  amount: string;

  /**
   * ISO 4217 fiat currency code.
   * @example 'USD', 'EUR', 'GBP'
   */
  fiatCurrency: string;

  /**
   * Crypto asset the user wants to receive.
   * @example 'XLM', 'USDC'
   */
  asset: string;

  /**
   * Target C-address that will receive the purchased crypto.
   * The provider will route funds to this address on Stellar.
   */
  cAddress: string;
}

/**
 * Parameters for generating an off-ramp URL via
 * {@link OffRampIntegration.getOffRampUrl}.
 *
 * An off-ramp URL redirects the user to a provider's page where they sell
 * crypto from `gAddress` and receive fiat currency.
 */
export interface OffRampUrlParams {
  /** Provider to use for this transaction. */
  provider: OffRampProvider;

  /**
   * Amount of crypto the user wants to sell (as a decimal string).
   */
  amount: string;

  /**
   * Crypto asset the user is selling.
   * @example 'XLM', 'USDC'
   */
  asset: string;

  /**
   * ISO 4217 fiat currency the user wants to receive.
   * @example 'USD', 'EUR'
   */
  fiatCurrency: string;

  /**
   * Source G-address from which the user will send crypto to the provider.
   * Must be a valid Stellar G-address (Ed25519 public key).
   */
  gAddress: string;
}

// ---------------------------------------------------------------------------
// Transaction result
// ---------------------------------------------------------------------------

/**
 * Unified result type returned by all mutating SDK methods.
 *
 * Mutating methods never throw — errors are surfaced through this type.
 * Always check `status` before using `hash`.
 *
 * @example
 * ```ts
 * const result = await sdk.fundCAddress(options, keypair);
 *
 * if (result.status === 'failed') {
 *   console.error('Transfer failed:', result.error);
 *   return;
 * }
 *
 * // Poll for confirmation
 * const txResult = await server.getTransaction(result.hash);
 * ```
 */
export interface TransactionResult {
  /**
   * Transaction hash on the Stellar network.
   * Empty string (`''`) when `status` is `'failed'` and the transaction was
   * never submitted.
   */
  hash: string;

  /**
   * Current status of the transaction:
   * - `'pending'`  — submitted and waiting for ledger inclusion.
   * - `'success'`  — included and successful (rare, usually stays `'pending'`).
   * - `'failed'`   — rejected before submission or returned an error.
   */
  status: 'success' | 'pending' | 'failed';

  /**
   * Human-readable error description when `status === 'failed'`.
   * Absent when the transaction is pending or successful.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Cross-chain types
// ---------------------------------------------------------------------------

/**
 * A single relayer attestation over a cross-chain event.
 *
 * Relayers sign the canonical payload hash of a cross-chain transfer using
 * their Ed25519 private key. The contract verifies each signature and counts
 * how many are from registered relayers before applying the transfer.
 *
 * @see {@link CrossChainFundOptions}
 */
export interface RelayerSig {
  /**
   * 32-byte Ed25519 public key of the signing relayer, as a lowercase hex string.
   * Must be registered on the contract via `addRelayer`.
   */
  pubkey: string;

  /**
   * 64-byte Ed25519 signature over the canonical payload hash, as a lowercase
   * hex string.
   */
  signature: string;
}

/**
 * Options for {@link OnboardingBridgeSDK.fundCrosschain}.
 *
 * Used by the relayer service to relay a cross-chain deposit event onto Stellar.
 * The contract verifies the relayer signatures, checks for replay, calculates
 * the fee, and credits the target C-address.
 *
 * @example
 * ```ts
 * await sdk.fundCrosschain(
 *   {
 *     chainId: 1,                        // Ethereum mainnet
 *     txHash: '0xabc...def',
 *     target: 'CC...',
 *     asset: 'CD...usdc',
 *     amount: '1000000',                 // 0.1 USDC (6 decimals on Ethereum → bridged)
 *     sigs: [relayerSig1, relayerSig2],
 *   },
 *   relayerKeypair,
 * );
 * ```
 */
export interface CrossChainFundOptions {
  /**
   * Numeric identifier of the source chain.
   * Commonly: `1` = Ethereum mainnet, `101` = Solana mainnet.
   */
  chainId: number;

  /**
   * 32-byte source-chain transaction hash as a hex string (with or without `0x` prefix).
   * Used together with `chainId` as a replay-protection nonce.
   */
  txHash: string;

  /** Destination Soroban C-address that will receive the net funds. */
  target: string;

  /**
   * Whitelisted token contract address on Stellar that represents the bridged asset.
   */
  asset: string;

  /**
   * Gross amount of `asset` to credit (fee deducted before forwarding to `target`).
   * In the token's smallest unit.
   */
  amount: string;

  /**
   * Relayer signatures over the canonical payload hash.
   * At least `threshold` signatures from registered relayers are required.
   */
  sigs: RelayerSig[];
}

/**
 * Options for {@link OnboardingBridgeSDK.addRelayer} and
 * {@link OnboardingBridgeSDK.removeRelayer}.
 */
export interface RelayerManagementOptions {
  /**
   * 32-byte Ed25519 public key of the relayer to add or remove, as a lowercase
   * hex string (64 characters).
   */
  pubkey: string;
}

// ---------------------------------------------------------------------------
// C-address creation
// ---------------------------------------------------------------------------

/**
 * Options for {@link OnboardingBridgeSDK.createCAddress}.
 *
 * Creates a new Soroban smart-contract account (C-address) and optionally
 * funds it immediately in the same flow.
 *
 * @example
 * ```ts
 * const { cAddress } = await sdk.createCAddress({
 *   deployerKeypair: keypair,
 *   initialFunds: { asset: 'CD...usdc', amount: '10000000' },
 * });
 * console.log('New C-address:', cAddress);
 * ```
 */
export interface CreateCOptions {
  /**
   * Keypair used to sign the contract-creation transaction.
   * This account pays the deployment fees.
   */
  deployerKeypair: any;

  /**
   * Optional 32-byte salt for deterministic address derivation, as a hex string.
   * If omitted, a random salt is generated so the address is non-deterministic.
   */
  salt?: string;

  /**
   * Optional initial funds to transfer to the newly created C-address immediately
   * after its creation, using the bridge contract's `fund_c_address` function.
   */
  initialFunds?: {
    /** Token contract address of the asset to send. */
    asset: string;
    /** Amount to send, in the token's smallest unit. */
    amount: string;
  };
}

/**
 * Result returned by {@link OnboardingBridgeSDK.createCAddress}.
 */
export interface CreateCAddressResult {
  /**
   * The newly created C-address (Soroban contract address starting with `C`).
   */
  cAddress: string;

  /** Transaction hash of the contract-creation transaction. */
  txHash: string;
}

// ---------------------------------------------------------------------------
// Swap-and-bridge
// ---------------------------------------------------------------------------

/**
 * Options for {@link OnboardingBridgeSDK.fundCAddressWithSwap}.
 *
 * The bridge contract will:
 * 1. Pull `sourceAmount` of `sourceAsset` from `source`.
 * 2. Route it through `swapRoute` (an ordered list of DEX pool addresses).
 * 3. Deduct the protocol fee in `targetAsset`.
 * 4. Credit the net `targetAsset` amount to `target`.
 *
 * @example
 * ```ts
 * const result = await sdk.fundCAddressWithSwap(
 *   {
 *     source: keypair.publicKey(),
 *     target: 'CC...',
 *     sourceAsset: 'CD...usdc',
 *     targetAsset: 'CD...xlm',
 *     sourceAmount: '10000000',    // 1 USDC
 *     minTargetAmount: '9000000',  // 0.9 XLM minimum (10% slippage tolerance)
 *     swapRoute: ['CD...xlm_usdc_pool'],
 *   },
 *   keypair,
 * );
 * ```
 */
export interface FundCAddressWithSwapOptions {
  /**
   * Source G-address providing `sourceAsset`.
   * Must sign the transaction.
   */
  source: string;

  /** Destination C-address that will receive `targetAsset`. */
  target: string;

  /** Contract address of the token the source holds and wants to swap. */
  sourceAsset: string;

  /** Contract address of the token the target should receive after the swap. */
  targetAsset: string;

  /**
   * Gross amount of `sourceAsset` to swap and bridge, in its smallest unit.
   */
  sourceAmount: string;

  /**
   * Minimum acceptable `targetAsset` amount after the swap.
   * The transaction reverts with `SlippageExceeded` if the DEX returns less.
   * Set this to protect against price manipulation or large slippage.
   */
  minTargetAmount: string;

  /**
   * Ordered list of DEX pool contract addresses through which the swap is routed.
   * Each pool must implement `swap(min_amount_out: i128, to: Address) → i128`.
   */
  swapRoute: string[];
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * A single page of results returned by list-querying SDK methods such as
 * {@link OnboardingBridgeSDK.getWhitelistedAssets},
 * {@link OnboardingBridgeSDK.getBlocklistedAddresses}, etc.
 *
 * Because Soroban contracts return full vectors, pagination is performed
 * client-side. The `cursor` is an opaque base64-encoded offset token.
 *
 * @typeParam T — the element type for items in this page.
 *
 * @example
 * ```ts
 * // Iterate through all whitelisted assets page by page
 * let page = await sdk.getWhitelistedAssets();
 * while (page.hasMore) {
 *   console.log(page.items);
 *   page = await sdk.getWhitelistedAssets(page.cursor);
 * }
 * console.log(page.items); // last page
 * ```
 */
export interface PaginatedResult<T> {
  /** Items in this page. May be an empty array on the last page. */
  items: T[];

  /**
   * Opaque cursor token to pass as the `cursor` argument in the next call.
   * `undefined` when there are no further pages.
   */
  cursor?: string;

  /**
   * `true` when there is at least one more page available.
   * Convenience alias for `cursor !== undefined`.
   */
  hasMore: boolean;
}

/**
 * Options for paginated list queries.
 * Passed as optional parameters to methods that return {@link PaginatedResult}.
 */
export interface PaginationOptions {
  /**
   * Opaque cursor token returned from a previous call.
   * Omit (or pass `undefined`) to start from the first page.
   */
  cursor?: string;

  /**
   * Maximum number of items to return per page.
   * Defaults to `20` when omitted.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Issue #58: Transaction cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimated cost for a `fundCAddress` transaction.
 * All fee values are in stroops (1 XLM = 10_000_000 stroops).
 */
export interface CostEstimate {
  /**
   * Inclusion fee (base network fee) in stroops.
   * This is the minimum fee required for the transaction to be included.
   */
  fee: string;
  /**
   * Minimum account balance required to submit the transaction, in stroops.
   * Accounts below this balance cannot submit transactions.
   */
  minBalance: string;
  /**
   * Soroban resource fee in stroops (covers CPU, memory, storage, I/O).
   * This is on top of the inclusion fee.
   */
  resourceFee: string;
  /**
   * Wall-clock time the simulation took, in milliseconds.
   * Useful for UI feedback — if this is high, the RPC may be under load.
   */
  executionTimeMs: number;
}
