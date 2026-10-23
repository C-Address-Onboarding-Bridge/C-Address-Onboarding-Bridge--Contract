import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { poll } from './deploy';

// Minimal fake server shape used by poll().
function makeServer(responses: Array<{ status: string; resultXdr?: { toXDR: (format: string) => string } }>) {
  let call = 0;
  return {
    getTransaction: async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return response;
    },
    getCallCount: () => call,
  };
}

describe('poll()', () => {
  it('resolves once the transaction is SUCCESS', async () => {
    const success = { status: 'SUCCESS' };
    const server = makeServer([
      { status: 'NOT_FOUND' },
      success,
    ]);

    assert.equal(await poll(server as any, 'abc123'), success);
    assert.equal(server.getCallCount(), 2);
  });

  it('throws when the transaction is FAILED and includes the result XDR', async () => {
    const resultXdr = 'AAAAAAABBBBBBBBCCCCCCCC';
    const server = makeServer([{
      status: 'FAILED',
      resultXdr: { toXDR: () => resultXdr },
    }]);

    await assert.rejects(poll(server as any, 'abc123'), new RegExp(resultXdr));
    assert.equal(server.getCallCount(), 1);
  });

  it('keeps polling while the transaction is NOT_FOUND', async () => {
    const success = { status: 'SUCCESS' };
    const server = makeServer([
      { status: 'NOT_FOUND' },
      { status: 'NOT_FOUND' },
      success,
    ]);

    assert.equal(await poll(server as any, 'abc123'), success);
    assert.equal(server.getCallCount(), 3);
  });
});
