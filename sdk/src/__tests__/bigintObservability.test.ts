import { ConsoleLogger, createOpenTelemetryHooks } from '../observability';

describe('BigInt serialization in observability (#869)', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('ConsoleLogger', () => {
    it('serializes bigint params in onTransactionStart without throwing', () => {
      expect(() => {
        ConsoleLogger.onTransactionStart!('fundCAddress', {
          nonce: 1n,
          deadline: 1700000000n,
        });
      }).not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(
        '[bridge-sdk] tx:start  fundCAddress',
        '{"nonce":"1","deadline":"1700000000"}'
      );
    });

    it('serializes bigint result in onTransactionSuccess without throwing', () => {
      expect(() => {
        ConsoleLogger.onTransactionSuccess!(
          'fundCAddress',
          { commitmentId: 999999999999999999n },
          120
        );
      }).not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(
        '[bridge-sdk] tx:ok     fundCAddress',
        '{"commitmentId":"999999999999999999"}',
        '120ms'
      );
    });

    it('serializes bigint params in onRpcCall without throwing', () => {
      expect(() => {
        ConsoleLogger.onRpcCall!(
          'sendTransaction',
          { nonce: 42n },
          45
        );
      }).not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(
        '[bridge-sdk] rpc:call  sendTransaction',
        '{"nonce":"42"}',
        '45ms'
      );
    });
  });

  describe('OpenTelemetry adapter', () => {
    it('records serialized bigint in bridge.params instead of [unserializable]', () => {
      const attributes: Record<string, any> = {};
      const mockSpan: any = {
        setAttribute: jest.fn((k: string, v: any) => {
          attributes[k] = v;
          return mockSpan;
        }),
        setStatus: jest.fn().mockReturnThis(),
        recordException: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockTracer = {
        startSpan: jest.fn(() => mockSpan),
      };

      const hooks = createOpenTelemetryHooks(mockTracer as any);
      hooks.onTransactionStart!('fundCAddress', { nonce: 100n, deadline: 200n });

      expect(attributes['bridge.params']).toBe('{"nonce":"100","deadline":"200"}');
      expect(attributes['bridge.params']).not.toBe('[unserializable]');
    });

    it('records serialized bigint in rpc.params instead of [unserializable]', () => {
      const attributes: Record<string, any> = {};
      const mockSpan: any = {
        setAttribute: jest.fn((k: string, v: any) => {
          attributes[k] = v;
          return mockSpan;
        }),
        setStatus: jest.fn().mockReturnThis(),
        recordException: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockTracer = {
        startSpan: jest.fn(() => mockSpan),
      };

      const hooks = createOpenTelemetryHooks(mockTracer as any);
      hooks.onRpcCall!('simulateTransaction', { nonce: 555n }, 30);

      expect(attributes['rpc.params']).toBe('{"nonce":"555"}');
      expect(attributes['rpc.params']).not.toBe('[unserializable]');
    });
  });
});
