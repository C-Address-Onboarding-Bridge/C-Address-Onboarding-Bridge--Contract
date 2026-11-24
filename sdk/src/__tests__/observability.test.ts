/**
 * Bigint-safe observability hooks.
 *
 * SDK write methods pass `nonce` / `deadline` / amounts to the hooks as
 * `bigint`. These tests make sure the built-in console logger and the
 * OpenTelemetry hooks serialise them instead of throwing.
 */
import {
  ConsoleLogger,
  bigintReplacer,
  composeHooks,
  createOpenTelemetryHooks,
  withRpcHook,
} from '../observability';

describe('bigintReplacer', () => {
  it('converts bigint values to decimal strings', () => {
    expect(JSON.stringify({ nonce: 1n, nested: { deadline: 2n ** 70n } }, bigintReplacer)).toBe(
      '{"nonce":"1","nested":{"deadline":"1180591620717411303424"}}',
    );
  });

  it('leaves other values untouched', () => {
    expect(JSON.stringify({ a: 1, b: 'x', c: null }, bigintReplacer)).toBe('{"a":1,"b":"x","c":null}');
  });
});

describe('ConsoleLogger', () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs onTransactionStart with bigint params without throwing', () => {
    expect(() => ConsoleLogger.onTransactionStart!('fundCAddress', { nonce: 1n })).not.toThrow();

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[bridge-sdk] tx:start  fundCAddress', '{"nonce":"1"}');
  });

  it('logs onRpcCall with bigint params without throwing', () => {
    expect(() => ConsoleLogger.onRpcCall!('sendTransaction', { deadline: 2n }, 12)).not.toThrow();

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[bridge-sdk] rpc:call  sendTransaction', '{"deadline":"2"}', '12ms');
  });

  it('logs a failed onRpcCall to console.error', () => {
    ConsoleLogger.onRpcCall!('getAccount', { nonce: 3n }, 5, new Error('boom'));

    expect(error).toHaveBeenCalledWith('[bridge-sdk] rpc:error getAccount', '{"nonce":"3"}', 'boom', '5ms');
  });
});

describe('createOpenTelemetryHooks', () => {
  function fakeTracer() {
    const span = {
      setAttribute: jest.fn().mockReturnThis(),
      setStatus: jest.fn().mockReturnThis(),
      recordException: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };
    return { tracer: { startSpan: jest.fn(() => span) }, span };
  }

  it('records bigint onTransactionStart params as a span attribute', () => {
    const { tracer, span } = fakeTracer();
    const hooks = createOpenTelemetryHooks(tracer);

    expect(() => hooks.onTransactionStart!('fundCAddress', { nonce: 1n })).not.toThrow();

    expect(tracer.startSpan).toHaveBeenCalledWith('bridge-sdk/fundCAddress');
    expect(span.setAttribute).toHaveBeenCalledWith('bridge.params', '{"nonce":"1"}');
  });

  it('records bigint onRpcCall params and ends the span OK', () => {
    const { tracer, span } = fakeTracer();
    const hooks = createOpenTelemetryHooks(tracer);

    expect(() => hooks.onRpcCall!('sendTransaction', { deadline: 2n }, 7)).not.toThrow();

    expect(tracer.startSpan).toHaveBeenCalledWith('bridge-sdk/rpc/sendTransaction');
    expect(span.setAttribute).toHaveBeenCalledWith('rpc.params', '{"deadline":"2"}');
    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(span.end).toHaveBeenCalled();
  });

  it('marks a failed RPC span as ERROR', () => {
    const { tracer, span } = fakeTracer();
    const hooks = createOpenTelemetryHooks(tracer);
    const err = new Error('rpc down');

    hooks.onRpcCall!('getAccount', {}, 3, err);

    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'rpc down' });
    expect(span.recordException).toHaveBeenCalledWith(err);
  });

  it('skips RPC spans when traceRpcCalls is false', () => {
    const { tracer } = fakeTracer();
    createOpenTelemetryHooks(tracer, { traceRpcCalls: false }).onRpcCall!('x', {}, 1);
    expect(tracer.startSpan).not.toHaveBeenCalled();
  });
});

describe('composeHooks', () => {
  it('forwards bigint params and the rpc error to every hook', () => {
    const a = { onRpcCall: jest.fn() };
    const b = { onRpcCall: jest.fn() };
    const err = new Error('x');

    composeHooks(a, b).onRpcCall!('m', { nonce: 1n }, 4, err);

    expect(a.onRpcCall).toHaveBeenCalledWith('m', { nonce: 1n }, 4, err);
    expect(b.onRpcCall).toHaveBeenCalledWith('m', { nonce: 1n }, 4, err);
  });
});

describe('withRpcHook (#1121)', () => {
  it('resolves to the wrapped value when no hooks are configured', async () => {
    await expect(withRpcHook(undefined, 'x', {}, async () => 42)).resolves.toBe(42);
  });

  it('rejects with the same error when no hooks are configured', async () => {
    const err = new Error('rpc down');
    await expect(withRpcHook(undefined, 'x', {}, async () => { throw err; })).rejects.toBe(err);
  });

  it('calls onRpcCall exactly once on success, with no error', async () => {
    const onRpcCall = jest.fn();
    await expect(withRpcHook({ onRpcCall }, 'getAccount', { a: 1 }, async () => 'ok')).resolves.toBe('ok');
    expect(onRpcCall).toHaveBeenCalledTimes(1);
    expect(onRpcCall).toHaveBeenCalledWith('getAccount', { a: 1 }, expect.any(Number), undefined);
  });

  it('calls onRpcCall exactly once on failure, with the error', async () => {
    const onRpcCall = jest.fn();
    const err = new Error('boom');
    await expect(withRpcHook({ onRpcCall }, 'sendTransaction', {}, async () => { throw err; })).rejects.toBe(err);
    expect(onRpcCall).toHaveBeenCalledTimes(1);
    expect(onRpcCall).toHaveBeenCalledWith('sendTransaction', {}, expect.any(Number), err);
  });
});
