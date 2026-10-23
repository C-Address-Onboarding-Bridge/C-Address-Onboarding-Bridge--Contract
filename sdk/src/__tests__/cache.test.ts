import { InMemoryCache } from '../cache';

describe('InMemoryCache', () => {
  it('stores and retrieves values', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    const cache = new InMemoryCache<string, number>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after their ttl', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1, 10);
    expect(cache.get('a')).toBe(1);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
    expect(cache.get('a')).toBeUndefined();
    (Date.now as jest.Mock).mockRestore();
  });

  it('evicts the least recently used entry when maxEntries is exceeded', () => {
    const cache = new InMemoryCache<string, number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('sweeps expired entries on set so unread keys do not leak', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1, 10);
    cache.set('b', 2, 10);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
    cache.set('c', 3);
    expect(cache.size).toBe(1);
    expect(cache.get('c')).toBe(3);
    (Date.now as jest.Mock).mockRestore();
  });
});
