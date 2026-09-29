/**
 * Cache provider abstraction for SDK value caching.
 *
 * This interface is intentionally asynchronous so it can be implemented by
 * in-memory stores, Redis, LocalStorage, or any other backend without
 * changing the caller.
 */
export interface ICacheProvider {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
}

/**
 * Options for {@link InMemoryCache}.
 */
export interface InMemoryCacheOptions {
  /**
   * Maximum number of entries to retain. When exceeded, the least recently
   * used entry is evicted. When omitted, the cache is unbounded.
   */
  maxEntries?: number;
  /**
   * Minimum interval (in ms) between expired-entry sweeps triggered by `set`.
   * Defaults to 1000ms. Set to 0 to sweep on every `set`.
   */
  sweepIntervalMs?: number;
}

/**
 * Simple in-memory cache provider with TTL support.
 *
 * This provider is the default fallback in the SDK wrapper. Expired entries are
 * evicted lazily on read, swept periodically on write, and the total number of
 * entries can be bounded via `maxEntries` using LRU eviction.
 */
export class InMemoryCache implements ICacheProvider {
  private store = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries?: number;
  private readonly sweepIntervalMs: number;
  private lastSweep = 0;

  constructor(options: InMemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 1000;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh recency for LRU ordering.
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;

    // Re-insert so the key becomes the most recently used entry.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt });

    this.sweepExpired();
    this.evictOverflow();
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /**
   * Remove all expired entries. Throttled by `sweepIntervalMs` so frequent
   * writes do not repeatedly scan the whole store.
   */
  private sweepExpired(): void {
    const now = Date.now();
    if (this.sweepIntervalMs > 0 && now - this.lastSweep < this.sweepIntervalMs) {
      return;
    }
    this.lastSweep = now;

    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== undefined && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Evict least recently used entries until the store is within `maxEntries`.
   */
  private evictOverflow(): void {
    if (this.maxEntries === undefined) {
      return;
    }

    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) {
        break;
      }
      this.store.delete(oldest.value);
    }
  }
}
