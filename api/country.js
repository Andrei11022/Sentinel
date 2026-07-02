// Live country intel for ANY ISO 3166-1 alpha-2 code, aggregated server-side
// (so the browser never hits restcountries.com/query.wikidata.org directly
// and never sees a CORS failure). Combines:
//   - World Bank country API   -> name, capital, region, income level, lat/lon
//   - REST Countries v3.1      -> population, currency, language, region
//     (this API's free tier has been deprecated by its operator and
//     currently returns {success:false} for every request — see PROGRESS.md.
//     Still attempted here in case that ever changes; failure just means
//     those few fields fall back to '—' on the frontend.)
//   - Wikidata SPARQL          -> head of state (P35) + head of government (P6),
//     resolved by ISO alpha-2 code (P297) so it works for every country
//     without a hand-maintained QID table.
//
// Elections timing and political leaning have no good free live API and
// change rarely, so they stay as a small hardcoded table.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1hr — persists across warm invocations
const cache = new Map();

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

async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
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

async function fetchRestCountries(code) {
  try {
    const r = await fetchWithTimeout(
      `https://restcountries.com/v3.1/alpha/${code}?fields=name,capital,population,currencies,languages,flags,region,subregion`
    );
    const data = await r.json();
    const d = Array.isArray(data) ? data[0] : data;
    if (!d || d.success === false || !d.name) return null;
    return {
      name: d.name.common || null,
      capital: d.capital?.[0] || null,
      population: typeof d.population === 'number' ? d.population.toLocaleString() : null,
      currency: Object.values(d.currencies || {})[0]?.name || null,
      language: Object.values(d.languages || {}).slice(0, 2).join(', ') || null,
      flag: d.flags?.emoji || null,
      region: d.region || null,
      subregion: d.subregion || null,
    };
  } catch (e) {
    return null;
  }
}

async function fetchWikidata(code) {
  try {
    const sparql = `SELECT ?countryLabel ?hosLabel ?hogLabel WHERE {
      ?country wdt:P297 "${code}".
      OPTIONAL { ?country wdt:P35 ?hos. }
      OPTIONAL { ?country wdt:P6 ?hog. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
    } LIMIT 1`;
    const r = await fetchWithTimeout(
      'https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql) + '&format=json',
      { headers: {
        Accept: 'application/sparql-results+json',
        // Wikimedia's User-Agent policy 403s requests without a descriptive UA
        // (browsers send one automatically; server-side fetch needs it set explicitly).
        'User-Agent': 'SentinelIntelligence/1.0 (https://github.com/Andrei11022/Sentinel)',
      } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const b = d.results?.bindings?.[0];
    if (!b) return null;
    return {
      name: b.countryLabel?.value || null,
      headOfState: b.hosLabel?.value || null,
      headOfGovernment: b.hogLabel?.value || null,
    };
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
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.status(200).json(cached.data);
  }

  const [wb, rc, wd] = await Promise.all([
    fetchWorldBank(upperCode),
    fetchRestCountries(upperCode),
    fetchWikidata(upperCode),
  ]);

  // Only a genuinely unrecognized code (no source has ever heard of it)
  // should look like "no data" to the frontend.
  if (!wb && !rc && !wd) {
    return res.status(404).json({ error: 'Country not found', code: upperCode });
  }

  const result = {
    code: upperCode,
    name: rc?.name || wb?.name || wd?.name || upperCode,
    flag: rc?.flag || flagEmoji(upperCode),
    capital: rc?.capital || wb?.capital || null,
    region: rc?.region || wb?.region || null,
    subregion: rc?.subregion || null,
    incomeLevel: wb?.incomeLevel || null,
    population: rc?.population || null,
    currency: rc?.currency || null,
    language: rc?.language || null,
    leader: wd?.headOfState || null,
    headOfGovernment: wd?.headOfGovernment || null,
    elections: ELECTIONS[upperCode] || null,
    politicalLeaning: POLITICAL_LEANING[upperCode] || null,
    lat: wb?.lat ?? null,
    lon: wb?.lon ?? null,
  };

  cache.set(upperCode, { ts: Date.now(), data: result });
  return res.status(200).json(result);
};
