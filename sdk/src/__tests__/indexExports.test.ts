import * as fs from 'fs';
import * as path from 'path';
import {
  assertRelayerPubkey,
  InMemoryCache,
  toScVals,
  buildSimulationTx,
  withTransactionHooks,
  withRpcHook,
  CachedContractClient,
  EventSubscriber,
  ConsoleLogger,
  createOpenTelemetryHooks,
  composeHooks,
} from '../index';
import type {
  InMemoryCacheOptions,
  TypedArg,
} from '../index';

describe('Public index exports (#875)', () => {
  it('exports missing helper functions and classes', () => {
    expect(typeof assertRelayerPubkey).toBe('function');
    expect(typeof toScVals).toBe('function');
    expect(typeof buildSimulationTx).toBe('function');
    expect(typeof withTransactionHooks).toBe('function');
    expect(typeof withRpcHook).toBe('function');
    expect(typeof CachedContractClient).toBe('function');
    expect(typeof InMemoryCache).toBe('function');
    expect(typeof EventSubscriber).toBe('function');
    expect(typeof ConsoleLogger).toBe('object');
    expect(typeof createOpenTelemetryHooks).toBe('function');
    expect(typeof composeHooks).toBe('function');
  });

  it('allows referencing exported types', () => {
    const opts: InMemoryCacheOptions = { maxEntries: 50, sweepIntervalMs: 2000 };
    expect(opts.maxEntries).toBe(50);
    expect(opts.sweepIntervalMs).toBe(2000);

    const arg: TypedArg = { value: '42', type: 'u32' };
    expect(arg.type).toBe('u32');
  });

  it('documents CachedContractClient, InMemoryCache, EventSubscriber, and observability in header table', () => {
    const indexPath = path.resolve(__dirname, '../index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const headerTable = content.slice(content.indexOf('## Exports'), content.indexOf('@module index'));

    expect(headerTable).toContain('assertRelayerPubkey');
    expect(headerTable).toContain('CachedContractClient');
    expect(headerTable).toContain('InMemoryCache');
    expect(headerTable).toContain('EventSubscriber');
    expect(headerTable).toContain('ConsoleLogger');
    expect(headerTable).toContain('createOpenTelemetryHooks');
    expect(headerTable).toContain('composeHooks');
    expect(headerTable).toContain('withTransactionHooks');
    expect(headerTable).toContain('withRpcHook');
    expect(headerTable).toContain('toScVals');
    expect(headerTable).toContain('buildSimulationTx');
  });
});
