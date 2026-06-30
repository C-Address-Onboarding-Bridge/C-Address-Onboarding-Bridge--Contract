/**
 * Tests for BridgeEventEmitter (sdk/src/events.ts)
 *
 * All RPC calls are mocked — no real network access is required.
 */
import { BridgeEventEmitter } from "../events";
import type {
  CAddressFundedEvent,
  FeesWithdrawnEvent,
  AdminChangedEvent,
  BridgeEvent,
} from "../events";
import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Mock stellar-sdk
// ---------------------------------------------------------------------------

jest.mock("@stellar/stellar-sdk", () => ({
  SorobanRpc: {
    Server: jest.fn(),
  },
  scValToNative: jest.fn((v: any) => v),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

const CONFIG = {
  contractId: CONTRACT_ID,
  rpcUrl: RPC_URL,
  networkPassphrase: PASSPHRASE,
  pollIntervalMs: 0, // instant for tests
  retry: { baseDelayMs: 0, maxDelayMs: 0 },
};

/** Build a minimal raw Soroban event as returned by getEvents(). */
function rawEvent(overrides: {
  id?: string;
  ledger?: number;
  txHash?: string;
  topic: any[];
  value: any;
}) {
  return {
    id: overrides.id ?? "event-1",
    ledger: overrides.ledger ?? 100,
    txHash: overrides.txHash ?? "tx-abc",
    topic: overrides.topic,
    value: overrides.value,
  };
}

/**
 * Build a mock SorobanRpc.Server that:
 *  - returns `ledger` from getLatestLedger()
 *  - returns `events` arrays sequentially from getEvents() on each call
 */
function makeMockProvider(latestLedger: number, ...eventPages: any[][]) {
  let callCount = 0;
  const mockProvider = {
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: latestLedger }),
    getEvents: jest.fn().mockImplementation(() => {
      const page = eventPages[callCount] ?? [];
      callCount++;
      return Promise.resolve({ events: page });
    }),
  };
  (SorobanRpc.Server as jest.Mock).mockImplementation(() => mockProvider);
  return mockProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BridgeEventEmitter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: scValToNative just returns the value unchanged for simplicity.
    (scValToNative as jest.Mock).mockImplementation((v: any) => v);
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("is not running before start()", () => {
      makeMockProvider(100);
      const emitter = new BridgeEventEmitter(CONFIG);
      expect(emitter.isRunning).toBe(false);
    });

    it("is running after start()", () => {
      makeMockProvider(100);
      const emitter = new BridgeEventEmitter(CONFIG);
      emitter.start();
      expect(emitter.isRunning).toBe(true);
      emitter.stop();
    });

    it("is not running after stop()", () => {
      makeMockProvider(100);
      const emitter = new BridgeEventEmitter(CONFIG);
      emitter.start();
      emitter.stop();
      expect(emitter.isRunning).toBe(false);
    });

    it("start() is idempotent — calling twice does not duplicate polling", async () => {
      const mock = makeMockProvider(100, []);
      const emitter = new BridgeEventEmitter(CONFIG);
      emitter.start();
      emitter.start(); // second call should be a no-op
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();
      // getLatestLedger should only be called once
      expect(mock.getLatestLedger).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // CAddressFunded
  // -------------------------------------------------------------------------

  describe("CAddressFunded event", () => {
    it("delivers a typed CAddressFundedEvent to a specific listener", async () => {
      const raw = rawEvent({
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["1000", "10"],
      });
      makeMockProvider(99, [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const received: CAddressFundedEvent[] = [];
      emitter.on("CAddressFunded", (e) => received.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("CAddressFunded");
      expect(received[0].asset).toBe("CASSET");
      expect(received[0].source).toBe("GSOURCE");
      expect(received[0].target).toBe("CTARGET");
      expect(received[0].amount).toBe("1000");
      expect(received[0].fee).toBe("10");
      expect(received[0].ledger).toBe(100);
      expect(received[0].txHash).toBe("tx-abc");
    });
  });

  // -------------------------------------------------------------------------
  // FeesWithdrawn
  // -------------------------------------------------------------------------

  describe("FeesWithdrawn event", () => {
    it("delivers a typed FeesWithdrawnEvent to a specific listener", async () => {
      const raw = rawEvent({
        topic: ["FeesWithdrawn", "GCOLLECTOR"],
        value: ["500", "CASSET"],
      });
      makeMockProvider(99, [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const received: FeesWithdrawnEvent[] = [];
      emitter.on("FeesWithdrawn", (e) => received.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("FeesWithdrawn");
      expect(received[0].feeCollector).toBe("GCOLLECTOR");
      expect(received[0].amount).toBe("500");
      expect(received[0].asset).toBe("CASSET");
    });
  });

  // -------------------------------------------------------------------------
  // AdminChanged
  // -------------------------------------------------------------------------

  describe("AdminChanged event", () => {
    it("delivers a typed AdminChangedEvent to a specific listener", async () => {
      const raw = rawEvent({
        topic: ["AdminChanged", "GOLD_ADMIN", "GNEW_ADMIN"],
        value: [],
      });
      makeMockProvider(99, [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const received: AdminChangedEvent[] = [];
      emitter.on("AdminChanged", (e) => received.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("AdminChanged");
      expect(received[0].oldAdmin).toBe("GOLD_ADMIN");
      expect(received[0].newAdmin).toBe("GNEW_ADMIN");
    });
  });

  // -------------------------------------------------------------------------
  // Wildcard listener
  // -------------------------------------------------------------------------

  describe("wildcard listener (*)", () => {
    it("receives all events regardless of type", async () => {
      const funded = rawEvent({
        id: "e1",
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["1000", "10"],
      });
      const withdrawn = rawEvent({
        id: "e2",
        ledger: 101,
        topic: ["FeesWithdrawn", "GCOLLECTOR"],
        value: ["500", "CASSET"],
      });
      makeMockProvider(99, [funded, withdrawn]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const all: BridgeEvent[] = [];
      emitter.on("*", (e) => all.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(all).toHaveLength(2);
      expect(all[0].type).toBe("CAddressFunded");
      expect(all[1].type).toBe("FeesWithdrawn");
    });
  });

  // -------------------------------------------------------------------------
  // once()
  // -------------------------------------------------------------------------

  describe("once()", () => {
    it("resolves with the first matching event and does not fire again", async () => {
      const e1 = rawEvent({
        id: "e1",
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["100", "1"],
      });
      const e2 = rawEvent({
        id: "e2",
        ledger: 101,
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["200", "2"],
      });
      makeMockProvider(99, [e1, e2]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const oncePromise = emitter.once("CAddressFunded");
      emitter.start();
      const received = await oncePromise;
      emitter.stop();

      expect(received.type).toBe("CAddressFunded");
      expect((received as CAddressFundedEvent).amount).toBe("100");
    });
  });

  // -------------------------------------------------------------------------
  // off()
  // -------------------------------------------------------------------------

  describe("off()", () => {
    it("stops delivering events after unsubscription", async () => {
      const raw = rawEvent({
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["1000", "10"],
      });
      makeMockProvider(99, [raw], [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const received: CAddressFundedEvent[] = [];
      const listener = (e: CAddressFundedEvent) => received.push(e);
      emitter.on("CAddressFunded", listener);
      emitter.off("CAddressFunded", listener);
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(received).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate event deduplication
  // -------------------------------------------------------------------------

  describe("event deduplication", () => {
    it("does not re-deliver an event with the same id", async () => {
      const raw = rawEvent({
        id: "dup-1",
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["1000", "10"],
      });
      // Return the same event in two consecutive poll pages
      makeMockProvider(99, [raw], [raw]);
      const emitter = new BridgeEventEmitter({ ...CONFIG, pollIntervalMs: 5 });

      const received: BridgeEvent[] = [];
      emitter.on("*", (e) => received.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 50));
      emitter.stop();

      expect(received).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // startLedger option
  // -------------------------------------------------------------------------

  describe("startLedger option", () => {
    it("uses the configured numeric startLedger without fetching latest", async () => {
      const mock = makeMockProvider(200, []);
      const emitter = new BridgeEventEmitter({ ...CONFIG, startLedger: 42 });
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(mock.getLatestLedger).not.toHaveBeenCalled();
      expect(mock.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 42 }),
      );
    });

    it('fetches the latest ledger when startLedger is "latest"', async () => {
      const mock = makeMockProvider(300, []);
      const emitter = new BridgeEventEmitter({
        ...CONFIG,
        startLedger: "latest",
      });
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(mock.getLatestLedger).toHaveBeenCalledTimes(1);
      expect(mock.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 300 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unknown / malformed events are ignored
  // -------------------------------------------------------------------------

  describe("unknown events", () => {
    it("ignores events with unrecognised type names", async () => {
      const raw = rawEvent({ topic: ["UnknownEventXYZ"], value: [] });
      makeMockProvider(99, [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const received: BridgeEvent[] = [];
      emitter.on("*", (e) => received.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(received).toHaveLength(0);
    });

    it("ignores events with empty topics array", async () => {
      const raw = rawEvent({ topic: [], value: [] });
      makeMockProvider(99, [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const all: BridgeEvent[] = [];
      emitter.on("*", (e) => all.push(e));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(all).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple listeners on the same event
  // -------------------------------------------------------------------------

  describe("multiple listeners", () => {
    it("delivers one event to all registered listeners for that type", async () => {
      const raw = rawEvent({
        topic: ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
        value: ["100", "1"],
      });
      makeMockProvider(99, [raw]);
      const emitter = new BridgeEventEmitter(CONFIG);

      const calls: number[] = [];
      emitter.on("CAddressFunded", () => calls.push(1));
      emitter.on("CAddressFunded", () => calls.push(2));
      emitter.start();
      await new Promise((r) => setTimeout(r, 20));
      emitter.stop();

      expect(calls.sort()).toEqual([1, 2]);
    });
  });
});
