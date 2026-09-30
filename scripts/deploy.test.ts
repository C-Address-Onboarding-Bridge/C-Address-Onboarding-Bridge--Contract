import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { poll } from './deploy';

// Minimal fake server shape used by poll().
function makeServer(responses: Array<{ status: string; resultXdr?: string }>) {
  let call = 0;
  return {
    getTransaction: vi.fn(async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return response;
    }),
  };
}

describe('poll()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves once the transaction is SUCCESS', async () => {
    const server = makeServer([
      { status: 'NOT_FOUND' },
      { status: 'SUCCESS' },
    ]);

    const promise = poll(server as any, 'abc123');
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    expect(server.getTransaction).toHaveBeenCalledTimes(2);
  });

  it('throws when the transaction is FAILED and includes the result XDR', async () => {
    const resultXdr = 'AAAAAAABBBBBBBBCCCCCCCC';
    const server = makeServer([{ status: 'FAILED', resultXdr }]);

    const promise = poll(server as any, 'abc123');
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow(resultXdr);
    expect(server.getTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while the transaction is NOT_FOUND', async () => {
    const server = makeServer([
      { status: 'NOT_FOUND' },
      { status: 'NOT_FOUND' },
      { status: 'SUCCESS' },
    ]);

    const promise = poll(server as any, 'abc123');
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    expect(server.getTransaction).toHaveBeenCalledTimes(3);
  });
});
