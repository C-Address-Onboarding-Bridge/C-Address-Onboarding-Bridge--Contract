import { InMemoryCache } from '../cache';

describe('InMemoryCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores and retrieves values', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1);
    await expect(cache.get('a')).resolves.toBe(1);
  });

  it('returns undefined for missing keys', async () => {
    const cache = new InMemoryCache();
    await expect(cache.get('missing')).resolves.toBeUndefined();
  });

  it('expires entries after their ttl', async () => {
    const cache = new InMemoryCache();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.set('a', 1, 10);
    await expect(cache.get('a')).resolves.toBe(1);
    spy.mockReturnValue(now + 100);
    await expect(cache.get('a')).resolves.toBeUndefined();
  });

  it('deletes and clears entries', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.delete('a');
    await expect(cache.get('a')).resolves.toBeUndefined();
    expect(cache.size).toBe(1);
    await cache.clear();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry when maxEntries is exceeded', async () => {
    const cache = new InMemoryCache({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a');
    await cache.set('c', 3);
    await expect(cache.get('b')).resolves.toBeUndefined();
    await expect(cache.get('a')).resolves.toBe(1);
    await expect(cache.get('c')).resolves.toBe(3);
    expect(cache.size).toBe(2);
  });

  it('sweeps expired entries on set so unread keys do not leak', async () => {
    const cache = new InMemoryCache({ sweepIntervalMs: 0 });
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.set('a', 1, 10);
    await cache.set('b', 2, 10);
    spy.mockReturnValue(now + 100);
    await cache.set('c', 3);
    expect(cache.size).toBe(1);
    await expect(cache.get('c')).resolves.toBe(3);
  });

  it('throttles the expired-entry sweep by sweepIntervalMs', async () => {
    const cache = new InMemoryCache({ sweepIntervalMs: 1000 });
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.set('a', 1, 10);
    await cache.set('b', 2, 10);
    spy.mockReturnValue(now + 100);
    // Within the sweep interval: expired entries are not swept yet.
    await cache.set('c', 3);
    expect(cache.size).toBe(3);
    // Past the sweep interval: the next set sweeps them.
    spy.mockReturnValue(now + 2000);
    await cache.set('d', 4);
    expect(cache.size).toBe(2);
    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('d')).resolves.toBe(4);
  });
});
