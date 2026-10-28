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
 *   onRpcCall: (method, params, durationMs, error) => {
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
   * Called when a mutating SDK method completes successfully (i.e. the result
   * does not carry a `status: 'failed'`). Failed results are routed to
   * {@link onTransactionError} instead.
   *
   * @param method     - The SDK method name.
   * @param result     - The {@link TransactionResult} (or array of results for batch calls).
   * @param durationMs - Wall-clock milliseconds from `onTransactionStart` to completion.
   */
  onTransactionSuccess?: (method: string, result: unknown, durationMs: number) => void;

  /**
   * Called when a mutating SDK method fails — either because it threw an
   * unexpected exception, or because it returned a result with
   * `status: 'failed'` (or an array containing a failed element).
   *
   * @param method     - The SDK method name.
   * @param error      - The caught exception, or an `Error` describing the failed result.
   * @param durationMs - Wall-clock milliseconds elapsed before the failure.
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
   * @param error      - The thrown error if the RPC call failed, otherwise `undefined`.
   */
  onRpcCall?: (method: string, params: unknown, durationMs: number, error?: Error) => void;
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
  error?: Error,
): void {
  if (hooks?.onRpcCall) {
    safeInvoke('onRpcCall', () => hooks.onRpcCall!(method, params, durationMs, error));
  }
}

/**
 * Determine whether a transaction result (or any element of an array result)
 * represents a failure.  Write methods catch their own errors and *return*
 * `{ status: 'failed' }` rather than throwing, so we must inspect the result.
 *
 * @internal
 */
function extractTransactionFailure(result: unknown): Error | undefined {
  if (Array.isArray(result)) {
    for (const item of result) {
      const failure = extractTransactionFailure(item);
      if (failure) return failure;
    }
    return undefined;
  }
  if (result && typeof result === 'object') {
    const r = result as { status?: unknown; error?: unknown };
    if (r.status === 'failed') {
      const message =
        typeof r.error === 'string' && r.error.length > 0
          ? r.error
          : 'Transaction failed';
      return new Error(message);
    }
  }
  return undefined;
}

/**
 * Helper that wraps an async function with transaction lifecycle hooks.
 *
 * Records `onTransactionStart` before execution, `onTransactionSuccess` on
 * a successful return, and `onTransactionError` if the function throws or
 * returns a result carrying `status: 'failed'` (including any failed element
 * of an array result).
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
    const failure = extractTransactionFailure(result);
    if (failure) {
      fireTransactionError(hooks, method, failure, Date.now() - start);
    } else {
      fireTransactionSuccess(hooks, method, result, Date.now() - start);
    }
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
 * (whether successfully or not).  The thrown error (if any) is forwarded to
 * the hook so callers can distinguish failed RPC calls.
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
  } catch (err: any) {
    fireRpcCall(
      hooks,
      rpcMethod,
      params,
      Date.now() - start,
      err instanceof Error ? err : new Error(String(err)),
    );
    throw err;
  } finally {
    // Success path fires here; the error path already fired above.
    if (!hooks?.onRpcCall) return;
  }
}

// -----------------------------------------------------

/* … truncated 9598 chars — edit only what you need near the top … */
