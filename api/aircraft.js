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
// US DoD-registered aircraft. Every flagged aircraft carries a human-readable
// `militaryReason` so the frontend never just asserts "military" with no basis.
//
// Units are normalized to OpenSky's native units regardless of source, since
// adsb.lol reports altitude in feet and speed in knots while OpenSky reports
// meters and m/s — the frontend converts from these canonical units to
// whatever display units it wants (both m/ft, both km/h/kt, etc).
//   altitude: meters | velocity: m/s | verticalRate: m/s

const { getCache, setCache } = require('../lib/cache');

const CACHE_TTL_MS = 30 * 1000;
const CACHE_TTL_SEC = 30;
const cache = { ts: 0, data: null };

const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;
const FPM_TO_MS = 0.00508;

const MIL_CALLSIGN_PREFIXES = [
  'RCH', 'RRR', 'CFC', 'NATO', 'ASCOT', 'GAF', 'FAF', 'CTM', 'SPAR',
  'CNV', 'IAM', 'KNIFE', 'REACH', 'VIVI', 'DUKE', 'TREND', 'HKY',
];

function classifyMilitary(icao24, callsign) {
  const cs = (callsign || '').toUpperCase();
  const prefix = MIL_CALLSIGN_PREFIXES.find(p => cs.startsWith(p));
  if (prefix) return { isMilitary: true, militaryReason: `callsign pattern "${prefix}"` };
  if (icao24 && /^ae/i.test(icao24)) {
    return { isMilitary: true, militaryReason: 'ICAO24 in US DoD hex block (AE0000–AFFFFF)' };
  }
  return { isMilitary: false, militaryReason: null };
}

// ADS-B emitter category, per the OpenSky `category` field (index 17) and
// the equivalent 2-char codes adsb.lol/dump1090 report — same enum, two
// different encodings, so one label set serves both.
const CATEGORY_LABELS = [
  null, 'No category info', 'Light aircraft', 'Small aircraft', 'Large aircraft',
  'High vortex large', 'Heavy aircraft', 'High performance', 'Rotorcraft',
  'Glider / sailplane', 'Lighter than air', 'Parachutist / skydiver',
  'Ultralight / hang-glider', 'Reserved', 'UAV / drone', 'Space vehicle',
  'Surface vehicle (emergency)', 'Surface vehicle (service)',
  'Point obstacle', 'Cluster obstacle', 'Line obstacle',
];
const ADSB_CATEGORY_INDEX = {
  A0: 1, A1: 2, A2: 3, A3: 4, A4: 5, A5: 6, A6: 7, A7: 8,
  B0: 1, B1: 9, B2: 10, B3: 11, B4: 12, B6: 14, B7: 15,
  C0: 1, C1: 16, C2: 17, C3: 18, C4: 19, C5: 19, C6: 19, C7: 20,
};

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
      .map(s => {
        const mil = classifyMilitary(s[0], s[1]);
        return {
          icao24: s[0],
          callsign: (s[1] || '').trim() || null,
          country: s[2] || null,
          lon: s[5],
          lat: s[6],
          altitude: s[7] ?? s[13] ?? null,
          velocity: s[9] ?? null,
          heading: s[10] ?? 0,
          verticalRate: s[11] ?? null,
          onGround: !!s[8],
          squawk: s[14] || null,
          category: CATEGORY_LABELS[s[17]] || null,
          registration: null, // not exposed by this source
          ...mil,
        };
      });

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
      .map(a => {
        const rateFtMin = typeof a.baro_rate === 'number' ? a.baro_rate
          : typeof a.geom_rate === 'number' ? a.geom_rate : null;
        const catIdx = a.category ? ADSB_CATEGORY_INDEX[a.category] : null;
        return {
          icao24: a.hex || null,
          callsign: (a.flight || '').trim() || null,
          country: null, // not provided by this source
          lon: a.lon,
          lat: a.lat,
          altitude: typeof a.alt_baro === 'number' ? a.alt_baro * FT_TO_M : null,
          velocity: typeof a.gs === 'number' ? a.gs * KT_TO_MS : null,
          heading: a.track ?? a.nav_heading ?? 0,
          verticalRate: rateFtMin != null ? rateFtMin * FPM_TO_MS : null,
          onGround: false, // pre-filtered above
          squawk: a.squawk || null,
          // `t` (ICAO type designator, e.g. "C17", "F16") is far more specific
          // than the generic emitter category — prefer it when present.
          category: a.t || CATEGORY_LABELS[catIdx] || null,
          registration: a.r || null,
          isMilitary: true, // pre-filtered by the source
          militaryReason: 'source pre-filtered: api.adsb.lol/v2/mil (military-only feed)',
        };
      });

    return { aircraft: mapped.slice(0, 200), source: 'adsb.lol (military-only fallback)' };
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cacheKey = 'aircraft:live';

  const fromRedis = await getCache(cacheKey);
  if (fromRedis) return res.status(200).json(fromRedis);

  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return res.status(200).json(cache.data);
  }

  let result = await fetchOpenSky();
  if (!result) result = await fetchAdsbLolMilitary();
  if (!result) result = { aircraft: [], source: 'unavailable' };

  const payload = { ...result, count: result.aircraft.length, updatedAt: new Date().toISOString() };
  cache.data = payload;
  cache.ts = Date.now();
  await setCache(cacheKey, payload, CACHE_TTL_SEC);
  return res.status(200).json(payload);
};
