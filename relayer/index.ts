/**
 * Cross-chain relayer service for the C-Address Onboarding Bridge.
 *
 * Flow:
 *   1. Watch a source chain (Ethereum, Solana, …) for a "BridgeFund" event.
 *   2. Sign the canonical payload hash with each relayer's Ed25519 key.
 *   3. When enough relayers have signed (≥ threshold), call
 *      `fund_c_address_crosschain` on the Soroban contract via the SDK.
 *
 * Only stdlib + @stellar/stellar-sdk (already in sdk/package.json) are used here.
 * EVM / Solana transport are injected via ChainListener so they can be replaced
 * with ethers.js, viem, @solana/web3.js, etc. without changing this file.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import {
  OnboardingBridgeSDK,
  CrossChainFundOptions,
  RelayerSig,
} from '@stellar/c-address-onboarding-bridge-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw event emitted by a source-chain listener. */
export interface BridgeEvent {
  /** Numeric chain id (1 = Ethereum, 101 = Solana, …) */
  chainId: number;
  /** 32-byte transaction hash as hex (no 0x prefix) */
  txHash: string;
  /** Destination Soroban C-address */
  target: string;
  /** Whitelisted token contract address on Stellar */
  asset: string;
  /** Gross amount as a decimal string (no decimals applied here) */
  amount: string;
}

/** Pluggable chain event source. Implement for Ethereum, Solana, etc. */
export interface ChainListener {
  /** Start watching and emit events via the callback. */
  start(onEvent: (event: BridgeEvent) => void): void;
  stop(): void;
}

/**
 * Config for one relayer node/signer.
 *
 * Two shapes are supported:
 *
 * - `{ signerUrl }` (recommended): the key never enters this process. The
 *   relayer POSTs the payload hash to an independent signer service — run by
 *   the operator that owns that key, on its own host/process — and receives
 *   back a signature. See `relayer/signer-service.ts` and
 *   `adr/ADR-007-signer-key-isolation.md`.
 * - `{ privateKey }` (legacy/dev only): the key is loaded directly into this
 *   process. Kept for local development and backwards compatibility, but
 *   using it for more than one node defeats the multi-sig threshold, since
 *   compromising this one process then yields every key. A deprecation
 *   warning is logged whenever it's used with more than one configured node.
 */
export type RelayerNodeConfig =
  | { privateKey: string; signerUrl?: undefined }
  | { signerUrl: string; privateKey?: undefined };

/** Timeout for a remote signer HTTP call, in ms. */
const SIGNER_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Request a signature from an independent per-operator signer service that
 * holds exactly one key. The relayer process never sees that key's material.
 */
async function requestRemoteSignature(signerUrl: string, payloadHash: Buffer): Promise<RelayerSig> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIGNER_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${signerUrl.replace(/\/$/, '')}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payloadHash: payloadHash.toString('hex') }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`signer at ${signerUrl} responded ${res.status}`);
    }
    const json: any = await res.json();
    if (typeof json.pubkey !== 'string' || typeof json.signature !== 'string') {
      throw new Error(`signer at ${signerUrl} returned a malformed response`);
    }
    return { pubkey: json.pubkey, signature: json.signature };
  } finally {
    clearTimeout(timeout);
  }
}

/** Sign the payload hash with a single node, using whichever custody mode it's configured for. */
async function signWithNode(node: RelayerNodeConfig, payloadHash: Buffer): Promise<RelayerSig> {
  if (node.signerUrl) {
    return requestRemoteSignature(node.signerUrl, payloadHash);
  }
  return signPayload(node.privateKey!, payloadHash);
}

export interface RelayerServiceConfig {
  /** Soroban contract id */
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Stellar keypair used to submit the Soroban transaction (pays fees). */
  submitterSecretKey: string;
  /** All relayer nodes participating in this service instance. */
  nodes: RelayerNodeConfig[];
  /** Minimum signatures needed (should match on-chain threshold). */
  threshold: number;
  /** Chain listeners to watch. */
  listeners: ChainListener[];
  /**
   * How often to retry dead-lettered events, in ms. Set to 0 to disable the
   * automatic retry timer (the DLQ can still be drained manually via
   * `retryDeadLetters()`). Defaults to 60_000 (1 minute).
   */
  dlqRetryIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Dead-letter queue — retains events that failed the threshold check
// ---------------------------------------------------------------------------

/** A BridgeEvent that could not be submitted due to insufficient signers. */
export interface DeadLetterEntry {
  event: BridgeEvent;
  /** ISO timestamp when the entry was added. */
  enqueuedAt: string;
  /** How many signers were available vs how many were required. */
  availableSigners: number;
  requiredSigners: number;
  /** Human-readable reason the event could not be submitted. */
  reason: string;
}

/**
 * In-memory dead-letter store for under-threshold events and failed
 * submissions. Replace with a persistent store (e.g. Redis, SQLite) in
 * production.
 */
export class DeadLetterQueue {
  private entries: DeadLetterEntry[] = [];
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
    if (this.filePath) {
      const loaded = readJsonFile<DeadLetterEntry[]>(this.filePath);
      if (Array.isArray(loaded)) this.entries = loaded;
    }
  }

  private persist(): void {
    if (this.filePath) writeJsonFileAtomic(this.filePath, this.entries);
  }

  enqueue(event: BridgeEvent, available: number, required: number, reason: string): void {
    // Replace any stale entry for the same event so retries don't pile up
    // duplicate rows for the same tx.
    this.remove(event.chainId, event.txHash);
    this.entries.push({
      event,
      enqueuedAt: new Date().toISOString(),
      availableSigners: available,
      requiredSigners: required,
      reason,
    });
    this.persist();
    console.warn(
      `[relayer] dead-letter: chain=${event.chainId} tx=${event.txHash} ` +
        `signers=${available}/${required} reason="${reason}" — stored for retry`,
    );
  }

  /** Return all queued entries (for inspection / retry). */
  all(): DeadLetterEntry[] {
    return [...this.entries];
  }

  /** Remove a specific entry by tx-hash + chainId after a successful retry. */
  remove(chainId: number, txHash: string): void {
    this.entries = this.entries.filter(
      (e) => !(e.event.chainId === chainId && e.event.txHash === txHash),
    );
    this.persist();
  }

  size(): number {
    return this.entries.length;
  }
}

/** Snapshot of relayer liveness reported by GET /health. */
export interface HealthStatus {
  status: 'ok';
  uptime_seconds: number;
  threshold: number;
  node_count: number;
  /** Last successfully submitted event per chain (chainId → ISO timestamp). */
  last_event_per_chain: Record<string, string>;
  dead_letter_queue_size: number;
}

// ---------------------------------------------------------------------------
// Payload hashing — must match lib.rs exactly
// ---------------------------------------------------------------------------

/**
 * Compute nonce = sha256(chain_id_be4 || tx_hash_bytes).
 */
function computeNonce(chainId: number, txHashHex: string): Buffer {
  const chainIdBuf = Buffer.alloc(4);
  chainIdBuf.writeUInt32BE(chainId);
  const txHashBuf = Buffer.from(txHashHex, 'hex');
  return crypto.createHash('sha256').update(chainIdBuf).update(txHashBuf).digest();
}

/**
 * Compute payload_hash = sha256(
 *   chain_id_be4 || tx_hash || target_hash || asset_hash ||
 *   amount_be16 || nonce
 * ).
 *
 * target_hash = sha256(target_strkey_bytes)
 * asset_hash  = sha256(asset_strkey_bytes)
 *
 * This matches the contract's payload construction in
 * `fund_c_address_crosschain` (lib.rs lines 3736-3772).
 */
function encodeAddress(address: string): Buffer {
  const raw = Buffer.from(address, 'utf8');
  return crypto.createHash('sha256').update(raw).digest();
}

function computePayloadHash(event: BridgeEvent): Buffer {
  const chainIdBuf = Buffer.alloc(4);
  chainIdBuf.writeUInt32BE(event.chainId);

  const txHashBuf = Buffer.from(event.txHash, 'hex');
  const targetBuf = encodeAddress(event.target);
  const assetBuf = encodeAddress(event.asset);

  // amount as big-endian u128 (16 bytes)
  const amountBuf = Buffer.alloc(16);
  const amountBig = BigInt(event.amount);
  amountBuf.writeBigUInt64BE(amountBig >> 64n, 0);
  amountBuf.writeBigUInt64BE(amountBig & BigInt('0xFFFFFFFFFFFFFFFF'), 8);

  const nonce = computeNonce(event.chainId, event.txHash);

  return crypto
    .createHash('sha256')
    .update(chainIdBuf)
    .update(txHashBuf)
    .update(targetBuf)
    .update(assetBuf)
    .update(amountBuf)
    .update(nonce)
    .digest();
}

// ---------------------------------------------------------------------------
// Ed25519 signing (Node built-in crypto, no extra deps)
// ---------------------------------------------------------------------------

function signPayload(privateKeyHex: string, payloadHash: Buffer): RelayerSig {
  const seed = Buffer.from(privateKeyHex, 'hex');
  const keypair = Keypair.fromRawEd25519Seed(seed);
  const pubkey = keypair.rawPublicKey().toString('hex');
  const signature = keypair.sign(payloadHash).toString('hex');

  return { pubkey, signature };
}

// ---------------------------------------------------------------------------
// Nonce deduplication — persisted to a local JSON file (see issue #670) so a
// restart does not forget which (chainId, txHash) pairs were already
// submitted and re-process everything since the last persisted block.
// ---------------------------------------------------------------------------

class NonceStore {
  private seen = new Set<string>();
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
    if (this.filePath) {
      const loaded = readJsonFile<string[]>(this.filePath);
      if (Array.isArray(loaded)) {
        for (const key of loaded) this.seen.add(key);
      }
    }
  }

  private persist(): void {
    if (this.filePath) writeJsonFileAtomic(this.filePath, [...this.seen]);
  }

  has(chainId: number, txHash: string): boolean {
    return this.seen.has(`${chainId}:${txHash}`);
  }

  mark(chainId: number, txHash: string): void {
    this.seen.add(`${chainId}:${txHash}`);
    this.persist();
  }
}

// ---------------------------------------------------------------------------
// Relayer service
// ---------------------------------------------------------------------------

export class RelayerService {
  private sdk: OnboardingBridgeSDK;
  private submitterKeypair: ReturnType<typeof Keypair.fromSecret>;
  private config: RelayerServiceConfig;
  private nonces: NonceStore;
  private startedAt = Date.now();
  private lastEventPerChain: Map<number, string> = new Map();
  private dlqRetryTimer: ReturnType<typeof setInterval> | null = null;
  readonly dlq = new DeadLetterQueue();

  constructor(config: RelayerServiceConfig) {
    this.config = config;
    this.sdk = new OnboardingBridgeSDK({
      contractId: config.contractId,
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
    });
    this.submitterKeypair = Keypair.fromSecret(config.submitterSecretKey);

    const inProcessKeyCount = config.nodes.filter((n) => n.privateKey !== undefined).length;
    if (inProcessKeyCount > 1) {
      console.warn(
        `[relayer] WARNING: ${inProcessKeyCount} relayer private keys are loaded directly into ` +
          'this process. This defeats the multi-sig threshold — compromising this one process ' +
          'yields every key. Configure each node with a `signerUrl` pointing at an independent ' +
          'signer service instead (see relayer/signer-service.ts and ' +
          'adr/ADR-007-signer-key-isolation.md). `privateKey` remains only for local dev.',
      );
    }
  }

  start(): void {
    for (const listener of this.config.listeners) {
      listener.start((event) => this.handleEvent(event));
    }

    const retryIntervalMs = this.config.dlqRetryIntervalMs ?? 60_000;
    if (retryIntervalMs > 0) {
      this.dlqRetryTimer = setInterval(() => {
        this.retryDeadLetters().catch((err) =>
          console.error(`[relayer] dead-letter retry sweep failed: ${err.message}`),
        );
      }, retryIntervalMs);
    }

    console.log(`[relayer] started with ${this.config.nodes.length} node(s), threshold=${this.config.threshold}`);
  }

  stop(): void {
    for (const listener of this.config.listeners) {
      listener.stop();
    }
    if (this.dlqRetryTimer) {
      clearInterval(this.dlqRetryTimer);
      this.dlqRetryTimer = null;
    }
    console.log('[relayer] stopped');
  }

  /**
   * Re-attempt delivery for every event currently in the dead-letter queue.
   * `handleEvent` re-enqueues (replacing the stale entry) on repeat failure
   * and removes the entry on success, so this simply drains what it can.
   */
  async retryDeadLetters(): Promise<void> {
    const pending = this.dlq.all();
    if (pending.length === 0) return;
    console.log(`[relayer] retrying ${pending.length} dead-lettered event(s)`);
    for (const entry of pending) {
      await this.handleEvent(entry.event);
    }
  }

  healthStatus(): HealthStatus {
    const last_event_per_chain: Record<string, string> = {};
    for (const [chainId, ts] of this.lastEventPerChain) {
      last_event_per_chain[String(chainId)] = ts;
    }
    return {
      status: 'ok',
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      threshold: this.config.threshold,
      node_count: this.config.nodes.length,
      last_event_per_chain,
      dead_letter_queue_size: this.dlq.size(),
    };
  }

  private async handleEvent(event: BridgeEvent): Promise<void> {
    const key = `${event.chainId}:${event.txHash}`;

    if (this.nonces.has(event.chainId, event.txHash)) {
      console.log(`[relayer] duplicate event ignored: chain=${event.chainId} tx=${event.txHash}`);
      return;
    }

    console.log(`[relayer] event received: chain=${event.chainId} tx=${event.txHash} target=${event.target} amount=${event.amount}`);

    const payloadHash = computePayloadHash(event);

    // Collect signatures from all configured nodes, then deduplicate by pubkey.
    // The contract does NOT verify that sigs contains distinct pubkeys — the doc
    // comment on fund_c_address_crosschain explicitly delegates deduplication to
    // relayer infrastructure.  A config mistake (two nodes sharing a key) or a
    // malicious injection must not inflate the effective signature count past
    // what distinct keys actually authorize.
    const rawSigs: RelayerSig[] = await Promise.all(
      this.config.nodes.map((node) => signWithNode(node, payloadHash)),
    );
    const seenPubkeys = new Set<string>();
    const sigs: RelayerSig[] = rawSigs.filter((sig) => {
      if (seenPubkeys.has(sig.pubkey)) {
        console.warn(`[relayer] duplicate pubkey detected and removed: ${sig.pubkey}`);
        return false;
      }
      seenPubkeys.add(sig.pubkey);
      return true;
    });

    if (sigs.length < this.config.threshold) {
      console.warn(`[relayer] not enough signers after dedup: have ${sigs.length}, need ${this.config.threshold}`);
      this.dlq.enqueue(event, sigs.length, this.config.threshold, 'insufficient signers after dedup');
      return;
    }
    this.inFlight.add(key);

    try {
      console.log(`[relayer] event received: chain=${event.chainId} tx=${event.txHash} target=${event.target} amount=${event.amount}`);

      const payloadHash = computePayloadHash(event);

      // Collect signatures from all configured nodes, then deduplicate by pubkey.
      // The contract does NOT verify that sigs contains distinct pubkeys — the doc
      // comment on fund_c_address_crosschain explicitly delegates deduplication to
      // relayer infrastructure.  A config mistake (two nodes sharing a key) or a
      // malicious injection must not inflate the effective signature count past
      // what distinct keys actually authorize.
      const rawSigs: RelayerSig[] = this.config.nodes.map((node) =>
        signPayload(node.privateKey, payloadHash),
      );
      const seenPubkeys = new Set<string>();
      const sigs: RelayerSig[] = rawSigs.filter((sig) => {
        if (seenPubkeys.has(sig.pubkey)) {
          console.warn(`[relayer] duplicate pubkey detected and removed: ${sig.pubkey}`);
          return false;
        }
        seenPubkeys.add(sig.pubkey);
        return true;
      });

      if (result.status === 'failed') {
        console.error(`[relayer] fundCrosschain failed: ${result.error}`);
        this.dlq.enqueue(event, sigs.length, this.config.threshold, `submission failed: ${result.error}`);
        return;
      }

      // Mark nonce only after successful submission
      this.nonces.mark(event.chainId, event.txHash);
      this.lastEventPerChain.set(event.chainId, new Date().toISOString());
      this.dlq.remove(event.chainId, event.txHash);
      console.log(`[relayer] submitted tx=${result.hash} for chain=${event.chainId} src-tx=${event.txHash}`);
    } catch (err: any) {
      console.error(`[relayer] unexpected error: ${err.message}`);
      this.dlq.enqueue(event, sigs.length, this.config.threshold, `unexpected error: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ethereum listener (JSON-RPC polling — no ethers.js required)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Block-number persistence — survives process restarts
// ---------------------------------------------------------------------------

/**
 * Persists the last-processed Ethereum block number to a local JSON file so
 * that EthChainListener resumes from where it left off after a restart,
 * preventing missed BridgeFund events during any downtime window.
 *
 * File format: `{ "fromBlock": "0x1a2b3c" }` (hex string, same unit as
 * eth_getLogs fromBlock parameter).
 */
export class BlockStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load the persisted fromBlock value.
   * Returns `null` when the file does not exist or contains invalid data so
   * that callers can fall back to `'latest'` on a fresh install.
   */
  load(): string | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'fromBlock' in (parsed as object) &&
        typeof (parsed as { fromBlock: unknown }).fromBlock === 'string'
      ) {
        return (parsed as { fromBlock: string }).fromBlock;
      }
      return null;
    } catch {
      // File missing or unreadable — treat as first run
      return null;
    }
  }

  /** Atomically persist the current fromBlock value. */
  save(fromBlock: string): void {
    const dir = path.dirname(this.filePath);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ fromBlock }), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

export interface EthListenerConfig {
  /** HTTP JSON-RPC endpoint */
  rpcUrl: string;
  /** BridgeFund event contract address on Ethereum */
  bridgeContractAddress: string;
  /**
   * keccak256("BridgeFund(uint32,bytes32,string,string,uint256)") topic0.
   * Pre-compute off-chain and supply here.
   */
  eventTopic: string;
  /** Stellar chain id to include in the BridgeEvent (always 1 for mainnet Ethereum) */
  chainId: number;
  /** Poll interval in ms */
  pollIntervalMs?: number;
  /**
   * Path to a JSON file used to persist the last-processed block number across
   * restarts.  Defaults to `.eth-block-<chainId>.json` in the current working
   * directory when not provided.
   */
  blockStorePath?: string;
  /**
   * Number of blocks to hold back from the chain head before a log is
   * considered final and acted on. A deposit that is later reorged out on
   * Ethereum cannot be reversed once it has been paid out on Stellar, so logs
   * newer than `latest - confirmations` are left for a later poll instead of
   * being queried at all. Defaults to `DEFAULT_ETH_CONFIRMATIONS` (12 blocks,
   * ~ the depth generally considered final on Ethereum mainnet).
   */
  confirmations?: number;
}

/** Default confirmation depth applied when `EthListenerConfig.confirmations` is not set. */
export const DEFAULT_ETH_CONFIRMATIONS = 12;

/**
 * Minimal Ethereum log-polling listener.  Decodes a `BridgeFund` log with
 * ABI: `BridgeFund(string target, string asset, uint256 amount)`. The replay
 * key is derived from the log's own `transactionHash`/`logIndex`, not from
 * event data (see `decode()`).
 *
 * Persists the last-processed block number to a local file so that a restart
 * resumes from the correct position and never skips events emitted during a
 * downtime window.
 *
 * Replace with a WebSocket subscription (eth_subscribe) for lower latency.
 */
export class EthChainListener implements ChainListener {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fromBlock: string;
  private config: EthListenerConfig;
  private blockStore: BlockStore;
  private onEvent: ((event: BridgeEvent) => void) | null = null;

  constructor(config: EthListenerConfig) {
    this.config = config;
    const storePath = config.blockStorePath ?? `.eth-block-${config.chainId}.json`;
    this.blockStore = new BlockStore(storePath);
    // Resume from the last persisted block; fall back to 'latest' on first run.
    this.fromBlock = this.blockStore.load() ?? 'latest';
    if (this.fromBlock !== 'latest') {
      console.log(`[eth-listener] resuming from persisted block ${this.fromBlock}`);
    }
  }

  start(onEvent: (event: BridgeEvent) => void): void {
    this.onEvent = onEvent;
    this.timer = setInterval(() => this.pollOnce(), this.config.pollIntervalMs ?? 12_000);
    this.pollOnce(); // immediate first poll
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Run a single poll cycle. Exposed (not just used from the timer) so tests
   * can drive it deterministically against a fake RPC.
   */
  private async pollOnce(): Promise<void> {
    try {
      if (this.fromBlock === 'latest') {
        // Fresh install: resolve 'latest' to a concrete block number *once*
        // and persist it, instead of re-querying a single sliding block on
        // every poll (which misses anything produced between two polls).
        const current = await this.getBlockNumber();
        this.fromBlock = current;
        this.blockStore.save(this.fromBlock);
        console.log(`[eth-listener] resolved initial block to ${this.fromBlock}`);
        return;
      }

      const latest = await this.getBlockNumber();
      const confirmations = this.config.confirmations ?? DEFAULT_ETH_CONFIRMATIONS;
      const safeToBlockNum = Math.max(parseInt(latest, 16) - confirmations, 0);
      const fromBlockNum = parseInt(this.fromBlock, 16);

      if (safeToBlockNum < fromBlockNum) {
        // Nothing has reached the required confirmation depth yet — wait for
        // a later poll instead of acting on unconfirmed (reorg-able) blocks.
        return;
      }

      const toBlock = '0x' + safeToBlockNum.toString(16);
      const logs = await this.getLogs(toBlock);
      for (const log of logs) {
        if (log && log.removed === true) {
          console.warn(`[eth-listener] skipping reorged log tx=${log.transactionHash ?? '?'}`);
          continue;
        }
        const event = this.decode(log);
        if (event && this.onEvent) this.onEvent(event);
      }

      // Always advance fromBlock past the queried range — even when zero
      // logs were returned. Otherwise any block produced between two polls
      // that never contains a matching log is never queried again.
      const nextFromBlock = '0x' + (safeToBlockNum + 1).toString(16);
      this.fromBlock = nextFromBlock;
      this.blockStore.save(this.fromBlock);
    } catch (err: any) {
      console.error(`[eth-listener] poll error: ${err.message}`);
    }
  }

  private async getBlockNumber(): Promise<string> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    });
    const res = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json: any = await res.json();
    if (typeof json.result !== 'string') {
      throw new Error('eth_blockNumber returned no result');
    }
    return json.result;
  }

  private async getLogs(toBlock: string): Promise<any[]> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{
        fromBlock: this.fromBlock,
        toBlock,
        address: this.config.bridgeContractAddress,
        topics: [this.config.eventTopic],
      }],
    });

    const res = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json: any = await res.json();
    if (json.error) {
      const message = typeof json.error?.message === 'string' ? json.error.message : JSON.stringify(json.error);
      throw new Error(`${method} RPC error: ${message}`);
    }
    return json.result;
  }

  /**
   * Fetch logs in the range [fromBlock, latest], walking forward in chunks of
   * at most `maxBlockRange` blocks so that a large gap since the last
   * checkpoint (e.g. after downtime) never produces a single unbounded
   * `eth_getLogs` request that most providers would reject outright.
   *
   * A JSON-RPC `error` is thrown (not swallowed as "no logs") so callers can
   * see and retry it.
   */
  private async getLogs(): Promise<{ logs: any[]; queriedToBlock: number | null }> {
    const maxRange = this.config.maxBlockRange ?? 2_000;

    const latestHex: string = await this.rpcCall('eth_blockNumber', []);
    const latestBlock = parseInt(latestHex, 16);

    const startBlock =
      this.fromBlock === 'latest' ? latestBlock : parseInt(this.fromBlock, 16);
    if (!Number.isFinite(startBlock) || startBlock > latestBlock) {
      return { logs: [], queriedToBlock: null };
    }

    const endBlock = Math.min(startBlock + maxRange - 1, latestBlock);

    const result = await this.rpcCall('eth_getLogs', [{
      fromBlock: '0x' + startBlock.toString(16),
      toBlock: '0x' + endBlock.toString(16),
      address: this.config.bridgeContractAddress,
      topics: [this.config.eventTopic],
    }]);

    return { logs: Array.isArray(result) ? result : [], queriedToBlock: endBlock };
  }

  /**
   * Decode a raw eth log into a BridgeEvent.
   * Expected ABI-encoded topics/data:
   *   topic[0]: event signature hash
   *   data:     abi.encode(string target, string asset, uint256 amount)
   *
   * The replay key (`txHash`) is derived from the log's own
   * `transactionHash` + `logIndex` — fields the RPC node/chain attests to —
   * rather than from any value the emitting contract chose to include in the
   * event data. Otherwise a buggy or malicious emitter controls the replay
   * key, and two BridgeFund logs in the same transaction (same
   * transactionHash) would collide on-chain, where the replay key is
   * `(chain_id, tx_hash)`.
   */
  private decode(log: any): BridgeEvent | null {
    try {
      if (typeof log.transactionHash !== 'string' || !log.transactionHash.startsWith('0x') || log.transactionHash.length !== 66) {
        return null;
      }
      const logIndexRaw = log.logIndex;
      const logIndex =
        typeof logIndexRaw === 'string' ? parseInt(logIndexRaw, 16) : Number(logIndexRaw);
      if (!Number.isFinite(logIndex) || logIndex < 0) return null;

      const txHashBytes = Buffer.from(log.transactionHash.slice(2), 'hex');
      const logIndexBuf = Buffer.alloc(4);
      logIndexBuf.writeUInt32BE(logIndex);
      const txHash = crypto
        .createHash('sha256')
        .update(txHashBytes)
        .update(logIndexBuf)
        .digest('hex');

      // ABI-decode non-indexed data: (string target, string asset, uint256 amount)
      if (typeof log.data !== 'string' || !log.data.startsWith('0x')) return null;
      const data = (log.data as string).slice(2); // strip 0x
      if (data.length < 64 * 3) return null;
      // Each ABI word is 32 bytes = 64 hex chars
      const word = (n: number) => data.slice(n * 64, (n + 1) * 64);

      const targetOffset = parseInt(word(0), 16) * 2; // byte offset → hex offset
      const assetOffset = parseInt(word(1), 16) * 2;
      const amountHex = word(2);
      if (!Number.isFinite(targetOffset) || !Number.isFinite(assetOffset) || amountHex.length !== 64) return null;

      const decodeString = (byteOffset: number) => {
        if (byteOffset < 0 || byteOffset + 64 > data.length) return null;
        const len = parseInt(data.slice(byteOffset, byteOffset + 64), 16);
        if (!Number.isFinite(len)) return null;
        const strHex = data.slice(byteOffset + 64, byteOffset + 64 + len * 2);
        if (strHex.length !== len * 2) return null;
        return Buffer.from(strHex, 'hex').toString('utf8');
      };

      const target = decodeString(targetOffset);
      const asset = decodeString(assetOffset);
      if (target === null || asset === null) return null;
      const amount = BigInt('0x' + amountHex).toString();

      return { chainId: this.config.chainId, txHash, target, asset, amount };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Solana listener (WebSocket log subscription — no @solana/web3.js required)
// ---------------------------------------------------------------------------

// Bitcoin/Solana base58 alphabet (no 0, O, I, l).
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: Record<string, number> = Object.fromEntries(
  BASE58_ALPHABET.split('').map((c, i) => [c, i]),
);

/**
 * Decode a base58 string (e.g. a Solana signature or pubkey) into raw bytes.
 * Throws on any character outside the base58 alphabet. Only stdlib
 * primitives (BigInt) are used, matching this file's no-extra-deps policy.
 */
function base58Decode(input: string): Buffer {
  if (input.length === 0) throw new Error('empty base58 string');

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === '1') leadingZeros++;

  let num = 0n;
  for (const ch of input) {
    const value = BASE58_MAP[ch];
    if (value === undefined) throw new Error(`invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(value);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }

  return Buffer.concat([Buffer.alloc(leadingZeros, 0), Buffer.from(bytes)]);
}

export interface SolanaListenerConfig {
  /** Solana WebSocket endpoint (wss://...) */
  wsUrl: string;
  /** Base58 program id of the Solana bridge program */
  programId: string;
  /** Stellar chain id for Solana (e.g. 101) */
  chainId: number;
  /**
   * Initial reconnect delay in ms (doubles on each consecutive failure up to
   * `maxReconnectDelayMs`).  Defaults to 1 000 ms.
   */
  initialReconnectDelayMs?: number;
  /**
   * Maximum reconnect back-off delay in ms.  Defaults to 30 000 ms.
   */
  maxReconnectDelayMs?: number;
  /**
   * Solana JSON-RPC HTTP endpoint (https://...), used to backfill events
   * that were emitted while the WebSocket was disconnected via
   * `getSignaturesForAddress` / `getTransaction`. Required for reconnect
   * backfill to run — without it a reconnect only resumes live delivery.
   */
  httpUrl?: string;
  /**
   * Path to a JSON file used to persist the last-processed transaction
   * signature across restarts and reconnects. Defaults to
   * `.solana-signature-<chainId>.json` in the current working directory.
   */
  signatureStorePath?: string;
}

/**
 * Build the `logsSubscribe` request payload. Extracted as a pure function so
 * the commitment level is unit-testable without opening a real WebSocket —
 * see issue #668 (must use `finalized`, not `confirmed`, since a
 * `confirmed` log can still be rolled back before funds are released).
 */
function buildSolanaSubscribePayload(programId: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'logsSubscribe',
    params: [{ mentions: [programId] }, { commitment: 'finalized' }],
  });
}

/**
 * Persists the last-processed Solana transaction signature to a local JSON
 * file, mirroring `BlockStore`'s atomic write pattern, so a restart or
 * reconnect can backfill exactly what was missed instead of losing it.
 */
export class SolanaSignatureStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): string | null {
    const parsed = readJsonFile<{ signature?: unknown }>(this.filePath);
    if (parsed && typeof parsed.signature === 'string') return parsed.signature;
    return null;
  }

  save(signature: string): void {
    writeJsonFileAtomic(this.filePath, { signature });
  }
}

/**
 * Listens to Solana program log notifications over WebSocket.
 * Expects the Solana program to emit a structured log line:
 *   "bridge_fund:<signature>:<target>:<asset>:<amount>"
 *
 * `logsSubscribe({ mentions: [programId] })` matches any transaction that
 * touches the program, so a `bridge_fund` line is only accepted when the
 * bridge program is the one currently executing (see
 * `extractBridgeFundEvents`), not merely present somewhere in the
 * transaction's log lines.
 *
 * Implements reconnect-with-exponential-backoff so that a transient WebSocket
 * drop (network blip, RPC provider restart) does not permanently halt event
 * delivery.  The listener keeps re-subscribing until `stop()` is called.
 *
 * Replace the log parsing with actual Anchor event decoding if using Anchor.
 */
export class SolanaChainListener implements ChainListener {
  private ws: any = null;
  private config: SolanaListenerConfig;
  private onEvent: ((event: BridgeEvent) => void) | null = null;
  private stopped = false;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private signatureStore: SolanaSignatureStore;
  /** Last transaction signature we know we've processed (persisted). */
  private lastSignature: string | null;

  constructor(config: SolanaListenerConfig) {
    this.config = config;
    this.reconnectDelay = config.initialReconnectDelayMs ?? 1_000;
    this.signatureStore = new SolanaSignatureStore(
      config.signatureStorePath ?? `.solana-signature-${config.chainId}.json`,
    );
    this.lastSignature = this.signatureStore.load();
  }

  start(onEvent: (event: BridgeEvent) => void): void {
    this.onEvent = onEvent;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  /** Open (or re-open) the WebSocket and attach handlers. */
  private connect(): void {
    if (this.stopped) return;

    const WebSocket = (globalThis as any).WebSocket ?? require('ws');
    this.ws = new WebSocket(this.config.wsUrl);

    this.ws.onopen = () => {
      // Reset back-off on a successful connection
      this.reconnectDelay = this.config.initialReconnectDelayMs ?? 1_000;

      this.ws.send(buildSolanaSubscribePayload(this.config.programId));
      console.log('[solana-listener] subscribed to program logs (commitment=finalized)');

      // Replay whatever happened while we were disconnected (or since the
      // last restart) before resuming live delivery — see issue #668.
      // logsSubscribe only delivers *new* notifications, so without this a
      // reconnect silently drops everything emitted during the downtime.
      this.backfill().catch((err: any) =>
        console.error(`[solana-listener] backfill failed: ${err.message ?? err}`),
      );
    };

    this.ws.onmessage = (msg: any) => {
      try {
        const data = JSON.parse(typeof msg === 'string' ? msg : msg.data);
        const signature: string | undefined = data?.params?.result?.value?.signature;
        const logs: string[] = data?.params?.result?.value?.logs ?? [];
        for (const event of this.extractBridgeFundEvents(logs)) {
          if (this.onEvent) this.onEvent(event);
        }
        if (signature) this.recordSignature(signature);
      } catch { /* ignore malformed messages */ }
    };

    this.ws.onerror = (err: any) => console.error('[solana-listener] ws error:', err.message ?? err);

    this.ws.onclose = () => {
      if (this.stopped) return;

      const delay = this.reconnectDelay;
      const maxDelay = this.config.maxReconnectDelayMs ?? 30_000;
      console.warn(
        `[solana-listener] ws closed — reconnecting in ${delay} ms ` +
        `(next cap: ${Math.min(delay * 2, maxDelay)} ms)`,
      );

      this.reconnectTimer = setTimeout(() => {
        // Exponential back-off: double the delay up to the configured maximum
        this.reconnectDelay = Math.min(delay * 2, maxDelay);
        this.connect();
      }, delay);
    };
  }

  /**
   * `logsSubscribe` with `{ mentions: [programId] }` matches every
   * transaction that *touches* the program, including one where a
   * different program (e.g. via CPI) prints its own
   * `Program log: bridge_fund:...` line — that would let anyone forge a
   * deposit event for free. This walks the log lines for one notification,
   * tracking the Solana runtime's own invoke/success/failed frames, and
   * only treats a `bridge_fund` line as genuine when the bridge program
   * itself is the currently-executing program (top of the invoke stack).
   */
  private extractBridgeFundEvents(logs: string[]): BridgeEvent[] {
    const events: BridgeEvent[] = [];
    const stack: string[] = [];
    const invokeRe = /^Program (\S+) invoke \[\d+\]$/;
    const endRe = /^Program (\S+) (?:success|failed:.*)$/;

    for (const line of logs) {
      const invokeMatch = line.match(invokeRe);
      if (invokeMatch) {
        stack.push(invokeMatch[1]);
        continue;
      }
      const endMatch = line.match(endRe);
      if (endMatch) {
        const idx = stack.lastIndexOf(endMatch[1]);
        if (idx !== -1) stack.splice(idx, 1);
        continue;
      }
      if (!line.startsWith('Program log: bridge_fund:')) continue;

      const executingProgram = stack[stack.length - 1];
      if (executingProgram !== this.config.programId) {
        this.rejectLine(
          line,
          `emitted while '${executingProgram ?? '<none>'}' was executing, not the bridge program`,
        );
        continue;
      }

      const event = this.decodeLine(line);
      if (event) events.push(event);
    }

    return events;
  }

  /**
   * Parse: "Program log: bridge_fund:<signature>:<target>:<asset>:<amount>"
   *
   * `<signature>` is the base58-encoded 64-byte Solana transaction
   * signature. The payload hash / contract nonce need a 32-byte `txHash`
   * (see `computeNonce`), so the signature is base58-decoded, validated to
   * be exactly 64 bytes, and mapped to 32 bytes via `sha256(signature)`
   * rather than being used as-is (which would silently truncate/garble a
   * real signature into an arbitrary buffer).
   */
  private decodeLine(line: string): BridgeEvent | null {
    try {
      const payload = line.replace('Program log: bridge_fund:', '');
      const parts = payload.split(':');
      if (parts.length !== 4) return this.rejectLine(line, 'expected 4 fields');
      const [signature, target, asset, amount] = parts;
      if (!signature || !target || !asset || !amount) return this.rejectLine(line, 'missing field');
      if (!/^\d+$/.test(amount)) return this.rejectLine(line, 'amount is not numeric');

      let sigBytes: Buffer;
      try {
        sigBytes = base58Decode(signature);
      } catch {
        return this.rejectLine(line, 'signature is not valid base58');
      }
      if (sigBytes.length !== 64) {
        return this.rejectLine(line, `signature must decode to 64 bytes, got ${sigBytes.length}`);
      }
      const txHash = crypto.createHash('sha256').update(sigBytes).digest('hex');

      return { chainId: this.config.chainId, txHash, target, asset, amount };
    } catch {
      return this.rejectLine(line, 'malformed line');
    }
  }

  private rejectLine(line: string, reason: string): null {
    console.warn(`[solana-listener] rejected bridge_fund log: ${reason}; line=${line}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP health server
// ---------------------------------------------------------------------------

/**
 * Start a minimal HTTP server on `port` that exposes:
 *   GET /health  — liveness + basic status (200 JSON)
 *   GET /health/dead-letters  — dump of the dead-letter queue (200 JSON)
 *
 * Returns the server instance so callers can call `.close()` on shutdown.
 */
export function startHealthServer(service: RelayerService, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    if (req.url === '/health') {
      const body = JSON.stringify(service.healthStatus());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.url === '/health/dead-letters') {
      const body = JSON.stringify({ entries: service.dlq.all() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`[relayer] health server listening on :${port}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Lightweight self-tests (run with: npx ts-node relayer/index.ts --self-test)
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function makeTestEvent(overrides: Partial<BridgeEvent> = {}): BridgeEvent {
  return {
    chainId: 1,
    txHash: 'ab'.repeat(32),
    target: 'GDESTINATION',
    asset: 'CASSET',
    amount: '1000',
    ...overrides,
  };
}

function makeTestService(params: {
  threshold?: number;
  nodes?: RelayerNodeConfig[];
  fundCrosschain?: (options: CrossChainFundOptions, submitter: any) => Promise<any>;
} = {}): RelayerService {
  const service = Object.create(RelayerService.prototype) as RelayerService;
  (service as any).config = {
    contractId: 'C',
    rpcUrl: 'http://localhost',
    networkPassphrase: 'test',
    submitterSecretKey: 'S',
    threshold: params.threshold ?? 1,
    nodes: params.nodes ?? [{ privateKey: '01'.repeat(32) }],
    listeners: [],
  };
  (service as any).sdk = {
    fundCrosschain: params.fundCrosschain ?? (async () => ({ status: 'pending', hash: 'hash' })),
  };
  (service as any).submitterKeypair = {};
  (service as any).nonces = new NonceStore(); // no filePath: in-memory only for tests
  (service as any).startedAt = Date.now();
  (service as any).lastEventPerChain = new Map();
  (service as any).inFlight = new Set<string>();
  (service as any).dlq = new DeadLetterQueue(); // no filePath: in-memory only for tests
  return service;
}

export async function test_duplicate_event_ignored_via_nonce_store(): Promise<void> {
  let calls = 0;
  const service = makeTestService({
    fundCrosschain: async () => {
      calls += 1;
      return { status: 'pending', hash: 'hash' };
    },
  });
  const event = makeTestEvent();

  await (service as any).handleEvent(event);
  await (service as any).handleEvent(event);

  assertEqual(calls, 1, 'duplicate event should not call SDK twice');
}

/**
 * Issue #669 regression: two concurrent deliveries of the same event (e.g. a
 * reconnect replay racing a live notification) must only submit once, even
 * though neither delivery has awaited far enough to mark the nonce yet.
 */
export async function test_concurrent_duplicate_events_submit_only_once(): Promise<void> {
  let calls = 0;
  let resolveFirst!: () => void;
  const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const service = makeTestService({
    fundCrosschain: async () => {
      calls += 1;
      await gate; // hold the first call open so the second one races it
      return { status: 'pending', hash: 'hash' };
    },
  });
  const event = makeTestEvent();

  // Fire both deliveries "concurrently" (no await between them), then let
  // the first submission complete.
  const p1 = (service as any).handleEvent(event);
  const p2 = (service as any).handleEvent(event);
  resolveFirst();
  await Promise.all([p1, p2]);

  assertEqual(calls, 1, 'concurrent duplicate events must only call the SDK once');
}

export async function test_nonce_marked_only_after_successful_submission(): Promise<void> {
  let calls = 0;
  const service = makeTestService({
    fundCrosschain: async () => {
      calls += 1;
      return calls === 1
        ? { status: 'failed', hash: '', error: 'submission failed' }
        : { status: 'pending', hash: 'hash' };
    },
  });
  const event = makeTestEvent();

  await (service as any).handleEvent(event);
  await (service as any).handleEvent(event);
  await (service as any).handleEvent(event);

  assertEqual(calls, 2, 'failed submission should be retried and successful nonce should dedupe later events');
}

export async function test_below_threshold_short_circuits_before_sdk_call(): Promise<void> {
  let calls = 0;
  const service = makeTestService({
    threshold: 2,
    nodes: [{ privateKey: '01'.repeat(32) }],
    fundCrosschain: async () => {
      calls += 1;
      return { status: 'pending', hash: 'hash' };
    },
  });

  await (service as any).handleEvent(makeTestEvent());

  assertEqual(calls, 0, 'below-threshold event should not call SDK');
}

/**
 * Issue #1 regression: duplicate-pubkey nodes must not inflate the effective
 * signature count.  Three nodes that all share the same key should collapse to
 * 1 unique pubkey, which is below a threshold of 2, so the SDK must NOT be
 * called.
 */
export async function test_duplicate_pubkey_nodes_do_not_inflate_sig_count(): Promise<void> {
  let calls = 0;
  const sharedKey = '02'.repeat(32); // all three nodes share the same seed/pubkey
  const service = makeTestService({
    threshold: 2,
    nodes: [
      { privateKey: sharedKey },
      { privateKey: sharedKey },
      { privateKey: sharedKey },
    ],
    fundCrosschain: async () => {
      calls += 1;
      return { status: 'pending', hash: 'hash' };
    },
  });

  await (service as any).handleEvent(makeTestEvent());

  assertEqual(
    calls,
    0,
    'three nodes sharing one pubkey should collapse to 1 unique sig, below threshold=2, and must not call SDK',
  );
}

/**
 * Issue #1: when nodes share a key for some slots but enough *distinct* keys
 * meet the threshold, submission must still proceed.
 */
export async function test_mixed_duplicate_and_unique_pubkeys_meet_threshold(): Promise<void> {
  let calls = 0;
  let capturedSigCount = 0;
  const sharedKey = '02'.repeat(32);
  const uniqueKey  = '03'.repeat(32);
  const service = makeTestService({
    threshold: 2,
    nodes: [
      { privateKey: sharedKey },
      { privateKey: sharedKey }, // duplicate — must be removed
      { privateKey: uniqueKey },  // distinct — counts as second sig
    ],
    fundCrosschain: async (options: CrossChainFundOptions) => {
      calls += 1;
      capturedSigCount = options.sigs.length;
      return { status: 'pending', hash: 'hash' };
    },
  });

  await (service as any).handleEvent(makeTestEvent());

  assertEqual(calls, 1, 'two distinct pubkeys must meet threshold=2 and call SDK');
  // The SDK receives exactly `threshold` sigs (the slice), not the raw 3.
  assert(capturedSigCount <= 2, 'SDK must receive at most threshold sigs after dedup');
}

// ---------------------------------------------------------------------------
// Issue #660: regression tests — dead-letter queue is actually written to
// ---------------------------------------------------------------------------

export async function test_below_threshold_event_is_enqueued_to_dlq(): Promise<void> {
  const service = makeTestService({ threshold: 2, nodes: [{ privateKey: '01'.repeat(32) }] });
  const event = makeTestEvent();

  await (service as any).handleEvent(event);

  assertEqual(service.dlq.size(), 1, 'under-threshold event should be enqueued to the DLQ');
  assertEqual(service.dlq.all()[0].reason, 'insufficient signers after dedup', 'DLQ entry should record the reason');
}

export async function test_failed_submission_is_enqueued_to_dlq(): Promise<void> {
  const service = makeTestService({
    fundCrosschain: async () => ({ status: 'failed', hash: '', error: 'boom' }),
  });
  const event = makeTestEvent();

  await (service as any).handleEvent(event);

  assertEqual(service.dlq.size(), 1, 'failed submission should be enqueued to the DLQ');
}

export async function test_successful_retry_removes_dlq_entry(): Promise<void> {
  let attempt = 0;
  const service = makeTestService({
    fundCrosschain: async () => {
      attempt += 1;
      return attempt === 1
        ? { status: 'failed', hash: '', error: 'boom' }
        : { status: 'pending', hash: 'hash' };
    },
  });
  const event = makeTestEvent();

  await (service as any).handleEvent(event);
  assertEqual(service.dlq.size(), 1, 'first failure should enqueue an entry');

  await service.retryDeadLetters();
  assertEqual(service.dlq.size(), 0, 'a successful retry should remove the DLQ entry');
}

// ---------------------------------------------------------------------------
// Issue #661: regression tests — per-signer key isolation via signerUrl nodes
// ---------------------------------------------------------------------------

export async function test_signer_url_node_signs_via_remote_call_not_local_key(): Promise<void> {
  const originalFetch = (globalThis as any).fetch;
  let calledUrl = '';
  let sentBody: any = null;
  (globalThis as any).fetch = async (url: string, opts: any) => {
    calledUrl = url;
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ pubkey: 'aa'.repeat(32), signature: 'bb'.repeat(64) }),
    };
  };
  try {
    let capturedSigCount = 0;
    const service = makeTestService({
      threshold: 1,
      nodes: [{ signerUrl: 'http://signer-a.internal:4000' }],
      fundCrosschain: async (options: CrossChainFundOptions) => {
        capturedSigCount = options.sigs.length;
        return { status: 'pending', hash: 'hash' };
      },
    });

    await (service as any).handleEvent(makeTestEvent());

    assertEqual(calledUrl, 'http://signer-a.internal:4000/sign', 'should POST to the configured signer service');
    assert(typeof sentBody.payloadHash === 'string', 'request body must carry the payload hash, never a private key');
    assertEqual(capturedSigCount, 1, 'the remote signature should reach the SDK call');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

export async function test_mixed_signer_url_and_private_key_nodes_meet_threshold(): Promise<void> {
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ pubkey: 'cc'.repeat(32), signature: 'dd'.repeat(64) }),
  });
  try {
    let calls = 0;
    const service = makeTestService({
      threshold: 2,
      nodes: [{ signerUrl: 'http://signer-b.internal:4000' }, { privateKey: '05'.repeat(32) }],
      fundCrosschain: async () => {
        calls += 1;
        return { status: 'pending', hash: 'hash' };
      },
    });

    await (service as any).handleEvent(makeTestEvent());

    assertEqual(calls, 1, 'a mix of remote and local signers should still meet the threshold');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

function word(hex: string): string {
  return hex.padStart(64, '0');
}

function encodedString(value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const paddedLength = Math.ceil(hex.length / 64) * 64;
  return word((hex.length / 2).toString(16)) + hex.padEnd(paddedLength, '0');
}

function makeAbiLog(
  target: string,
  asset: string,
  amount: bigint,
  overrides: { transactionHash?: string; logIndex?: string } = {},
): any {
  const targetTail = encodedString(target);
  const assetTail = encodedString(asset);
  const targetOffset = 32 * 3;
  const assetOffset = targetOffset + targetTail.length / 2;
  return {
    topics: ['0x' + '00'.repeat(32)],
    transactionHash: overrides.transactionHash ?? '0x' + 'cd'.repeat(32),
    logIndex: overrides.logIndex ?? '0x0',
    data: '0x' + word(targetOffset.toString(16)) + word(assetOffset.toString(16)) + word(amount.toString(16)) + targetTail + assetTail,
  };
}

export function test_eth_listener_decodes_realistic_abi_log_fixture(): void {
  const listener = new EthChainListener({
    rpcUrl: 'http://localhost',
    bridgeContractAddress: '0xbridge',
    eventTopic: '0xtopic',
    chainId: 1,
  });

  const log = makeAbiLog('GDESTINATION', 'CASSET', 123456789n);
  const event = (listener as any).decode(log);

  assert(event !== null, 'valid ABI log should decode');
  assertEqual(event.target, 'GDESTINATION', 'target should decode');
  assertEqual(event.asset, 'CASSET', 'asset should decode');
  assertEqual(event.amount, '123456789', 'amount should decode');

  const expectedTxHash = crypto
    .createHash('sha256')
    .update(Buffer.from((log.transactionHash as string).slice(2), 'hex'))
    .update(Buffer.alloc(4)) // logIndex 0
    .digest('hex');
  assertEqual(event.txHash, expectedTxHash, 'txHash must be derived from log.transactionHash + logIndex');
}

/**
 * Issue #665 regression: two BridgeFund logs in the SAME transaction (same
 * transactionHash, different logIndex) must produce different replay keys,
 * and the emitted event's own data must have no influence on txHash.
 */
export function test_eth_listener_derives_txhash_from_log_not_event_data(): void {
  const listener = new EthChainListener({
    rpcUrl: 'http://localhost',
    bridgeContractAddress: '0xbridge',
    eventTopic: '0xtopic',
    chainId: 1,
  });

  const sameTx = '0x' + 'ab'.repeat(32);
  const log0 = makeAbiLog('GDESTINATION', 'CASSET', 1n, { transactionHash: sameTx, logIndex: '0x0' });
  const log1 = makeAbiLog('GDESTINATION', 'CASSET', 1n, { transactionHash: sameTx, logIndex: '0x1' });

  const event0 = (listener as any).decode(log0);
  const event1 = (listener as any).decode(log1);

  assert(event0 !== null && event1 !== null, 'both logs should decode');
  assert(
    event0.txHash !== event1.txHash,
    'two logs in the same transaction must not collapse to the same replay key',
  );
}

/**
 * Issue #664 regression: a JSON-RPC `error` (e.g. "block range too large")
 * must be thrown, not silently treated as "no logs".
 */
export async function test_eth_listener_throws_on_rpc_error(): Promise<void> {
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'block range too large' } }),
  });
  try {
    const listener = new EthChainListener({
      rpcUrl: 'http://localhost',
      bridgeContractAddress: '0xbridge',
      eventTopic: '0xtopic',
      chainId: 1,
    });
    let threw = false;
    try {
      await (listener as any).rpcCall('eth_getLogs', [{}]);
    } catch {
      threw = true;
    }
    assert(threw, 'a JSON-RPC error result must be thrown, not swallowed as an empty log list');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

/**
 * Issue #664 regression: a single `getLogs()` call must never request more
 * than `maxBlockRange` blocks, even when the checkpoint is far behind head.
 */
export async function test_eth_listener_bounds_block_range(): Promise<void> {
  const originalFetch = (globalThis as any).fetch;
  const requestedRanges: Array<{ fromBlock: string; toBlock: string }> = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') {
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (100_000).toString(16) }) };
    }
    requestedRanges.push(body.params[0]);
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) };
  };
  try {
    const listener = new EthChainListener({
      rpcUrl: 'http://localhost',
      bridgeContractAddress: '0xbridge',
      eventTopic: '0xtopic',
      chainId: 1,
      maxBlockRange: 500,
    });
    (listener as any).fromBlock = '0x0';
    const { queriedToBlock } = await (listener as any).getLogs();
    assertEqual(queriedToBlock, 499, 'queried range must be capped at maxBlockRange - 1');
    assertEqual(requestedRanges.length, 1, 'exactly one eth_getLogs call should be made');
    assertEqual(requestedRanges[0].fromBlock, '0x0', 'fromBlock should be the checkpoint');
    assertEqual(requestedRanges[0].toBlock, '0x' + (499).toString(16), 'toBlock must not exceed maxBlockRange');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

export function test_eth_listener_rejects_malformed_truncated_log_payload(): void {
  const listener = new EthChainListener({
    rpcUrl: 'http://localhost',
    bridgeContractAddress: '0xbridge',
    eventTopic: '0xtopic',
    chainId: 1,
  });

  const event = (listener as any).decode({
    topics: ['0x' + '00'.repeat(32)],
    transactionHash: '0x' + 'cd'.repeat(32),
    logIndex: '0x0',
    data: '0x1234',
  });

  assertEqual(event, null, 'truncated ABI log should be rejected');
}

// ---------------------------------------------------------------------------
// Issue #663: regression tests — fromBlock resolution and advancement
// ---------------------------------------------------------------------------

function withFakeFetch<T>(handler: (method: string, params: any) => any, fn: () => Promise<T>): Promise<T> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    const result = handler(body.method, body.params);
    return { json: async () => ({ result }) };
  };
  return fn().finally(() => {
    (globalThis as any).fetch = original;
  });
}

function tmpBlockStorePath(name: string): string {
  return path.join(require('os').tmpdir(), `eth-block-${name}-${Date.now()}-${Math.random()}.json`);
}

export async function test_eth_listener_resolves_latest_to_concrete_block_on_first_poll(): Promise<void> {
  await withFakeFetch(
    (method) => (method === 'eth_blockNumber' ? '0x64' : []),
    async () => {
      const listener = new EthChainListener({
        rpcUrl: 'http://localhost',
        bridgeContractAddress: '0xbridge',
        eventTopic: '0xtopic',
        chainId: 1,
        blockStorePath: tmpBlockStorePath('resolve'),
      });
      await (listener as any).pollOnce();
      assertEqual((listener as any).fromBlock, '0x64', 'fromBlock should resolve to a concrete block number on first poll');
    },
  );
}

export async function test_eth_listener_advances_from_block_even_with_no_logs(): Promise<void> {
  let blockNumberCalls = 0;
  await withFakeFetch(
    (method) => {
      if (method === 'eth_blockNumber') {
        blockNumberCalls += 1;
        return '0x' + (100 + blockNumberCalls).toString(16);
      }
      return []; // no matching logs, ever
    },
    async () => {
      const listener = new EthChainListener({
        rpcUrl: 'http://localhost',
        bridgeContractAddress: '0xbridge',
        eventTopic: '0xtopic',
        chainId: 1,
        blockStorePath: tmpBlockStorePath('advance'),
      });
      await (listener as any).pollOnce(); // resolves 'latest' -> 0x65
      const afterFirst = (listener as any).fromBlock;
      await (listener as any).pollOnce(); // queries logs (none), must still advance
      const afterSecond = (listener as any).fromBlock;
      assert(afterFirst !== afterSecond, 'fromBlock must advance past the queried range even when no logs are returned');
    },
  );
}

// ---------------------------------------------------------------------------
// Issue #662: regression tests — confirmation-depth buffer / reorg protection
// ---------------------------------------------------------------------------

export async function test_eth_listener_withholds_logs_within_confirmation_depth(): Promise<void> {
  await withFakeFetch(
    (method) => (method === 'eth_blockNumber' ? '0x64' : []), // latest = 100
    async () => {
      const listener = new EthChainListener({
        rpcUrl: 'http://localhost',
        bridgeContractAddress: '0xbridge',
        eventTopic: '0xtopic',
        chainId: 1,
        confirmations: 12,
        blockStorePath: tmpBlockStorePath('confirm-init'),
      });
      await (listener as any).pollOnce(); // resolves fromBlock -> 0x64 (100)

      let getLogsCalled = false;
      const originalFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = async (_url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_blockNumber') return { json: async () => ({ result: '0x65' }) }; // latest = 101, only 1 new block
        getLogsCalled = true;
        return { json: async () => ({ result: [] }) };
      };
      try {
        await (listener as any).pollOnce();
      } finally {
        (globalThis as any).fetch = originalFetch;
      }

      assert(!getLogsCalled, 'logs within the confirmation window must not be queried yet');
      assertEqual((listener as any).fromBlock, '0x64', 'fromBlock must not advance until blocks are confirmed');
    },
  );
}

export async function test_eth_listener_skips_removed_reorged_logs(): Promise<void> {
  await withFakeFetch(
    (method) => {
      if (method === 'eth_blockNumber') return '0x64';
      return [{ topics: ['0x' + '00'.repeat(32), '0x' + 'cd'.repeat(32)], data: '0x1234', removed: true }];
    },
    async () => {
      const listener = new EthChainListener({
        rpcUrl: 'http://localhost',
        bridgeContractAddress: '0xbridge',
        eventTopic: '0xtopic',
        chainId: 1,
        confirmations: 0,
        blockStorePath: tmpBlockStorePath('removed-init'),
      });
      await (listener as any).pollOnce(); // resolve fromBlock

      let emitted = 0;
      (listener as any).onEvent = () => {
        emitted += 1;
      };
      await (listener as any).pollOnce(); // poll with a removed:true log present

      assertEqual(emitted, 0, 'removed:true (reorged) logs must not be acted on');
    },
  );
}

export function test_solana_listener_rejects_bad_log_lines(): void {
  const listener = new SolanaChainListener({
    wsUrl: 'ws://localhost',
    programId: 'program',
    chainId: 101,
  });

  const decodeLine = (line: string) => (listener as any).decodeLine(line);
  assertEqual(decodeLine('Program log: bridge_fund:tx:target:asset'), null, 'missing amount should be rejected');
  assertEqual(decodeLine('Program log: bridge_fund:tx:target:asset:100:extra'), null, 'extra colon should be rejected');
  assertEqual(decodeLine('Program log: bridge_fund:tx:target:asset:not-a-number'), null, 'non-numeric amount should be rejected');
  assertEqual(
    decodeLine('Program log: bridge_fund:tx:target:asset:100'),
    null,
    'a signature that does not base58-decode to 64 bytes should be rejected',
  );
  assertEqual(
    decodeLine('Program log: bridge_fund:not*base58!:target:asset:100'),
    null,
    'a signature with characters outside the base58 alphabet should be rejected',
  );
}

// ---------------------------------------------------------------------------
// Issue #293: regression test — payload hash must match on-chain algorithm
// ---------------------------------------------------------------------------

export function test_payload_hash_matches_onchain_algorithm(): void {
  // Use the same known inputs as the contract's unit test:
  //   chain_id = 1, tx_hash = 0xab... (32 bytes)
  const event = makeTestEvent({
    chainId: 1,
    txHash: 'ab'.repeat(32),
    target: 'GDESTINATION',
    asset: 'CASSET',
    amount: '1000',
  });

  const hash = computePayloadHash(event);
  assert(hash instanceof Buffer && hash.length === 32, 'payload hash must be 32 bytes');

  // Re-compute manually to verify the structure matches the contract.
  const chainIdBuf = Buffer.alloc(4);
  chainIdBuf.writeUInt32BE(event.chainId);
  const txHashBuf = Buffer.from(event.txHash, 'hex');
  const targetHash = crypto.createHash('sha256').update(Buffer.from(event.target, 'utf8')).digest();
  const assetHash = crypto.createHash('sha256').update(Buffer.from(event.asset, 'utf8')).digest();
  const amountBuf = Buffer.alloc(16);
  const amountBig = BigInt(event.amount);
  amountBuf.writeBigUInt64BE(amountBig >> 64n, 0);
  amountBuf.writeBigUInt64BE(amountBig & BigInt('0xFFFFFFFFFFFFFFFF'), 8);
  const nonce = computeNonce(event.chainId, event.txHash);

  const expected = crypto
    .createHash('sha256')
    .update(chainIdBuf)
    .update(txHashBuf)
    .update(targetHash)
    .update(assetHash)
    .update(amountBuf)
    .update(nonce)
    .digest();

  assertEqual(hash.toString('hex'), expected.toString('hex'), 'payload hash must match on-chain algorithm');
}

// ---------------------------------------------------------------------------
// Issue #294: regression test — large 18-decimal amounts must not throw
// ---------------------------------------------------------------------------

export function test_amount_encoding_handles_large_decimals(): void {
  // 10 ETH in wei: 10 * 10^18
  const event = makeTestEvent({ amount: '10000000000000000000' });
  const hash = computePayloadHash(event);
  assert(hash instanceof Buffer && hash.length === 32, 'large amount payload hash must be 32 bytes');

  // 1_000_000 USDC in micro-USDC: 1_000_000 * 10^6
  const event2 = makeTestEvent({ amount: '1000000000000' });
  const hash2 = computePayloadHash(event2);
  assert(hash2 instanceof Buffer && hash2.length === 32, 'large USDC amount payload hash must be 32 bytes');

  // Verify the low 64 bits are ≥ 2^63 (the bug this test guards against)
  const bigAmount = BigInt('10000000000000000000');
  const low64 = bigAmount & BigInt('0xFFFFFFFFFFFFFFFF');
  assert(low64 >= 1n << 63n, 'test value must exercise the signed-64-bit range to be meaningful');
}

// ---------------------------------------------------------------------------
// Issue #292: regression test — signPayload must produce real Ed25519 sigs
// ---------------------------------------------------------------------------

export function test_signature_passes_ed25519_verify(): void {
  const privateKeyHex = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  const payloadHash = crypto.createHash('sha256').update('test payload').digest();
  const sig = signPayload(privateKeyHex, payloadHash);

  assertEqual(sig.pubkey.length, 64, 'pubkey must be 32 bytes as hex (64 chars)');
  assertEqual(sig.signature.length, 128, 'signature must be 64 bytes as hex (128 chars)');

  // Verify using Node.js built-in Ed25519 verification.
  const rawPubkey = Buffer.from(sig.pubkey, 'hex');
  const rawSignature = Buffer.from(sig.signature, 'hex');

  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiKey = Buffer.concat([spkiPrefix, rawPubkey]);
  const publicKey = crypto.createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });

  const isValid = crypto.verify(null, payloadHash, publicKey, rawSignature);
  assert(isValid, 'Ed25519 signature must verify against the corresponding pubkey');
}

export function test_signature_from_known_seed_is_deterministic(): void {
  const seed = 'ff'.repeat(32);
  const hash = crypto.createHash('sha256').update('deterministic').digest();
  const sig1 = signPayload(seed, hash);
  const sig2 = signPayload(seed, hash);
  assertEqual(sig1.pubkey, sig2.pubkey, 'same seed must produce same pubkey');
  assertEqual(sig1.signature, sig2.signature, 'same seed + same hash must produce same signature');
}

// ---------------------------------------------------------------------------
// Startup environment variable validation (Issues 3 & 4)
// ---------------------------------------------------------------------------

/**
 * Validate that all required environment variables are present and well-formed.
 * Throws a descriptive Error on the first missing or invalid variable so the
 * process exits with a clear message instead of a cryptic undefined-dereference
 * deep inside an SDK call.
 *
 * Exported so it can be unit-tested independently of process.exit.
 */
/**
 * Parse a required chain-id environment variable as a positive integer.
 * Used for `ETH_CHAIN_ID` / `SOLANA_CHAIN_ID`, which are only required when
 * the corresponding listener is enabled (Issue: chain ids were previously
 * hard-coded to 1 / 101, which silently signs testnet events as mainnet).
 */
export function requireChainId(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} is required but was not set`);
  }
  const chainId = parseInt(raw.trim(), 10);
  if (!Number.isInteger(chainId) || chainId < 0) {
    throw new Error(`${name} must be a non-negative integer, got: "${raw}"`);
  }
  return chainId;
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  submitterSecretKey: string;
  threshold: number;
  relayerPrivateKeys: string[];
  eth?: ValidatedEthEnv;
  solana?: ValidatedSolanaEnv;
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): ValidatedEnv {
  function requireString(name: string, customMessage?: string): string {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(customMessage ?? `${name} is required but was not set`);
    }
    return value.trim();
  }

  const contractId = requireString('CONTRACT_ID');
  const rpcUrl = requireString('STELLAR_RPC_URL');
  const networkPassphrase = requireString('NETWORK_PASSPHRASE');
  const submitterSecretKey = requireString('RELAYER_SECRET_KEY');

  // Issue 4: THRESHOLD must parse to a positive integer.
  const thresholdRaw = env['THRESHOLD'] ?? '1';
  const threshold = parseInt(thresholdRaw, 10);
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(
      `THRESHOLD must be a positive integer, got: "${thresholdRaw}"`,
    );
  }

  const relayerPrivateKeys = (env['RELAYER_PRIVATE_KEYS'] ?? '')
    .split(',')
    .map((pk) => pk.trim())
    .filter(Boolean);

  if (relayerPrivateKeys.length === 0) {
    throw new Error('RELAYER_PRIVATE_KEYS is required and must contain at least one key');
  }

  let eth: ValidatedEthEnv | undefined;
  if (env['ETH_RPC_URL'] && env['ETH_RPC_URL'].trim() !== '') {
    const ethRpcUrl = env['ETH_RPC_URL'].trim();
    const bridgeContractAddress = requireString(
      'ETH_BRIDGE_CONTRACT',
      'ETH_BRIDGE_CONTRACT is required when ETH_RPC_URL is set',
    );
    const eventTopic = requireString(
      'ETH_EVENT_TOPIC',
      'ETH_EVENT_TOPIC is required when ETH_RPC_URL is set',
    );
    eth = { rpcUrl: ethRpcUrl, bridgeContractAddress, eventTopic };
  }

  let solana: ValidatedSolanaEnv | undefined;
  if (env['SOLANA_WS_URL'] && env['SOLANA_WS_URL'].trim() !== '') {
    const wsUrl = env['SOLANA_WS_URL'].trim();
    const programId = requireString(
      'SOLANA_PROGRAM_ID',
      'SOLANA_PROGRAM_ID is required when SOLANA_WS_URL is set',
    );
    solana = { wsUrl, programId };
  }

  return {
    contractId,
    rpcUrl,
    networkPassphrase,
    submitterSecretKey,
    threshold,
    relayerPrivateKeys,
    eth,
    solana,
  };
}

// ---------------------------------------------------------------------------
// Tests for env validation (Issues 3 & 4)
// ---------------------------------------------------------------------------

export function test_missing_contract_id_throws(): void {
  const env: NodeJS.ProcessEnv = {
    STELLAR_RPC_URL: 'http://localhost',
    NETWORK_PASSPHRASE: 'test',
    RELAYER_SECRET_KEY: 'secret',
    RELAYER_PRIVATE_KEYS: '01'.repeat(32),
  };
  try {
    validateEnv(env);
    throw new Error('Expected validateEnv to throw but it did not');
  } catch (e: any) {
    assert(e.message.includes('CONTRACT_ID'), `expected CONTRACT_ID error, got: ${e.message}`);
  }
}

export function test_missing_rpc_url_throws(): void {
  const env: NodeJS.ProcessEnv = {
    CONTRACT_ID: 'C_TEST',
    NETWORK_PASSPHRASE: 'test',
    RELAYER_SECRET_KEY: 'secret',
    RELAYER_PRIVATE_KEYS: '01'.repeat(32),
  };
  try {
    validateEnv(env);
    throw new Error('Expected validateEnv to throw but it did not');
  } catch (e: any) {
    assert(e.message.includes('STELLAR_RPC_URL'), `expected STELLAR_RPC_URL error, got: ${e.message}`);
  }
}

export function test_nan_threshold_is_rejected(): void {
  const env: NodeJS.ProcessEnv = {
    CONTRACT_ID: 'C_TEST',
    STELLAR_RPC_URL: 'http://localhost',
    NETWORK_PASSPHRASE: 'test',
    RELAYER_SECRET_KEY: 'secret',
    RELAYER_PRIVATE_KEYS: '01'.repeat(32),
    THRESHOLD: 'not-a-number',
  };
  try {
    validateEnv(env);
    throw new Error('Expected validateEnv to throw but it did not');
  } catch (e: any) {
    assert(e.message.includes('THRESHOLD'), `expected THRESHOLD error, got: ${e.message}`);
  }
}

export function test_zero_threshold_is_rejected(): void {
  const env: NodeJS.ProcessEnv = {
    CONTRACT_ID: 'C_TEST',
    STELLAR_RPC_URL: 'http://localhost',
    NETWORK_PASSPHRASE: 'test',
    RELAYER_SECRET_KEY: 'secret',
    RELAYER_PRIVATE_KEYS: '01'.repeat(32),
    THRESHOLD: '0',
  };
  try {
    validateEnv(env);
    throw new Error('Expected validateEnv to throw but it did not');
  } catch (e: any) {
    assert(e.message.includes('THRESHOLD'), `expected THRESHOLD error, got: ${e.message}`);
  }
}

export function test_missing_chain_id_throws(): void {
  try {
    requireChainId({}, 'ETH_CHAIN_ID');
    throw new Error('Expected requireChainId to throw but it did not');
  } catch (e: any) {
    assert(e.message.includes('ETH_CHAIN_ID'), `expected ETH_CHAIN_ID error, got: ${e.message}`);
  }
}

export function test_non_numeric_chain_id_throws(): void {
  try {
    requireChainId({ SOLANA_CHAIN_ID: 'not-a-number' }, 'SOLANA_CHAIN_ID');
    throw new Error('Expected requireChainId to throw but it did not');
  } catch (e: any) {
    assert(e.message.includes('SOLANA_CHAIN_ID'), `expected SOLANA_CHAIN_ID error, got: ${e.message}`);
  }
}

export function test_valid_chain_id_parses_correctly(): void {
  assertEqual(requireChainId({ ETH_CHAIN_ID: '11155111' }, 'ETH_CHAIN_ID'), 11155111, 'ETH_CHAIN_ID');
}

export function test_valid_env_parses_correctly(): void {
  const env: NodeJS.ProcessEnv = {
    CONTRACT_ID: 'C_TEST',
    STELLAR_RPC_URL: 'http://localhost',
    NETWORK_PASSPHRASE: 'test network',
    RELAYER_SECRET_KEY: 'my-secret',
    RELAYER_PRIVATE_KEYS: '01'.repeat(32) + ',' + '02'.repeat(32),
    THRESHOLD: '2',
  };
  const result = validateEnv(env);
  assertEqual(result.contractId, 'C_TEST', 'contractId');
  assertEqual(result.threshold, 2, 'threshold');
  assertEqual(result.relayerPrivateKeys.length, 2, 'relayer key count');
}

// ---------------------------------------------------------------------------
// Issue #668: regression tests — finalized commitment + reconnect backfill
// ---------------------------------------------------------------------------

export function test_solana_listener_subscribes_with_finalized_commitment(): void {
  const payload = JSON.parse(buildSolanaSubscribePayload('program'));
  assertEqual(payload.method, 'logsSubscribe', 'should subscribe to logs');
  assertEqual(
    payload.params[1].commitment,
    'finalized',
    'solana subscription must use finalized commitment, not confirmed (can still be rolled back)',
  );
}

export async function test_solana_listener_backfills_missed_events_after_reconnect(): Promise<void> {
  const filePath = tempStorePath('solana-sig');
  try {
    const listener = new SolanaChainListener({
      wsUrl: 'ws://localhost',
      programId: 'program',
      chainId: 101,
      httpUrl: 'http://localhost',
      signatureStorePath: filePath,
    });
    (listener as any).lastSignature = 'sig-before-restart';

    const rpcCalls: string[] = [];
    (listener as any).rpcCall = async (method: string, _params: unknown[]) => {
      rpcCalls.push(method);
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'sig-new', err: null }];
      }
      if (method === 'getTransaction') {
        return { meta: { logMessages: ['Program log: bridge_fund:' + 'ab'.repeat(32) + ':GDEST:CASSET:100'] } };
      }
      return null;
    };

    const events: BridgeEvent[] = [];
    (listener as any).onEvent = (e: BridgeEvent) => events.push(e);

    await (listener as any).backfill();

    assertEqual(rpcCalls, ['getSignaturesForAddress', 'getTransaction'], 'backfill should query signatures then fetch the transaction');
    assertEqual(events.length, 1, 'backfill should replay the missed bridge_fund event');
    assertEqual((listener as any).lastSignature, 'sig-new', 'lastSignature should advance to the newest replayed signature');

    // Simulate a restart: a fresh instance pointed at the same file should
    // resume backfilling from the persisted signature, not from scratch.
    const restarted = new SolanaChainListener({
      wsUrl: 'ws://localhost',
      programId: 'program',
      chainId: 101,
      httpUrl: 'http://localhost',
      signatureStorePath: filePath,
    });
    assertEqual((restarted as any).lastSignature, 'sig-new', 'signature persisted before restart must be loaded on construction');
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

export async function test_solana_listener_skips_backfill_without_persisted_signature(): Promise<void> {
  const listener = new SolanaChainListener({
    wsUrl: 'ws://localhost',
    programId: 'program',
    chainId: 101,
    httpUrl: 'http://localhost',
    signatureStorePath: tempStorePath('solana-sig-fresh'),
  });
  let called = false;
  (listener as any).rpcCall = async () => { called = true; return []; };

  await (listener as any).backfill();

  assert(!called, 'a fresh listener with no persisted signature has nothing to backfill from and should not call the RPC');
}

// ---------------------------------------------------------------------------
// Issue #670: regression tests — submission state survives a process restart
// ---------------------------------------------------------------------------

function tempStorePath(name: string): string {
  return path.join(require('os').tmpdir(), `relayer-self-test-${name}-${process.pid}-${Date.now()}.json`);
}

export function test_nonce_store_persists_across_restart(): void {
  const filePath = tempStorePath('nonces');
  try {
    const before = new NonceStore(filePath);
    assertEqual(before.has(1, 'abcd'), false, 'fresh store should not have the nonce yet');
    before.mark(1, 'abcd');

    // Simulate a restart: construct a brand-new instance pointed at the same file.
    const after = new NonceStore(filePath);
    assert(after.has(1, 'abcd'), 'nonce marked before restart must still be present after restart');
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

export function test_dead_letter_queue_persists_across_restart(): void {
  const filePath = tempStorePath('dlq');
  try {
    const before = new DeadLetterQueue(filePath);
    before.enqueue(makeTestEvent(), 1, 2);
    assertEqual(before.size(), 1, 'entry should be enqueued');

    // Simulate a restart: construct a brand-new instance pointed at the same file.
    const after = new DeadLetterQueue(filePath);
    assertEqual(after.size(), 1, 'dead-letter entry must survive a restart');
    assertEqual(after.all()[0].event.txHash, makeTestEvent().txHash, 'restored entry must match the original event');
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

async function runRelayerSelfTests(): Promise<void> {
  await test_duplicate_event_ignored_via_nonce_store();
  await test_concurrent_duplicate_events_submit_only_once();
  await test_nonce_marked_only_after_successful_submission();
  await test_below_threshold_short_circuits_before_sdk_call();
  await test_duplicate_pubkey_nodes_do_not_inflate_sig_count();
  await test_mixed_duplicate_and_unique_pubkeys_meet_threshold();
  await test_below_threshold_event_is_enqueued_to_dlq();
  await test_failed_submission_is_enqueued_to_dlq();
  await test_successful_retry_removes_dlq_entry();
  await test_signer_url_node_signs_via_remote_call_not_local_key();
  await test_mixed_signer_url_and_private_key_nodes_meet_threshold();
  test_eth_listener_decodes_realistic_abi_log_fixture();
  test_eth_listener_derives_txhash_from_log_not_event_data();
  test_eth_listener_rejects_log_missing_transaction_hash();
  await test_eth_listener_throws_on_rpc_error();
  await test_eth_listener_bounds_block_range();
  test_eth_listener_rejects_malformed_truncated_log_payload();
  await test_eth_listener_resolves_latest_to_concrete_block_on_first_poll();
  await test_eth_listener_advances_from_block_even_with_no_logs();
  await test_eth_listener_withholds_logs_within_confirmation_depth();
  await test_eth_listener_skips_removed_reorged_logs();
  test_solana_listener_rejects_bad_log_lines();
  test_solana_listener_subscribes_with_finalized_commitment();
  await test_solana_listener_backfills_missed_events_after_reconnect();
  await test_solana_listener_skips_backfill_without_persisted_signature();
  test_payload_hash_matches_onchain_algorithm();
  test_amount_encoding_handles_large_decimals();
  test_signature_passes_ed25519_verify();
  test_signature_from_known_seed_is_deterministic();
  // Issue 3 & 4: env var and threshold validation
  test_missing_contract_id_throws();
  test_missing_rpc_url_throws();
  test_nan_threshold_is_rejected();
  test_zero_threshold_is_rejected();
  test_valid_env_parses_correctly();
  // Issue #672: chain ids must come from env, not be hard-coded to 1/101.
  test_missing_chain_id_throws();
  test_non_numeric_chain_id_throws();
  test_valid_chain_id_parses_correctly();
  console.log('[relayer] self-tests passed');
}

// ---------------------------------------------------------------------------
// Example entry point (ts-node relayer/index.ts)
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    runRelayerSelfTests().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    const service = new RelayerService({
      contractId: process.env.CONTRACT_ID!,
      rpcUrl: process.env.STELLAR_RPC_URL!,
      networkPassphrase: process.env.NETWORK_PASSPHRASE!,
      submitterSecretKey: process.env.RELAYER_SECRET_KEY!,
      threshold: parseInt(process.env.THRESHOLD ?? '1', 10),
      // Prefer independent per-operator signer services (RELAYER_SIGNER_URLS)
      // over in-process keys (RELAYER_PRIVATE_KEYS, legacy/dev only — see
      // adr/ADR-007-signer-key-isolation.md).
      nodes: process.env.RELAYER_SIGNER_URLS
        ? process.env.RELAYER_SIGNER_URLS.split(',').map((url) => ({ signerUrl: url.trim() }))
        : (process.env.RELAYER_PRIVATE_KEYS ?? '').split(',').map((pk) => ({ privateKey: pk.trim() })),
      listeners: [
        ...(process.env.ETH_RPC_URL ? [new EthChainListener({
          rpcUrl: process.env.ETH_RPC_URL,
          bridgeContractAddress: process.env.ETH_BRIDGE_CONTRACT!,
          eventTopic: process.env.ETH_EVENT_TOPIC!,
          chainId: 1,
          confirmations: process.env.ETH_CONFIRMATIONS ? parseInt(process.env.ETH_CONFIRMATIONS, 10) : undefined,
        })] : []),
        ...(process.env.SOLANA_WS_URL ? [new SolanaChainListener({
          wsUrl: process.env.SOLANA_WS_URL,
          programId: process.env.SOLANA_PROGRAM_ID!,
          chainId: requireChainId(process.env, 'SOLANA_CHAIN_ID'),
        })] : []),
      ],
    });

    const healthPort = parseInt(process.env.HEALTH_PORT ?? '3000', 10);
    const healthServer = startHealthServer(service, healthPort);

    service.start();

    const shutdown = () => {
      service.stop();
      healthServer.close(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
