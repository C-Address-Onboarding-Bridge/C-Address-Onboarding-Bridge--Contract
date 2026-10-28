import { InMemoryCache } from '../cache';

describe('InMemoryCache', () => {
  it('stores and retrieves values', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1);
    expect(await cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', async () => {
    const cache = new InMemoryCache();
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('expires entries after their ttl', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1, 10);
    expect(await cache.get('a')).toBe(1);
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now + 100);
    expect(await cache.get('a')).toBeUndefined();
    nowSpy.mockRestore();
  });

  it('evicts the least recently used entry when maxEntries is exceeded', async () => {
    const cache = new InMemoryCache({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    expect(cache.size).toBe(2);

    // Access 'a' to mark it as more recently used than 'b'
    await cache.get('a');

    // Inserting 'c' should evict 'b' (the oldest / least recently used)
    await cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('c')).toBe(3);
  });

  it('sweeps expired entries on set so unread keys do not leak', async () => {
    let fakeTime = 10000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeTime);

    const cache = new InMemoryCache({ sweepIntervalMs: 0 });
    await cache.set('a', 1, 10);
    await cache.set('b', 2, 10);
    expect(cache.size).toBe(2);

    fakeTime += 100;
    await cache.set('c', 3);
    expect(cache.size).toBe(1);
    expect(await cache.get('c')).toBe(3);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('throttles periodic sweeps when sweepIntervalMs is configured', async () => {
    let fakeTime = 10000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeTime);

    const cache = new InMemoryCache({ sweepIntervalMs: 1000 });
    // First set triggers initial sweep and sets lastSweep = 10000
    await cache.set('a', 1, 100);
    await cache.set('b', 2, 100);
    expect(cache.size).toBe(2);

    // Advance time past TTL (100ms), but within sweepIntervalMs (500ms < 1000ms)
    fakeTime += 500;
    await cache.set('c', 3);
    // Because sweep is throttled, expired 'a' and 'b' remain until sweep interval passes
    expect(cache.size).toBe(3);

    // Advance time past sweepIntervalMs
    fakeTime += 600; // Total 11100, elapsed since last sweep = 1100ms > 1000ms
    await cache.set('d', 4);
    // Sweep executes and evicts expired 'a' and 'b'
    expect(cache.size).toBe(2);
    expect(await cache.get('c')).toBe(3);
    expect(await cache.get('d')).toBe(4);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('supports delete and clear methods', async () => {
    const cache = new InMemoryCache();
    await cache.set('x', 10);
    await cache.set('y', 20);
    expect(cache.size).toBe(2);

    await cache.delete('x');
    expect(cache.size).toBe(1);
    expect(await cache.get('x')).toBeUndefined();
    expect(await cache.get('y')).toBe(20);

    await cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get('y')).toBeUndefined();
  });
});
