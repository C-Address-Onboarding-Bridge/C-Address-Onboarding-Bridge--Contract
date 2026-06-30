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
 * | `assertAccountAddress` | Validates a G-address; throws on invalid input |
 * | `assertContractAddress` | Validates a C-address; throws on invalid input |
 * | `withRetry` | Low-level retry wrapper for arbitrary async functions |
 * | `withRpcRetry` | Wraps a `SorobanRpc.Server` with automatic retries |
 * | `isRetryableRpcError` | Classifies an error as transient (worth retrying) |
 * | `computeBackoffDelay` | Computes exponential backoff delay with optional jitter |
 * | `VIEW_RETRY_POLICY` | Default retry policy for idempotent read calls |
 * | `STATE_CHANGING_RETRY_POLICY` | Conservative retry policy for write calls |
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

export { OnboardingBridgeSDK } from './bridge';
export { OffRampIntegration } from './offramp';
export { assertAccountAddress, assertContractAddress } from './validate';
export { CachedContractClient } from './cachedBridge';
export type { ICacheProvider, CacheOptions, CacheKey } from './cachedBridge';
export { OnboardingBridgeSDK } from "./bridge";
export { OffRampIntegration } from "./offramp";
export { BridgeEventEmitter } from "./events";
export type {
  BridgeEvent,
  BridgeEventType,
  BridgeEventListener,
  BridgeEventEmitterConfig,
  CAddressFundedEvent,
  BatchTransferFailedEvent,
  BatchCompletedEvent,
  CrossChainFundedEvent,
  FeesWithdrawnEvent,
  AdminChangedEvent,
  FeeBpsChangedEvent,
  FeeCollectorChangedEvent,
  ContractPausedEvent,
  ContractUnpausedEvent,
  ContractUpgradedEvent,
  UpgradeScheduledEvent,
  UpgradeCancelledEvent,
  TimelockCreatedEvent,
  TimelockClaimedEvent,
  CommitFundEvent,
  CommitRevealFundedEvent,
  SwapAndFundedEvent,
  ReferralPaidEvent,
} from "./events";
export { assertAccountAddress, assertContractAddress } from "./validate";
export {
  withRetry,
  withRpcRetry,
  isRetryableRpcError,
  computeBackoffDelay,
  VIEW_RETRY_POLICY,
  STATE_CHANGING_RETRY_POLICY,
} from "./retry";
export type {
  RetryOptions,
  RpcRetryOptions,
  RetryAttempt,
  RetryLogger,
  RetryableClassifier,
} from './retry';

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
  AdminChangedEvent,
  MetaFundExecutedEvent,
  GenericBridgeEvent,
} from './events';

// Issue #58: Cost estimation
export type { CostEstimate } from './types';

export * from './types';
