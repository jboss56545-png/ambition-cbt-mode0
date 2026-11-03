'use strict';

// Per-instance in-memory limiter.
// Sufficient for a single-admin private beta.
// PHASE 3: replace with Upstash Redis for cross-instance accuracy.
const buckets = new Map();

function hit(key, limit, windowMs) {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + windowMs };
    buckets.set(key, entry);
  }
  entry.count += 1;
  const allowed = entry.count <= limit;
  return {
    allowed: allowed,
    remaining: Math.max(0, limit - entry.count),
    retryAfter: Math.ceil((entry.reset - now) / 1000)
  };
}

function reset(key) {
  buckets.delete(key);
}

// Opportunistic pruning so the Map cannot grow unbounded.
function prune() {
  const now = Date.now();
  buckets.forEach(function (v, k) {
    if (now > v.reset) buckets.delete(k);
  });
}

setInterval(prune, 60 * 1000).unref?.();

module.exports = { hit, reset };
