/**
 * Event subscription for the OnboardingBridge Soroban contract.
 *
 * Polls `getEvents` on the Soroban RPC on a configurable interval and delivers
 * typed, parsed event payloads to registered listeners.
 *
 * ## Usage
 *
 * ```ts
 * const emitter = new BridgeEventEmitter({
 *   contractId: 'C...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 * });
 *
 * emitter.on('CAddressFunded', (event) => console.log(event));
 * emitter.on('FeesWithdrawn', (event) => console.log(event));
 * emitter.on('*', (event) => console.log('any event', event));
 *
 * emitter.start();
 * // later:
 * emitter.stop();
 * ```
 */

import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { withRpcRetry } from "./retry";
import type { RpcRetryOptions } from "./retry";

// ---------------------------------------------------------------------------
// Typed event payloads
// ---------------------------------------------------------------------------

/** Emitted by `fund_c_address` and `batch_fund_c_address` for each successfully funded target. */
export interface CAddressFundedEvent {
  type: "CAddressFunded";
  asset: string;
  source: string;
  target: string;
  amount: string;
  fee: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted when a batch item is skipped because the target is blocked/not-allowlisted. */
export interface BatchTransferFailedEvent {
  type: "BatchTransferFailed";
  source: string;
  target: string;
  amount: string;
  reason: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted once per `batch_fund_c_address` call after all items are processed. */
export interface BatchCompletedEvent {
  type: "BatchCompleted";
  source: string;
  numSuccess: number;
  numFailures: number;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `fund_c_address_crosschain` after a successful cross-chain deposit. */
export interface CrossChainFundedEvent {
  type: "CrossChainFunded";
  target: string;
  chainId: number;
  txHash: string;
  amount: string;
  fee: string;
  asset: string;
  ledger: number;
  sorobanTxHash: string;
  id: string;
}

/** Emitted by `withdraw_fees` after the fee collector withdraws accumulated fees. */
export interface FeesWithdrawnEvent {
  type: "FeesWithdrawn";
  feeCollector: string;
  amount: string;
  asset: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `set_admin` (immediate) or `accept_admin` (two-phase) when admin changes. */
export interface AdminChangedEvent {
  type: "AdminChanged";
  oldAdmin: string;
  newAdmin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `set_fee_bps` when the global fee rate changes. */
export interface FeeBpsChangedEvent {
  type: "FeeBpsChanged";
  oldFeeBps: number;
  newFeeBps: number;
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `set_fee_collector` when the fee collector address changes. */
export interface FeeCollectorChangedEvent {
  type: "FeeCollectorChanged";
  oldCollector: string;
  newCollector: string;
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted when the contract is paused. */
export interface ContractPausedEvent {
  type: "ContractPaused";
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted when the contract is unpaused. */
export interface ContractUnpausedEvent {
  type: "ContractUnpaused";
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `execute_upgrade` or `upgrade` after a successful WASM upgrade. */
export interface ContractUpgradedEvent {
  type: "ContractUpgraded";
  oldHash: string;
  newHash: string;
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `schedule_upgrade` when an upgrade is queued. */
export interface UpgradeScheduledEvent {
  type: "UpgradeScheduled";
  newWasmHash: string;
  executableAfterLedger: number;
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `cancel_upgrade`. */
export interface UpgradeCancelledEvent {
  type: "UpgradeCancelled";
  newWasmHash: string;
  admin: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `fund_c_address_timelocked` when a new timelock entry is created. */
export interface TimelockCreatedEvent {
  type: "TimelockCreated";
  source: string;
  target: string;
  id: string;
  amount: string;
  asset: string;
  releaseTime: string;
  cliffTime: string;
  ledger: number;
  txHash: string;
}

/** Emitted by `claim_timelocked` when a mature timelock entry is claimed. */
export interface TimelockClaimedEvent {
  type: "TimelockClaimed";
  target: string;
  id: string;
  netAmount: string;
  fee: string;
  asset: string;
  ledger: number;
  txHash: string;
}

/** Emitted by `commit_fund` when a commit-reveal commitment is created. */
export interface CommitFundEvent {
  type: "CommitFund";
  source: string;
  target: string;
  id: string;
  amountHash: string;
  asset: string;
  deadline: string;
  ledger: number;
  txHash: string;
}

/** Emitted by `reveal_fund` after a commit-reveal is completed. */
export interface CommitRevealFundedEvent {
  type: "CommitRevealFunded";
  asset: string;
  source: string;
  target: string;
  commitmentId: string;
  amount: string;
  fee: string;
  ledger: number;
  txHash: string;
}

/** Emitted by `fund_c_address_with_swap` after a successful swap-and-fund. */
export interface SwapAndFundedEvent {
  type: "SwapAndFunded";
  sourceAsset: string;
  targetAsset: string;
  source: string;
  target: string;
  sourceAmount: string;
  receivedAmount: string;
  fee: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Emitted by `fund_c_address` when a referral fee is paid. */
export interface ReferralPaidEvent {
  type: "ReferralPaid";
  source: string;
  referrer: string;
  amount: string;
  asset: string;
  ledger: number;
  txHash: string;
  id: string;
}

/** Union of all typed event payloads emitted by the bridge contract. */
export type BridgeEvent =
  | CAddressFundedEvent
  | BatchTransferFailedEvent
  | BatchCompletedEvent
  | CrossChainFundedEvent
  | FeesWithdrawnEvent
  | AdminChangedEvent
  | FeeBpsChangedEvent
  | FeeCollectorChangedEvent
  | ContractPausedEvent
  | ContractUnpausedEvent
  | ContractUpgradedEvent
  | UpgradeScheduledEvent
  | UpgradeCancelledEvent
  | TimelockCreatedEvent
  | TimelockClaimedEvent
  | CommitFundEvent
  | CommitRevealFundedEvent
  | SwapAndFundedEvent
  | ReferralPaidEvent;

/** All event type discriminants supported by `BridgeEventEmitter.on()`. */
export type BridgeEventType = BridgeEvent["type"] | "*";

/** Listener callback — receives a strongly-typed event payload. */
export type BridgeEventListener<T extends BridgeEvent = BridgeEvent> = (
  event: T,
) => void;

// ---------------------------------------------------------------------------
// EventEmitter config
// ---------------------------------------------------------------------------

/** Configuration for {@link BridgeEventEmitter}. */
export interface BridgeEventEmitterConfig {
  /** Contract ID of the deployed OnboardingBridge Soroban contract. */
  contractId: string;
  /** Soroban RPC URL. */
  rpcUrl: string;
  /** Network passphrase — must match `rpcUrl`. */
  networkPassphrase: string;
  /**
   * How often the RPC is polled for new events (milliseconds).
   * Default: 6000 (6 s — roughly one Stellar ledger close).
   */
  pollIntervalMs?: number;
  /**
   * Starting ledger sequence to fetch events from.
   * Default: `'latest'` — only events produced after `start()` is called.
   */
  startLedger?: number | "latest";
  /** Retry options forwarded to {@link withRpcRetry}. */
  retry?: RpcRetryOptions;
}

// ---------------------------------------------------------------------------
// Raw Soroban event shape returned by getEvents()
// ---------------------------------------------------------------------------

/** Minimal shape of a raw Soroban event entry as returned by `getEvents`. */
interface RawSorobanEvent {
  id: string;
  ledger: number;
  txHash: string;
  topic: any[];
  value: any;
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

/** Safely convert an ScVal to its native JS equivalent; returns undefined on failure. */
function safeNative(scVal: any): any {
  try {
    return scValToNative(scVal);
  } catch {
    return undefined;
  }
}

/** Convert any value to a plain string (handles BigInt, Address, number, string). */
function toStr(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  // Soroban Address objects expose toString()
  if (typeof v === "object" && typeof v.toString === "function")
    return v.toString();
  return String(v);
}

/**
 * Parse a raw Soroban event into a typed {@link BridgeEvent}.
 *
 * Soroban contract events use `env.events().publish(topics, data)`.
 * The first element of `topic` is always the event-name symbol.
 * Additional topic elements are "indexed" fields; `data` holds the rest.
 *
 * Returns `null` for unrecognised event names or malformed payloads.
 */
function parseEvent(raw: RawSorobanEvent): BridgeEvent | null {
  const { id, ledger, txHash, topic, value } = raw;

  if (!Array.isArray(topic) || topic.length === 0) return null;

  const eventName: string = safeNative(topic[0]);
  if (typeof eventName !== "string") return null;

  // data is a tuple/vec — normalise to an array for consistent indexing
  const rawData = safeNative(value);
  const data: any[] = Array.isArray(rawData) ? rawData : [rawData];

  switch (eventName) {
    case "CAddressFunded": {
      // topics: [name, asset, source, target]
      // data:   [amount, fee]
      return {
        type: "CAddressFunded",
        asset: toStr(safeNative(topic[1])),
        source: toStr(safeNative(topic[2])),
        target: toStr(safeNative(topic[3])),
        amount: toStr(data[0]),
        fee: toStr(data[1]),
        ledger,
        txHash,
        id,
      } satisfies CAddressFundedEvent;
    }

    case "BatchTransferFailed": {
      // topics: [name, source, target]
      // data:   [amount, reason]
      return {
        type: "BatchTransferFailed",
        source: toStr(safeNative(topic[1])),
        target: toStr(safeNative(topic[2])),
        amount: toStr(data[0]),
        reason: toStr(data[1]),
        ledger,
        txHash,
        id,
      } satisfies BatchTransferFailedEvent;
    }

    case "BatchCompleted": {
      // topics: [name, source]
      // data:   [num_success, num_failures]
      return {
        type: "BatchCompleted",
        source: toStr(safeNative(topic[1])),
        numSuccess: Number(data[0] ?? 0),
        numFailures: Number(data[1] ?? 0),
        ledger,
        txHash,
        id,
      } satisfies BatchCompletedEvent;
    }

    case "CrossChainFunded": {
      // topics: [name, target]
      // data:   [chain_id, tx_hash, amount, fee, asset]
      return {
        type: "CrossChainFunded",
        target: toStr(safeNative(topic[1])),
        chainId: Number(data[0] ?? 0),
        txHash: toStr(data[1]),
        amount: toStr(data[2]),
        fee: toStr(data[3]),
        asset: toStr(safeNative(data[4])),
        ledger,
        sorobanTxHash: txHash,
        id,
      } satisfies CrossChainFundedEvent;
    }

    case "FeesWithdrawn": {
      // topics: [name, fee_collector]
      // data:   [amount, asset]
      return {
        type: "FeesWithdrawn",
        feeCollector: toStr(safeNative(topic[1])),
        amount: toStr(data[0]),
        asset: toStr(safeNative(data[1])),
        ledger,
        txHash,
        id,
      } satisfies FeesWithdrawnEvent;
    }

    case "AdminChanged": {
      // topics: [name, old_admin, new_admin]
      // data:   []
      return {
        type: "AdminChanged",
        oldAdmin: toStr(safeNative(topic[1])),
        newAdmin: toStr(safeNative(topic[2])),
        ledger,
        txHash,
        id,
      } satisfies AdminChangedEvent;
    }

    case "FeeBpsChanged": {
      // topics: [name, old_fee_bps, new_fee_bps]
      // data:   [admin]
      return {
        type: "FeeBpsChanged",
        oldFeeBps: Number(safeNative(topic[1]) ?? 0),
        newFeeBps: Number(safeNative(topic[2]) ?? 0),
        admin: toStr(safeNative(data[0])),
        ledger,
        txHash,
        id,
      } satisfies FeeBpsChangedEvent;
    }

    case "FeeCollectorChanged": {
      // topics: [name, old_collector, new_fee_collector]
      // data:   [admin]
      return {
        type: "FeeCollectorChanged",
        oldCollector: toStr(safeNative(topic[1])),
        newCollector: toStr(safeNative(topic[2])),
        admin: toStr(safeNative(data[0])),
        ledger,
        txHash,
        id,
      } satisfies FeeCollectorChangedEvent;
    }

    case "ContractPaused": {
      // topics: [name]
      // data:   [admin]
      return {
        type: "ContractPaused",
        admin: toStr(safeNative(data[0])),
        ledger,
        txHash,
        id,
      } satisfies ContractPausedEvent;
    }

    case "ContractUnpaused": {
      // topics: [name]
      // data:   [admin]
      return {
        type: "ContractUnpaused",
        admin: toStr(safeNative(data[0])),
        ledger,
        txHash,
        id,
      } satisfies ContractUnpausedEvent;
    }

    case "ContractUpgraded": {
      // topics: [name]
      // data:   [old_hash, new_hash, admin]
      return {
        type: "ContractUpgraded",
        oldHash: toStr(data[0]),
        newHash: toStr(data[1]),
        admin: toStr(safeNative(data[2])),
        ledger,
        txHash,
        id,
      } satisfies ContractUpgradedEvent;
    }

    case "UpgradeScheduled": {
      // topics: [name]
      // data:   [new_wasm_hash, executable_after_ledger, admin]
      return {
        type: "UpgradeScheduled",
        newWasmHash: toStr(data[0]),
        executableAfterLedger: Number(data[1] ?? 0),
        admin: toStr(safeNative(data[2])),
        ledger,
        txHash,
        id,
      } satisfies UpgradeScheduledEvent;
    }

    case "UpgradeCancelled": {
      // topics: [name]
      // data:   [new_wasm_hash, admin]
      return {
        type: "UpgradeCancelled",
        newWasmHash: toStr(data[0]),
        admin: toStr(safeNative(data[1])),
        ledger,
        txHash,
        id,
      } satisfies UpgradeCancelledEvent;
    }

    case "TimelockCreated": {
      // topics: [name, source, target]
      // data:   [id, amount, asset, release_time, cliff_time]
      return {
        type: "TimelockCreated",
        source: toStr(safeNative(topic[1])),
        target: toStr(safeNative(topic[2])),
        id: toStr(data[0]),
        amount: toStr(data[1]),
        asset: toStr(safeNative(data[2])),
        releaseTime: toStr(data[3]),
        cliffTime: toStr(data[4]),
        ledger,
        txHash,
      } satisfies TimelockCreatedEvent;
    }

    case "TimelockClaimed": {
      // topics: [name, target]
      // data:   [id, net_amount, fee, asset]
      return {
        type: "TimelockClaimed",
        target: toStr(safeNative(topic[1])),
        id: toStr(data[0]),
        netAmount: toStr(data[1]),
        fee: toStr(data[2]),
        asset: toStr(safeNative(data[3])),
        ledger,
        txHash,
      } satisfies TimelockClaimedEvent;
    }

    case "CommitFund": {
      // topics: [name, source, target]
      // data:   [id, amount_hash, asset, deadline]
      return {
        type: "CommitFund",
        source: toStr(safeNative(topic[1])),
        target: toStr(safeNative(topic[2])),
        id: toStr(data[0]),
        amountHash: toStr(data[1]),
        asset: toStr(safeNative(data[2])),
        deadline: toStr(data[3]),
        ledger,
        txHash,
      } satisfies CommitFundEvent;
    }

    case "CommitRevealFunded": {
      // topics: [name, asset, source, target]
      // data:   [commitment_id, amount, fee]
      return {
        type: "CommitRevealFunded",
        asset: toStr(safeNative(topic[1])),
        source: toStr(safeNative(topic[2])),
        target: toStr(safeNative(topic[3])),
        commitmentId: toStr(data[0]),
        amount: toStr(data[1]),
        fee: toStr(data[2]),
        ledger,
        txHash,
      } satisfies CommitRevealFundedEvent;
    }

    case "SwapAndFunded": {
      // topics: [name, source_asset, target_asset, source, target]
      // data:   [source_amount, received_amount, fee]
      return {
        type: "SwapAndFunded",
        sourceAsset: toStr(safeNative(topic[1])),
        targetAsset: toStr(safeNative(topic[2])),
        source: toStr(safeNative(topic[3])),
        target: toStr(safeNative(topic[4])),
        sourceAmount: toStr(data[0]),
        receivedAmount: toStr(data[1]),
        fee: toStr(data[2]),
        ledger,
        txHash,
        id,
      } satisfies SwapAndFundedEvent;
    }

    case "ReferralPaid": {
      // topics: [name, source, referrer]
      // data:   [rf_amount, asset]
      return {
        type: "ReferralPaid",
        source: toStr(safeNative(topic[1])),
        referrer: toStr(safeNative(topic[2])),
        amount: toStr(data[0]),
        asset: toStr(safeNative(data[1])),
        ledger,
        txHash,
        id,
      } satisfies ReferralPaidEvent;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// BridgeEventEmitter
// ---------------------------------------------------------------------------

/**
 * Polls the Soroban RPC for contract events and delivers typed payloads to
 * registered listeners.
 *
 * Implements a minimal EventEmitter-style API:
 * - `.on(type, listener)` — subscribe (including wildcard `'*'`)
 * - `.off(type, listener)` — unsubscribe
 * - `.once(type, listener)` — subscribe for a single delivery
 * - `.start()` — begin polling
 * - `.stop()` — cancel polling
 */
export class BridgeEventEmitter {
  private readonly config: Required<BridgeEventEmitterConfig>;
  private readonly provider: SorobanRpc.Server;
  private readonly listeners: Map<string, Set<BridgeEventListener<any>>>;
  private readonly onceListeners: Map<string, Set<BridgeEventListener<any>>>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** The highest event id seen so far; used to avoid re-delivering events. */
  private lastEventId = "";
  /** Current ledger cursor for getEvents. */
  private currentStartLedger: number | undefined;

  constructor(config: BridgeEventEmitterConfig) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 6_000,
      startLedger: config.startLedger ?? "latest",
      retry: config.retry ?? {},
      contractId: config.contractId,
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
    };
    this.provider = withRpcRetry(
      new SorobanRpc.Server(config.rpcUrl),
      this.config.retry,
    );
    this.listeners = new Map();
    this.onceListeners = new Map();
  }

  /**
   * Subscribe to a specific event type or to all events with `'*'`.
   *
   * @example
   * emitter.on('CAddressFunded', (e) => console.log(e.amount));
   * emitter.on('*', (e) => console.log(e.type));
   */
  on<T extends BridgeEventType>(
    type: T,
    listener: T extends "*"
      ? BridgeEventListener<BridgeEvent>
      : BridgeEventListener<Extract<BridgeEvent, { type: T }>>,
  ): this {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as BridgeEventListener<any>);
    return this;
  }

  /**
   * Unsubscribe a previously registered listener.
   */
  off<T extends BridgeEventType>(
    type: T,
    listener: T extends "*"
      ? BridgeEventListener<BridgeEvent>
      : BridgeEventListener<Extract<BridgeEvent, { type: T }>>,
  ): this {
    this.listeners.get(type)?.delete(listener as BridgeEventListener<any>);
    this.onceListeners.get(type)?.delete(listener as BridgeEventListener<any>);
    return this;
  }

  /**
   * Subscribe to exactly one delivery of an event, then auto-unsubscribe.
   *
   * Returns a Promise that resolves with the first matching event.
   *
   * @example
   * const event = await emitter.once('FeesWithdrawn');
   */
  once<T extends BridgeEventType>(
    type: T,
    listener?: T extends "*"
      ? BridgeEventListener<BridgeEvent>
      : BridgeEventListener<Extract<BridgeEvent, { type: T }>>,
  ): Promise<T extends "*" ? BridgeEvent : Extract<BridgeEvent, { type: T }>> {
    return new Promise((resolve) => {
      const wrapper: BridgeEventListener<any> = (event) => {
        if (listener) (listener as any)(event);
        this.onceListeners.get(type)?.delete(wrapper);
        resolve(event);
      };
      if (!this.onceListeners.has(type))
        this.onceListeners.set(type, new Set());
      this.onceListeners.get(type)!.add(wrapper);
    }) as any;
  }

  /**
   * Start polling the RPC for new events.
   * Calling `start()` on an already-running emitter is a no-op.
   */
  start(): this {
    if (this.running) return this;
    this.running = true;
    void this.poll();
    return this;
  }

  /**
   * Stop polling and release resources.
   */
  stop(): this {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this;
  }

  /** Whether the emitter is currently polling. */
  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Internal polling loop
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.fetchAndDispatch();
    } catch (err: any) {
      // Swallow poll errors — the next tick will retry.
      // Callers can attach a listener on the special '__error' key if needed.
      this.dispatchInternal("__error", err);
    }

    if (this.running) {
      this.timer = setTimeout(
        () => void this.poll(),
        this.config.pollIntervalMs,
      );
    }
  }

  private async fetchAndDispatch(): Promise<void> {
    // Resolve 'latest' to the current ledger sequence on the first poll.
    if (this.currentStartLedger === undefined) {
      if (this.config.startLedger === "latest") {
        const latest = await this.provider.getLatestLedger();
        this.currentStartLedger = latest.sequence;
      } else {
        this.currentStartLedger = this.config.startLedger as number;
      }
    }

    const response = await (this.provider as any).getEvents({
      startLedger: this.currentStartLedger,
      filters: [
        {
          type: "contract",
          contractIds: [this.config.contractId],
        },
      ],
    });

    const rawEvents: RawSorobanEvent[] = response?.events ?? [];
    if (rawEvents.length === 0) return;

    // Advance the ledger cursor past the last received event's ledger so the
    // next poll window starts one ledger ahead (avoids re-fetching same ledger).
    const lastLedger = rawEvents[rawEvents.length - 1].ledger;
    this.currentStartLedger = lastLedger + 1;

    for (const raw of rawEvents) {
      // Skip already-delivered events (safety net if RPC overlaps ledgers).
      if (this.lastEventId && raw.id <= this.lastEventId) continue;

      const parsed = parseEvent(raw);
      if (parsed === null) continue;

      this.lastEventId = raw.id;
      this.dispatch(parsed);
    }
  }

  private dispatch(event: BridgeEvent): void {
    // Deliver to type-specific listeners.
    this.deliverTo(event.type, event);
    // Deliver to wildcard listeners.
    this.deliverTo("*", event);
  }

  private deliverTo(key: string, event: BridgeEvent): void {
    const persistent = this.listeners.get(key);
    if (persistent) {
      for (const fn of persistent) {
        try {
          fn(event);
        } catch {
          /* individual listener errors must not break the loop */
        }
      }
    }
    const once = this.onceListeners.get(key);
    if (once) {
      for (const fn of [...once]) {
        once.delete(fn);
        try {
          fn(event);
        } catch {
          /* same */
        }
      }
    }
  }

  private dispatchInternal(key: string, payload: unknown): void {
    const fns = this.listeners.get(key);
    if (fns) {
      for (const fn of fns) {
        try {
          fn(payload as any);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
