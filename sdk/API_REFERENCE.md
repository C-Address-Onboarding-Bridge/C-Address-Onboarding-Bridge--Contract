# API Reference — @stellar/c-address-onboarding-bridge-sdk

This document provides a comprehensive API reference for all exported classes, interfaces, error types, and retry configurations of the C-Address Onboarding Bridge TypeScript SDK.

---

## Table of Contents
1. [Classes](#classes)
   - [OnboardingBridgeSDK](#onboardingbridgesdk)
   - [OffRampIntegration](#offrampintegration)
   - [CachedContractClient](#cachedcontractclient)
   - [InMemoryCache](#inmemorycache)
   - [EventSubscriber](#eventsubscriber)
2. [Functions](#functions)
   - [Retry Utilities](#retry-utilities)
   - [Observability Helpers](#observability-helpers)
3. [Constants](#constants)
4. [Interfaces](#interfaces)
   - [BridgeConfig](#bridgeconfig)
   - [FundCOptions](#fundcoptions)
   - [BatchFundCOptions](#batchfundcoptions)
   - [WithdrawFeesOptions](#withdrawfeesoptions)
   - [OffRampConfig](#offrampconfig)
   - [TransactionResult](#transactionresult)
   - [FundCAddressWithSwapOptions](#fundcaddresswithswapoptions)
   - [CrossChainFundOptions](#crosschainfundoptions)
   - [CreateCOptions](#createcoptions)
   - [CreateCAddressResult](#createcaddressresult)
   - [PaginatedResult](#paginatedresult)
   - [PaginationOptions](#paginationoptions)
   - [CostEstimate](#costestimate)
   - [CacheOptions](#cacheoptions)
   - [ICacheProvider](#icacheprovider)
   - [RetryOptions](#retryoptions)
   - [RpcRetryOptions](#rpcretryoptions)
   - [RetryAttempt](#retryattempt)
   - [ObservabilityHooks](#observabilityhooks)
   - [OpenTelemetryHooksOptions](#opentelemetryhooksoptions)
   - [EventSubscriberConfig](#eventsubscriberconfig)
   - [Bridge Event Payloads](#bridge-event-payloads)
5. [Type Aliases](#type-aliases)
6. [Error Handling & Validation](#error-handling--validation)
   - [Validation Methods](#validation-methods)
   - [RPC Retry & Transient Errors](#rpc-retry--transient-errors)
   - [Cancelling Retries](#cancelling-retries)
   - [Common Error Scenarios & Solutions](#common-error-scenarios--solutions)

---

## Classes

### `OnboardingBridgeSDK`

Main entry point for interacting with the deployed Onboarding Bridge Soroban contract.

#### Constructor

```ts
constructor(config: BridgeConfig)
```
Initializes the SDK instance, instantiates the underlying Soroban RPC server, and wraps it in a transparent retry proxy.

- **Parameters**:
  - `config`: [`BridgeConfig`](#bridgeconfig) — Connection details and retry preferences.

---

#### Methods

##### `fundCAddress`
```ts
async fundCAddress(
  options: FundCOptions,
  sourceKeypair: Keypair
): Promise<TransactionResult>
```
Funds a single C-address from a source account. The source account must have pre-authorized the token transfer to the bridge contract.
- **Parameters**:
  - `options`: [`FundCOptions`](#fundcoptions)
  - `sourceKeypair`: `Keypair` (from `@stellar/stellar-sdk`)
- **Returns**: `Promise<TransactionResult>`

##### `fundCAddressWithSwap`
```ts
async fundCAddressWithSwap(
  options: FundCAddressWithSwapOptions,
  sourceKeypair: any
): Promise<TransactionResult>
```
Funds a C-address by first swapping a source asset to a target asset via DEX pools, deducting the fee, and forwarding the remaining net amount.
- **Parameters**:
  - `options`: [`FundCAddressWithSwapOptions`](#fundcaddresswithswapoptions)
  - `sourceKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `batchFundCAddresses`
```ts
async batchFundCAddresses(
  options: BatchFundCOptions,
  sourceKeypair: Keypair,
  onProgress?: BatchProgressCallback
): Promise<TransactionResult[]>
```
Funds multiple C-addresses. Lists longer than [`BATCH_TX_LIMIT`](#constants) are split into chunks of that size and submitted as one transaction per chunk, so the result is an array with one entry per chunk.
- **Parameters**:
  - `options`: [`BatchFundCOptions`](#batchfundcoptions)
  - `sourceKeypair`: `Keypair`
  - `onProgress`: [`BatchProgressCallback`](#type-aliases) (optional) — invoked after each chunk.
- **Returns**: `Promise<TransactionResult[]>`
- **Example**:
```ts
const results = await sdk.batchFundCAddresses(
  { source: keypair.publicKey(), targets, amounts, asset: 'CD...' },
  keypair,
  (completed, total, txHash) => console.log(`${completed}/${total}`, txHash),
);
```

##### `withdrawFees`
```ts
async withdrawFees(
  options: WithdrawFeesOptions,
  feeCollectorKeypair: Keypair
): Promise<TransactionResult>
```
Withdraws accumulated fees from the bridge contract. Accessible only by the designated fee collector address.
- **Parameters**:
  - `options`: [`WithdrawFeesOptions`](#withdrawfeesoptions)
  - `feeCollectorKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `reclaimTokens`
```ts
async reclaimTokens(
  options: ReclaimTokensOptions,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Reclaims accidentally sent tokens held in the bridge contract. Accessible only by the contract admin.
- **Parameters**:
  - `options`: `ReclaimTokensOptions`
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `getFee`
```ts
async getFee(): Promise<number>
```
Simulates a transaction to retrieve the current protocol fee in basis points (1 bps = 0.01%).
- **Returns**: `Promise<number>`

##### `getFeeCollector`
```ts
async getFeeCollector(): Promise<string>
```
Retrieves the G-address of the designated fee collector.
- **Returns**: `Promise<string>`

##### `getAdmin`
```ts
async getAdmin(): Promise<string>
```
Retrieves the G-address of the contract admin.
- **Returns**: `Promise<string>`

##### `getCAddressBalance`
```ts
async getCAddressBalance(
  cAddress: string,
  asset: string
): Promise<string>
```
Queries the balance of a C-address for a specific whitelisted token.
- **Parameters**:
  - `cAddress`: `string` — Target contract address.
  - `asset`: `string` — Token contract address.
- **Returns**: `Promise<string>` (in the smallest unit of the token)

##### `getFeeBalance`
```ts
async getFeeBalance(asset: string): Promise<string>
```
Queries the accumulated fee balance for a given token contract.
- **Parameters**:
  - `asset`: `string` — Token contract address.
- **Returns**: `Promise<string>`

##### `getAllBalances`
```ts
async getAllBalances(assets: string[]): Promise<Record<string, string>>
```
Queries balances for a set of token contracts in one simulation call.
- **Parameters**:
  - `assets`: `string[]` — Array of token contract addresses.
- **Returns**: `Promise<Record<string, string>>` — Map of `assetAddress -> balance`.

##### `isInitialized`
```ts
async isInitialized(): Promise<boolean>
```
Checks if the contract is initialized.
- **Returns**: `Promise<boolean>`

##### `setFee`
```ts
async setFee(
  newFeeBps: number,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Updates the protocol fee rate (admin only; capped at 1000 bps or 10%).
- **Parameters**:
  - `newFeeBps`: `number` — New rate in basis points.
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `setFeeCollector`
```ts
async setFeeCollector(
  newFeeCollector: string,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Rotates the fee collector address (admin only).
- **Parameters**:
  - `newFeeCollector`: `string` — New collector's G-address.
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `setAdmin`
```ts
async setAdmin(
  newAdmin: string,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Transfers the contract admin role (admin only).
- **Parameters**:
  - `newAdmin`: `string` — New admin's G-address.
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `upgrade`
```ts
async upgrade(
  options: UpgradeOptions,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Upgrades the contract implementation to a new compiled WASM hash (admin only).
- **Parameters**:
  - `options`: `UpgradeOptions`
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `fundCrosschain`
```ts
async fundCrosschain(
  options: CrossChainFundOptions,
  relayerKeypair: Keypair
): Promise<TransactionResult>
```
Submits a cross-chain funding transaction verified with relayer signatures (relayer only).
- **Parameters**:
  - `options`: [`CrossChainFundOptions`](#crosschainfundoptions)
  - `relayerKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `addRelayer`
```ts
async addRelayer(
  options: RelayerManagementOptions,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Registers an authorized relayer public key (admin only).
- **Parameters**:
  - `options`: `RelayerManagementOptions`
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `removeRelayer`
```ts
async removeRelayer(
  options: RelayerManagementOptions,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Removes a registered relayer public key (admin only).
- **Parameters**:
  - `options`: `RelayerManagementOptions`
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `setRelayerThreshold`
```ts
async setRelayerThreshold(
  threshold: number,
  adminKeypair: Keypair
): Promise<TransactionResult>
```
Configures the required threshold of relayer signatures (admin only).
- **Parameters**:
  - `threshold`: `number`
  - `adminKeypair`: `Keypair`
- **Returns**: `Promise<TransactionResult>`

##### `queryRelayerThreshold`
```ts
async queryRelayerThreshold(): Promise<number>
```
Queries the current signature threshold for cross-chain transactions.
- **Returns**: `Promise<number>`

##### `createCAddress`
```ts
async createCAddress(
  options: CreateCOptions
): Promise<CreateCAddressResult>
```
Deploys a new C-address contract deterministically and optionally funds it immediately.
- **Parameters**:
  - `options`: [`CreateCOptions`](#createcoptions)
- **Returns**: `Promise<CreateCAddressResult>`

##### `queryIsRelayer`
```ts
async queryIsRelayer(pubkeyHex: string): Promise<boolean>
```
Checks if a given public key (hex) is a registered relayer.
- **Parameters**:
  - `pubkeyHex`: `string`
- **Returns**: `Promise<boolean>`

##### `getWhitelistedAssets`
```ts
async getWhitelistedAssets(
  cursor?: string,
  limit?: number
): Promise<PaginatedResult<string>>
```
Queries the list of whitelisted tokens with client-side pagination.
- **Parameters**:
  - `cursor`: `string` (optional base64 cursor)
  - `limit`: `number` (optional, default 20)
- **Returns**: `Promise<PaginatedResult<string>>`

##### `getFeeExemptAddresses`
```ts
async getFeeExemptAddresses(
  cursor?: string,
  limit?: number
): Promise<PaginatedResult<string>>
```
Queries fee-exempt addresses with client-side pagination.
- **Parameters**:
  - `cursor`: `string` (optional)
  - `limit`: `number` (optional)
- **Returns**: `Promise<PaginatedResult<string>>`

##### `getBlocklistedAddresses`
```ts
async getBlocklistedAddresses(
  cursor?: string,
  limit?: number
): Promise<PaginatedResult<string>>
```
Queries the blocklist with client-side pagination.
- **Parameters**:
  - `cursor`: `string` (optional)
  - `limit`: `number` (optional)
- **Returns**: `Promise<PaginatedResult<string>>`

##### `getAllowlistedAddresses`
```ts
async getAllowlistedAddresses(
  cursor?: string,
  limit?: number
): Promise<PaginatedResult<string>>
```
Queries the allowlist with client-side pagination.
- **Parameters**:
  - `cursor`: `string` (optional)
  - `limit`: `number` (optional)
- **Returns**: `Promise<PaginatedResult<string>>`

##### `estimateCost`
```ts
async estimateCost(options: FundCOptions): Promise<CostEstimate>
```
Simulates a `fundCAddress` call without submitting it, returning the inclusion fee, the Soroban resource fee, and the minimum balance the source account must hold. The minimum balance is derived from the account's on-chain subentry count as `(2 + numSubentries) * baseReserve`; see [`BASE_RESERVE_STROOPS`](#constants).
- **Parameters**:
  - `options`: [`FundCOptions`](#fundcoptions)
- **Returns**: `Promise<CostEstimate>` — see [`CostEstimate`](#costestimate)
- **Example**:
```ts
const estimate = await sdk.estimateCost({
  source: keypair.publicKey(),
  target: 'CC...',
  asset: 'CD...',
  amount: '10000000',
});
console.log('Total fee:  ', estimate.fee, 'stroops');
console.log('Min balance:', estimate.minBalance, 'stroops');
```

---

### `OffRampIntegration`

A standalone integration class that coordinates off-ramps, on-ramps, and centralized exchange deposit mapping.

#### Constructor

```ts
constructor(config: OffRampConfig)
```
- **Parameters**:
  - `config`: [`OffRampConfig`](#offrampconfig)

---

#### Methods

##### `getOnRampUrl`
```ts
getOnRampUrl(params: OnRampUrlParams): string
```
Generates a direct URL to allow fiat purchases of crypto targetted to a specific C-address.
- **Parameters**:
  - `params`: `OnRampUrlParams`
- **Returns**: `string`

##### `getOffRampUrl`
```ts
getOffRampUrl(params: OffRampUrlParams): string
```
Generates a URL to trigger a crypto off-ramp sell transaction funded from a G-address.
- **Parameters**:
  - `params`: `OffRampUrlParams`
- **Returns**: `string`

##### `getProviderConfig`
```ts
getProviderConfig(provider: OffRampProvider): ProviderConfig
```
Fetches the static configuration and limits for the given off-ramp provider.
- **Parameters**:
  - `provider`: `'moonpay' | 'transak' | 'ramp' | 'banxa'`
- **Returns**: `ProviderConfig`

##### `compareProviders`
```ts
compareProviders(
  amount: string,
  asset: string,
  fiatCurrency?: string
): Partial<Record<OffRampProvider, ProviderComparison>>
```
Compares supported providers for fee levels, net asset yields, and expected settlement times.
- **Parameters**:
  - `amount`: `string` — Total input amount.
  - `asset`: `string` — Target cryptocurrency symbol.
  - `fiatCurrency`: `string` (optional, default `'USD'`)
- **Returns**: `Partial<Record<OffRampProvider, ProviderComparison>>`

##### `generateCEXDepositMemo`
```ts
generateCEXDepositMemo(targetCAddress: string): string
```
Encodes a target C-address into a memo string (`"bridge:<target_c_address>"`) for routing deposits from centralized exchanges.
- **Parameters**:
  - `targetCAddress`: `string` — Destination C-address.
- **Returns**: `string`

##### `decodeCEXDepositMemo`
```ts
decodeCEXDepositMemo(memo: string): string | null
```
Decodes a CEX deposit memo to retrieve the destination C-address, returning `null` if the memo is not formatted correctly.
- **Parameters**:
  - `memo`: `string`
- **Returns**: `string | null`

---

### `CachedContractClient`

Wraps the SDK and caches the four cheap-but-frequently-read view methods, delegating every transaction method to the underlying client. Cached values are invalidated automatically when a state-changing transaction succeeds.

Default TTLs are 5 minutes for `getFee` and `isInitialized`, and 24 hours for `getFeeCollector` and `getAdmin`.

#### Constructor

```ts
constructor(config: BridgeConfig, options?: CacheOptions)
```
- **Parameters**:
  - `config`: [`BridgeConfig`](#bridgeconfig)
  - `options`: [`CacheOptions`](#cacheoptions) (optional) — defaults to an [`InMemoryCache`](#inmemorycache) with the default TTLs.

---

#### Methods

##### `getFee`
```ts
async getFee(): Promise<number>
```
Returns the protocol fee in basis points, served from cache when a fresh value is present.
- **Returns**: `Promise<number>`

##### `getFeeCollector`
```ts
async getFeeCollector(): Promise<string>
```
Returns the fee collector's G-address, served from cache when fresh.
- **Returns**: `Promise<string>`

##### `getAdmin`
```ts
async getAdmin(): Promise<string>
```
Returns the contract admin's G-address, served from cache when fresh.
- **Returns**: `Promise<string>`

##### `isInitialized`
```ts
async isInitialized(): Promise<boolean>
```
Returns whether the contract is initialized, served from cache when fresh.
- **Returns**: `Promise<boolean>`

##### `client`
```ts
get client(): ContractClient
```
Accessor for the wrapped client, exposing the transaction methods `fundCAddress`, `fundCAddressWithSwap`, `withdrawFees`, `setFee`, `setFeeCollector`, `setAdmin`, and `upgrade`. Calling any of them invalidates the affected cache entries. For the full method set (batching, cross-chain, relayers, paginated queries) use [`OnboardingBridgeSDK`](#onboardingbridgesdk) directly.
- **Returns**: The wrapped client instance.

##### `invalidateCache`
```ts
async invalidateCache(keys?: CacheKey | CacheKey[]): Promise<void>
```
Drops one key, several keys, or — when `keys` is omitted — the entire cache.
- **Parameters**:
  - `keys`: [`CacheKey`](#type-aliases) `| CacheKey[]` (optional)
- **Returns**: `Promise<void>`

- **Example**:
```ts
import { CachedContractClient } from '@stellar/c-address-onboarding-bridge-sdk';

const cached = new CachedContractClient(
  { contractId: 'CA...', rpcUrl: 'https://soroban-testnet.stellar.org', networkPassphrase: Networks.TESTNET },
  { ttlMs: { getFee: 60_000 } },
);

await cached.getFee();               // simulated against the network
await cached.getFee();               // served from cache

await cached.client.setFee(50, adminKeypair); // invalidates the cached fee
await cached.invalidateCache('getAdmin');     // or drop a key by hand
```

---

### `InMemoryCache`

The default [`ICacheProvider`](#icacheprovider): a process-local `Map` with per-entry TTLs. Expired entries are evicted lazily on read. Implement `ICacheProvider` yourself to back the cache with Redis, `localStorage`, or anything else.

```ts
class InMemoryCache implements ICacheProvider {
  async get<T>(key: string): Promise<T | undefined>
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void>
  async delete(key: string): Promise<void>
  async clear(): Promise<void>
}
```

- **Example**:
```ts
import { InMemoryCache, CachedContractClient } from '@stellar/c-address-onboarding-bridge-sdk';

const provider = new InMemoryCache();
await provider.set('custom', { hello: 'world' }, 30_000); // expires in 30s

const cached = new CachedContractClient(config, { provider });
```

---

### `EventSubscriber`

Polls Soroban RPC for contract events and dispatches them to typed listeners. Polling starts automatically when the first listener is registered and stops when the last one is removed.

#### Constructor

```ts
constructor(config: EventSubscriberConfig)
```
- **Parameters**:
  - `config`: [`EventSubscriberConfig`](#eventsubscriberconfig)

---

#### Methods

##### `on`
```ts
on<K extends BridgeEventName>(
  eventName: K,
  callback: BridgeEventCallback<K>
): Unsubscribe
```
Registers a listener for one event name, `'error'`, or `'*'` for every event. Starts the polling loop on the first call. Throws if the subscriber has been destroyed.
- **Parameters**:
  - `eventName`: [`BridgeEventName`](#type-aliases)
  - `callback`: [`BridgeEventCallback<K>`](#type-aliases)
- **Returns**: [`Unsubscribe`](#type-aliases) — call it to remove this listener.

##### `off`
```ts
off(eventName: BridgeEventName): void
```
Removes every listener registered for one event name.
- **Parameters**:
  - `eventName`: [`BridgeEventName`](#type-aliases)
- **Returns**: `void`

##### `listenerCount`
```ts
listenerCount(): number
```
Total number of registered callbacks across all event names.
- **Returns**: `number`

##### `poll`
```ts
async poll(): Promise<void>
```
Runs a single poll immediately, for tests or on-demand refresh. RPC failures are dispatched to `'error'` listeners rather than thrown.
- **Returns**: `Promise<void>`

##### `destroy`
```ts
destroy(): void
```
Stops polling and removes all listeners. The instance cannot be reused afterwards.
- **Returns**: `void`

- **Example**:
```ts
import { EventSubscriber } from '@stellar/c-address-onboarding-bridge-sdk';

const subscriber = new EventSubscriber({
  contractId: 'CA...',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  pollingIntervalMs: 5000,
  startLedger: 'now',
});

const unsubscribe = subscriber.on('CAddressFunded', (event) => {
  console.log(`${event.amount} of ${event.asset} -> ${event.target} (fee ${event.fee})`);
});

subscriber.on('error', (err) => console.error('poll failed', err));

// later
unsubscribe();
subscriber.destroy();
```

---

## Functions

### Retry Utilities

Exported from the SDK root for use with any async operation, not just SDK calls.

##### `withRetry`
```ts
async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>
```
Runs `fn`, retrying transient failures with exponential backoff plus full jitter. The initial call is attempt 0 and up to `maxRetries` further attempts follow. Errors classified as permanent are re-thrown immediately; the last error is re-thrown once retries are exhausted. Pass `options.signal` to cancel an in-flight loop — see [Cancelling Retries](#cancelling-retries).
- **Parameters**:
  - `fn`: `() => Promise<T>`
  - `options`: [`RetryOptions`](#retryoptions) (optional)
- **Returns**: `Promise<T>`

##### `withRpcRetry`
```ts
function withRpcRetry<T extends object>(
  provider: T,
  options?: RpcRetryOptions
): T
```
Wraps an RPC provider in a transparent proxy so each method is retried under the policy matching its nature: read methods use `VIEW_RETRY_POLICY`, `sendTransaction` uses `STATE_CHANGING_RETRY_POLICY`, and anything else passes through untouched. Method signatures and return values are unchanged, so the proxy can replace the provider in place. The SDK applies this to its own RPC server automatically.
- **Parameters**:
  - `provider`: `T` — typically a `SorobanRpc.Server`.
  - `options`: [`RpcRetryOptions`](#rpcretryoptions) (optional)
- **Returns**: `T`

##### `isRetryableRpcError`
```ts
function isRetryableRpcError(error: unknown): boolean
```
Classifies an error as transient (worth retrying) or permanent. Matches transient network error codes, the retryable HTTP statuses, and a set of message patterns; returns `false` for validation errors and contract reverts. See [RPC Retry & Transient Errors](#rpc-retry--transient-errors) for the full lists.
- **Parameters**:
  - `error`: `unknown`
- **Returns**: `boolean`

##### `computeBackoffDelay`
```ts
function computeBackoffDelay(
  attempt: number,
  baseDelayMs?: number,
  maxDelayMs?: number,
  jitter?: boolean
): number
```
Computes the delay before a given retry. Without jitter the sequence is `base, base*2, base*4, …` capped at `maxDelayMs`. With full jitter the result is uniform in `[0, cappedDelay]`.
- **Parameters**:
  - `attempt`: `number` — 0-based retry index.
  - `baseDelayMs`: `number` (optional, default `1000`)
  - `maxDelayMs`: `number` (optional, default `30000`)
  - `jitter`: `boolean` (optional, default `true`)
- **Returns**: `number` — delay in milliseconds.

- **Example**:
```ts
import { withRetry, withRpcRetry, isRetryableRpcError } from '@stellar/c-address-onboarding-bridge-sdk';

// Retry an arbitrary async operation.
const data = await withRetry(() => fetch(url).then((r) => r.json()), {
  maxRetries: 5,
  baseDelayMs: 500,
  onRetry: ({ attempt, delayMs }) => console.warn(`retry ${attempt} in ${delayMs}ms`),
});

// Or wrap a whole RPC provider.
const server = withRpcRetry(new SorobanRpc.Server(rpcUrl), { maxRetries: 4 });

if (!isRetryableRpcError(err)) throw err;
```

---

### Observability Helpers

##### `ConsoleLogger`
```ts
const ConsoleLogger: ObservabilityHooks
```
A ready-made [`ObservabilityHooks`](#observabilityhooks) implementation that writes one `[bridge-sdk]` line per transaction start, RPC call, and transaction result to the console. Intended for local debugging.

##### `createOpenTelemetryHooks`
```ts
function createOpenTelemetryHooks(
  tracer: Tracer,
  options?: OpenTelemetryHooksOptions
): ObservabilityHooks
```
Builds hooks backed by an OpenTelemetry `Tracer`. Each mutating SDK method becomes a span carrying `bridge.method`, `bridge.tx.hash`, `bridge.tx.status`, and `bridge.duration_ms`. When `traceRpcCalls` is enabled (the default) each RPC round-trip becomes a child span with `rpc.method` and `rpc.duration_ms`.
- **Parameters**:
  - `tracer`: `Tracer` — from `trace.getTracer(...)` in `@opentelemetry/api`.
  - `options`: [`OpenTelemetryHooksOptions`](#opentelemetryhooksoptions) (optional)
- **Returns**: [`ObservabilityHooks`](#observabilityhooks)

##### `composeHooks`
```ts
function composeHooks(...hooks: ObservabilityHooks[]): ObservabilityHooks
```
Merges several hook objects into one that forwards every callback to each of them in order. Useful for combining `ConsoleLogger` with your own metrics hooks.
- **Parameters**:
  - `...hooks`: [`ObservabilityHooks[]`](#observabilityhooks)
- **Returns**: [`ObservabilityHooks`](#observabilityhooks)

- **Example**:
```ts
import { trace } from '@opentelemetry/api';
import {
  OnboardingBridgeSDK,
  ConsoleLogger,
  composeHooks,
  createOpenTelemetryHooks,
} from '@stellar/c-address-onboarding-bridge-sdk';

const tracer = trace.getTracer('my-service', '1.0.0');

const sdk = new OnboardingBridgeSDK({
  contractId: 'CA...',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  hooks: composeHooks(
    ConsoleLogger,
    createOpenTelemetryHooks(tracer, { spanPrefix: 'my-service/bridge' }),
    { onRpcCall: (method, _params, durationMs) => metrics.histogram('rpc', durationMs, { method }) },
  ),
});
```

---

## Constants

| Constant | Type | Value | Description |
| :--- | :--- | :--- | :--- |
| `BATCH_TX_LIMIT` | `number` | `100` | Maximum `(target, amount)` pairs per `batch_fund_c_address` call, matching the contract's on-chain `MAX_BATCH_SIZE`. `batchFundCAddresses` splits longer lists into chunks of this size. |
| `BASE_RESERVE_STROOPS` | `number` | `5_000_000` | Stellar's default base reserve (0.5 XLM) used by [`estimateCost`](#estimatecost). Override per instance with `BridgeConfig.baseReserveStroops`. |
| `VIEW_RETRY_POLICY` | `Required<Pick<RetryOptions, 'maxRetries' \| 'baseDelayMs' \| 'maxDelayMs' \| 'jitter'>>` | `{ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitter: true }` | Retry policy for idempotent read-only RPC calls. |
| `STATE_CHANGING_RETRY_POLICY` | same as above | `{ maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 30000, jitter: true }` | Conservative policy for `sendTransaction`, limiting double-submission risk. |

---

## Interfaces

### `BridgeConfig`
Defines configuration properties to connect the SDK to the network.

| Field | Type | Description |
| :--- | :--- | :--- |
| `contractId` | `string` | Stellar Contract ID (C-address format) of the bridge. |
| `rpcUrl` | `string` | URL of the Soroban RPC server. |
| `networkPassphrase` | `string` | Network identifier (e.g. `Test SDF Network ; September 2015`). |
| `timeout` | `number` | *Optional*. Timeout in seconds for Soroban operations. |
| `retry` | `RpcRetryOptions` | *Optional*. Retries configuration for RPC requests. |
| `hooks` | `ObservabilityHooks` | *Optional*. Instrumentation callbacks for SDK methods and RPC calls. |
| `baseReserveStroops` | `number \| string` | *Optional*. Network base reserve in stroops used by [`estimateCost`](#estimatecost). Defaults to `BASE_RESERVE_STROOPS` (5,000,000). |

---

### `FundCOptions`
Input parameters for simple single-target funding operations.

| Field | Type | Description |
| :--- | :--- | :--- |
| `source` | `string` | G-address or C-address sending the funds. |
| `target` | `string` | Destination C-address. |
| `asset` | `string` | Token contract address. |
| `amount` | `string` | Amount in the token's smallest unit (e.g., stroops). |

---

### `BatchFundCOptions`
Input parameters for multi-target batch funding operations.

| Field | Type | Description |
| :--- | :--- | :--- |
| `source` | `string` | G-address sending the funds. |
| `targets` | `string[]` | Array of destination C-addresses. |
| `amounts` | `string[]` | Array of amounts corresponding to each target address. |
| `asset` | `string` | Token contract address. |

---

### `WithdrawFeesOptions`
Parameters for fee collection.

| Field | Type | Description |
| :--- | :--- | :--- |
| `asset` | `string` | Token contract address to collect. |
| `amount` | `string` | Amount in smallest unit. |

---

### `OffRampConfig`
Static key definitions for off-ramp integrations.

| Field | Type | Description |
| :--- | :--- | :--- |
| `moonpayApiKey` | `string` | *Optional*. Moonpay API Key. |
| `transakApiKey` | `string` | *Optional*. Transak API Key. |
| `rampApiKey` | `string` | *Optional*. Ramp API Key. |
| `banxaApiKey` | `string` | *Optional*. Banxa API Key. |
| `testMode` | `boolean` | *Optional*. Enables sandbox URLs if `true`. |

---

### `TransactionResult`
The result of an on-chain transaction submission.

| Field | Type | Description |
| :--- | :--- | :--- |
| `hash` | `string` | On-chain transaction hash. |
| `status` | `'success' \| 'pending' \| 'failed'` | Execution status. |
| `error` | `string` | *Optional*. Error description if `status` is `'failed'`. |

---

### `FundCAddressWithSwapOptions`
Input details for swap-and-bridge operations.

| Field | Type | Description |
| :--- | :--- | :--- |
| `source` | `string` | G-address providing the source asset. |
| `target` | `string` | Destination C-address. |
| `sourceAsset` | `string` | Token contract address held by the source. |
| `targetAsset` | `string` | Token contract address the target receives. |
| `sourceAmount` | `string` | Raw input amount of the source asset. |
| `minTargetAmount` | `string` | Minimum acceptable amount of the target asset (slippage limit). |
| `swapRoute` | `string[]` | Ordered array of DEX pool contract addresses. |

---

### `CrossChainFundOptions`
Parameters for bridge relay submissions.

| Field | Type | Description |
| :--- | :--- | :--- |
| `chainId` | `number` | Numeric source chain identifier (e.g. 1 = Ethereum). |
| `txHash` | `string` | Hash of the source transaction. |
| `target` | `string` | Destination C-address. |
| `asset` | `string` | Whitelisted token contract on Soroban. |
| `amount` | `string` | Total gross amount. |
| `sigs` | `RelayerSig[]` | Attestations signed by authorized relayers. |

---

### `CreateCOptions`
Options to deploy a new C-address contract deterministically.

| Field | Type | Description |
| :--- | :--- | :--- |
| `deployerKeypair` | `any` | Deployer's keypair. |
| `salt` | `string` | *Optional*. 32-byte hex salt for address derivation. |
| `initialFunds` | `{ asset: string, amount: string }` | *Optional*. Initial transfer details. |

---

### `CreateCAddressResult`
The return value of C-address deployment.

| Field | Type | Description |
| :--- | :--- | :--- |
| `cAddress` | `string` | Deployed contract C-address. |
| `txHash` | `string` | Transaction hash. |

---

### `PaginatedResult<T>`
Standard return wrapping for paginated queries.

| Field | Type | Description |
| :--- | :--- | :--- |
| `items` | `T[]` | Retrieved items in the page. |
| `cursor` | `string` | *Optional*. Base64 token for next page query. |
| `hasMore` | `boolean` | `true` if more items are available. |

---

### `PaginationOptions`
Parameters to page read queries.

| Field | Type | Description |
| :--- | :--- | :--- |
| `cursor` | `string` | *Optional*. Cursor token to continue listing. |
| `limit` | `number` | *Optional*. Maximum items per page (default: 20). |

---

### `CostEstimate`
Returned by [`estimateCost`](#estimatecost). All fee values are in stroops (1 XLM = 10,000,000 stroops).

| Field | Type | Description |
| :--- | :--- | :--- |
| `fee` | `string` | Total fee: inclusion fee plus resource fee. |
| `minBalance` | `string` | Minimum balance the source account must hold, computed as `(2 + numSubentries) * baseReserve`. |
| `resourceFee` | `string` | Soroban resource fee covering CPU, memory, storage, and I/O. |
| `executionTimeMs` | `number` | Wall-clock duration of the simulation, useful as an RPC-load signal. |

---

### `CacheOptions`
Second argument to the [`CachedContractClient`](#cachedcontractclient) constructor.

| Field | Type | Description |
| :--- | :--- | :--- |
| `provider` | `ICacheProvider` | *Optional*. Backing store. Defaults to a new [`InMemoryCache`](#inmemorycache). |
| `ttlMs` | `Partial<Record<CacheKey, number>>` | *Optional*. Per-key TTL overrides in milliseconds. Unspecified keys keep their defaults. |

---

### `ICacheProvider`
Storage abstraction behind [`CachedContractClient`](#cachedcontractclient). Every method is asynchronous so the same interface fits in-memory, Redis, and `localStorage` backends.

| Method | Signature | Description |
| :--- | :--- | :--- |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | Returns the cached value, or `undefined` if absent or expired. |
| `set` | `set<T>(key: string, value: T, ttlMs?: number): Promise<void>` | Stores a value; omitting `ttlMs` stores it without expiry. |
| `delete` | `delete(key: string): Promise<void>` | Removes one key. |
| `clear` | `clear(): Promise<void>` | Removes every key. |

---

### `RetryOptions`
Options for [`withRetry`](#retry-utilities).

| Field | Type | Description |
| :--- | :--- | :--- |
| `maxRetries` | `number` | *Optional*. Retries after the initial attempt (default: 3). |
| `baseDelayMs` | `number` | *Optional*. Delay for the first backoff step (default: 1000). |
| `maxDelayMs` | `number` | *Optional*. Upper bound for any single delay (default: 30000). |
| `jitter` | `boolean` | *Optional*. Apply full jitter to each delay (default: `true`). |
| `isRetryable` | `RetryableClassifier` | *Optional*. Error classifier (default: `isRetryableRpcError`). |
| `onRetry` | `RetryLogger` | *Optional*. Called once per retry (default: no-op). |
| `signal` | `AbortSignal` | *Optional*. Cancels the loop. Checked before each attempt and interrupts the pending backoff, so an abort takes effect immediately. |

---

### `RpcRetryOptions`
Options for [`withRpcRetry`](#retry-utilities), also accepted as `BridgeConfig.retry`.

| Field | Type | Description |
| :--- | :--- | :--- |
| `maxRetries` | `number` | *Optional*. Retries for view calls (default: 3). State-changing calls are capped at 1 regardless. |
| `baseDelayMs` | `number` | *Optional*. Delay for the first backoff step (default: 1000). |
| `maxDelayMs` | `number` | *Optional*. Upper bound for any single delay (default: 30000). |
| `jitter` | `boolean` | *Optional*. Apply full jitter (default: `true`). |
| `onRetry` | `RetryLogger` | *Optional*. Called once per retry (default: no-op). |

---

### `RetryAttempt`
The record passed to a `RetryLogger`.

| Field | Type | Description |
| :--- | :--- | :--- |
| `attempt` | `number` | 1-based index of the attempt that just failed. |
| `maxRetries` | `number` | Total retries allowed after the initial attempt. |
| `delayMs` | `number` | Delay before the next attempt. |
| `error` | `unknown` | The error that triggered the retry. |

---

### `ObservabilityHooks`
Instrumentation callbacks, passed as `BridgeConfig.hooks`. Supply any subset. Exceptions thrown inside a hook are caught and logged, so instrumentation never disrupts SDK behaviour.

| Field | Type | Description |
| :--- | :--- | :--- |
| `onTransactionStart` | `(method: string, params: unknown) => void` | *Optional*. Fires before a mutating method runs. `params` excludes keypairs. |
| `onTransactionSuccess` | `(method: string, result: unknown, durationMs: number) => void` | *Optional*. Fires when a mutating method returns without throwing — including `status: 'failed'` results. |
| `onTransactionError` | `(method: string, error: Error, durationMs: number) => void` | *Optional*. Fires only on an unhandled exception, not on a `'failed'` result. |
| `onRpcCall` | `(method: string, params: unknown, durationMs: number) => void` | *Optional*. Fires after every internal RPC call, whether it succeeded or failed. |

---

### `OpenTelemetryHooksOptions`
Second argument to [`createOpenTelemetryHooks`](#observability-helpers).

| Field | Type | Description |
| :--- | :--- | :--- |
| `traceRpcCalls` | `boolean` | *Optional*. Record RPC calls as child spans of the transaction span (default: `true`). |
| `spanPrefix` | `string` | *Optional*. Prefix for all span names (default: `'bridge-sdk'`). |

---

### `EventSubscriberConfig`
Constructor argument for [`EventSubscriber`](#eventsubscriber).

| Field | Type | Description |
| :--- | :--- | :--- |
| `contractId` | `string` | Deployed bridge contract ID (C-address). |
| `rpcUrl` | `string` | Soroban RPC URL. |
| `networkPassphrase` | `string` | *Optional*. Used only when constructing the RPC server. |
| `pollingIntervalMs` | `number` | *Optional*. Poll interval in milliseconds (default: 5000). |
| `startLedger` | `number \| 'now'` | *Optional*. `'now'` (default) sees only new events; a ledger number replays from that point. |
| `limit` | `number` | *Optional*. Maximum events fetched per poll (default: 100). |

---

### Bridge Event Payloads

Every payload carries `ledger` (`number`, the emitting ledger sequence) and `pagingToken` (`string`, the cursor for polling) alongside the fields below.

#### `CAddressFundedEvent`
| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | `'CAddressFunded'` | Discriminant. |
| `asset` | `string` | Token contract address. |
| `source` | `string` | Account that provided the tokens. |
| `target` | `string` | C-address that received them. |
| `amount` | `string` | Gross amount transferred. |
| `fee` | `string` | Fee deducted from the gross amount. |

#### `FeesWithdrawnEvent`
| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | `'FeesWithdrawn'` | Discriminant. |
| `feeCollector` | `string` | Address that received the fees. |
| `amount` | `string` | Amount withdrawn. |
| `asset` | `string` | Token contract address. |

#### `AdminChangedEvent`
| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | `'AdminChanged'` | Discriminant. |
| `oldAdmin` | `string` | Previous admin address. |
| `newAdmin` | `string` | New admin address. |

#### `MetaFundExecutedEvent`
| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | `'MetaFundExecuted'` | Discriminant. |
| `asset` | `string` | Token contract address. |
| `source` | `string` | Account that provided the tokens. |
| `target` | `string` | C-address that received them. |
| `amount` | `string` | Gross amount transferred. |
| `fee` | `string` | Fee deducted. |
| `nonce` | `string` | Meta-transaction nonce. |

#### `GenericBridgeEvent`
Catch-all for contract events without a dedicated type.

| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Event name as emitted. |
| `topics` | `unknown[]` | Raw topics decoded to native JS values. |
| `value` | `unknown` | Raw value decoded to a native JS value. |

---

## Type Aliases

| Alias | Definition | Description |
| :--- | :--- | :--- |
| `CacheKey` | `'getFee' \| 'getFeeCollector' \| 'getAdmin' \| 'isInitialized'` | The view methods [`CachedContractClient`](#cachedcontractclient) caches. |
| `BatchProgressCallback` | `(completed: number, total: number, txHash?: string) => void` | Progress reporter for `batchFundCAddresses`, invoked once per submitted chunk. |
| `RetryLogger` | `(attempt: RetryAttempt) => void` | Receives one record per retry. Defaults to a no-op. |
| `RetryableClassifier` | `(error: unknown) => boolean` | Decides whether a thrown error is worth retrying. |
| `BridgeEventName` | `keyof BridgeEventMap` | `'CAddressFunded' \| 'FeesWithdrawn' \| 'AdminChanged' \| 'MetaFundExecuted' \| 'error' \| '*'`. |
| `BridgeEventPayload` | Union of the five event payload interfaces | The value delivered to a `'*'` listener. |
| `BridgeEventMap` | Interface mapping each event name to its payload | `'error'` maps to `Error`; `'*'` maps to `BridgeEventPayload`. |
| `BridgeEventCallback<K>` | `(event: BridgeEventMap[K]) => void` | Listener signature for event name `K`. |
| `Unsubscribe` | `() => void` | Returned by `EventSubscriber.on`; call it to remove that listener. |

---

## Error Handling & Validation

### Validation Methods

The SDK performs frontend validation on Stellar address inputs using the following functions:
- `assertAccountAddress(address: string, field: string)`: Validates that the input is a valid Stellar G-address (ed25519 public key). Throws if validation fails.
- `assertContractAddress(address: string, field: string)`: Validates that the input is a valid Stellar contract C-address. Throws if validation fails.

---

### RPC Retry & Transient Errors

The SDK includes transient error detection and auto-retries via exponential backoff with jitter.

#### Retryable Error Classes
The SDK retries if it catches:
1. **Network Errors**: `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EPIPE`, `ENETUNREACH`, `EHOSTUNREACH`.
2. **HTTP Transient Statuses**: `429` (Rate Limited), `502` (Bad Gateway), `503` (Service Unavailable), `504` (Gateway Timeout).
3. **Common Message Regex Patterns**: `(timeout|timed out|rate limit|too many requests|network error|socket hang up|fetch failed|service unavailable|temporarily unavailable|connection reset|connection refused)`.

#### Retry Policies
- **Read-Only / Idempotent Calls (`VIEW_RETRY_POLICY`)**: Automatically retries up to 3 times (first backoff at 1s, capped at 30s) using exponential backoff + jitter.
- **State-Changing / Write Calls (`STATE_CHANGING_RETRY_POLICY`)**: Automatically retries **only once** to prevent double-spending, keeping the transaction envelope's sequence identical.

---

### Cancelling Retries

With the defaults, a single [`withRetry`](#retry-utilities) call can spend tens of seconds asleep between attempts. Pass an `AbortSignal` as `RetryOptions.signal` to cut that short — for example when a UI component unmounts while a request is still backing off.

The signal is honoured in three places: before the first attempt (an already-aborted signal means `fn` never runs), between attempts, and **during** the backoff delay itself. Aborting therefore takes effect immediately rather than after the current sleep elapses. The returned promise rejects with the signal's `reason`, so an abort is distinguishable from an RPC failure.

```ts
import { withRetry } from '@stellar/c-address-onboarding-bridge-sdk';

const controller = new AbortController();

// Abandon the operation if it has not settled within 5 seconds.
const timer = setTimeout(() => controller.abort(new Error('took too long')), 5000);

try {
  const result = await withRetry(() => server.getTransaction(hash), {
    maxRetries: 3,
    signal: controller.signal,
  });
  console.log(result);
} catch (err) {
  if (controller.signal.aborted) {
    console.warn('cancelled:', err); // Error: took too long
  } else {
    throw err;
  }
} finally {
  clearTimeout(timer);
}
```

In React, wire the signal to the effect cleanup so an unmount stops the loop:

```ts
useEffect(() => {
  const controller = new AbortController();
  withRetry(() => sdk.getFee(), { signal: controller.signal })
    .then(setFee)
    .catch((err) => {
      if (!controller.signal.aborted) setError(err);
    });
  return () => controller.abort();
}, []);
```

---

### Common Error Scenarios & Solutions

#### 1. `SlippageExceeded` Reverts
- **Scenario**: A swap-and-bridge transaction using `fundCAddressWithSwap` fails on-chain.
- **Cause**: The price of the asset fluctuated on the DEX, causing the output of the swap to drop below `minTargetAmount`.
- **Solution**: Increase the `minTargetAmount` tolerance slightly (higher slippage allowance) or execute the swap in a less volatile window.

#### 2. `Invalid account address` / `Invalid contract address`
- **Scenario**: The SDK throws a validation error before submitting a transaction.
- **Cause**: G-address format was passed where C-address was expected, or vice versa.
- **Solution**: Ensure destination wallets are contract accounts (C-addresses starting with `C...`) and signing accounts are standard Stellar accounts (G-addresses starting with `G...`).

#### 3. `429 Too Many Requests`
- **Scenario**: API or RPC queries are getting rejected.
- **Cause**: The public Soroban RPC node rate limits have been exceeded.
- **Solution**: Use a private RPC node provider or configure custom `retry` settings in [`BridgeConfig`](#bridgeconfig) with a higher `baseDelayMs` to stagger requests.
