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
 *   chain_id_be4 || tx_hash || target_xdr || asset_xdr ||
 *   amount_be16 || nonce
 * ).
 *
 * target_xdr and asset_xdr replicate the Soroban `Address::to_xdr` output.
 * For Stellar addresses this is the 32-byte raw public-key wrapped in the
 * ScAddress XDR discriminant (4 bytes discriminant + 4 bytes account-id
 * discriminant + 32 bytes key = 40 bytes for G-addresses; for C-addresses the
 * discriminant differs).  Rather than re-implementing XDR encoding here we
 * store the canonical payload hash in the event store and have signers hash
 * the raw fields — keeping the hashing logic here simple and auditable.
 *
 * NOTE: In production you'd use `@stellar/stellar-sdk`'s `xdr` module to
 * encode the addresses exactly as the contract does.  This implementation
 * uses a deterministic UTF-8 encoding of the address string as a documented
 * approximation; replace `encodeAddress` if you need exact XDR fidelity.
 */
function encodeAddress(address: string): Buffer {
  // Replace with xdr.ScAddress encoding via stellar-sdk for exact fidelity.
  return Buffer.from(address, 'utf8');
}

function computePayloadHash(event: BridgeEvent): Buffer {
  const chainIdBuf = Buffer.alloc(4);
  chainIdBuf.writeUInt32BE(event.chainId);

  const txHashBuf = Buffer.from(event.txHash, 'hex');
  const targetBuf = encodeAddress(event.target);
  const assetBuf = encodeAddress(event.asset);

  // amount as big-endian i128 (16 bytes)
  const amountBuf = Buffer.alloc(16);
  const amountBig = BigInt(event.amount);
  amountBuf.writeBigInt64BE(amountBig >> 64n, 0);
  amountBuf.writeBigInt64BE(amountBig & BigInt('0xFFFFFFFFFFFFFFFF'), 8);

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
  // Node's crypto.generateKeyPairSync from seed is not available directly;
  // use the webcrypto subtle API available in Node ≥ 15.
  // For a production relayer use the `@noble/ed25519` or `tweetnacl` library.
  //
  // This implementation uses a deterministic HMAC-SHA512 as a stand-in so the
  // file runs without extra dependencies; swap it out for a real Ed25519 signer.
  const hmac = crypto.createHmac('sha512', seed).update(payloadHash).digest();
  const pubkey = hmac.slice(0, 32).toString('hex');
  const signature = hmac.slice(0, 64).toString('hex'); // placeholder

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
      console.warn(`[relayer] not enough signers: have ${sigs.length}, need ${this.config.threshold}`);
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

async function runRelayerSelfTests(): Promise<void> {
  await test_duplicate_event_ignored_via_nonce_store();
  await test_nonce_marked_only_after_successful_submission();
  await test_below_threshold_short_circuits_before_sdk_call();
  test_eth_listener_decodes_realistic_abi_log_fixture();
  test_eth_listener_rejects_malformed_truncated_log_payload();
  test_solana_listener_rejects_bad_log_lines();
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

    service.start();

    process.on('SIGINT', () => { service.stop(); process.exit(0); });
    process.on('SIGTERM', () => { service.stop(); process.exit(0); });
  }
}
