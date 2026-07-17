// server/cache.js
// A tiny per-key TTL cache that ALSO coalesces concurrent misses. This is the mechanism
// that keeps board load flat as panels scale: many panels poll the same head's preview
// every few seconds, and without coalescing, N simultaneous cache misses would still fire
// N board requests (none has resolved yet to populate the cache). By caching the in-flight
// promise, all concurrent callers for the same key share ONE board fetch.
//
// Result: board traffic scales with the number of distinct heads/cards being viewed, not
// with (panels × heads). A fresh value is served straight from memory within its TTL.

export function createTtlCache(defaultTtlMs, opts = {}) {
  // key -> { value, at }         (resolved, cached values)
  const store = new Map();
  // key -> Promise                (in-flight fetches, shared by concurrent callers)
  const inflight = new Map();
  // key -> { err, at }            (recent failures, cached briefly — see negTtlMs)
  const negative = new Map();
  // Keys invalidated WHILE a fetch was in flight. The fetch started before the write that
  // triggered the invalidation, so its result is stale the moment it arrives — it may be
  // returned to the callers already awaiting it (a snapshot from before the write, same as if
  // they'd polled a moment earlier) but it must NOT be cached, or every other caller gets the
  // pre-write value served from memory for a full TTL after an invalidate that promised
  // otherwise. Only ever holds keys that are also in `inflight`, so it can't grow unbounded.
  const doomed = new Set();
  // How long to remember a failure. A down/rebooting board otherwise gets a fresh fetch
  // attempt (each with the full board timeout) on every poll; caching the failure for a few
  // seconds lets it recover without being hammered. 0 disables negative caching.
  const negTtlMs = opts.negativeTtlMs || 0;

  async function get(key, producer, ttlMs = defaultTtlMs) {
    const hit = store.get(key);
    if (hit && (Date.now() - hit.at) < ttlMs) return hit.value;

    // Recent failure still within the negative window — rethrow it without hitting the board.
    if (negTtlMs) {
      const neg = negative.get(key);
      if (neg && (Date.now() - neg.at) < negTtlMs) throw neg.err;
    }

    // A fetch for this key is already running — join it instead of starting another. Unless
    // it's doomed: this caller arrived AFTER the invalidation, so handing it that fetch's
    // result would serve data known to predate the write. Let the doomed fetch settle (the
    // one-producer-per-key invariant) and then start fresh.
    const pending = inflight.get(key);
    if (pending) {
      if (!doomed.has(key)) return pending;
      try { await pending; } catch { /* the doomed fetch's outcome isn't this caller's */ }
      return get(key, producer, ttlMs);
    }

    const p = (async () => {
      try {
        const value = await producer();
        if (!doomed.has(key)) {
          store.set(key, { value, at: Date.now() });
          if (negTtlMs) negative.delete(key);
        }
        return value;
      } catch (err) {
        if (negTtlMs && !doomed.has(key)) negative.set(key, { err, at: Date.now() });
        throw err;
      } finally {
        inflight.delete(key);
        doomed.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  // Drop a key (e.g. after a write that we know changed the underlying data). A fetch already
  // in flight for the key started BEFORE that write, so mark it doomed: it resolves to its
  // waiting callers but is not cached.
  function invalidate(key) {
    store.delete(key);
    negative.delete(key);
    if (inflight.has(key)) doomed.add(key);
  }

  // Periodic prune so the maps can't grow without bound from transient keys.
  function prune(maxAgeMs) {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at >= maxAgeMs) store.delete(k);
    for (const [k, v] of negative) if (now - v.at >= maxAgeMs) negative.delete(k);
  }

  return { get, invalidate, prune };
}
