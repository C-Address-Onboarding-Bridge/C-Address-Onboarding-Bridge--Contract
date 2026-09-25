/**
 * Retry utilities for Soroban RPC calls.
 *
 * Implements exponential backoff (1s, 2s, 4s, 8s … capped at 30s) with full
 * jitter, a transient-error classifier, and two preset policies:
 *
 *  - {@link VIEW_RETRY_POLICY} for idempotent read-only calls.
 *  - {@link STATE_CHANGING_RETRY_POLICY} for write calls, which carry a
 *    double-submission risk and are therefore retried conservatively.
 *
 * The {@link withRpcRetry} helper wraps a `SorobanRpc.Server` so every RPC
 * method is automatically retried with the policy appropriate to it.
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

/** Details about a single retry, passed to the {@link RetryLogger}. */
export interface RetryAttempt {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Total retries allowed after the initial attempt. */
  maxRetries: number;
  /** Delay in milliseconds before the next attempt. */
  delayMs: number;
  /** The error that triggered the retry. */
  error: unknown;
}

/** Receives one record per retry. Defaults to a no-op so the SDK stays quiet. */
export type RetryLogger = (attempt: RetryAttempt) => void;

/** Decides whether a thrown error is worth retrying. */
export type RetryableClassifier = (error: unknown) => boolean;

/** Options for the low-level {@link withRetry} wrapper. */
export interface RetryOptions {
  /** Max retries after the initial attempt. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for the first backoff step. Default: 1000. */
  baseDelayMs?: number;
  /** Upper bound for any single backoff delay. Default: 30000. */
  maxDelayMs?: number;
  /** Apply full jitter to each delay. Default: true. */
  jitter?: boolean;
  /** Error classifier. Default: {@link isRetryableRpcError}. */
  isRetryable?: RetryableClassifier;
  /** Retry logger. Default: no-op. */
  onRetry?: RetryLogger;
  /**
   * Cancels an in-flight retry loop.
   *
   * The signal is checked before each attempt and interrupts the backoff delay
   * itself, so an abort takes effect immediately rather than after the current
   * sleep (which can be up to `maxDelayMs`) elapses. When it fires,
   * {@link withRetry} rejects with the signal's `reason`.
   */
  signal?: AbortSignal;
  /**
   * Clock seam used to wait between attempts. Injectable for tests.
   * Default: a `setTimeout`-based sleep. Receives {@link RetryOptions.signal}
   * when one is set; implementations may ignore it, since `withRetry` also
   * races the sleep against the signal.
   * @internal
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Tunable knobs for {@link withRpcRetry}, surfaced on `BridgeConfig.retry`. */
export interface RpcRetryOptions {
  /** Max retries for view calls (default 3). State calls are capped at 1. */
  maxRetries?: number;
  /** Base delay in ms for the first backoff step. Default: 1000. */
  baseDelayMs?: number;
  /** Upper bound for any single backoff delay. Default: 30000. */
  maxDelayMs?: number;
  /** Apply full jitter to each delay. Default: true. */
  jitter?: boolean;
  /** Retry logger. Default: no-op. */
  onRetry?: RetryLogger;
}

const noopLogger: RetryLogger = () => {};

/**
 * The value an aborted {@link withRetry} rejects with. Environments that
 * predate `AbortSignal.reason` leave it undefined, so fall back to an
 * equivalent error.
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('The operation was aborted');
}

/**
 * Default backoff sleep. When given a signal it clears its own timer on abort
 * so a cancelled retry leaves nothing pending on the event loop.
 */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Sleep for `ms`, rejecting early if `signal` aborts.
 *
 * Without this a single backoff can block for `maxDelayMs` after the caller has
 * already given up. The signal is forwarded to `sleep` so a signal-aware
 * implementation can release its timer, and raced against separately so that
 * sleeps which ignore it are still cut short.
 */
function abortableSleep(
  ms: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortReason(signal));

  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([sleep(ms, signal), aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/** Node network error codes that indicate a transient, retryable failure. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** Transient HTTP status codes: rate limiting and gateway/upstream failures. */
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);

const RETRYABLE_MESSAGE_PATTERN =
  /(timeout|timed out|rate limit|too many requests|network error|socket hang up|fetch failed|service unavailable|temporarily unavailable|connection reset|connection refused|econnreset|econnrefused|enotfound|eai_again|etimedout)/i;

/**
 * Classify an error as transient (worth retrying) or permanent.
 *
 * Retries on network errors, timeouts, and rate-limit / transient gateway
 * responses. Does NOT retry on validation errors, contract reverts, or other
 * deterministic failures — retrying those only wastes time.
 */
export function isRetryableRpcError(error: unknown): boolean {
  if (error == null) return false;

  const err = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };

  if (typeof err.code === 'string' && RETRYABLE_ERROR_CODES.has(err.code)) {
    return true;
  }

  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (typeof status === 'number' && RETRYABLE_HTTP_STATUS.has(status)) {
    return true;
  }

  const message = typeof err.message === 'string' ? err.message : String(error);
  return RETRYABLE_MESSAGE_PATTERN.test(message);
}

/**
 * Compute the backoff delay for a given (0-based) retry attempt.
 *
 * Without jitter the sequence is `base, base*2, base*4, …` capped at `maxDelayMs`
 * (i.e. 1s, 2s, 4s, 8s, 16s, 30s for the defaults). With full jitter the delay
 * is a random value in `[0, cappedDelay]` to avoid a thundering herd.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
  jitter: boolean = true,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  if (!jitter) return exponential;
  // Full jitter (AWS "Exponential Backoff And Jitter"): pick uniformly in
  // [0, exponential] so concurrent clients spread their retries out.
  return Math.floor(Math.random() * (exponential + 1));
}

/**
 * Run `fn`, retrying on transient errors with exponential backoff + jitter.
 *
 * The initial call counts as attempt 0; up to `maxRetries` further attempts are
 * made. Permanent errors (per {@link isRetryableRpcError}) are re-thrown
 * immediately. The last error is re-thrown once retries are exhausted.
 *
 * Pass `options.signal` to cancel the loop; the pending backoff is cut short
 * and the returned promise rejects with the signal's reason.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = options.jitter ?? true;
  const isRetryable = options.isRetryable ?? isRetryableRpcError;
  const onRetry = options.onRetry ?? noopLogger;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // An abort that landed while `fn` was in flight wins over its error:
      // the caller no longer wants the result either way.
      if (signal?.aborted) throw abortReason(signal);
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      onRetry({ attempt: attempt + 1, maxRetries, delayMs, error });
      await abortableSleep(delayMs, sleep, signal);
    }
  }
  // Unreachable: the loop either returns or throws, but TS needs a terminator.
  throw lastError;
}

/**
 * Retry policy for idempotent *view* (read-only) RPC calls such as
 * `simulateTransaction`, `getAccount`, and `getTransaction`. These can be
 * retried freely because they never mutate on-chain state.
 */
export const VIEW_RETRY_POLICY: Required<
  Pick<RetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'jitter'>
> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
};

/**
 * Retry policy for *state-changing* RPC calls (`sendTransaction`).
 *
 * State-changing calls carry a double-submission risk: a request may time out
 * on the client *after* the network already accepted the transaction. We
 * therefore retry only once and rely on Soroban's hash-based deduplication —
 * resubmitting the *same signed transaction* is safe, but a retry must NEVER
 * rebuild the transaction with a fresh sequence number (that would double-spend).
 */
export const STATE_CHANGING_RETRY_POLICY: Required<
  Pick<RetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'jitter'>
> = {
  maxRetries: 1,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
};

/** RPC methods that are idempotent reads — safe to retry with the view policy. */
const VIEW_RPC_METHODS = new Set([
  'getAccount',
  'simulateTransaction',
  'prepareTransaction',
  'getTransaction',
  'getTransactions',
  'getLatestLedger',
  'getNetwork',
  'getHealth',
  'getEvents',
  'getLedgerEntries',
  'getContractData',
]);

/** RPC methods that mutate on-chain state — retried with the conservative policy. */
const STATE_CHANGING_RPC_METHODS = new Set(['sendTransaction']);

function resolveViewOptions(o: RpcRetryOptions): RetryOptions {
  return {
    maxRetries: o.maxRetries ?? VIEW_RETRY_POLICY.maxRetries,
    baseDelayMs: o.baseDelayMs ?? VIEW_RETRY_POLICY.baseDelayMs,
    maxDelayMs: o.maxDelayMs ?? VIEW_RETRY_POLICY.maxDelayMs,
    jitter: o.jitter ?? VIEW_RETRY_POLICY.jitter,
    onRetry: o.onRetry,
  };
}

function resolveStateOptions(o: RpcRetryOptions): RetryOptions {
  const viewMax = o.maxRetries ?? VIEW_RETRY_POLICY.maxRetries;
  return {
    // State-changing retries never exceed the conservative cap, even if the
    // caller raises maxRetries for view calls.
    maxRetries: Math.min(viewMax, STATE_CHANGING_RETRY_POLICY.maxRetries),
    baseDelayMs: o.baseDelayMs ?? STATE_CHANGING_RETRY_POLICY.baseDelayMs,
    maxDelayMs: o.maxDelayMs ?? STATE_CHANGING_RETRY_POLICY.maxDelayMs,
    jitter: o.jitter ?? STATE_CHANGING_RETRY_POLICY.jitter,
    onRetry: o.onRetry,
  };
}

/**
 * Wrap an RPC provider so every method call is retried with the policy that
 * matches its nature: read methods use {@link VIEW_RETRY_POLICY}, the
 * `sendTransaction` write method uses {@link STATE_CHANGING_RETRY_POLICY}, and
 * anything else is passed through untouched.
 *
 * The wrapper is transparent: method signatures and return values are
 * unchanged, so it can replace the underlying provider in place.
 */
export function withRpcRetry<T extends object>(
  provider: T,
  options: RpcRetryOptions = {},
): T {
  const viewOptions = resolveViewOptions(options);
  const stateOptions = resolveStateOptions(options);

  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      const name = String(prop);
      const policy = VIEW_RPC_METHODS.has(name)
        ? viewOptions
        : STATE_CHANGING_RPC_METHODS.has(name)
          ? stateOptions
          : undefined;

      if (!policy) return value.bind(target);

      return (...args: unknown[]): Promise<unknown> =>
        withRetry(() => value.apply(target, args), policy);
    },
  });
}
