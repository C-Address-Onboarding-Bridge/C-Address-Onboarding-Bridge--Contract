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

/** Emitted when the admin address is changed. */
export interface AdminChangedEvent {
  name: 'AdminChanged';
  /** Previous admin address */
  oldAdmin: string;
  /** New admin address */
  newAdmin: string;
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
  | AdminChangedEvent
  | MetaFundExecutedEvent
  | GenericBridgeEvent;

// ---------------------------------------------------------------------------
// Event name map
// ---------------------------------------------------------------------------

/** Map from event name string to its typed payload type. */
export interface BridgeEventMap {
  CAddressFunded: CAddressFundedEvent;
  FeesWithdrawn: FeesWithdrawnEvent;
  AdminChanged: AdminChangedEvent;
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
 * All polling happens in a `setInterval` loop. Call `destroy()` to stop it and
 * release all listeners.
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

  /** NodeJS/browser interval handle. */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

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
    if (this.intervalHandle === null) {
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
      // Stop polling when no listeners remain (preserve 'error' listeners for
      // the polling loop — only stop when ALL listeners are gone, including
      // error listeners).
      if (this.listenerCount() === 0) {
        this.stopPolling();
      }
    };
  }

  /**
   * Remove all listeners for a specific event name.
   */
  off(eventName: BridgeEventName): void {
    this.listeners.delete(eventName);
    if (this.listenerCount() === 0) {
      this.stopPolling();
    }
  }

  /**
   * Stop polling and remove all listeners. The subscriber cannot be reused
   * after this call.
   */
  destroy(): void {
    this.destroyed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Total number of registered listeners across all event names. */
  private listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }

  /** Start the polling loop. */
  private startPolling(): void {
    // Kick off an immediate poll, then schedule subsequent polls.
    void this.poll();
    this.intervalHandle = setInterval(() => {
      void this.poll();
    }, this.pollingIntervalMs);
  }

  /** Stop the polling loop. */
  private stopPolling(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Build the RPC event filter for this contract.
   *
   * NOTE: In Soroban RPC each segment of a `topics` filter matches exactly one
   * topic, so a filter like `topics: [['*']]` only matches events with exactly
   * one topic (e.g. `ContractPaused`). Multi-topic events such as
   * `CAddressFunded` (4 topics), `AdminTransferred` (3 topics) and
   * `FeesWithdrawn` (2 topics) would never match.
   *
   * To receive every event emitted by the contract we therefore omit the
   * `topics` field entirely, which matches all events of the contract
   * regardless of how many topics they carry.
   */
  private buildFilter(): SorobanRpc.Api.EventFilter {
    return {
      type: 'contract',
      contractIds: [this.contractId],
    };
  }

  /** Perform a single poll of the RPC for new events. */
  private async poll(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    try {
      const response = await this.server.getEvents({
        filters: [this.buildFilter()],
        cursor: this.cursor as any,
        limit: this.limit,
      });

      for (const raw of response.events) {
        this.dispatch(raw);
      }

      // Advance the cursor to the latest paging token so the next poll only
      // returns newer events.
      if (response.events.length > 0) {
        this.cursor = response.events[response.events.length - 1].pagingToken;
      }
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Decode a raw RPC event and dispatch it to matching listeners. */
  private dispatch(raw: SorobanRpc.Api.EventResponse): void {
    const topics = raw.topic.map((t) => scValToNative(t));
    const name = typeof topics[0] === 'string' ? (topics[0] as string) : '';
    const value = scValToNative(raw.value);

    const payload = this.buildPayload(name, topics, value, raw);

    // Notify specific listeners
    const specific = this.listeners.get(name);
    if (specific) {
      for (const cb of specific) {
        cb(payload);
      }
    }

    // Notify wildcard listeners
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const cb of wildcard) {
        cb(payload);
      }
    }
  }

  /** Build a typed payload from decoded topics/value. */
  private buildPayload(
    name: string,
    topics: unknown[],
    value: unknown,
    raw: SorobanRpc.Api.EventResponse,
  ): BridgeEventPayload {
    const base = {
      ledger: raw.ledger,
      pagingToken: raw.pagingToken,
    };

    const v = (value ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'CAddressFunded':
        return {
          name: 'CAddressFunded',
          asset: String(v.asset ?? topics[1] ?? ''),
          source: String(v.source ?? topics[2] ?? ''),
          target: String(v.target ?? topics[3] ?? ''),
          amount: String(v.amount ?? ''),
          fee: String(v.fee ?? ''),
          ...base,
        };
      case 'FeesWithdrawn':
        return {
          name: 'FeesWithdrawn',
          feeCollector: String(v.feeCollector ?? topics[1] ?? ''),
          amount: String(v.amount ?? ''),
          asset: String(v.asset ?? ''),
          ...base,
        };
      case 'AdminChanged':
        return {
          name: 'AdminChanged',
          oldAdmin: String(v.oldAdmin ?? topics[1] ?? ''),
          newAdmin: String(v.newAdmin ?? topics[2] ?? ''),
          ...base,
        };
      case 'MetaFundExecuted':
        return {
          name: 'MetaFundExecuted',
          asset: String(v.asset ?? ''),
          source: String(v.source ?? ''),
          target: String(v.target ?? ''),
          amount: String(v.amount ?? ''),
          fee: String(v.fee ?? ''),
          nonce: String(v.nonce ?? ''),
          ...base,
        };
      default:
        return {
          name,
          topics,
          value,
          ...base,
        };
    }
  }

  /** Emit an error to any registered 'error' listeners. */
  private emitError(err: Error): void {
    const set = this.listeners.get('error');
    if (set) {
      for (const cb of set) {
        cb(err);
      }
    }
  }
}
