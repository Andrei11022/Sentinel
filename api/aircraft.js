// Live aircraft tracking, free/no-key.
// Primary: OpenSky Network `states/all` — global civil + military traffic.
// OpenSky's anonymous quota is tight (400 credits/day, 4 credits per
// unfiltered global states/all call — confirmed live via the
// `x-rate-limit-remaining` response header, ~100 calls/day before 429s),
// so results are cached server-side for CACHE_TTL_MS regardless of how often
// the frontend polls, and any OpenSky failure (429, other non-2xx, network
// error) falls back to api.adsb.lol/v2/mil, which is pre-filtered to
// military aircraft only (no "isMilitary" guessing needed in that path, and
// no `country` field available from that source).
//
// Military detection on the OpenSky path is a best-effort heuristic, not a
// verified classification: known military callsign prefixes, plus the
// well-documented ICAO24 hex block (AE0000-AFFFFF) publicly associated with
// US DoD-registered aircraft.

const CACHE_TTL_MS = 30 * 1000;
const cache = { ts: 0, data: null };

const MIL_CALLSIGN_PREFIXES = [
  'RCH', 'RRR', 'CFC', 'NATO', 'ASCOT', 'GAF', 'FAF', 'CTM', 'SPAR',
  'CNV', 'IAM', 'KNIFE', 'REACH', 'VIVI', 'DUKE', 'TREND', 'HKY',
];

function isMilitaryAircraft(icao24, callsign) {
  const cs = (callsign || '').toUpperCase();
  if (MIL_CALLSIGN_PREFIXES.some(p => cs.startsWith(p))) return true;
  if (icao24 && /^ae/i.test(icao24)) return true; // US DoD ICAO24 block
  return false;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenSky() {
  try {
    const r = await fetchWithTimeout('https://opensky-network.org/api/states/all');
    if (!r.ok) return null; // triggers adsb.lol fallback (429 = rate-limited, etc)
    const data = await r.json();
    const states = data.states || [];

    const mapped = states
      .filter(s => s[5] != null && s[6] != null && !s[8]) // has position, airborne
      .map(s => ({
        icao24: s[0],
        callsign: (s[1] || '').trim() || null,
        country: s[2] || null,
        lon: s[5],
        lat: s[6],
        altitude: s[7] ?? s[13] ?? null,
        velocity: s[9] ?? null,
        heading: s[10] ?? 0,
        isMilitary: isMilitaryAircraft(s[0], s[1]),
      }));

    // Military first so the 200-cap never silently drops them for civilian traffic.
    mapped.sort((a, b) => Number(b.isMilitary) - Number(a.isMilitary));
    return { aircraft: mapped.slice(0, 200), source: 'opensky' };
  } catch (e) {
    return null;
  }
}

async function fetchAdsbLolMilitary() {
  try {
    const r = await fetchWithTimeout('https://api.adsb.lol/v2/mil');
    if (!r.ok) return null;
    const data = await r.json();
    const list = data.ac || [];

    const mapped = list
      .filter(a => a.lat != null && a.lon != null && a.alt_baro !== 'ground')
      .map(a => ({
        icao24: a.hex || null,
        callsign: (a.flight || '').trim() || null,
        country: null, // not provided by this source
        lon: a.lon,
        lat: a.lat,
        altitude: typeof a.alt_baro === 'number' ? a.alt_baro : null,
        velocity: typeof a.gs === 'number' ? a.gs : null,
        heading: a.track ?? a.nav_heading ?? 0,
        isMilitary: true, // pre-filtered by the source
      }));

    return { aircraft: mapped.slice(0, 200), source: 'adsb.lol (military-only fallback)' };
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return res.status(200).json(cache.data);
  }

  let result = await fetchOpenSky();
  if (!result) result = await fetchAdsbLolMilitary();
  if (!result) result = { aircraft: [], source: 'unavailable' };

  const payload = { ...result, count: result.aircraft.length, updatedAt: new Date().toISOString() };
  cache.data = payload;
  cache.ts = Date.now();
  return res.status(200).json(payload);
};
