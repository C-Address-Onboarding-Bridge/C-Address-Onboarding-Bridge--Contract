import {
  withTransactionHooks,
  withRpcHook,
  createOpenTelemetryHooks,
  ConsoleLogger,
  composeHooks,
  ObservabilityHooks,
} from '../observability';

const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;

describe('Observability failure routing and reporting (Issue #866)', () => {
  describe('withTransactionHooks routing', () => {
    it('routes failed transaction result ({ status: "failed" }) to onTransactionError', async () => {
      const onTransactionSuccess = jest.fn();
      const onTransactionError = jest.fn();

      const hooks: ObservabilityHooks = {
        onTransactionSuccess,
        onTransactionError,
      };

      const failedResult = {
        status: 'failed',
        error: 'Simulation failed: ContractError(1)',
      };

      const result = await withTransactionHooks(
        hooks,
        'fundCAddress',
        { amount: '1000' },
        async () => failedResult,
      );

      expect(result).toBe(failedResult);
      expect(onTransactionError).toHaveBeenCalledTimes(1);
      const [method, err, duration] = onTransactionError.mock.calls[0];
      expect(method).toBe('fundCAddress');
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Simulation failed: ContractError(1)');
      expect(typeof duration).toBe('number');
      expect(onTransactionSuccess).not.toHaveBeenCalled();
    });

    it('routes partial batch failure array to onTransactionError', async () => {
      const onTransactionSuccess = jest.fn();
      const onTransactionError = jest.fn();

      const hooks: ObservabilityHooks = {
        onTransactionSuccess,
        onTransactionError,
      };

      const batchResults = [
        { status: 'success', hash: 'abc' },
        { status: 'failed', error: 'Target address blocklisted' },
      ];

      const result = await withTransactionHooks(
        hooks,
        'batchFundCAddress',
        {},
        async () => batchResults,
      );

      expect(result).toBe(batchResults);
      expect(onTransactionError).toHaveBeenCalledTimes(1);
      const [method, err] = onTransactionError.mock.calls[0];
      expect(method).toBe('batchFundCAddress');
      expect(err.message).toBe('Target address blocklisted');
      expect(onTransactionSuccess).not.toHaveBeenCalled();
    });

    it('routes successful transaction to onTransactionSuccess', async () => {
      const onTransactionSuccess = jest.fn();
      const onTransactionError = jest.fn();

      const hooks: ObservabilityHooks = {
        onTransactionSuccess,
        onTransactionError,
      };

      const successResult = {
        status: 'success',
        hash: '0x123',
      };

      const result = await withTransactionHooks(
        hooks,
        'fundCAddress',
        { amount: '1000' },
        async () => successResult,
      );

      expect(result).toBe(successResult);
      expect(onTransactionSuccess).toHaveBeenCalledTimes(1);
      expect(onTransactionError).not.toHaveBeenCalled();
    });

    it('routes thrown exceptions to onTransactionError and re-throws', async () => {
      const onTransactionSuccess = jest.fn();
      const onTransactionError = jest.fn();

      const hooks: ObservabilityHooks = {
        onTransactionSuccess,
        onTransactionError,
      };

      await expect(
        withTransactionHooks(
          hooks,
          'fundCAddress',
          {},
          async () => {
            throw new Error('Network timeout');
          },
        ),
      ).rejects.toThrow('Network timeout');

      expect(onTransactionError).toHaveBeenCalledTimes(1);
      expect(onTransactionSuccess).not.toHaveBeenCalled();
    });
  });

  describe('withRpcHook success/error reporting', () => {
    it('passes success=true to onRpcCall when RPC completes', async () => {
      const onRpcCall = jest.fn();
      const hooks: ObservabilityHooks = { onRpcCall };

      const res = await withRpcHook(hooks, 'sendTransaction', { foo: 'bar' }, async () => 'tx_ok');
      expect(res).toBe('tx_ok');

      expect(onRpcCall).toHaveBeenCalledTimes(1);
      const [method, params, duration, success, error] = onRpcCall.mock.calls[0];
      expect(method).toBe('sendTransaction');
      expect(params).toEqual({ foo: 'bar' });
      expect(typeof duration).toBe('number');
      expect(success).toBe(true);
      expect(error).toBeUndefined();
    });

    it('passes success=false and error to onRpcCall when RPC throws', async () => {
      const onRpcCall = jest.fn();
      const hooks: ObservabilityHooks = { onRpcCall };

      await expect(
        withRpcHook(hooks, 'simulateTransaction', {}, async () => {
          throw new Error('RPC 503');
        }),
      ).rejects.toThrow('RPC 503');

      expect(onRpcCall).toHaveBeenCalledTimes(1);
      const [method, params, duration, success, error] = onRpcCall.mock.calls[0];
      expect(method).toBe('simulateTransaction');
      expect(success).toBe(false);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('RPC 503');
    });
  });

  describe('OpenTelemetry adapter span status', () => {
    function createMockTracer() {
      const spans: any[] = [];
      const tracer = {
        startSpan: jest.fn((name: string) => {
          const span: any = {
            name,
            attributes: {} as Record<string, any>,
            status: {} as any,
          };
          span.setAttribute = jest.fn((k: string, v: any) => {
            span.attributes[k] = v;
            return span;
          });
          span.setStatus = jest.fn((status: any) => {
            span.status = status;
            return span;
          });
          span.recordException = jest.fn();
          span.end = jest.fn();
          spans.push(span);
          return span;
        }),
      };
      return { tracer: tracer as any, spans };
    }

    it('sets SpanStatusCode.ERROR when transaction result has status "failed"', () => {
      const { tracer, spans } = createMockTracer();
      const hooks = createOpenTelemetryHooks(tracer);

      hooks.onTransactionStart?.('fundCAddress', {});
      hooks.onTransactionSuccess?.(
        'fundCAddress',
        { status: 'failed', error: 'Account not found' },
        150,
      );

      const span = spans.find((s) => s.name.includes('fundCAddress'));
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('Account not found');
      expect(span.attributes['bridge.tx.status']).toBe('failed');
      expect(span.attributes['bridge.tx.error']).toBe('Account not found');
    });

    it('sets SpanStatusCode.OK when transaction result is successful', () => {
      const { tracer, spans } = createMockTracer();
      const hooks = createOpenTelemetryHooks(tracer);

      hooks.onTransactionStart?.('fundCAddress', {});
      hooks.onTransactionSuccess?.('fundCAddress', { status: 'success', hash: '0xabc' }, 150);

      const span = spans.find((s) => s.name.includes('fundCAddress'));
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('sets SpanStatusCode.ERROR when onRpcCall reports failure', () => {
      const { tracer, spans } = createMockTracer();
      const hooks = createOpenTelemetryHooks(tracer);

      hooks.onRpcCall?.('simulateTransaction', {}, 50, false, new Error('Sim error'));

      const span = spans.find((s) => s.name.includes('simulateTransaction'));
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('Sim error');
    });
  });

  describe('composeHooks', () => {
    it('propagates success and error to all composed hooks in onRpcCall', () => {
      const h1 = { onRpcCall: jest.fn() };
      const h2 = { onRpcCall: jest.fn() };
      const composed = composeHooks(h1, h2);

      const err = new Error('fail');
      composed.onRpcCall?.('getAccount', {}, 30, false, err);

      expect(h1.onRpcCall).toHaveBeenCalledWith('getAccount', {}, 30, false, err);
      expect(h2.onRpcCall).toHaveBeenCalledWith('getAccount', {}, 30, false, err);
    });
  });
});

