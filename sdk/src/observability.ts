/**
 * @fileoverview Observability hooks, console logger, and OpenTelemetry integration
 * for the C-Address Onboarding Bridge SDK.
 *
 * ## Overview
 *
 * This module provides three complementary mechanisms for instrumenting the SDK:
 *
 * 1. **{@link ObservabilityHooks}** — a plain callback interface you can implement
 *    however you like (custom metrics, structured logging, tracing, etc.).
 *
 * 2. **{@link ConsoleLogger}** — a ready-made `ObservabilityHooks` implementation
 *    that writes structured JSON lines to `console.log` / `console.error`.
 *    Pass it to `BridgeConfig.hooks` for zero-config debug logging.
 *
 * 3. **{@link createOpenTelemetryHooks}** — creates an `ObservabilityHooks`
 *    implementation backed by an OpenTelemetry `Tracer`.  Every SDK method
 *    becomes a child span with full attribute propagation and error recording.
 *    Requires `@opentelemetry/api` as a peer dependency.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   ConsoleLogger,
 *   createOpenTelemetryHooks,
 * } from '@stellar/c-address-onboarding-bridge-sdk';
 * import { trace } from '@opentelemetry/api';
 *
 * // Debug mode — log everything to the console
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...',
 *   rpcUrl: '...',
 *   networkPassphrase: Networks.TESTNET,
 *   hooks: ConsoleLogger,
 * });
 *
 * // Production — emit OpenTelemetry spans
 * const tracer = trace.getTracer('bridge-sdk', '0.1.0');
 * const sdk = new OnboardingBridgeSDK({
 *   // ...
 *   hooks: createOpenTelemetryHooks(tracer),
 * });
 * ```
 *
 * @module observability
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Lifecycle callbacks that the SDK invokes around every mutating method
 * (state-changing contract calls) and every RPC call.
 *
 * All hooks are **optional** — supply only the callbacks you need.
 * Hooks must not throw; any uncaught exception is silently swallowed so
 * that instrumentation never breaks the core SDK flow.
 *
 * @example
 * ```ts
 * const hooks: ObservabilityHooks = {
 *   onTransactionStart: (method, params) => metrics.increment(`sdk.tx.${method}`),
 *   onTransactionSuccess: (method, result, durationMs) => {
 *     metrics.histogram('sdk.tx.duration', durationMs, { method });
 *   },
 *   onTransactionError: (method, error, durationMs) => {
 *     logger.error({ method, error, durationMs });
 *   },
 *   onRpcCall: (method, params, durationMs) => {
 *     metrics.histogram('sdk.rpc.duration', durationMs, { method });
 *   },
 * };
 * ```
 */
export interface ObservabilityHooks {
  /**
   * Called immediately before a mutating SDK method is executed (before any
   * RPC calls or transaction building takes place).
   *
   * @param method - The SDK method name (e.g. `'fundCAddress'`).
   * @param params - The parameters passed to the method (sanitised — keypairs
   *                 are excluded, only plain option objects are forwarded).
   */
  onTransactionStart?: (method: string, params: unknown) => void;

  /**
   * Called when a mutating SDK method completes without throwing.
   * Note: `status: 'failed'` results still trigger this hook; check
   * `result.status` if you want to distinguish submission failures from
   * network errors.
   *
   * @param method     - The SDK method name.
   * @param result     - The {@link TransactionResult} (or array of results for batch calls).
   * @param durationMs - Wall-clock milliseconds from `onTransactionStart` to completion.
   */
  onTransactionSuccess?: (method: string, result: unknown, durationMs: number) => void;

  /**
   * Called when a mutating SDK method throws an unexpected exception.
   * Normal `status: 'failed'` returns do NOT trigger this; only unhandled
   * exceptions propagated out of the method do.
   *
   * @param method     - The SDK method name.
   * @param error      - The caught exception.
   * @param durationMs - Wall-clock milliseconds elapsed before the throw.
   */
  onTransactionError?: (method: string, error: Error, durationMs: number) => void;

  /**
   * Called after every internal RPC call (simulation, account fetch, send, etc.)
   * whether it succeeded or failed. This provides fine-grained visibility into
   * how long each network round-trip took.
   *
   * @param method     - A descriptive label for the RPC call (e.g. `'simulateTransaction'`,
   *                     `'getAccount'`, `'sendTransaction'`).
   * @param params     - Relevant call parameters for correlation (e.g. contract method name).
   * @param durationMs - Wall-clock milliseconds the call took.
   */
  onRpcCall?: (method: string, params: unknown, durationMs: number) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely invoke a hook callback.  Any thrown exception is caught and logged to
 * `console.error` so instrumentation never disrupts the SDK's core logic.
 *
 * @internal
 */
function safeInvoke(hookName: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // Instrumentation must never crash the SDK.
    console.error(`[bridge-sdk] observability hook "${hookName}" threw:`, err);
  }
}

/**
 * Fire `hooks.onTransactionStart` safely.
 * @internal
 */
export function fireTransactionStart(
  hooks: ObservabilityHooks | undefined,
  method: string,
  params: unknown,
): void {
  if (hooks?.onTransactionStart) {
    safeInvoke('onTransactionStart', () => hooks.onTransactionStart!(method, params));
  }
}

/**
 * Fire `hooks.onTransactionSuccess` safely.
 * @internal
 */
export function fireTransactionSuccess(
  hooks: ObservabilityHooks | undefined,
  method: string,
  result: unknown,
  durationMs: number,
): void {
  if (hooks?.onTransactionSuccess) {
    safeInvoke('onTransactionSuccess', () =>
      hooks.onTransactionSuccess!(method, result, durationMs),
    );
  }
}

/**
 * Fire `hooks.onTransactionError` safely.
 * @internal
 */
export function fireTransactionError(
  hooks: ObservabilityHooks | undefined,
  method: string,
  error: Error,
  durationMs: number,
): void {
  if (hooks?.onTransactionError) {
    safeInvoke('onTransactionError', () =>
      hooks.onTransactionError!(method, error, durationMs),
    );
  }
}

/**
 * Fire `hooks.onRpcCall` safely.
 * @internal
 */
export function fireRpcCall(
  hooks: ObservabilityHooks | undefined,
  method: string,
  params: unknown,
  durationMs: number,
): void {
  if (hooks?.onRpcCall) {
    safeInvoke('onRpcCall', () => hooks.onRpcCall!(method, params, durationMs));
  }
}

/**
 * Helper that wraps an async function with transaction lifecycle hooks.
 *
 * Records `onTransactionStart` before execution, `onTransactionSuccess` on
 * return, and `onTransactionError` if the function throws.
 *
 * @internal
 */
export async function withTransactionHooks<T>(
  hooks: ObservabilityHooks | undefined,
  method: string,
  params: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  fireTransactionStart(hooks, method, params);
  const start = Date.now();
  try {
    const result = await fn();
    fireTransactionSuccess(hooks, method, result, Date.now() - start);
    return result;
  } catch (err: any) {
    fireTransactionError(
      hooks,
      method,
      err instanceof Error ? err : new Error(String(err)),
      Date.now() - start,
    );
    throw err;
  }
}

/**
 * Helper that wraps an async RPC call and fires `onRpcCall` when it completes
 * (whether successfully or not).
 *
 * @internal
 */
export async function withRpcHook<T>(
  hooks: ObservabilityHooks | undefined,
  rpcMethod: string,
  params: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    fireRpcCall(hooks, rpcMethod, params, Date.now() - start);
  }
}

// ---------------------------------------------------------------------------
// Built-in console logger
// ---------------------------------------------------------------------------

/**
 * A ready-made {@link ObservabilityHooks} implementation that writes structured
 * log lines to the console using the `[bridge-sdk]` prefix.
 *
 * - `onTransactionStart` / `onTransactionSuccess` write to `console.log`.
 * - `onTransactionError` writes to `console.error`.
 * - `onRpcCall` writes to `console.log`.
 *
 * Pass this directly as `BridgeConfig.hooks` for zero-config debug output:
 *
 * @example
 * ```ts
 * import { OnboardingBridgeSDK, ConsoleLogger } from '@stellar/c-address-onboarding-bridge-sdk';
 *
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 *   hooks: ConsoleLogger,
 * });
 * ```
 *
 * Sample output:
 * ```
 * [bridge-sdk] tx:start  fundCAddress {"source":"G...","target":"C...","asset":"C...","amount":"1000000"}
 * [bridge-sdk] rpc:call  sendTransaction {"contractMethod":"fund_c_address"} 142ms
 * [bridge-sdk] tx:ok     fundCAddress {"hash":"abc...","status":"pending"} 185ms
 * ```
 */
export const ConsoleLogger: ObservabilityHooks = {
  onTransactionStart(method: string, params: unknown): void {
    console.log(
      `[bridge-sdk] tx:start  ${method}`,
      JSON.stringify(params, null, 0),
    );
  },

  onTransactionSuccess(method: string, result: unknown, durationMs: number): void {
    console.log(
      `[bridge-sdk] tx:ok     ${method}`,
      JSON.stringify(result, null, 0),
      `${durationMs}ms`,
    );
  },

  onTransactionError(method: string, error: Error, durationMs: number): void {
    console.error(
      `[bridge-sdk] tx:error  ${method}`,
      error.message,
      `${durationMs}ms`,
    );
  },

  onRpcCall(method: string, params: unknown, durationMs: number): void {
    console.log(
      `[bridge-sdk] rpc:call  ${method}`,
      JSON.stringify(params, null, 0),
      `${durationMs}ms`,
    );
  },
};

// ---------------------------------------------------------------------------
// OpenTelemetry integration
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the `@opentelemetry/api` `Span` interface used internally.
 * Keeping this narrow means the module compiles even when `@opentelemetry/api`
 * is not installed — the type is only resolved when the caller provides a real
 * `Tracer` object at runtime.
 *
 * @internal
 */
interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(exception: Error | { message: string }): this;
  end(): void;
}

/**
 * Minimal subset of the `@opentelemetry/api` `Tracer` interface.
 * @internal
 */
interface OtelTracer {
  startSpan(name: string, options?: Record<string, unknown>): OtelSpan;
}

/**
 * SpanStatusCode enum values as numeric constants so this file compiles
 * without a hard dependency on `@opentelemetry/api`.
 * - `0` = UNSET, `1` = OK, `2` = ERROR
 * @internal
 */
const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;

/**
 * Options for {@link createOpenTelemetryHooks}.
 */
export interface OpenTelemetryHooksOptions {
  /**
   * If `true`, RPC calls are recorded as **child spans** of the enclosing
   * transaction span.  Adds more granularity at the cost of more spans.
   * Defaults to `true`.
   */
  traceRpcCalls?: boolean;

  /**
   * Prefix for all span names.  Defaults to `'bridge-sdk'`.
   * @example 'my-service/bridge-sdk'
   */
  spanPrefix?: string;
}

/**
 * Create an {@link ObservabilityHooks} implementation backed by an
 * OpenTelemetry `Tracer`.
 *
 * Each mutating SDK method becomes a span with:
 * - `bridge.method` — the SDK method name.
 * - `bridge.tx.hash` — the transaction hash on success.
 * - `bridge.tx.status` — `'pending'`, `'success'`, or `'failed'`.
 * - `bridge.duration_ms` — wall-clock duration.
 *
 * RPC calls (when `traceRpcCalls` is true, the default) produce spans with:
 * - `rpc.method` — the RPC method label.
 * - `rpc.duration_ms` — round-trip duration.
 *
 * @param tracer  - An OpenTelemetry `Tracer` instance obtained from
 *                  `trace.getTracer('bridge-sdk', '0.1.0')`.
 * @param options - Optional configuration.
 *
 * @returns An {@link ObservabilityHooks} object ready to pass to `BridgeConfig.hooks`.
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api';
 * import { OnboardingBridgeSDK, createOpenTelemetryHooks } from '...';
 *
 * const tracer = trace.getTracer('my-service', '1.0.0');
 *
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 *   hooks: createOpenTelemetryHooks(tracer),
 * });
 * ```
 */
export function createOpenTelemetryHooks(
  tracer: OtelTracer,
  options: OpenTelemetryHooksOptions = {},
): ObservabilityHooks {
  const { traceRpcCalls = true, spanPrefix = 'bridge-sdk' } = options;

  // Map from method name → active span, so we can end it in success/error.
  // Using a simple Map is sufficient because SDK calls are typically awaited
  // sequentially per instance.  Concurrent calls to the same method will
  // create overlapping entries, but each key is overwritten; the last span wins.
  // For highly concurrent usage, consider keying by a correlation ID instead.
  const activeSpans = new Map<string, OtelSpan>();

  return {
    onTransactionStart(method: string, params: unknown): void {
      const span = tracer.startSpan(`${spanPrefix}/${method}`);
      span.setAttribute('bridge.method', method);
      // Safely stringify params (may contain non-serialisable values)
      try {
        span.setAttribute('bridge.params', JSON.stringify(params));
      } catch {
        span.setAttribute('bridge.params', '[unserializable]');
      }
      activeSpans.set(method, span);
    },

    onTransactionSuccess(method: string, result: unknown, durationMs: number): void {
      const span = activeSpans.get(method);
      if (!span) return;
      activeSpans.delete(method);

      span.setAttribute('bridge.duration_ms', durationMs);

      // Extract hash and status from TransactionResult (or array of results)
      if (Array.isArray(result)) {
        const hashes = result
          .map((r: any) => r?.hash)
          .filter(Boolean)
          .join(',');
        span.setAttribute('bridge.tx.hashes', hashes);
        const anyFailed = result.some((r: any) => r?.status === 'failed');
        span.setAttribute('bridge.tx.status', anyFailed ? 'partial_failure' : 'pending');
      } else if (result && typeof result === 'object') {
        const r = result as any;
        if (r.hash != null) span.setAttribute('bridge.tx.hash', r.hash);
        if (r.status != null) span.setAttribute('bridge.tx.status', r.status);
        if (r.error != null) span.setAttribute('bridge.tx.error', r.error);
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },

    onTransactionError(method: string, error: Error, durationMs: number): void {
      const span = activeSpans.get(method);
      if (!span) return;
      activeSpans.delete(method);

      span.setAttribute('bridge.duration_ms', durationMs);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      span.end();
    },

    onRpcCall(method: string, params: unknown, durationMs: number): void {
      if (!traceRpcCalls) return;

      const span = tracer.startSpan(`${spanPrefix}/rpc/${method}`);
      span.setAttribute('rpc.method', method);
      span.setAttribute('rpc.duration_ms', durationMs);
      try {
        span.setAttribute('rpc.params', JSON.stringify(params));
      } catch {
        span.setAttribute('rpc.params', '[unserializable]');
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },
  };
}

/**
 * Compose multiple {@link ObservabilityHooks} instances into one.
 *
 * All hooks are called in the order they are supplied.  If one hook throws,
 * the error is swallowed and the remaining hooks are still invoked.
 *
 * Useful for combining the built-in {@link ConsoleLogger} with a custom
 * metrics hook in development:
 *
 * @example
 * ```ts
 * import { composeHooks, ConsoleLogger } from '...';
 *
 * const sdk = new OnboardingBridgeSDK({
 *   // ...
 *   hooks: composeHooks(ConsoleLogger, myMetricsHooks),
 * });
 * ```
 */
export function composeHooks(...hooks: ObservabilityHooks[]): ObservabilityHooks {
  return {
    onTransactionStart(method, params) {
      for (const h of hooks) {
        if (h.onTransactionStart) {
          safeInvoke('onTransactionStart', () => h.onTransactionStart!(method, params));
        }
      }
    },
    onTransactionSuccess(method, result, durationMs) {
      for (const h of hooks) {
        if (h.onTransactionSuccess) {
          safeInvoke('onTransactionSuccess', () =>
            h.onTransactionSuccess!(method, result, durationMs),
          );
        }
      }
    },
    onTransactionError(method, error, durationMs) {
      for (const h of hooks) {
        if (h.onTransactionError) {
          safeInvoke('onTransactionError', () =>
            h.onTransactionError!(method, error, durationMs),
          );
        }
      }
    },
    onRpcCall(method, params, durationMs) {
      for (const h of hooks) {
        if (h.onRpcCall) {
          safeInvoke('onRpcCall', () => h.onRpcCall!(method, params, durationMs));
        }
      }
    },
  };
}
