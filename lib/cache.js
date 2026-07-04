// Shared persistent cache via Upstash Redis's REST API (no persistent
// connection needed — plain HTTPS per call, which is what makes it safe to
// use from short-lived serverless functions). Every endpoint's own
// in-memory cache stays in place as a fallback: this is an optimization
// layer on top of that, never a hard dependency. If UPSTASH_REDIS_REST_URL
// / UPSTASH_REDIS_REST_TOKEN are missing, or any Redis call throws for any
// reason (network error, non-2xx, timeout), every function here swallows it
// and returns null/false — callers always fall through to their existing
// in-memory cache and then a live call, exactly as if Redis didn't exist.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function isConfigured() {
  return !!(UPSTASH_URL && UPSTASH_TOKEN);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Values are stored JSON-stringified so any JSON-serializable result
// (objects, arrays, strings, numbers) can be cached uniformly.
async function getCache(key) {
  if (!isConfigured()) return null;
  try {
    const r = await fetchWithTimeout(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.result == null) return null;
    try {
      return JSON.parse(d.result);
    } catch {
      return null; // corrupted/foreign value under this key — treat as a miss
    }
  } catch (e) {
    return null;
  }
}

async function setCache(key, value, ttlSeconds) {
  if (!isConfigured()) return false;
  try {
    const r = await fetchWithTimeout(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}?EX=${encodeURIComponent(ttlSeconds)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: JSON.stringify(value),
      }
    );
    return r.ok;
  } catch (e) {
    return false;
  }
}

// Deterministic, URL-safe short hash for building cache keys out of long or
// free-form input (e.g. a user's analyst question) — not cryptographic,
// just needs to be stable and collision-light for cache-key purposes.
function hashKey(str) {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

module.exports = { getCache, setCache, hashKey, isConfigured };
