// Naval ship tracker — positions are never hand-typed or hand-updated.
//
// What IS hardcoded below is pure identity/reference data (name, class,
// type, nationality, homeport text, expected operating region) — ships
// don't rename themselves or change nationality, so this list never goes
// stale the way a "current position" table would. Compare api/aircraft.js's
// MIL_CALLSIGN_PREFIXES list, which is the same kind of static-but-safe
// reference data.
//
// Every ship's actual position is computed fresh on each cache cycle:
//   1. Self-fetch /api/news (same x-forwarded-proto/host pattern
//      api/threats.js and api/analyst.js already use) and scan every
//      article's title+summary for the ship's own name, or failing that,
//      its expected operating-region keywords (Red Sea, Taiwan Strait, ...).
//   2. If a match is found, extract a place name from THAT article's text
//      against a maritime gazetteer (seas/straits/major naval ports — the
//      same "keyword -> stable coordinate" pattern api/threats.js already
//      uses for country hotspots) and use its coordinates.
//   3. If nothing in the current news cycle mentions the ship at all, fall
//      back to its home port — geocoded LIVE via Open-Meteo's geocoding API
//      (the same free/no-key API index.html's search tab already calls
//      client-side), never a coordinate I typed in myself.
//
// A small deterministic offset (seeded from the ship's own name, so it's
// stable across refreshes rather than jittering) spreads out ships that
// resolve to the same regional centroid so they don't stack exactly on
// top of each other on the map.

const { getCache, setCache } = require('../lib/cache');

const NEWS_CACHE_TTL_MS = 3 * 60 * 1000; // matches api/search.js's live-news cache cadence
let listCache = { ts: 0, data: null };
const FLEET_CACHE_TTL_SEC = 600; // Redis tier, per PROGRESS.md's tiered-caching design

const HOMEPORT_TTL_MS = 24 * 60 * 60 * 1000; // home ports don't move; cache aggressively
const homeportGeoCache = new Map(); // homeport text -> { ts, coords }

// ═══════════════════════════════════
// FLEET IDENTITY (reference data — never a position)
// ═══════════════════════════════════
const FLEET = [
  { name: 'USS Gerald R. Ford', class: 'Gerald R. Ford-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['red sea', 'mediterranean', 'atlantic'] },
  { name: 'USS Dwight D. Eisenhower', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['red sea', 'persian gulf', 'gulf of aden'] },
  { name: 'USS Nimitz', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Bremerton, Washington', regionKeywords: ['south china sea', 'strait of hormuz', 'pacific'] },
  { name: 'USS Carl Vinson', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'San Diego, California', regionKeywords: ['south china sea', 'taiwan strait', 'pacific'] },
  { name: 'USS Theodore Roosevelt', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'San Diego, California', regionKeywords: ['south china sea', 'east china sea', 'pacific'] },
  { name: 'USS Abraham Lincoln', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'San Diego, California', regionKeywords: ['pacific', 'south china sea'] },
  { name: 'USS George Washington', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Yokosuka, Japan', regionKeywords: ['sea of japan', 'east china sea', 'taiwan strait'] },
  { name: 'USS John C. Stennis', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['atlantic'] },
  { name: 'USS Harry S. Truman', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['mediterranean', 'red sea'] },
  { name: 'USS Ronald Reagan', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'San Diego, California', regionKeywords: ['pacific', 'south china sea'] },
  { name: 'USS George H.W. Bush', class: 'Nimitz-class', type: 'Aircraft Carrier', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['mediterranean', 'atlantic'] },
  { name: 'USS America', class: 'America-class', type: 'Amphibious Assault Ship', nationality: 'US', flag: '🇺🇸', homeport: 'San Diego, California', regionKeywords: ['south china sea', 'pacific'] },
  { name: 'USS Arleigh Burke', class: 'Arleigh Burke-class', type: 'Guided-Missile Destroyer', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['red sea', 'mediterranean'] },
  { name: 'USS Mason', class: 'Arleigh Burke-class', type: 'Guided-Missile Destroyer', nationality: 'US', flag: '🇺🇸', homeport: 'Norfolk, Virginia', regionKeywords: ['red sea', 'gulf of aden'] },
  { name: 'USS Ohio', class: 'Ohio-class', type: 'Guided-Missile Submarine', nationality: 'US', flag: '🇺🇸', homeport: 'Bangor, Washington', regionKeywords: ['pacific', 'persian gulf'] },
  { name: 'HMS Queen Elizabeth', class: 'Queen Elizabeth-class', type: 'Aircraft Carrier', nationality: 'UK', flag: '🇬🇧', homeport: 'Portsmouth, England', regionKeywords: ['north sea', 'mediterranean', 'atlantic'] },
  { name: 'HMS Prince of Wales', class: 'Queen Elizabeth-class', type: 'Aircraft Carrier', nationality: 'UK', flag: '🇬🇧', homeport: 'Portsmouth, England', regionKeywords: ['atlantic', 'mediterranean'] },
  { name: 'HMS Astute', class: 'Astute-class', type: 'Attack Submarine', nationality: 'UK', flag: '🇬🇧', homeport: 'Faslane, Scotland', regionKeywords: ['north sea', 'atlantic'] },
  { name: 'Admiral Kuznetsov', class: 'Kuznetsov-class', type: 'Aircraft Carrier', nationality: 'Russia', flag: '🇷🇺', homeport: 'Severomorsk, Russia', regionKeywords: ['barents sea', 'mediterranean'] },
  { name: 'Pyotr Velikiy', class: 'Kirov-class', type: 'Battlecruiser', nationality: 'Russia', flag: '🇷🇺', homeport: 'Severomorsk, Russia', regionKeywords: ['barents sea', 'norwegian sea', 'arctic'] },
  { name: 'Admiral Gorshkov', class: 'Admiral Gorshkov-class', type: 'Frigate', nationality: 'Russia', flag: '🇷🇺', homeport: 'Severomorsk, Russia', regionKeywords: ['atlantic', 'mediterranean', 'barents sea'] },
  { name: 'Severodvinsk', class: 'Yasen-class', type: 'Attack Submarine', nationality: 'Russia', flag: '🇷🇺', homeport: 'Gadzhiyevo, Russia', regionKeywords: ['barents sea', 'arctic'] },
  { name: 'Moskva-class replacement flagship', class: 'Slava-class', type: 'Guided-Missile Cruiser', nationality: 'Russia', flag: '🇷🇺', homeport: 'Novorossiysk, Russia', regionKeywords: ['black sea', 'crimea'] },
  { name: 'Liaoning', class: 'Type 001', type: 'Aircraft Carrier', nationality: 'China', flag: '🇨🇳', homeport: 'Qingdao, China', regionKeywords: ['yellow sea', 'south china sea'] },
  { name: 'Shandong', class: 'Type 002', type: 'Aircraft Carrier', nationality: 'China', flag: '🇨🇳', homeport: 'Sanya, China', regionKeywords: ['south china sea', 'taiwan strait'] },
  { name: 'Fujian', class: 'Type 003', type: 'Aircraft Carrier', nationality: 'China', flag: '🇨🇳', homeport: 'Shanghai, China', regionKeywords: ['east china sea', 'south china sea'] },
  { name: 'Nanchang', class: 'Type 055', type: 'Destroyer', nationality: 'China', flag: '🇨🇳', homeport: 'Qingdao, China', regionKeywords: ['taiwan strait', 'east china sea'] },
  { name: 'Charles de Gaulle', class: 'Charles de Gaulle-class', type: 'Aircraft Carrier', nationality: 'France', flag: '🇫🇷', homeport: 'Toulon, France', regionKeywords: ['mediterranean'] },
  { name: 'INS Vikramaditya', class: 'Modified Kiev-class', type: 'Aircraft Carrier', nationality: 'India', flag: '🇮🇳', homeport: 'Karwar, India', regionKeywords: ['arabian sea', 'indian ocean'] },
  { name: 'INS Vikrant', class: 'Vikrant-class', type: 'Aircraft Carrier', nationality: 'India', flag: '🇮🇳', homeport: 'Kochi, India', regionKeywords: ['arabian sea', 'bay of bengal', 'indian ocean'] },
  { name: 'JS Izumo', class: 'Izumo-class', type: 'Helicopter Destroyer', nationality: 'Japan', flag: '🇯🇵', homeport: 'Yokosuka, Japan', regionKeywords: ['sea of japan', 'east china sea', 'pacific'] },
  { name: 'JS Kaga', class: 'Izumo-class', type: 'Helicopter Destroyer', nationality: 'Japan', flag: '🇯🇵', homeport: 'Kure, Japan', regionKeywords: ['east china sea', 'south china sea'] },
  { name: 'Cavour', class: 'Cavour-class', type: 'Aircraft Carrier', nationality: 'Italy', flag: '🇮🇹', homeport: 'Taranto, Italy', regionKeywords: ['mediterranean'] },
  { name: 'Dokdo', class: 'Dokdo-class', type: 'Amphibious Assault Ship', nationality: 'South Korea', flag: '🇰🇷', homeport: 'Busan, South Korea', regionKeywords: ['sea of japan', 'yellow sea'] },
  { name: 'TCG Anadolu', class: 'Anadolu-class', type: 'Light Carrier / LHD', nationality: 'Turkey', flag: '🇹🇷', homeport: 'Istanbul, Turkey', regionKeywords: ['black sea', 'aegean sea', 'mediterranean'] },
  { name: 'Makran', class: 'Converted Tanker Forward Base Ship', type: 'Forward Base Ship', nationality: 'Iran', flag: '🇮🇷', homeport: 'Bandar Abbas, Iran', regionKeywords: ['persian gulf', 'strait of hormuz', 'red sea'] },
  { name: 'Atlantico', class: 'Multipurpose Aircraft Carrier', type: 'Amphibious Assault Ship', nationality: 'Brazil', flag: '🇧🇷', homeport: 'Rio de Janeiro, Brazil', regionKeywords: ['atlantic'] },
  { name: 'HMAS Canberra', class: 'Canberra-class', type: 'Amphibious Assault Ship', nationality: 'Australia', flag: '🇦🇺', homeport: 'Sydney, Australia', regionKeywords: ['coral sea', 'pacific'] },
  { name: 'Gamal Abdel Nasser', class: 'Mistral-class', type: 'Helicopter Carrier', nationality: 'Egypt', flag: '🇪🇬', homeport: 'Alexandria, Egypt', regionKeywords: ['mediterranean', 'red sea'] },
  { name: 'Juan Carlos I', class: 'Juan Carlos I-class', type: 'Amphibious Assault Ship', nationality: 'Spain', flag: '🇪🇸', homeport: 'Rota, Spain', regionKeywords: ['mediterranean', 'atlantic'] },
  { name: 'Choe Hyon', class: 'Choe Hyon-class', type: 'Destroyer', nationality: 'North Korea', flag: '🇰🇵', homeport: 'Nampo, North Korea', regionKeywords: ['sea of japan', 'yellow sea'] },
];

// Color coding by nationality for map markers — task calls out US/UK blue,
// Russia red, China orange explicitly; everything else gets a neutral tone
// consistent with the existing mil-marker "other affiliation" convention.
const NATION_COLOR = {
  US: '#00d4ff', UK: '#4488ff', Russia: '#ff2244', China: '#ff7700',
};
const DEFAULT_NATION_COLOR = '#9fb3c8';

// ═══════════════════════════════════
// MARITIME GAZETTEER — for extracting a place from ARTICLE TEXT, not for
// storing any ship's position. Ordered specific-first so e.g. "strait of
// hormuz" matches before the more generic "persian gulf".
// ═══════════════════════════════════
const MARITIME_GAZETTEER = [
  { name: 'Strait of Hormuz', lat: 26.55, lon: 56.25, patterns: ['strait of hormuz'] },
  { name: 'Taiwan Strait', lat: 24.0, lon: 119.0, patterns: ['taiwan strait'] },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, patterns: ['strait of malacca', 'malacca strait'] },
  { name: 'Yokosuka, Japan', lat: 35.28, lon: 139.67, patterns: ['yokosuka'] },
  { name: 'Norfolk, Virginia', lat: 36.85, lon: -76.29, patterns: ['norfolk'] },
  { name: 'San Diego, California', lat: 32.72, lon: -117.17, patterns: ['san diego'] },
  { name: 'Qingdao, China', lat: 36.07, lon: 120.38, patterns: ['qingdao'] },
  { name: 'Sanya, China', lat: 18.25, lon: 109.51, patterns: ['sanya'] },
  { name: 'Severomorsk, Russia', lat: 69.07, lon: 33.42, patterns: ['severomorsk'] },
  { name: 'Sevastopol, Crimea', lat: 44.6, lon: 33.53, patterns: ['sevastopol'] },
  { name: 'Portsmouth, England', lat: 50.8, lon: -1.09, patterns: ['portsmouth'] },
  { name: 'Toulon, France', lat: 43.12, lon: 5.93, patterns: ['toulon'] },
  { name: 'Gaza / Eastern Mediterranean', lat: 31.5, lon: 34.4, patterns: ['gaza'] },
  { name: 'Red Sea', lat: 20.0, lon: 38.0, patterns: ['red sea'] },
  { name: 'Gulf of Aden', lat: 12.5, lon: 47.5, patterns: ['gulf of aden'] },
  { name: 'Gulf of Oman', lat: 24.8, lon: 58.5, patterns: ['gulf of oman'] },
  { name: 'Persian Gulf', lat: 26.5, lon: 51.5, patterns: ['persian gulf', 'arabian gulf'] },
  { name: 'Arabian Sea', lat: 15.0, lon: 65.0, patterns: ['arabian sea'] },
  { name: 'Bay of Bengal', lat: 15.0, lon: 88.0, patterns: ['bay of bengal'] },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, patterns: ['black sea'] },
  { name: 'Sea of Azov', lat: 46.1, lon: 36.8, patterns: ['sea of azov'] },
  { name: 'Aegean Sea', lat: 38.0, lon: 25.0, patterns: ['aegean sea', 'aegean'] },
  { name: 'Mediterranean Sea', lat: 35.0, lon: 18.0, patterns: ['mediterranean'] },
  { name: 'Baltic Sea', lat: 58.0, lon: 20.0, patterns: ['baltic sea'] },
  { name: 'North Sea', lat: 56.0, lon: 3.5, patterns: ['north sea'] },
  { name: 'English Channel', lat: 50.2, lon: -1.0, patterns: ['english channel'] },
  { name: 'Barents Sea', lat: 74.0, lon: 40.0, patterns: ['barents sea'] },
  { name: 'Norwegian Sea', lat: 68.0, lon: 2.0, patterns: ['norwegian sea'] },
  { name: 'South China Sea', lat: 12.0, lon: 113.0, patterns: ['south china sea'] },
  { name: 'East China Sea', lat: 29.0, lon: 125.0, patterns: ['east china sea'] },
  { name: 'Yellow Sea', lat: 36.0, lon: 123.5, patterns: ['yellow sea'] },
  { name: 'Sea of Japan', lat: 40.0, lon: 135.0, patterns: ['sea of japan', 'east sea'] },
  { name: 'Philippine Sea', lat: 18.0, lon: 135.0, patterns: ['philippine sea'] },
  { name: 'Coral Sea', lat: -15.0, lon: 152.0, patterns: ['coral sea'] },
  { name: 'Sea of Okhotsk', lat: 55.0, lon: 150.0, patterns: ['sea of okhotsk'] },
  { name: 'Bering Sea', lat: 58.0, lon: -175.0, patterns: ['bering sea'] },
  { name: 'Gulf of Mexico', lat: 25.0, lon: -90.0, patterns: ['gulf of mexico'] },
  { name: 'Caribbean Sea', lat: 15.0, lon: -75.0, patterns: ['caribbean sea', 'caribbean'] },
  { name: 'Indian Ocean', lat: -10.0, lon: 75.0, patterns: ['indian ocean'] },
  { name: 'Atlantic Ocean', lat: 20.0, lon: -40.0, patterns: ['atlantic ocean', 'north atlantic'] },
  { name: 'Pacific Ocean', lat: 10.0, lon: -160.0, patterns: ['pacific ocean', 'indo-pacific'] },
];

// ═══════════════════════════════════
// HELPERS
// ═══════════════════════════════════
const NAME_PREFIXES = ['USS ', 'HMS ', 'INS ', 'JS ', 'TCG ', 'HMAS ', 'RFA ', 'ARA '];

function coreName(name) {
  const prefix = NAME_PREFIXES.find(p => name.startsWith(p));
  return (prefix ? name.slice(prefix.length) : name).toLowerCase();
}

// Several ship names, once the USS/HMS/etc prefix is stripped, are bare
// common words or names that also mean something else entirely — "America"
// (the country), "Ohio" (the US state), "Dokdo" (the disputed islets the
// ship is named after). A raw substring match on those false-positives
// constantly (confirmed live: "USS America" matched a July 4th anniversary
// article with zero naval content). Requiring a naval/military context word
// in the same article closes that gap without needing a hand-maintained
// per-ship ambiguity flag.
const NAVAL_CONTEXT_WORDS = [
  'navy', 'naval', 'carrier', 'warship', 'destroyer', 'frigate', 'submarine',
  'fleet', 'flotilla', 'deployed', 'deployment', 'strike group', 'flagship',
  'vessel', 'sailors', 'aircraft carrier', 'amphibious',
];

function hasNavalContext(text) {
  const t = text.toLowerCase();
  return NAVAL_CONTEXT_WORDS.some(w => t.includes(w));
}

function extractLocation(text) {
  const t = (text || '').toLowerCase();
  return MARITIME_GAZETTEER.find(loc => loc.patterns.some(p => t.includes(p))) || null;
}

// Deterministic (not random) offset seeded from the ship's own name, so
// ships sharing a regional centroid spread apart visually but stay put
// across refreshes instead of jittering around.
function seededOffset(seed, magnitude) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = ((h % 1000) / 1000) - 0.5;
  const b = (((h >>> 10) % 1000) / 1000) - 0.5;
  return { dLat: a * 2 * magnitude, dLon: b * 2 * magnitude };
}

function timeAgoLabel(dateLike) {
  if (!dateLike) return null;
  const diff = Math.max(0, Math.floor((Date.now() - new Date(dateLike).getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLiveNews(baseUrl) {
  try {
    // /api/news aggregates 4 Guardian queries + GDELT + 4 RSS feeds in
    // parallel and can legitimately take close to its own ~9s per-source
    // timeout to resolve — a 9s timeout here races against that and was
    // aborting on every real request. Give it real headroom.
    const r = await fetchWithTimeout(`${baseUrl}/api/news?type=world`, {}, 15000);
    if (!r.ok) throw new Error(`news ${r.status}`);
    const d = await r.json();
    return d.articles || [];
  } catch (e) {
    return [];
  }
}

// Live geocode of a ship's homeport text — never a coordinate typed in by
// hand for a specific ship. Cached long-TTL since ports don't move.
async function geocodeHomeport(place) {
  const cached = homeportGeoCache.get(place);
  if (cached && Date.now() - cached.ts < HOMEPORT_TTL_MS) return cached.coords;
  try {
    const city = place.split(',')[0].trim();
    const r = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
    if (!r.ok) return null;
    const d = await r.json();
    const hit = d.results?.[0];
    if (!hit) return null;
    const coords = { lat: hit.latitude, lon: hit.longitude };
    homeportGeoCache.set(place, { ts: Date.now(), coords });
    return coords;
  } catch (e) {
    return null;
  }
}

// Wikimedia 403s/rate-limits requests with no descriptive User-Agent (same
// gotcha api/country.js already works around for Wikidata).
const WIKI_UA = 'SentinelIntelligence/1.0 (https://github.com/Andrei11022/Sentinel)';
const wikiHeaders = { headers: { 'User-Agent': WIKI_UA } };

async function wikiSummary(title) {
  const sumR = await fetchWithTimeout('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title), wikiHeaders);
  if (!sumR.ok) return null;
  return sumR.json();
}

const SHIP_CONTEXT_WORDS = ['ship', 'navy', 'naval', 'warship', 'carrier', 'destroyer', 'frigate', 'submarine', 'corvette', 'cruiser', 'vessel', 'fleet'];

// Two ways a resolved Wikipedia article can be the WRONG article for a ship:
// (1) it's a disambiguation/set-index list page — Wikipedia's own "type"
//     field doesn't reliably flag these (confirmed live: "USS America"
//     comes back type:"standard" despite its extract literally starting
//     "USS America may refer to:") so the extract wording is checked too.
// (2) it's a real, specific, unambiguous article about the WRONG thing —
//     "Dokdo" (the amphibious assault ship) resolves straight to "Liancourt
//     Rocks", the disputed islets the ship is named after, confirmed live.
//     That's not a disambiguation page at all, so it needs its own check:
//     does the article actually talk about a ship anywhere in it.
function isGoodShipMatch(sum) {
  if (!sum) return false;
  const text = `${sum.description || ''} ${sum.extract || ''}`.toLowerCase();
  if (sum.type === 'disambiguation') return false;
  if (text.includes('may refer to') || text.includes('can refer to') || text.includes('list of ships')) return false;
  return SHIP_CONTEXT_WORDS.some(w => text.includes(w));
}

// Live Wikipedia enrichment for the click-through detail card. Plain
// opensearch (title-prefix matching, same pattern api/search.js's
// fetchWikipedia uses) resolves most ships fine, but some names are
// ambiguous once stripped of context. For those, fall back to Wikipedia's
// full-text search (action=query&list=search) with the ship's type
// appended, which does real relevance ranking instead of prefix matching,
// then pick the first result that actually looks like a specific ship's
// article rather than a "-class" overview page or an unrelated topic that
// happens to share the name.
async function fetchShipWikipedia(name, type) {
  try {
    const os = await fetchWithTimeout(
      'https://en.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(name) + '&limit=1&format=json',
      wikiHeaders
    );
    let title = os.ok ? (await os.json())?.[1]?.[0] : null;
    let sum = title ? await wikiSummary(title) : null;

    if (!isGoodShipMatch(sum)) {
      const sr = await fetchWithTimeout(
        'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
        encodeURIComponent(`${name} ${type}`) + '&srlimit=5&format=json',
        wikiHeaders
      );
      const hits = sr.ok ? (await sr.json())?.query?.search || [] : [];
      const core = coreName(name);
      const candidates = hits.filter(h => h.title.toLowerCase().includes(core) && !h.title.toLowerCase().includes('-class'));
      for (const c of candidates) {
        const candidateSum = await wikiSummary(c.title);
        if (isGoodShipMatch(candidateSum)) { title = c.title; sum = candidateSum; break; }
      }
    }

    if (!isGoodShipMatch(sum)) return null;

    return {
      title: sum.title || title,
      description: sum.description || null,
      extract: sum.extract || null,
      thumbnail: sum.thumbnail?.source || sum.originalimage?.source || null,
      url: sum.content_urls?.desktop?.page || null,
    };
  } catch (e) {
    return null;
  }
}

async function locateShip(ship, articles) {
  const core = coreName(ship.name);
  const directHits = articles.filter(a => {
    const t = `${a.title} ${a.summary || ''}`.toLowerCase();
    return t.includes(core) && hasNavalContext(t);
  });
  const regionHits = directHits.length ? [] : articles.filter(a => {
    const t = `${a.title} ${a.summary || ''}`.toLowerCase();
    return ship.regionKeywords.some(k => t.includes(k)) && hasNavalContext(t);
  });

  const candidates = directHits.length ? directHits : regionHits;
  let positionBasis = directHits.length ? 'name-mention' : (regionHits.length ? 'region-mention' : 'homeport-default');

  let position = null;
  let positionLabel = null;
  let sourceArticle = null;
  let lastReportedAt = null;

  if (candidates.length) {
    candidates.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const best = candidates[0];
    const loc = extractLocation(`${best.title} ${best.summary || ''}`) || extractLocation(ship.regionKeywords.join(' '));
    if (loc) {
      position = { lat: loc.lat, lon: loc.lon };
      positionLabel = loc.name;
    }
    sourceArticle = { title: best.title, url: best.url, source: best.source, publishedAt: best.publishedAt };
    lastReportedAt = best.publishedAt;
  }

  if (!position && !candidates.length) {
    // No news evidence at all — try the ship's real home port, geocoded live.
    position = await geocodeHomeport(ship.homeport);
    positionLabel = ship.homeport;
    if (!position) {
      // Even the live geocode failed (network hiccup) — last resort only:
      // the ship's own expected operating region, clearly flagged as such
      // rather than silently mislabeled as a homeport position.
      const fallback = extractLocation(ship.regionKeywords[0]);
      position = fallback ? { lat: fallback.lat, lon: fallback.lon } : { lat: 0, lon: 0 };
      positionLabel = fallback ? fallback.name : 'Unknown';
      positionBasis = 'region-fallback';
    }
  } else if (!position) {
    // We DO have a real news mention (name or region) but couldn't extract
    // a specific place from that article's text — still evidence-based,
    // just less precise, so positionBasis stays name-mention/region-mention.
    const fallback = extractLocation(ship.regionKeywords[0]);
    position = fallback ? { lat: fallback.lat, lon: fallback.lon } : { lat: 0, lon: 0 };
    positionLabel = fallback ? fallback.name : ship.regionKeywords[0];
  }

  const jitter = seededOffset(ship.name, positionBasis === 'homeport-default' ? 0.15 : 1.1);

  return {
    name: ship.name,
    class: ship.class,
    type: ship.type,
    nationality: ship.nationality,
    flag: ship.flag,
    color: NATION_COLOR[ship.nationality] || DEFAULT_NATION_COLOR,
    homeport: ship.homeport,
    status: sourceArticle ? 'DEPLOYED' : 'IN PORT',
    lat: position.lat + jitter.dLat,
    lon: position.lon + jitter.dLon,
    positionLabel,
    positionBasis,
    lastReportedAt,
    lastReportedLabel: timeAgoLabel(lastReportedAt),
    source: sourceArticle,
  };
}

async function computeFleet(baseUrl) {
  const cacheKey = 'naval:fleet';

  const fromRedis = await getCache(cacheKey);
  if (fromRedis) return fromRedis;

  if (listCache.data && Date.now() - listCache.ts < NEWS_CACHE_TTL_MS) return listCache.data;

  const articles = await fetchLiveNews(baseUrl);
  const ships = await Promise.all(FLEET.map(ship => locateShip(ship, articles)));

  const payload = {
    ships,
    count: ships.length,
    deployedCount: ships.filter(s => s.status === 'DEPLOYED').length,
    newsArticleCount: articles.length,
    updatedAt: new Date().toISOString(),
    note: 'Positions estimated from OSINT (live news) reports, not live GPS tracking.',
  };
  listCache = { ts: Date.now(), data: payload };
  await setCache(cacheKey, payload, FLEET_CACHE_TTL_SEC);
  return payload;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  try {
    const fleet = await computeFleet(baseUrl);

    const wikiName = req.query?.wiki;
    if (wikiName) {
      const ship = fleet.ships.find(s => s.name === wikiName);
      if (!ship) return res.status(404).json({ error: 'Unknown ship' });
      const wiki = await fetchShipWikipedia(wikiName, ship.type);
      return res.status(200).json({ ship, wiki });
    }

    return res.status(200).json(fleet);
  } catch (e) {
    return res.status(200).json({ ships: [], count: 0, updatedAt: new Date().toISOString(), error: e.message });
  }
};
