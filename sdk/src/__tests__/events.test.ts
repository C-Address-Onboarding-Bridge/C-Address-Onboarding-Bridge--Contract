/**
 * Tests for the EventSubscriber polling event API (issue #57).
 */
import { EventSubscriber } from '../events';
import type { CAddressFundedEvent, BridgeEventPayload } from '../events';

const mockGetEvents = jest.fn();
const mockGetLatestLedger = jest.fn();

jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn().mockImplementation(() => ({
      getEvents: mockGetEvents,
      getLatestLedger: mockGetLatestLedger,
    })),
  },
  // The subscriber converts topics/values with scValToNative; the mock passes
  // raw fixture values straight through.
  scValToNative: jest.fn((v: unknown) => v),
}));

const CONTRACT_ID = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

function makeSubscriber(): EventSubscriber {
  return new EventSubscriber({
    contractId: CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    pollingIntervalMs: 1_000,
  });
}

function fundedEventResponse(pagingToken = 'tok-1') {
  return {
    events: [
      {
        topic: ['CAddressFunded', 'CASSET', 'GSOURCE', 'CTARGET'],
        value: [1000, 10],
        ledger: 42,
        pagingToken,
      },
    ],
  };
}

describe('EventSubscriber', () => {
  let subscriber: EventSubscriber;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetEvents.mockReset();
    mockGetEvents.mockResolvedValue({ events: [] });
    mockGetLatestLedger.mockReset();
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    subscriber = makeSubscriber();
  });

  afterEach(() => {
    subscriber.destroy();
    jest.useRealTimers();
  });

  describe('listener registry', () => {
    it('counts listeners and removes them via the unsubscribe function', () => {
      const unsub1 = subscriber.on('CAddressFunded', jest.fn());
      const unsub2 = subscriber.on('*', jest.fn());
      expect(subscriber.listenerCount()).toBe(2);

      unsub1();
      expect(subscriber.listenerCount()).toBe(1);
      unsub2();
      expect(subscriber.listenerCount()).toBe(0);
    });

    it('off() removes every listener for an event name', () => {
      subscriber.on('CAddressFunded', jest.fn());
      subscriber.on('CAddressFunded', jest.fn());
      subscriber.off('CAddressFunded');
      expect(subscriber.listenerCount()).toBe(0);
    });

    it('throws when registering on a destroyed subscriber', () => {
      subscriber.destroy();
      expect(() => subscriber.on('CAddressFunded', jest.fn())).toThrow(
        'EventSubscriber has been destroyed',
      );
    });
  });

  describe('polling loop', () => {
    it('starts polling on the first listener and stops when the last unsubscribes', () => {
      const unsub = subscriber.on('CAddressFunded', jest.fn());
      jest.advanceTimersByTime(3_000);
      expect(mockGetEvents).toHaveBeenCalledTimes(3);

      unsub();
      jest.advanceTimersByTime(3_000);
      expect(mockGetEvents).toHaveBeenCalledTimes(3);
    });

    it('keeps the loop alive when getEvents rejects', async () => {
      mockGetEvents.mockRejectedValueOnce(new Error('rpc down'));
      subscriber.on('CAddressFunded', jest.fn());

      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      jest.advanceTimersByTime(1_000);
      expect(mockGetEvents).toHaveBeenCalledTimes(2);
    });

    it('does not overlap polls when getEvents is slower than the interval (issue #686)', async () => {
      // A slow RPC: each getEvents call takes 2.5s, longer than the 1s interval.
      let inFlight = 0;
      let maxConcurrent = 0;
      mockGetEvents.mockImplementation(async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        inFlight -= 1;
        return { events: [] };
      });

      subscriber.on('*', jest.fn());

      // Advance well past several intervals while the first fetch is in flight.
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();

      // Only one fetch may ever be in flight at a time.
      expect(maxConcurrent).toBe(1);
    });

    it('does not dispatch duplicate events when getEvents is slow (issue #686)', async () => {
      const received: BridgeEventPayload[] = [];
      subscriber.on('*', (e) => received.push(e));

      // Each fetch is slow (2.5s) and always returns the same event with the
      // same paging token. Overlapping polls would dispatch it more than once.
      mockGetEvents.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return fundedEventResponse('tok-1');
      });

      jest.advanceTimersByTime(10_000);
      await Promise.resolve();

      expect(received).toHaveLength(1);
    });
  });

  describe('event dispatch', () => {
    it('parses CAddressFunded events and notifies specific listeners', async () => {
      mockGetEvents.mockResolvedValue(fundedEventResponse());
      const received: CAddressFundedEvent[] = [];
      subscriber.on('CAddressFunded', (e) => received.push(e));

      await subscriber.poll();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        name: 'CAddressFunded',
        asset: 'CASSET',
        source: 'GSOURCE',
        target: 'CTARGET',
        amount: '1000',
        fee: '10',
        ledger: 42,
        pagingToken: 'tok-1',
      });
    });

    it('notifies wildcard listeners for any event', async () => {
      mockGetEvents.mockResolvedValue(fundedEventResponse());
      const received: BridgeEventPayload[] = [];
      subscriber.on('*', (e) => received.push(e));

      await subscriber.poll();

      expect(received).toHaveLength(1);
      expect(received[0].name).toBe('CAddressFunded');
    });

    it('advances the cursor to the last paging token between polls', async () => {
      mockGetEvents.mockResolvedValue(fundedEventResponse('tok-42'));
      subscriber.on('*', jest.fn());

      await subscriber.poll();
      await subscriber.poll();

      const lastCall = mockGetEvents.mock.calls.at(-1)![0];
      expect(lastCall.cursor).toBe('tok-42');
    });

    it('isolates a throwing listener from other listeners', async () => {
      mockGetEvents.mockResolvedValue(fundedEventResponse());
      const healthy = jest.fn();
      subscriber.on('CAddressFunded', () => {
        throw new Error('handler bug');
      });
      subscriber.on('CAddressFunded', healthy);

      await expect(subscriber.poll()).resolves.toBeUndefined();
      expect(healthy).toHaveBeenCalledTimes(1);
    });

    it('emits error event when the underlying RPC call rejects', async () => {
      // Use real timers so async/await works naturally with poll()
      jest.useRealTimers();
      try {
        const rpcError = new Error('RPC endpoint down');
        mockGetEvents.mockRejectedValueOnce(rpcError);

        const errors: Error[] = [];
        subscriber.on('error', (err: Error) => errors.push(err));

        // poll() dispatches errors and rethrows — catch the throw
        await subscriber.poll().catch(() => {});

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe(rpcError);
      } finally {
        jest.useFakeTimers();
      }
    });

    it('isolates a throwing error listener from other error listeners', async () => {
      jest.useRealTimers();
      try {
        mockGetEvents.mockRejectedValueOnce(new Error('rpc down'));

        const healthy = jest.fn();
        subscriber.on('error', () => {
          throw new Error('handler bug');
        });
        subscriber.on('error', healthy);

        await subscriber.poll().catch(() => {});

        expect(healthy).toHaveBeenCalledTimes(1);
      } finally {
        jest.useFakeTimers();
      }
    });

    it('does not stop the polling loop when an error event fires', async () => {
      mockGetEvents.mockRejectedValueOnce(new Error('rpc down'));
      subscriber.on('error', jest.fn());

      jest.advanceTimersByTime(1_000);
      // The existing test pattern: just verify the loop stays alive (call count)
      jest.advanceTimersByTime(1_000);
      expect(mockGetEvents).toHaveBeenCalledTimes(2);
    });

    it('dispatches unknown event names as generic events', async () => {
      mockGetEvents.mockResolvedValue({
        events: [
          { topic: ['SomethingNew', 'extra'], value: 7, ledger: 1, pagingToken: 'p' },
        ],
      });
      const received: BridgeEventPayload[] = [];
      subscriber.on('*', (e) => received.push(e));

      await subscriber.poll();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ name: 'SomethingNew', ledger: 1 });
    });
  });

  describe('topic filter (issue #684)', () => {
    it('requests all contract events without a single-segment topic filter', async () => {
      subscriber.on('*', jest.fn());

      await subscriber.poll();

      const call = mockGetEvents.mock.calls.at(-1)![0];
      const filter = call.filters[0];
      expect(filter.contractIds).toEqual([CONTRACT_ID]);
      // A `topics: [['*']]` filter only matches single-topic events, so the
      // subscriber must not constrain topics to a single segment.
      expect(filter.topics).toBeUndefined();
    });

    it('dispatches multi-topic events from a captured RPC response', async () => {
      // Captured Soroban RPC response containing multi-topic events that the
      // old `topics: [['*']]` filter would have excluded.
      mockGetEvents.mockResolvedValue({
        events: [
          {
            topic: ['CAddressFunded', 'CASSET', 'GSOURCE', 'CTARGET'],
            value: [1000, 10],
            ledger: 42,
            pagingToken: 'tok-1',
          },
        ],
      });
      const received: BridgeEventPayload[] = [];
      subscriber.on('*', (e) => received.push(e));

      await subscriber.poll();

      expect(received).toHaveLength(1);
      expect(received[0].name).toBe('CAddressFunded');
    });
  });
});
