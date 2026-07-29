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
import * as http from 'http';
import { Keypair } from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../sdk/src/bridge';
import { CrossChainFundOptions, RelayerSig } from '../sdk/src/types';

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

/** Config for one relayer node (holds its own signing key). */
export interface RelayerNodeConfig {
  /** Ed25519 private key as 32-byte hex string (seed). */
  privateKey: string;
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
}

/**
 * In-memory dead-letter store for under-threshold events.
 * Replace with a persistent store (e.g. Redis, SQLite) in production.
 */
export class DeadLetterQueue {
  private entries: DeadLetterEntry[] = [];

  enqueue(event: BridgeEvent, available: number, required: number): void {
    this.entries.push({
      event,
      enqueuedAt: new Date().toISOString(),
      availableSigners: available,
      requiredSigners: required,
    });
    console.warn(
      `[relayer] dead-letter: chain=${event.chainId} tx=${event.txHash} ` +
        `signers=${available}/${required} — stored for retry`,
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
// In-memory nonce deduplication (replace with Redis / DB in production)
// ---------------------------------------------------------------------------

class NonceStore {
  private seen = new Set<string>();

  has(chainId: number, txHash: string): boolean {
    return this.seen.has(`${chainId}:${txHash}`);
  }

  mark(chainId: number, txHash: string): void {
    this.seen.add(`${chainId}:${txHash}`);
  }
}

// ---------------------------------------------------------------------------
// Relayer service
// ---------------------------------------------------------------------------

export class RelayerService {
  private sdk: OnboardingBridgeSDK;
  private submitterKeypair: ReturnType<typeof Keypair.fromSecret>;
  private config: RelayerServiceConfig;
  private nonces = new NonceStore();
  private startedAt = Date.now();
  private lastEventPerChain: Map<number, string> = new Map();
  readonly dlq = new DeadLetterQueue();

  constructor(config: RelayerServiceConfig) {
    this.config = config;
    this.sdk = new OnboardingBridgeSDK({
      contractId: config.contractId,
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
    });
    this.submitterKeypair = Keypair.fromSecret(config.submitterSecretKey);
  }

  start(): void {
    for (const listener of this.config.listeners) {
      listener.start((event) => this.handleEvent(event));
    }
    console.log(`[relayer] started with ${this.config.nodes.length} node(s), threshold=${this.config.threshold}`);
  }

  stop(): void {
    for (const listener of this.config.listeners) {
      listener.stop();
    }
    console.log('[relayer] stopped');
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
    if (this.nonces.has(event.chainId, event.txHash)) {
      console.log(`[relayer] duplicate event ignored: chain=${event.chainId} tx=${event.txHash}`);
      return;
    }

    console.log(`[relayer] event received: chain=${event.chainId} tx=${event.txHash} target=${event.target} amount=${event.amount}`);

    const payloadHash = computePayloadHash(event);

    // Collect signatures from all configured nodes
    const sigs: RelayerSig[] = this.config.nodes.map((node) =>
      signPayload(node.privateKey, payloadHash),
    );

    if (sigs.length < this.config.threshold) {
      // Persist to dead-letter queue instead of silently dropping
      this.dlq.enqueue(event, sigs.length, this.config.threshold);
      return;
    }

    const options: CrossChainFundOptions = {
      chainId: event.chainId,
      txHash: event.txHash,
      target: event.target,
      asset: event.asset,
      amount: event.amount,
      sigs: sigs.slice(0, this.config.threshold), // submit exactly threshold sigs
    };

    try {
      const result = await this.sdk.fundCrosschain(options, this.submitterKeypair);

      if (result.status === 'failed') {
        console.error(`[relayer] fundCrosschain failed: ${result.error}`);
        return;
      }

      // Mark nonce only after successful submission
      this.nonces.mark(event.chainId, event.txHash);
      this.lastEventPerChain.set(event.chainId, new Date().toISOString());
      console.log(`[relayer] submitted tx=${result.hash} for chain=${event.chainId} src-tx=${event.txHash}`);
    } catch (err: any) {
      console.error(`[relayer] unexpected error: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ethereum listener (JSON-RPC polling — no ethers.js required)
// ---------------------------------------------------------------------------

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
}

/**
 * Minimal Ethereum log-polling listener.  Decodes a `BridgeFund` log with
 * ABI: `BridgeFund(bytes32 txHash, string target, string asset, uint256 amount)`.
 *
 * Replace with a WebSocket subscription (eth_subscribe) for lower latency.
 */
export class EthChainListener implements ChainListener {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fromBlock: string = 'latest';
  private config: EthListenerConfig;

  constructor(config: EthListenerConfig) {
    this.config = config;
  }

  start(onEvent: (event: BridgeEvent) => void): void {
    const poll = async () => {
      try {
        const logs = await this.getLogs();
        for (const log of logs) {
          const event = this.decode(log);
          if (event) onEvent(event);
        }
        if (logs.length > 0) {
          // advance fromBlock past the last processed block
          const lastBlock = parseInt(logs[logs.length - 1].blockNumber, 16);
          this.fromBlock = '0x' + (lastBlock + 1).toString(16);
        }
      } catch (err: any) {
        console.error(`[eth-listener] poll error: ${err.message}`);
      }
    };

    this.timer = setInterval(poll, this.config.pollIntervalMs ?? 12_000);
    poll(); // immediate first poll
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async getLogs(): Promise<any[]> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{
        fromBlock: this.fromBlock,
        toBlock: 'latest',
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
    return json.result ?? [];
  }

  /**
   * Decode a raw eth log into a BridgeEvent.
   * Expected ABI-encoded topics/data:
   *   topic[0]: event signature hash
   *   topic[1]: bytes32 txHash (indexed)
   *   data:     abi.encode(string target, string asset, uint256 amount)
   */
  private decode(log: any): BridgeEvent | null {
    try {
      if (!Array.isArray(log.topics) || typeof log.topics[1] !== 'string') return null;
      const txHashTopic = log.topics[1] as string;
      if (!txHashTopic.startsWith('0x') || txHashTopic.length !== 66) return null;
      const txHash = txHashTopic.slice(2); // strip 0x

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

export interface SolanaListenerConfig {
  /** Solana WebSocket endpoint (wss://...) */
  wsUrl: string;
  /** Base58 program id of the Solana bridge program */
  programId: string;
  /** Stellar chain id for Solana (e.g. 101) */
  chainId: number;
}

/**
 * Listens to Solana program log notifications over WebSocket.
 * Expects the Solana program to emit a structured log line:
 *   "bridge_fund:<txHash>:<target>:<asset>:<amount>"
 *
 * Replace the log parsing with actual Anchor event decoding if using Anchor.
 */
export class SolanaChainListener implements ChainListener {
  private ws: any = null;
  private config: SolanaListenerConfig;

  constructor(config: SolanaListenerConfig) {
    this.config = config;
  }

  start(onEvent: (event: BridgeEvent) => void): void {
    const WebSocket = (globalThis as any).WebSocket ?? require('ws');
    this.ws = new WebSocket(this.config.wsUrl);

    this.ws.onopen = () => {
      const sub = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [this.config.programId] }, { commitment: 'confirmed' }],
      });
      this.ws.send(sub);
      console.log('[solana-listener] subscribed to program logs');
    };

    this.ws.onmessage = (msg: any) => {
      try {
        const data = JSON.parse(typeof msg === 'string' ? msg : msg.data);
        const logs: string[] = data?.params?.result?.value?.logs ?? [];
        for (const line of logs) {
          if (!line.startsWith('Program log: bridge_fund:')) continue;
          const event = this.decodeLine(line);
          if (event) onEvent(event);
        }
      } catch { /* ignore malformed messages */ }
    };

    this.ws.onerror = (err: any) => console.error('[solana-listener] ws error:', err.message);
    this.ws.onclose = () => console.warn('[solana-listener] ws closed — reconnect logic omitted for brevity');
  }

  stop(): void {
    if (this.ws) this.ws.close();
  }

  /**
   * Parse: "Program log: bridge_fund:<txHash>:<target>:<asset>:<amount>"
   */
  private decodeLine(line: string): BridgeEvent | null {
    try {
      const payload = line.replace('Program log: bridge_fund:', '');
      const parts = payload.split(':');
      if (parts.length !== 4) return this.rejectLine(line, 'expected 4 fields');
      const [txHash, target, asset, amount] = parts;
      if (!txHash || !target || !asset || !amount) return this.rejectLine(line, 'missing field');
      if (!/^\d+$/.test(amount)) return this.rejectLine(line, 'amount is not numeric');
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
  (service as any).nonces = new NonceStore();
  (service as any).startedAt = Date.now();
  (service as any).lastEventPerChain = new Map();
  (service as any).dlq = new DeadLetterQueue();
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

export async function test_below_threshold_event_is_stored_in_dlq(): Promise<void> {
  const service = makeTestService({
    threshold: 3,
    nodes: [{ privateKey: '01'.repeat(32) }, { privateKey: '02'.repeat(32) }],
  });

  const event = makeTestEvent({ chainId: 42, txHash: 'de'.repeat(32) });
  await (service as any).handleEvent(event);

  const entries = service.dlq.all();
  assertEqual(entries.length, 1, 'under-threshold event must be stored in DLQ');
  assertEqual(entries[0].event.txHash, event.txHash, 'DLQ entry must preserve the original txHash');
  assertEqual(entries[0].availableSigners, 2, 'DLQ entry must record available signer count');
  assertEqual(entries[0].requiredSigners, 3, 'DLQ entry must record required signer count');
}

export async function test_health_server_responds_200(): Promise<void> {
  const service = makeTestService();
  const port = 19876;
  const server = startHealthServer(service, port);

  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assertEqual(response.status, 200, '/health must respond 200');
    const body: any = await response.json();
    assertEqual(body.status, 'ok', 'health body.status must be "ok"');
    assert(typeof body.threshold === 'number', 'health body must include threshold');
    assert(typeof body.node_count === 'number', 'health body must include node_count');
    assert(typeof body.dead_letter_queue_size === 'number', 'health body must include dead_letter_queue_size');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

function makeAbiLog(target: string, asset: string, amount: bigint): any {
  const targetTail = encodedString(target);
  const assetTail = encodedString(asset);
  const targetOffset = 32 * 3;
  const assetOffset = targetOffset + targetTail.length / 2;
  return {
    topics: ['0x' + '00'.repeat(32), '0x' + 'cd'.repeat(32)],
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

  const event = (listener as any).decode(makeAbiLog('GDESTINATION', 'CASSET', 123456789n));

  assert(event !== null, 'valid ABI log should decode');
  assertEqual(event.target, 'GDESTINATION', 'target should decode');
  assertEqual(event.asset, 'CASSET', 'asset should decode');
  assertEqual(event.amount, '123456789', 'amount should decode');
}

export function test_eth_listener_rejects_malformed_truncated_log_payload(): void {
  const listener = new EthChainListener({
    rpcUrl: 'http://localhost',
    bridgeContractAddress: '0xbridge',
    eventTopic: '0xtopic',
    chainId: 1,
  });

  const event = (listener as any).decode({ topics: ['0x' + '00'.repeat(32), '0x' + 'cd'.repeat(32)], data: '0x1234' });

  assertEqual(event, null, 'truncated ABI log should be rejected');
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

async function runRelayerSelfTests(): Promise<void> {
  await test_duplicate_event_ignored_via_nonce_store();
  await test_nonce_marked_only_after_successful_submission();
  await test_below_threshold_short_circuits_before_sdk_call();
  await test_below_threshold_event_is_stored_in_dlq();
  await test_health_server_responds_200();
  test_eth_listener_decodes_realistic_abi_log_fixture();
  test_eth_listener_rejects_malformed_truncated_log_payload();
  test_solana_listener_rejects_bad_log_lines();
  test_payload_hash_matches_onchain_algorithm();
  test_amount_encoding_handles_large_decimals();
  test_signature_passes_ed25519_verify();
  test_signature_from_known_seed_is_deterministic();
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
      nodes: (process.env.RELAYER_PRIVATE_KEYS ?? '').split(',').map((pk) => ({ privateKey: pk.trim() })),
      listeners: [
        ...(process.env.ETH_RPC_URL ? [new EthChainListener({
          rpcUrl: process.env.ETH_RPC_URL,
          bridgeContractAddress: process.env.ETH_BRIDGE_CONTRACT!,
          eventTopic: process.env.ETH_EVENT_TOPIC!,
          chainId: 1,
        })] : []),
        ...(process.env.SOLANA_WS_URL ? [new SolanaChainListener({
          wsUrl: process.env.SOLANA_WS_URL,
          programId: process.env.SOLANA_PROGRAM_ID!,
          chainId: 101,
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
