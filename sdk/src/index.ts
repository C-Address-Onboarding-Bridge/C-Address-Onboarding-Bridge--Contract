/**
 * @fileoverview C-Address Onboarding Bridge SDK — public entry point.
 *
 * This package provides a TypeScript/JavaScript SDK for the Onboarding Bridge
 * Soroban smart contract on Stellar. It handles transaction building, signing,
 * submission, and automatic retries so callers only need to supply their
 * Keypair and intent.
 *
 * ## Quick start
 *
 * ```ts
 * import { OnboardingBridgeSDK, OffRampIntegration } from '@stellar/c-address-onboarding-bridge-sdk';
 * import { Keypair, Networks } from '@stellar/stellar-sdk';
 *
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 * });
 *
 * const result = await sdk.fundCAddress(
 *   { source: keypair.publicKey(), target: 'CC...', asset: 'CD...', amount: '1000000' },
 *   keypair,
 * );
 * ```
 *
 * ## Exports
 *
 * | Export | Description |
 * |---|---|
 * | {@link OnboardingBridgeSDK} | Main SDK class — wraps all contract calls |
 * | {@link OffRampIntegration} | Moonpay / Transak / Ramp / Banxa URL builder + CEX memo helpers |
 * | {@link CachedContractClient} | Cached contract client for high-throughput read operations |
 * | {@link InMemoryCache} | In-memory TTL cache with LRU eviction |
 * | {@link EventSubscriber} | Real-time event polling and subscriber dispatch |
 * | `assertAccountAddress` | Validates a G-address; throws on invalid input |
 * | `assertAddress` | Validates a G-address or C-address; throws on invalid input |
 * | `assertContractAddress` | Validates a C-address; throws on invalid input |
 * | `assertRelayerPubkey` | Validates a 32-byte relayer Ed25519 public key hex string |
 * | `toScVals` | Converts high-level values and types into Soroban ScVal representations |
 * | `buildSimulationTx` | Builds an un-signed transaction for Soroban RPC simulation |
 * | `withRetry` | Low-level retry wrapper for arbitrary async functions |
 * | `withRpcRetry` | Wraps an `rpc.Server` with automatic retries |
 * | `isRetryableRpcError` | Classifies an error as transient (worth retrying) |
 * | `computeBackoffDelay` | Computes exponential backoff delay with optional jitter |
 * | `VIEW_RETRY_POLICY` | Default retry policy for idempotent read calls |
 * | `STATE_CHANGING_RETRY_POLICY` | Conservative retry policy for write calls |
 * | `BATCH_TX_LIMIT` | Maximum targets per batch funding transaction |
 * | `BASE_RESERVE_STROOPS` | Stellar base reserve used to derive minimum balances |
 * | `ConsoleLogger` | Structured console logging implementation for ObservabilityHooks |
 * | `createOpenTelemetryHooks` | Creates OpenTelemetry tracing hooks for SDK methods and RPC calls |
 * | `composeHooks` | Combines multiple ObservabilityHooks into a single composite instance |
 * | `withTransactionHooks` | Executes an SDK transaction method wrapped in observability hooks |
 * | `withRpcHook` | Executes an RPC call wrapped in observability hooks |
 *
 * All types are also re-exported; import them directly:
 *
 * ```ts
 * import type { BridgeConfig, FundCOptions, TransactionResult } from '@stellar/c-address-onboarding-bridge-sdk';
 * ```
 *
 * @module index
 * @packageDocumentation
 */

export { OnboardingBridgeSDK, BATCH_TX_LIMIT, BASE_RESERVE_STROOPS, computeCommitmentHash } from './bridge';
export type { CommitmentHashOptions } from './bridge';
export { OffRampIntegration } from './offramp';
export { assertAccountAddress, assertAddress, assertContractAddress, assertRelayerPubkey } from './validate';
export { CachedContractClient } from './cachedBridge';
export type { CacheOptions, CacheKey } from './cachedBridge';
export { InMemoryCache } from './cache';
export type { ICacheProvider, InMemoryCacheOptions } from './cache';
export { toScVals, buildSimulationTx } from './encoding';
export type { TypedArg } from './encoding';
export {
  withRetry,
  withRpcRetry,
  isRetryableRpcError,
  computeBackoffDelay,
  VIEW_RETRY_POLICY,
  STATE_CHANGING_RETRY_POLICY,
} from './retry';
export type {
  RetryOptions,
  RpcRetryOptions,
  RetryAttempt,
  RetryLogger,
  RetryableClassifier,
} from './retry';

// Issue #214: Observability hooks + OpenTelemetry integration
export {
  ConsoleLogger,
  createOpenTelemetryHooks,
  composeHooks,
  withTransactionHooks,
  withRpcHook,
} from './observability';
export type { ObservabilityHooks, OpenTelemetryHooksOptions } from './observability';

// Issue #57: Event subscription
export { EventSubscriber } from './events';
export type {
  BridgeEventName,
  BridgeEventPayload,
  BridgeEventCallback,
  BridgeEventMap,
  EventSubscriberConfig,
  Unsubscribe,
  CAddressFundedEvent,
  FeesWithdrawnEvent,
  AdminProposedEvent,
  AdminTransferredEvent,
  FeeCollectorTransferProposedEvent,
  FeeCollectorTransferredEvent,
  MetaFundExecutedEvent,
  GenericBridgeEvent,
} from './events';

// Issue #58: Cost estimation
export type { CostEstimate } from './types';

export * from './types';
