import { InMemoryCache } from '../cache';

describe('InMemoryCache', () => {
  it('stores and retrieves values', async () => {
    const cache = new InMemoryCache<string, number>();
    await cache.set('a', 1);
    expect(await cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', async () => {
    const cache = new InMemoryCache<string, number>();
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('expires entries after their ttl', async () => {
    const cache = new InMemoryCache<string, number>();
    await cache.set('a', 1, 10);
    expect(await cache.get('a')).toBe(1);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 100);
    expect(await cache.get('a')).toBeUndefined();
    (Date.now as jest.Mock).mockRestore();
  });

  it('evicts the least recently used entry when maxEntries is exceeded', async () => {
    const cache = new InMemoryCache<string, number>({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a');
    await cache.set('c', 3);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('c')).toBe(3);
  });

  it('sweeps expired entries on set so unread keys do not leak', async () => {
    const cache = new InMemoryCache<string, number>({ sweepIntervalMs: 0 });
    await cache.set('a', 1, 10);
    await cache.set('b', 2, 10);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 100);
    await cache.set('c', 3);
    expect(cache.size).toBe(1);
    expect(await cache.get('c')).toBe(3);
    (Date.now as jest.Mock).mockRestore();
  });
});
