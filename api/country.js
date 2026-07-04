// Live country intel for ANY ISO 3166-1 alpha-2 code, aggregated server-side
// (so the browser never hits worldbank.org/wikidata.org directly and never
// sees a CORS failure). Combines:
//   - World Bank country API       -> name, capital, region, income level, lat/lon
//   - World Bank indicator API     -> population (SP.POP.TOTL, most recent value)
//   - Wikidata SPARQL, by ISO code -> head of state (P35), head of government (P6),
//     currency (P38), official language (P37). Resolved via P297 (ISO alpha-2
//     code) so it works for any country without a hand-maintained QID table.
//
// REST Countries is NOT used — its free tier has been deprecated by its
// operator and returns {success:false} for every request (see PROGRESS.md
// from the previous session). It contributed nothing this endpoint couldn't
// get from the two sources above, so rather than keep dead code around, this
// rewrite drops it entirely.
//
// Elections timing and political leaning have no good free live API and
// change rarely, so a small hardcoded table is checked first (covers ~20
// countries, no AI cost). For whichever of the 5 "analytical" fields
// (elections, politicalLeaning, governmentType, keyAllies, primaryRivals)
// are still empty after that — which is every country outside the table,
// and always governmentType/keyAllies/primaryRivals since there's no
// hardcoded source for those at all — one Groq call fills the gaps. Live
// data (leader, population, capital, currency, ...) always wins; AI never
// overwrites a real value, only fills a genuine `null`. Fields the AI
// actually supplied are listed in `result.aiFields` so the frontend can
// label them honestly instead of presenting them as live facts.
const { askAI, isConfigured } = require('../lib/ai');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1hr for a complete result — persists across warm invocations
// Wikidata's public SPARQL endpoint occasionally has one-off latency spikes
// well past what's reasonable to make a user wait on (confirmed live: the
// exact same US query that timed out once came back in ~200ms on every
// other attempt) — when a source comes back partial/null, that's very
// likely transient, so cache it far more briefly rather than baking a
// one-time blip into an hour of "missing" data on every country click.
const PARTIAL_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const WIKIDATA_UA = 'SentinelIntelligence/1.0 (https://github.com/Andrei11022/Sentinel)';
// Wikimedia's User-Agent policy 403s requests without a descriptive UA
// (browsers send one automatically; server-side fetch needs it set explicitly).

// No live API covers this well; changes infrequently.
const ELECTIONS = {
  US:'Nov 2028', RU:'2030 (controlled)', CN:'No free elections',
  UA:'Suspended (war)', IR:'2029', IL:'By 2026', SA:'None',
  IN:'2029', TR:'2028', DE:'2029', GB:'2029', FR:'2027',
  KP:'None', JP:'2025', BR:'2026', PK:'2029', SD:'None (war)',
  MM:'None (junta)', YE:'None (war)', SY:'Transitional',
  EG:'2029 (controlled)',
};

// No live API covers this well; changes infrequently.
const POLITICAL_LEANING = {
  US:'Right-Populist', RU:'Auth-Nationalist', CN:'Auth-Communist',
  UA:'Liberal Democrat', IR:'Theocratic', IL:'Right-Nationalist',
  SA:'Absolute Monarchy', IN:'Hindu-Nationalist', TR:'Auth-Islamist',
  DE:'Centre-Right', GB:'Centre-Left', FR:'Centrist-Liberal',
  KP:'Juche/Totalitarian', JP:'Conservative', BR:'Left-Progressive',
  PK:'Conservative-Islamic', SY:'Post-conflict transitional',
  LY:'Divided governance', MM:'Military Authoritarian', SD:'Military factions',
};

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function flagEmoji(code) {
  if (!/^[A-Za-z]{2}$/.test(code)) return null;
  return code.toUpperCase().replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

async function fetchWorldBank(code) {
  try {
    const r = await fetchWithTimeout(`https://api.worldbank.org/v2/country/${code}?format=json`);
    const data = await r.json();
    const entry = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : null;
    if (!entry || !entry.name) return null;
    return {
      name: entry.name,
      capital: entry.capitalCity || null,
      region: entry.region?.value && entry.region.value !== 'Aggregates' ? entry.region.value : null,
      incomeLevel: entry.incomeLevel?.value && entry.incomeLevel.value !== 'Aggregates' ? entry.incomeLevel.value : null,
      lat: entry.latitude ? Number(entry.latitude) : null,
      lon: entry.longitude ? Number(entry.longitude) : null,
    };
  } catch (e) {
    return null;
  }
}

async function fetchWorldBankPopulation(code) {
  try {
    // mrv=1 ("most recent value") instead of a hardcoded year, so this never
    // goes stale.
    const r = await fetchWithTimeout(`https://api.worldbank.org/v2/country/${code}/indicator/SP.POP.TOTL?format=json&mrv=1`);
    const data = await r.json();
    const entry = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : null;
    return typeof entry?.value === 'number' ? entry.value : null;
  } catch (e) {
    return null;
  }
}

// Splits a "|"-joined GROUP_CONCAT string, dedupes exact-string repeats
// (Wikidata sometimes has the same label under both "en" and "mul" tags,
// which SPARQL's DISTINCT treats as different terms), and keeps the first n.
function dedupeJoined(str, n = 1) {
  if (!str) return null;
  const parts = [...new Set(str.split('|').map(s => s.trim()).filter(Boolean))];
  return parts.length ? parts.slice(0, n).join(', ') : null;
}

// One retry on failure — Wikidata's public endpoint blips are transient
// (the exact query that timed out once came back in ~200ms moments later
// in testing), so a single immediate retry resolves most of them without
// meaningfully slowing down the case where it just works the first time.
async function fetchWikidata(code) {
  const first = await fetchWikidataOnce(code);
  if (first) return first;
  return fetchWikidataOnce(code);
}

async function fetchWikidataOnce(code) {
  try {
    // GROUP_CONCAT everything so multi-valued properties (P37 official
    // language especially — some countries recognize 20+) collapse to one
    // row instead of a row-per-combination cross product.
    const sparql = `SELECT ?countryLabel
      (GROUP_CONCAT(DISTINCT ?hosLabel; separator="|") AS ?hosAll)
      (GROUP_CONCAT(DISTINCT ?hogLabel; separator="|") AS ?hogAll)
      (GROUP_CONCAT(DISTINCT ?currencyLabel; separator="|") AS ?currencyAll)
      (GROUP_CONCAT(DISTINCT ?languageLabel; separator="|") AS ?languageAll)
    WHERE {
      ?country wdt:P297 "${code}".
      ?country rdfs:label ?countryLabel. FILTER(LANG(?countryLabel)="en")
      OPTIONAL { ?country wdt:P35 ?hos. ?hos rdfs:label ?hosLabel. FILTER(LANG(?hosLabel) IN ("en","mul")) }
      OPTIONAL { ?country wdt:P6 ?hog. ?hog rdfs:label ?hogLabel. FILTER(LANG(?hogLabel) IN ("en","mul")) }
      OPTIONAL { ?country wdt:P38 ?currency. ?currency rdfs:label ?currencyLabel. FILTER(LANG(?currencyLabel) IN ("en","mul")) }
      OPTIONAL { ?country wdt:P37 ?language. ?language rdfs:label ?languageLabel. FILTER(LANG(?languageLabel) IN ("en","mul")) }
    }
    GROUP BY ?countryLabel`;
    const r = await fetchWithTimeout(
      'https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql) + '&format=json',
      { headers: { Accept: 'application/sparql-results+json', 'User-Agent': WIKIDATA_UA } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const b = d.results?.bindings?.[0];
    if (!b) return null;
    return {
      name: b.countryLabel?.value || null,
      headOfState: dedupeJoined(b.hosAll?.value),
      headOfGovernment: dedupeJoined(b.hogAll?.value),
      currency: dedupeJoined(b.currencyAll?.value),
      language: dedupeJoined(b.languageAll?.value, 2),
    };
  } catch (e) {
    return null;
  }
}

// Maps the AI's JSON keys to this endpoint's result field names.
const AI_FIELD_MAP = {
  nextElections: 'elections',
  politicalLeaning: 'politicalLeaning',
  governmentType: 'governmentType',
  keyAllies: 'keyAllies',
  primaryRivals: 'primaryRivals',
};

async function fillGapsWithAI(countryName) {
  if (!isConfigured()) return null;
  try {
    const text = await askAI({
      messages: [{
        role: 'user',
        content: `For ${countryName}, provide current factual data as JSON:\n{\n  "nextElections": "month year and type, e.g. Nov 2028 Presidential, or None/Suspended",\n  "politicalLeaning": "brief: e.g. Right-nationalist / Centre-left / Authoritarian",\n  "governmentType": "e.g. Federal republic, Constitutional monarchy",\n  "keyAllies": "top 2-3 allies",\n  "primaryRivals": "top 2-3 rivals"\n}\nReturn ONLY valid JSON, no other text. Use your knowledge; if genuinely unknown, use null.`,
      }],
      maxTokens: 300,
    });
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code } = req.query;
  if (!code || !/^[A-Za-z]{2}$/.test(code)) {
    return res.status(400).json({ error: 'Provide a 2-letter country code, e.g. ?code=US' });
  }
  const upperCode = code.toUpperCase();

  const cached = cache.get(upperCode);
  if (cached && Date.now() - cached.ts < cached.ttl) {
    return res.status(200).json(cached.data);
  }

  const [wb, population, wd] = await Promise.all([
    fetchWorldBank(upperCode),
    fetchWorldBankPopulation(upperCode),
    fetchWikidata(upperCode),
  ]);

  // Only a genuinely unrecognized code (no source has ever heard of it)
  // should look like "no data" to the frontend.
  if (!wb && !population && !wd) {
    return res.status(404).json({ error: 'Country not found', code: upperCode });
  }

  const result = {
    code: upperCode,
    name: wb?.name || wd?.name || upperCode,
    flag: flagEmoji(upperCode),
    capital: wb?.capital || null,
    region: wb?.region || null,
    incomeLevel: wb?.incomeLevel || null,
    population,
    currency: wd?.currency || null,
    language: wd?.language || null,
    leader: wd?.headOfState || null,
    headOfGovernment: wd?.headOfGovernment || null,
    elections: ELECTIONS[upperCode] || null,
    politicalLeaning: POLITICAL_LEANING[upperCode] || null,
    governmentType: null,
    keyAllies: null,
    primaryRivals: null,
    aiFields: [],
    lat: wb?.lat ?? null,
    lon: wb?.lon ?? null,
  };

  // Only spend a Groq call on genuine gaps — never on fields the hardcoded
  // tables or live sources above already answered.
  const stillMissing = Object.values(AI_FIELD_MAP).some((field) => result[field] == null);
  if (stillMissing) {
    const aiData = await fillGapsWithAI(result.name);
    if (aiData) {
      for (const [aiKey, field] of Object.entries(AI_FIELD_MAP)) {
        if (result[field] != null) continue; // never overwrite a real value
        const val = aiData[aiKey];
        if (val == null || String(val).trim().toLowerCase() === 'null' || !String(val).trim()) continue;
        result[field] = String(val).trim();
        result.aiFields.push(field);
      }
    }
  }

  // Full TTL only when every source actually answered — a result missing
  // World Bank or Wikidata data gets a much shorter TTL so a transient
  // failure self-heals on the next click instead of showing "—" for an
  // hour (see PARTIAL_CACHE_TTL_MS comment above). The AI gap-fill result
  // (or lack of one) is cached right along with everything else here, so
  // it's not re-requested from Groq on every click.
  const isComplete = wb && wd && population != null;
  cache.set(upperCode, { ts: Date.now(), data: result, ttl: isComplete ? CACHE_TTL_MS : PARTIAL_CACHE_TTL_MS });
  return res.status(200).json(result);
};
