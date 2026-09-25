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
   * Total number of registered callbacks across all event names.
   */
  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }

  /**
   * Tear down the subscriber: stop the polling loop and remove all listeners.
   * After calling `destroy()` this instance cannot be reused.
   */
  destroy(): void {
    this.stopPolling();
    this.listeners.clear();
    this.destroyed = true;
  }

  /**
   * Manually trigger a single poll. Useful in tests or for on-demand refresh.
   *
   * If the underlying RPC call rejects, the error is dispatched to registered
   * 'error' listeners before the exception propagates to the caller.
   */
  async poll(): Promise<void> {
    try {
      await this.fetchAndDispatch();
    } catch (err) {
      this.dispatchError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Polling internals
  // -------------------------------------------------------------------------

  private startPolling(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => {
      this.fetchAndDispatch().catch((err) => {
        // Emit to error listeners so consumers can detect persistently-down
        // RPC endpoints and react (e.g. circuit break, alert, reconnect).
        this.dispatchError(err instanceof Error ? err : new Error(String(err)));
      });
    }, this.pollingIntervalMs);
  }

  private stopPolling(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async fetchAndDispatch(): Promise<void> {
    const params: SorobanRpc.Server.GetEventsRequest = {
      filters: [
        {
          type: 'contract',
          contractIds: [this.contractId],
          topics: [['*']],
        },
      ],
      limit: this.limit,
    };

    // Attach cursor: either startLedger (number) or pagingToken (string).
    if (typeof this.cursor === 'number') {
      params.startLedger = this.cursor;
    } else if (typeof this.cursor === 'string' && this.cursor !== 'now') {
      params.cursor = this.cursor;
    }
    // When cursor === 'now', omit both — the RPC defaults to current ledger

    const response = await this.server.getEvents(params);

    for (const raw of response.events) {
      const payload = this.parseEvent(raw);
      if (payload) {
        this.dispatch(payload);
      }
      // Advance cursor to the last received paging token
      if (raw.pagingToken) {
        this.cursor = raw.pagingToken as string;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event parsing
  // -------------------------------------------------------------------------

  private parseEvent(raw: SorobanRpc.Api.EventResponse): BridgeEventPayload | null {
    try {
      const topics = raw.topic.map((t) => scValToNative(t));
      const value = scValToNative(raw.value);
      const ledger = raw.ledger;
      const pagingToken = raw.pagingToken;

      const name = typeof topics[0] === 'string' ? topics[0] : String(topics[0]);

      switch (name) {
        case 'CAddressFunded': {
          // topics: [name, asset, source, target]  value: [amount, fee]
          const [amount, fee] = Array.isArray(value)
            ? value.map(String)
            : [String(value), '0'];
          return {
            name: 'CAddressFunded',
            asset: String(topics[1] ?? ''),
            source: String(topics[2] ?? ''),
            target: String(topics[3] ?? ''),
            amount,
            fee,
            ledger,
            pagingToken,
          } satisfies CAddressFundedEvent;
        }

        case 'FeesWithdrawn': {
          // topics: [name, feeCollector]  value: [amount, asset]
          const [amount, asset] = Array.isArray(value)
            ? value.map(String)
            : [String(value), ''];
          return {
            name: 'FeesWithdrawn',
            feeCollector: String(topics[1] ?? ''),
            amount,
            asset,
            ledger,
            pagingToken,
          } satisfies FeesWithdrawnEvent;
        }

        case 'AdminChanged': {
          // topics: [name, oldAdmin, newAdmin]  value: ()
          return {
            name: 'AdminChanged',
            oldAdmin: String(topics[1] ?? ''),
            newAdmin: String(topics[2] ?? ''),
            ledger,
            pagingToken,
          } satisfies AdminChangedEvent;
        }

        case 'MetaFundExecuted': {
          // topics: [name, asset, source, target]  value: [amount, fee, nonce]
          const [amount, fee, nonce] = Array.isArray(value)
            ? value.map(String)
            : [String(value), '0', '0'];
          return {
            name: 'MetaFundExecuted',
            asset: String(topics[1] ?? ''),
            source: String(topics[2] ?? ''),
            target: String(topics[3] ?? ''),
            amount,
            fee,
            nonce,
            ledger,
            pagingToken,
          } satisfies MetaFundExecutedEvent;
        }

        default: {
          return {
            name,
            topics,
            value,
            ledger,
            pagingToken,
          } satisfies GenericBridgeEvent;
        }
      }
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private dispatch(payload: BridgeEventPayload): void {
    // Fire specific listeners
    const specific = this.listeners.get(payload.name);
    if (specific) {
      for (const cb of specific) {
        try { cb(payload); } catch { /* isolate handler errors */ }
      }
    }

    // Fire wildcard listeners
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const cb of wildcard) {
        try { cb(payload); } catch { /* isolate handler errors */ }
      }
    }
  }

  /**
   * Dispatch an error to any registered 'error' listeners.
   *
   * This is called on poll failures so consumers can detect persistently-down
   * RPC endpoints.  Handler errors are isolated so one bad listener doesn't
   * break others.
   */
  private dispatchError(err: Error): void {
    const errorListeners = this.listeners.get('error');
    if (errorListeners) {
      for (const cb of errorListeners) {
        try { cb(err); } catch { /* isolate handler errors */ }
      }
    }
  }
}
