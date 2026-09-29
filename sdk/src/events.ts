/**
 * Issue #57: SDK Event Subscription Support
 *
 * Provides a polling-based event subscriber for the OnboardingBridge contract.
 *
 * Usage:
 * ```ts
 * const sub = new EventSubscriber({ contractId, rpcUrl, networkPassphrase });
 *
 * // Typed specific event
 * const unsub = sub.on('CAddressFunded', (event) => { ... });
 *
 * // Wildcard — receive every event
 * const unsubAll = sub.on('*', (event) => { ... });
 *
 * // Stop listening
 * unsub();
 *
 * // Tear down the whole subscriber (stops polling)
 * sub.destroy();
 * ```
 */

import { SorobanRpc, scValToNative } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/** Emitted when a C-address is successfully funded. */
export interface CAddressFundedEvent {
  /** Contract event name */
  name: 'CAddressFunded';
  /** Token contract address */
  asset: string;
  /** Source account that provided the tokens */
  source: string;
  /** Target C-address that received the tokens */
  target: string;
  /** Gross amount transferred */
  amount: string;
  /** Fee deducted from the gross amount */
  fee: string;
  /** Ledger sequence number when the event was emitted */
  ledger: number;
  /** Paging token for cursor-based polling */
  pagingToken: string;
}

/** Emitted when accumulated fees are withdrawn by the fee collector. */
export interface FeesWithdrawnEvent {
  name: 'FeesWithdrawn';
  /** Fee collector address that received the fees */
  feeCollector: string;
  /** Amount withdrawn */
  amount: string;
  /** Token contract address */
  asset: string;
  ledger: number;
  pagingToken: string;
}

/**
 * Emitted when a new admin is proposed (contract `AdminProposed`).
 * The transfer only takes effect once the proposed admin accepts it.
 */
export interface AdminProposedEvent {
  name: 'AdminProposed';
  /** Current admin address proposing the change */
  admin: string;
  /** Proposed new admin address */
  proposedAdmin: string;
  ledger: number;
  pagingToken: string;
}

/**
 * Emitted when a proposed admin accepts and the admin address changes
 * (contract `AdminTransferred`).
 */
export interface AdminTransferredEvent {
  name: 'AdminTransferred';
  /** Previous admin address */
  oldAdmin: string;
  /** New admin address */
  newAdmin: string;
  ledger: number;
  pagingToken: string;
}

/**
 * @deprecated The contract never emits `AdminChanged`. Admin changes are
 * emitted as `AdminProposed` / `AdminTransferred`. Kept as an alias for
 * backward compatibility.
 */
export interface AdminChangedEvent {
  name: 'AdminChanged';
  /** Previous admin address */
  oldAdmin: string;
  /** New admin address */
  newAdmin: string;
  ledger: number;
  pagingToken: string;
}

/**
 * Emitted when a new fee collector is proposed (contract
 * `FeeCollectorProposed`).
 */
export interface FeeCollectorProposedEvent {
  name: 'FeeCollectorProposed';
  /** Current fee collector proposing the change */
  feeCollector: string;
  /** Proposed new fee collector address */
  proposedFeeCollector: string;
  ledger: number;
  pagingToken: string;
}

/**
 * Emitted when a proposed fee collector accepts and the fee collector address
 * changes (contract `FeeCollectorTransferred`).
 */
export interface FeeCollectorTransferredEvent {
  name: 'FeeCollectorTransferred';
  /** Previous fee collector address */
  oldFeeCollector: string;
  /** New fee collector address */
  newFeeCollector: string;
  ledger: number;
  pagingToken: string;
}

/** Emitted when a meta-transaction fund is executed (issue #35). */
export interface MetaFundExecutedEvent {
  name: 'MetaFundExecuted';
  asset: string;
  source: string;
  target: string;
  amount: string;
  fee: string;
  nonce: string;
  ledger: number;
  pagingToken: string;
}

/** Catch-all: any contract event that is not explicitly typed. */
export interface GenericBridgeEvent {
  name: string;
  /** Raw event topics decoded to native JS values */
  topics: unknown[];
  /** Raw event value decoded to native JS value */
  value: unknown;
  ledger: number;
  pagingToken: string;
}

/** Union of all typed event payloads. */
export type BridgeEventPayload =
  | CAddressFundedEvent
  | FeesWithdrawnEvent
  | AdminProposedEvent
  | AdminTransferredEvent
  | AdminChangedEvent
  | FeeCollectorProposedEvent
  | FeeCollectorTransferredEvent
  | MetaFundExecutedEvent
  | GenericBridgeEvent;

// ---------------------------------------------------------------------------
// Event name map
// ---------------------------------------------------------------------------

/** Map from event name string to its typed payload type. */
export interface BridgeEventMap {
  CAddressFunded: CAddressFundedEvent;
  FeesWithdrawn: FeesWithdrawnEvent;
  AdminProposed: AdminProposedEvent;
  AdminTransferred: AdminTransferredEvent;
  /**
   * @deprecated The contract never emits `AdminChanged`; use
   * `AdminProposed` / `AdminTransferred` instead.
   */
  AdminChanged: AdminChangedEvent;
  FeeCollectorProposed: FeeCollectorProposedEvent;
  FeeCollectorTransferred: FeeCollectorTransferredEvent;
  MetaFundExecuted: MetaFundExecutedEvent;
  /**
   * Emitted when the polling loop encounters an RPC error.
   * Subscribe via `sub.on('error', (err) => { ... })` to detect
   * persistently-down endpoints.
   */
  'error': Error;
  /** Wildcard — receives every event regardless of name */
  '*': BridgeEventPayload;
}

export type BridgeEventName = keyof BridgeEventMap;

/** Callback signature for a specific event. */
export type BridgeEventCallback<K extends BridgeEventName> = (
  event: BridgeEventMap[K],
) => void;

/** Cleanup function returned by `on()`. Call it to unsubscribe. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Subscriber configuration
// ---------------------------------------------------------------------------

export interface EventSubscriberConfig {
  /** The deployed OnboardingBridge contract ID (C-address). */
  contractId: string;
  /** Soroban RPC URL. */
  rpcUrl: string;
  /** Network passphrase — used only for RPC Server construction. */
  networkPassphrase?: string;
  /**
   * Polling interval in milliseconds.
   * @default 5000
   */
  pollingIntervalMs?: number;
  /**
   * Starting ledger. Pass `'now'` (default) to only see new events, or a
   * specific ledger number to replay from that point.
   * @default 'now'
   */
  startLedger?: number | 'now';
  /**
   * Maximum events to fetch per poll.
   * @default 100
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// EventSubscriber
// ---------------------------------------------------------------------------

/**
 * Polls the Soroban RPC for contract events and dispatches them to registered
 * handlers.
 *
 * Polling uses a self-scheduling `setTimeout` loop: the next poll is only
 * scheduled after the previous `getEvents` call settles. This guarantees that
 * a slow RPC cannot cause overlapping fetches with the same cursor (which
 * would dispatch duplicate events and race on `this.cursor`). Call `destroy()`
 * to stop the loop and release all listeners.
 *
 * @example
 * ```ts
 * const sub = new EventSubscriber({
 *   contractId: 'C...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   pollingIntervalMs: 3000,
 * });
 *
 * const unsub = sub.on('CAddressFunded', (evt) => {
 *   console.log('Funded', evt.target, 'amount', evt.amount);
 * });
 *
 * // Later…
 * unsub();      // stop this specific listener
 * sub.destroy(); // stop polling entirely
 * ```
 */
export class EventSubscriber {
  private readonly contractId: string;
  private readonly server: SorobanRpc.Server;
  private readonly pollingIntervalMs: number;
  private readonly limit: number;

  /** Current cursor (paging token or ledger number). */
  private cursor: string | number;

  /** Registry of active listeners keyed by event name (including '*'). */
  private listeners: Map<string, Set<BridgeEventCallback<any>>>;

  /** NodeJS/browser timeout handle for the self-scheduling poll loop. */
  private intervalHandle: ReturnType<typeof setTimeout> | null = null;

  /** Whether a fetch is currently in flight (guards against overlap). */
  private polling = false;

  /** Whether destroy() has been called. */
  private destroyed = false;

  constructor(config: EventSubscriberConfig) {
    this.contractId = config.contractId;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.pollingIntervalMs = config.pollingIntervalMs ?? 5_000;
    this.limit = config.limit ?? 100;
    this.cursor = config.startLedger ?? 'now';
    this.listeners = new Map();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a listener for a specific event name or `'*'` for all events.
   *
   * Starts the polling loop on the first call.
   *
   * @returns An unsubscribe function — call it to remove this listener.
   */
  on<K extends BridgeEventName>(
    eventName: K,
    callback: BridgeEventCallback<K>,
  ): Unsubscribe {
    if (this.destroyed) {
      throw new Error('EventSubscriber has been destroyed');
    }

    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(callback as BridgeEventCallback<any>);

    // Auto-start polling when the first listener is registered
    if (this.intervalHandle === null && !this.polling) {
      this.startPolling();
    }

    return () => {
      const set = this.listeners.get(eventName);
      if (set) {
        set.delete(callback as BridgeEventCallback<any>);
        if (set.size === 0) {
          this.listeners.delete(eventName);
        }
      }
      // Stop polling when no listeners remain (preserve 'error' lis

/* … truncated 5789 chars — edit only what you need near the top … */
