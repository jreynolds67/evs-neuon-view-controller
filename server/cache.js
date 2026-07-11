// server/cache.js
// A tiny per-key TTL cache that ALSO coalesces concurrent misses. This is the mechanism
// that keeps board load flat as panels scale: many panels poll the same head's preview
// every few seconds, and without coalescing, N simultaneous cache misses would still fire
// N board requests (none has resolved yet to populate the cache). By caching the in-flight
// promise, all concurrent callers for the same key share ONE board fetch.
//
// Result: board traffic scales with the number of distinct heads/cards being viewed, not
// with (panels × heads). A fresh value is served straight from memory within its TTL.

export function createTtlCache(defaultTtlMs) {
  // key -> { value, at }         (resolved, cached values)
  const store = new Map();
  // key -> Promise                (in-flight fetches, shared by concurrent callers)
  const inflight = new Map();

  async function get(key, producer, ttlMs = defaultTtlMs) {
    const hit = store.get(key);
    if (hit && (Date.now() - hit.at) < ttlMs) return hit.value;

    // A fetch for this key is already running — join it instead of starting another.
    const pending = inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await producer();
        store.set(key, { value, at: Date.now() });
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  // Drop a key (e.g. after a write that we know changed the underlying data).
  function invalidate(key) {
    store.delete(key);
  }

  // Periodic prune so the map can't grow without bound from transient keys.
  function prune(maxAgeMs) {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at >= maxAgeMs) store.delete(k);
  }

  return { get, invalidate, prune };
}
