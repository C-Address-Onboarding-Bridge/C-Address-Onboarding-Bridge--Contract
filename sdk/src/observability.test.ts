import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConsoleLogger, OtelAdapter, bigintReplacer } from './observability';

describe('bigintReplacer', () => {
  it('converts bigint values to strings', () => {
    expect(JSON.stringify({ nonce: 1n }, bigintReplacer)).toBe(
      '{"nonce":"1"}',
    );
  });
});

describe('ConsoleLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs onTransactionStart with bigint params without throwing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = new ConsoleLogger();
    expect(() =>
      logger.onTransactionStart('x', { nonce: 1n }),
    ).not.toThrow();

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[bridge-sdk] tx:start  x',
      '{"nonce":"1"}',
    );
  });

  it('logs onRpcCall with bigint params without throwing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = new ConsoleLogger();
    expect(() =>
      logger.onRpcCall('x', { deadline: 2n }),
    ).not.toThrow();

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[bridge-sdk] rpc:call  x',
      '{"deadline":"2"}',
    );
  });
});

describe('OtelAdapter', () => {
  it('records bigint params as span attributes', () => {
    const setAttribute = vi.fn();
    const tracer = {
      startSpan: vi.fn(() => ({ setAttribute, end: vi.fn() })),
    };

    const adapter = new OtelAdapter(tracer);
    adapter.onTransactionStart('x', { nonce: 1n });

    expect(setAttribute).toHaveBeenCalledWith('params', '{"nonce":"1"}');
  });
});
