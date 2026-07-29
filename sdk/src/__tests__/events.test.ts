/**
 * Tests for the EventSubscriber polling event API (issue #57).
 */
import { EventSubscriber } from '../events';
import type { CAddressFundedEvent, BridgeEventPayload, BridgeEventName } from '../events';

const mockGetEvents = jest.fn();

jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn().mockImplementation(() => ({
      getEvents: mockGetEvents,
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
        subscriber.on('error' as BridgeEventName, (err: Error) => errors.push(err));

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
        subscriber.on('error' as BridgeEventName, () => {
          throw new Error('handler bug');
        });
        subscriber.on('error' as BridgeEventName, healthy);

        await subscriber.poll().catch(() => {});

        expect(healthy).toHaveBeenCalledTimes(1);
      } finally {
        jest.useFakeTimers();
      }
    });

    it('does not stop the polling loop when an error event fires', async () => {
      mockGetEvents.mockRejectedValueOnce(new Error('rpc down'));
      subscriber.on('error' as BridgeEventName, jest.fn());

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
});
