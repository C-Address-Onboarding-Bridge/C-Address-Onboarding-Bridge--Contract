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
   * Stop polling and remove all listeners. The instance cannot be reused.
   */
  destroy(): void {
    this.destroyed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internal polling
  // -------------------------------------------------------------------------

  private startPolling(): void {
    // Kick off an immediate poll, then schedule subsequent polls.
    void this.poll();
    this.intervalHandle = setInterval(() => {
      void this.poll();
    }, this.pollingIntervalMs);
  }

  private stopPolling(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }

  /**
   * Resolve the `'now'` sentinel to a concrete ledger sequence by querying the
   * RPC for the latest ledger. `getEvents` requires either `startLedger` or
   * `cursor`, so the default configuration must be materialised before the
   * first request.
   */
  private async resolveStartLedger(): Promise<number> {
    const latest = await this.server.getLatestLedger();
    return latest.sequence;
  }

  /**
   * Perform a single poll: fetch events since the current cursor and dispatch
   * them to matching listeners.
   */
  private async poll(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    try {
      // Materialise the `'now'` sentinel on the first poll so the RPC request
      // carries a concrete `startLedger`.
      if (this.cursor === 'now') {
        this.cursor = await this.resolveStartLedger();
      }

      const response = await this.fetchAndDispatch();

      // Advance the cursor so the start ledger does not age out of retention
      // when a poll returns no events.
      if (response) {
        if (response.cursor) {
          this.cursor = response.cursor;
        } else if (typeof response.latestLedger === 'number') {
          this.cursor = response.latestLedger;
        }
      }
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Fetch events from the RPC and dispatch them. Returns the raw RPC response
   * so the caller can advance the cursor.
   */
  private async fetchAndDispatch(): Promise<SorobanRpc.Api.GetEventsResponse | null> {
    const request: SorobanRpc.Api.GetEventsRequest = {
      filters: [{ type: 'contract', contractIds: [this.contractId] }],
      limit: this.limit,
    };

    if (typeof this.cursor === 'number') {
      request.startLedger = this.cursor;
    } else {
      request.cursor = this.cursor;
    }

    const response = await this.server.getEvents(request);

    for (const raw of response.events) {
      const decoded = this.decodeEvent(raw);
      if (decoded) {
        this.dispatch(decoded);
      }
    }

    return response;
  }

  /**
   * Decode a raw RPC event into a typed bridge event payload.
   */
  private decodeEvent(raw: SorobanRpc.Api.EventResponse): BridgeEventPayload | null {
    try {
      const topics = raw.topic.map((t) => scValToNative(t));
      const name = typeof topics[0] === 'string' ? topics[0] : String(topics[0]);
      const value = scValToNative(raw.value);
      const ledger = raw.ledger;
      const pagingToken = raw.pagingToken;

      switch (name) {
        case 'CAddressFunded': {
          const v = value as Record<string, unknown>;
          return {
            name: 'CAddressFunded',
            asset: String(v.asset ?? topics[1] ?? ''),
            source: String(v.source ?? topics[2] ?? ''),
            target: String(v.target ?? topics[3] ?? ''),
            amount: String(v.amount ?? ''),
            fee: String(v.fee ?? ''),
            ledger,
            pagingToken,
          };
        }
        case 'FeesWithdrawn': {
          const v = value as Record<string, unknown>;
          return {
            name: 'FeesWithdrawn',
            feeCollector: String(v.feeCollector ?? topics[1] ?? ''),
            amount: String(v.amount ?? ''),
            asset: String(v.asset ?? ''),
            ledger,
            pagingToken,
          };
        }
        case 'AdminChanged': {
          const v = value as Record<string, unknown>;
          return {
            name: 'AdminChanged',
            oldAdmin: String(v.oldAdmin ?? topics[1] ?? ''),
            newAdmin: String(v.newAdmin ?? topics[2] ?? ''),
            ledger,
            pagingToken,
          };
        }
        case 'MetaFundExecuted': {
          const v = value as Record<string, unknown>;
          return {
            name: 'MetaFundExecuted',
            asset: String(v.asset ?? topics[1] ?? ''),
            source: String(v.source ?? topics[2] ?? ''),
            target: String(v.target ?? topics[3] ?? ''),
            amount: String(v.amount ?? ''),
            fee: String(v.fee ?? ''),
            nonce: String(v.nonce ?? ''),
            ledger,
            pagingToken,
          };
        }
        default:
          return {
            name,
            topics,
            value,
            ledger,
            pagingToken,
          };
      }
    } catch {
      return null;
    }
  }

  /**
   * Dispatch a decoded event to all matching listeners.
   */
  private dispatch(event: BridgeEventPayload): void {
    const specific = this.listeners.get(event.name);
    if (specific) {
      for (const cb of specific) {
        cb(event);
      }
    }

    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const cb of wildcard) {
        cb(event);
      }
    }
  }

  /**
   * Emit an error to all `'error'` listeners.
   */
  private emitError(err: Error): void {
    const set = this.listeners.get('error');
    if (set) {
      for (const cb of set) {
        cb(err);
      }
    }
  }
}
