import {
  withRetry,
  withRpcRetry,
  isRetryableRpcError,
  computeBackoffDelay,
  VIEW_RETRY_POLICY,
  STATE_CHANGING_RETRY_POLICY,
  RetryAttempt,
} from '../retry';

/** A sleep that resolves immediately but records the delays it was asked for. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

const RETRYABLE = new Error('Network timeout');
const PERMANENT = new Error('Invalid contract address for "asset"');

describe('isRetryableRpcError', () => {
  it('retries on timeout, network, and rate-limit messages', () => {
    expect(isRetryableRpcError(new Error('Network timeout'))).toBe(true);
    expect(isRetryableRpcError(new Error('request timed out'))).toBe(true);
    expect(isRetryableRpcError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableRpcError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableRpcError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableRpcError(new Error('fetch failed'))).toBe(true);
  });

  it('retries on transient network error codes', () => {
    expect(isRetryableRpcError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableRpcError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isRetryableRpcError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('retries on transient HTTP status codes', () => {
    expect(isRetryableRpcError({ status: 429 })).toBe(true);
    expect(isRetryableRpcError({ statusCode: 503 })).toBe(true);
    expect(isRetryableRpcError({ response: { status: 504 } })).toBe(true);
  });

  it('does NOT retry permanent errors', () => {
    expect(isRetryableRpcError(new Error('Invalid contract address'))).toBe(false);
    expect(isRetryableRpcError(new Error('contract error: insufficient balance'))).toBe(false);
    expect(isRetryableRpcError({ status: 400 })).toBe(false);
    expect(isRetryableRpcError({ status: 404 })).toBe(false);
    expect(isRetryableRpcError(null)).toBe(false);
    expect(isRetryableRpcError(undefined)).toBe(false);
  });
});

describe('computeBackoffDelay', () => {
  it('produces the exponential sequence 1s, 2s, 4s, 8s without jitter', () => {
    const delays = [0, 1, 2, 3].map((n) => computeBackoffDelay(n, 1000, 30000, false));
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(computeBackoffDelay(4, 1000, 30000, false)).toBe(16000);
    expect(computeBackoffDelay(5, 1000, 30000, false)).toBe(30000);
    expect(computeBackoffDelay(10, 1000, 30000, false)).toBe(30000);
  });

  it('keeps jittered delays within [0, cappedDelay]', () => {
    for (let attempt = 0; attempt <= 6; attempt++) {
      const cap = Math.min(1000 * 2 ** attempt, 30000);
      for (let i = 0; i < 200; i++) {
        const delay = computeBackoffDelay(attempt, 1000, 30000, true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(cap);
      }
    }
  });
});

describe('withRetry', () => {
  it('returns immediately on success without sleeping', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, { sleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries a transient failure and then succeeds', async () => {
    const { sleep, delays } = recordingSleep();
    const onRetry = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(RETRYABLE)
      .mockRejectedValueOnce(RETRYABLE)
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { sleep, onRetry, jitter: false });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000, 2000]);
  });

  it('does not retry a permanent error', async () => {
    const { sleep, delays } = recordingSleep();
    const onRetry = jest.fn();
    const fn = jest.fn().mockRejectedValue(PERMANENT);

    await expect(withRetry(fn, { sleep, onRetry })).rejects.toThrow(PERMANENT.message);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });

  it('throws the last error after exhausting maxRetries', async () => {
    const { sleep } = recordingSleep();
    const onRetry = jest.fn();
    const fn = jest.fn().mockRejectedValue(RETRYABLE);

    await expect(withRetry(fn, { sleep, onRetry, maxRetries: 3 })).rejects.toThrow(
      RETRYABLE.message,
    );
    // initial attempt + 3 retries
    expect(fn).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('does not run the operation at all when the signal is already aborted', async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    controller.abort();
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, { sleep, signal: controller.signal })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops retrying once the signal is aborted between attempts', async () => {
    const controller = new AbortController();
    const fn = jest.fn().mockRejectedValue(RETRYABLE);
    // Abort while the first backoff is pending.
    const sleep = jest.fn(async () => {
      controller.abort();
    });

    await expect(
      withRetry(fn, { sleep, maxRetries: 5, signal: controller.signal }),
    ).rejects.toThrow();
    // Initial attempt only — the abort lands before the second one starts.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('interrupts a long backoff instead of waiting it out', async () => {
    const controller = new AbortController();
    const fn = jest.fn().mockRejectedValue(RETRYABLE);
    // A real 30s sleep: the test only finishes promptly if the abort cuts it short.
    const start = Date.now();

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 30000,
      maxDelayMs: 30000,
      jitter: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects with the abort reason when one is supplied', async () => {
    const { sleep } = recordingSleep();
    const reason = new Error('component unmounted');
    const controller = new AbortController();
    const fn = jest.fn().mockRejectedValue(RETRYABLE);

    const promise = withRetry(fn, { sleep, maxRetries: 5, signal: controller.signal });
    controller.abort(reason);

    await expect(promise).rejects.toThrow('component unmounted');
  });

  it('leaves unaborted retries untouched', async () => {
    const { sleep, delays } = recordingSleep();
    const controller = new AbortController();
    const fn = jest.fn().mockRejectedValueOnce(RETRYABLE).mockResolvedValue('ok');

    await expect(
      withRetry(fn, { sleep, jitter: false, signal: controller.signal }),
    ).resolves.toBe('ok');
    expect(delays).toEqual([1000]);
  });

  it('honours maxRetries: 0 (retries disabled)', async () => {
    const { sleep } = recordingSleep();
    const fn = jest.fn().mockRejectedValue(RETRYABLE);

    await expect(withRetry(fn, { sleep, maxRetries: 0 })).rejects.toThrow(RETRYABLE.message);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports accurate metadata to the logger', async () => {
    const { sleep } = recordingSleep();
    const attempts: RetryAttempt[] = [];
    const fn = jest
      .fn()
      .mockRejectedValueOnce(RETRYABLE)
      .mockResolvedValue('ok');

    await withRetry(fn, { sleep, jitter: false, onRetry: (a) => attempts.push(a) });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, maxRetries: 3, delayMs: 1000, error: RETRYABLE });
  });
});

describe('view vs state-changing policies', () => {
  it('exposes a more aggressive policy for view calls than for state-changing calls', () => {
    expect(VIEW_RETRY_POLICY.maxRetries).toBeGreaterThan(STATE_CHANGING_RETRY_POLICY.maxRetries);
  });

  it('retries view calls more times than state-changing calls for the same error', async () => {
    const { sleep } = recordingSleep();

    const viewFn = jest.fn().mockRejectedValue(RETRYABLE);
    await expect(withRetry(viewFn, { ...VIEW_RETRY_POLICY, sleep })).rejects.toThrow();

    const stateFn = jest.fn().mockRejectedValue(RETRYABLE);
    await expect(withRetry(stateFn, { ...STATE_CHANGING_RETRY_POLICY, sleep })).rejects.toThrow();

    expect(viewFn).toHaveBeenCalledTimes(VIEW_RETRY_POLICY.maxRetries + 1);
    expect(stateFn).toHaveBeenCalledTimes(STATE_CHANGING_RETRY_POLICY.maxRetries + 1);
    expect(viewFn.mock.calls.length).toBeGreaterThan(stateFn.mock.calls.length);
  });
});

describe('withRpcRetry', () => {
  // baseDelayMs: 0 keeps the (real) backoff instant for these wiring tests.
  const FAST = { baseDelayMs: 0, maxDelayMs: 0 };

  it('routes read methods through the view policy (retries up to 3 times)', async () => {
    const getAccount = jest.fn().mockRejectedValue(RETRYABLE);
    const provider = withRpcRetry({ getAccount }, FAST);

    await expect(provider.getAccount()).rejects.toThrow();
    expect(getAccount).toHaveBeenCalledTimes(VIEW_RETRY_POLICY.maxRetries + 1);
  });

  it('routes sendTransaction through the conservative state policy (retries once)', async () => {
    const sendTransaction = jest.fn().mockRejectedValue(RETRYABLE);
    const provider = withRpcRetry({ sendTransaction }, FAST);

    await expect(provider.sendTransaction()).rejects.toThrow();
    expect(sendTransaction).toHaveBeenCalledTimes(STATE_CHANGING_RETRY_POLICY.maxRetries + 1);
  });

  it('passes through non-RPC methods and properties untouched', async () => {
    const helper = jest.fn().mockReturnValue('plain');
    const provider = withRpcRetry({ helper, label: 'server' } as any, FAST);

    expect((provider as any).helper()).toBe('plain');
    expect((provider as any).label).toBe('server');
    expect(helper).toHaveBeenCalledTimes(1);
  });

  it('does not retry on success and returns the resolved value', async () => {
    const simulateTransaction = jest.fn().mockResolvedValue({ ok: true });
    const provider = withRpcRetry({ simulateTransaction }, FAST);

    await expect(provider.simulateTransaction()).resolves.toEqual({ ok: true });
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('forwards retry events to a configured logger', async () => {
    const onRetry = jest.fn();
    const getTransaction = jest.fn().mockRejectedValue(RETRYABLE);
    const provider = withRpcRetry({ getTransaction }, { ...FAST, onRetry });

    await expect(provider.getTransaction()).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(VIEW_RETRY_POLICY.maxRetries);
  });
});
