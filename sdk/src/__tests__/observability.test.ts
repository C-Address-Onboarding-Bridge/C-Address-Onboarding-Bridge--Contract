import {
  ConsoleLogger,
  createOpenTelemetryHooks,
  composeHooks,
  withTransactionHooks,
  withRpcHook,
} from '../index';
import type { ObservabilityHooks, OpenTelemetryHooksOptions } from '../index';

/** A fake OpenTelemetry tracer that records every span it starts. */
function fakeTracer() {
  const spans: Array<{
    name: string;
    attributes: Record<string, string | number | boolean>;
    status?: { code: number; message?: string };
    exceptions: unknown[];
    ended: boolean;
  }> = [];
  const tracer = {
    startSpan(name: string) {
      const record = {
        name,
        attributes: {} as Record<string, string | number | boolean>,
        status: undefined as { code: number; message?: string } | undefined,
        exceptions: [] as unknown[],
        ended: false,
      };
      spans.push(record);
      const span = {
        setAttribute(key: string, value: string | number | boolean) {
          record.attributes[key] = value;
          return span;
        },
        setStatus(status: { code: number; message?: string }) {
          record.status = status;
          return span;
        },
        recordException(exception: unknown) {
          record.exceptions.push(exception);
          return span;
        },
        end() {
          record.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

describe('observability exports (#1120)', () => {
  it('re-exports every observability helper from the package entry point', () => {
    expect(ConsoleLogger).toBeDefined();
    expect(createOpenTelemetryHooks).toBeDefined();
    expect(composeHooks).toBeDefined();
    expect(withTransactionHooks).toBeDefined();
    expect(withRpcHook).toBeDefined();

    // OpenTelemetryHooksOptions / ObservabilityHooks are types: this only
    // compiles if they are exported.
    const options: OpenTelemetryHooksOptions = { traceRpcCalls: false, spanPrefix: 'x' };
    const hooks: ObservabilityHooks = createOpenTelemetryHooks(fakeTracer().tracer, options);
    expect(hooks.onTransactionStart).toBeInstanceOf(Function);
  });
});

describe('ConsoleLogger', () => {
  afterEach(() => jest.restoreAllMocks());

  it('serialises bigint params instead of throwing (#869)', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => ConsoleLogger.onTransactionStart!('fundCAddress', { amount: 1000000n })).not.toThrow();
    expect(() => ConsoleLogger.onRpcCall!('sendTransaction', { deadline: 2n }, 5)).not.toThrow();

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenNthCalledWith(1, '[bridge-sdk] tx:start  fundCAddress', '{"amount":"1000000"}');
    expect(log).toHaveBeenNthCalledWith(2, '[bridge-sdk] rpc:call  sendTransaction', '{"deadline":"2"}', '5ms');
  });

  it('logs a failed RPC call to console.error', () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    ConsoleLogger.onRpcCall!('getAccount', {}, 7, new Error('boom'));

    expect(error).toHaveBeenCalledWith('[bridge-sdk] rpc:error getAccount', '{}', 'boom', '7ms');
  });
});

describe('createOpenTelemetryHooks', () => {
  it('records bigint params as a string span attribute (#869)', () => {
    const { tracer, spans } = fakeTracer();
    const hooks = createOpenTelemetryHooks(tracer);

    hooks.onTransactionStart!('fundCAddress', { nonce: 1n });
    hooks.onTransactionSuccess!('fundCAddress', { hash: 'abc', status: 'pending' }, 12);

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('bridge-sdk/fundCAddress');
    expect(spans[0].attributes['bridge.params']).toBe('{"nonce":"1"}');
    expect(spans[0].attributes['bridge.tx.hash']).toBe('abc');
    expect(spans[0].status).toEqual({ code: 1 });
    expect(spans[0].ended).toBe(true);
  });

  it('marks a failed RPC call span as ERROR', () => {
    const { tracer, spans } = fakeTracer();
    const hooks = createOpenTelemetryHooks(tracer);
    const err = new Error('rpc down');

    hooks.onRpcCall!('sendTransaction', { amount: 3n }, 9, err);

    expect(spans[0].attributes['rpc.params']).toBe('{"amount":"3"}');
    expect(spans[0].status).toEqual({ code: 2, message: 'rpc down' });
    expect(spans[0].exceptions).toEqual([err]);
  });

  it('does not create RPC spans when traceRpcCalls is false', () => {
    const { tracer, spans } = fakeTracer();
    createOpenTelemetryHooks(tracer, { traceRpcCalls: false }).onRpcCall!('getAccount', {}, 1);
    expect(spans).toHaveLength(0);
  });
});

describe('composeHooks', () => {
  it('calls every hook, forwards the RPC error, and survives a throwing hook', () => {
    const calls: string[] = [];
    const throwing: ObservabilityHooks = {
      onRpcCall: () => {
        throw new Error('hook bug');
      },
    };
    const recording: ObservabilityHooks = {
      onRpcCall: (method, _params, _ms, error) => {
        calls.push(`${method}:${error?.message ?? 'ok'}`);
      },
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    composeHooks(throwing, recording).onRpcCall!('getAccount', {}, 1, new Error('boom'));

    expect(calls).toEqual(['getAccount:boom']);
    jest.restoreAllMocks();
  });
});

describe('withTransactionHooks', () => {
  it('routes a status: failed result to onTransactionError (#866)', async () => {
    const onTransactionSuccess = jest.fn();
    const onTransactionError = jest.fn();

    const result = await withTransactionHooks(
      { onTransactionSuccess, onTransactionError },
      'fundCAddress',
      {},
      async () => ({ hash: 'h', status: 'failed', error: 'insufficient balance' }),
    );

    expect(result).toEqual({ hash: 'h', status: 'failed', error: 'insufficient balance' });
    expect(onTransactionSuccess).not.toHaveBeenCalled();
    expect(onTransactionError).toHaveBeenCalledTimes(1);
    expect(onTransactionError.mock.calls[0][1].message).toBe('insufficient balance');
  });
});

describe('withRpcHook', () => {
  it('returns the result and fires onRpcCall once on success', async () => {
    const onRpcCall = jest.fn();

    await expect(withRpcHook({ onRpcCall }, 'getAccount', { id: 1 }, async () => 42)).resolves.toBe(42);

    expect(onRpcCall).toHaveBeenCalledTimes(1);
    expect(onRpcCall.mock.calls[0][0]).toBe('getAccount');
    expect(onRpcCall.mock.calls[0][3]).toBeUndefined();
  });

  it('rethrows the error and passes it to onRpcCall once', async () => {
    const onRpcCall = jest.fn();
    const err = new Error('rpc down');

    await expect(
      withRpcHook({ onRpcCall }, 'sendTransaction', {}, async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    expect(onRpcCall).toHaveBeenCalledTimes(1);
    expect(onRpcCall.mock.calls[0][3]).toBe(err);
  });

  it('passes the result and the error through when no hook is configured', async () => {
    await expect(withRpcHook(undefined, 'getAccount', {}, async () => 'value')).resolves.toBe('value');
    await expect(
      withRpcHook({}, 'getAccount', {}, async () => {
        throw new Error('still thrown');
      }),
    ).rejects.toThrow('still thrown');
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
