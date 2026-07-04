// Consolidated intelligence endpoint — merges four formerly-separate
// serverless functions (analyze.js, entities.js, forecast.js, acled.js) into
// one, routed by a flat `type` value, to stay under Vercel Hobby's
// 12-Serverless-Function cap. One physical function, several behaviors:
//
//   GET  ?type=risk_matrix                    -> country risk matrix (was forecast.js)
//   GET  ?type=acled[&country=&limit=]        -> conflict event list (was acled.js)
//   POST {type:'scenarios', articles}         -> auto-generated, browsable forward-looking
//                                                 scenarios per live situation, with cited sources
//                                                 (redesigned 2026-07-04 from a simpler forecast.js
//                                                 scenario engine — see PROGRESS.md)
//   POST {type:'brief', articles}             -> AI intel brief + local fallback (was analyze.js)
//   POST {type:'correlations'|'warnings'|'actors', articles} -> same, other analyze.js behaviors
//   POST {type:'entities', articles, text}    -> entity + relationship extraction (was entities.js)
//   POST {type:'predictions', articles}       -> AI-assessed probability questions per live situation
//   POST {type:'simulate', mode:'conflict', countryA, countryB} -> AI conflict-scenario briefing
//   POST {type:'simulate', mode:'whatif', scenario}             -> AI cascade-effect breakdown
//   POST {type:'forecast', articles}          -> AI "next 30-90 days" global outlook
//
// Note: analyze.js used to have its own internal `type:'entities'` behavior
// (a simpler ACTOR_DB-based extractor with no relationships) that was never
// actually called from the frontend — superseded here by entities.js's real,
// used implementation under the same `type:'entities'` name. No live feature
// was dropped; that branch was dead code even before this merge.
const { askAI, isConfigured } = require('../lib/ai');
const { getCache, setCache, hashKey } = require('../lib/cache');

// ─── shared by brief/correlations/warnings/actors (was analyze.js) ───

const LOCATION_DB = [
  { key: /ukraine|kyiv|kharkiv|donetsk|zaporizhzhia/i, name: 'Ukraine', country: 'UA', lat: 49.0, lon: 32.0 },
  { key: /russia|moscow|kursk|belgorod/i, name: 'Russia', country: 'RU', lat: 55.7, lon: 37.6 },
  { key: /israel|gaza|west bank|rafah|jerusalem/i, name: 'Israel/Palestine', country: 'IL', lat: 31.5, lon: 34.8 },
  { key: /iran|tehran|fordow|hormuz/i, name: 'Iran', country: 'IR', lat: 32.4, lon: 53.7 },
  { key: /taiwan|taipei|taiwan strait/i, name: 'Taiwan', country: 'TW', lat: 23.8, lon: 121.0 },
  { key: /north korea|pyongyang|icbm/i, name: 'North Korea', country: 'KP', lat: 40.0, lon: 127.0 },
  { key: /yemen|houthi|aden|sanaa|red sea/i, name: 'Yemen/Red Sea', country: 'YE', lat: 15.6, lon: 44.2 },
  { key: /lebanon|hezbollah|beirut/i, name: 'Lebanon', country: 'LB', lat: 33.8, lon: 35.8 },
  { key: /sudan|darfur|khartoum/i, name: 'Sudan', country: 'SD', lat: 15.5, lon: 32.5 },
  { key: /myanmar|yangon|naypyidaw/i, name: 'Myanmar', country: 'MM', lat: 19.7, lon: 96.1 },
  { key: /china|beijing|south china sea|pla/i, name: 'China', country: 'CN', lat: 35.8, lon: 104.2 },
  { key: /pakistan|islamabad|kpk|ttp/i, name: 'Pakistan', country: 'PK', lat: 30.4, lon: 69.4 },
  { key: /syria|damascus|idlib/i, name: 'Syria', country: 'SY', lat: 35.1, lon: 38.5 },
  { key: /haiti|port-au-prince/i, name: 'Haiti', country: 'HT', lat: 18.9, lon: -72.3 },
  { key: /venezuela|guyana|essequibo/i, name: 'Venezuela/Guyana', country: 'VE', lat: 7.2, lon: -65.3 },
];

const ACTOR_DB = [
  { id: 'USA', label: 'USA', type: 'state', key: /\busa\b|united states|washington|trump|white house/i },
  { id: 'RUSSIA', label: 'RUSSIA', type: 'state', key: /russia|putin|kremlin|moscow/i },
  { id: 'UKRAINE', label: 'UKRAINE', type: 'state', key: /ukraine|zelensky|kyiv/i },
  { id: 'CHINA', label: 'CHINA', type: 'state', key: /china|beijing|xi jinping|pla/i },
  { id: 'IRAN', label: 'IRAN', type: 'state', key: /iran|tehran|khamenei|irgc/i },
  { id: 'ISRAEL', label: 'ISRAEL', type: 'state', key: /israel|idf|netanyahu/i },
  { id: 'NATO', label: 'NATO', type: 'org', key: /\bnato\b/i },
  { id: 'HAMAS', label: 'HAMAS', type: 'proxy', key: /hamas/i },
  { id: 'HEZBOLLAH', label: 'HEZBOLLAH', type: 'proxy', key: /hezbollah/i },
  { id: 'HOUTHIS', label: 'HOUTHIS', type: 'proxy', key: /houthi|houthis/i },
  { id: 'UN', label: 'UN', type: 'org', key: /\bun\b|united nations/i },
  { id: 'EU', label: 'EU', type: 'org', key: /\beu\b|european union/i },
];

function cleanArticles(input) {
  return (Array.isArray(input) ? input : [])
    .filter((a) => a && typeof a.title === 'string' && a.title.trim().length > 4)
    .map((a) => ({
      title: a.title.trim(),
      tag: a.tag || 'INTEL',
      threatScore: Number(a.threatScore || 50),
      publishedAt: a.publishedAt || new Date().toISOString(),
      summary: a.summary || '',
      source: a.source || 'Unknown',
      url: a.url || null, // kept so predictions/forecast can cite real, clickable sources
    }));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function timeAgoLabel(dateLike) {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(dateLike).getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}hr ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function inferLocation(text) {
  const found = LOCATION_DB.find((loc) => loc.key.test(text || ''));
  return found || { name: 'Global', country: 'GL', lat: 20.0, lon: 0.0 };
}

function severityForArticle(article) {
  const s = Number(article.threatScore || 50);
  if (s >= 75 || article.tag === 'NUCLEAR') return 'HIGH';
  if (s >= 50) return 'MEDIUM';
  return 'LOW';
}

function warningTypeForArticle(article) {
  if (article.tag === 'NUCLEAR') return 'nuclear';
  if (article.tag === 'CYBER') return 'cyber';
  if (article.tag === 'MILITARY') return 'military';
  if (article.tag === 'DISASTER') return 'disaster';
  return 'conflict';
}

function buildWarnings(articles) {
  return articles
    .slice()
    .sort((a, b) => b.threatScore - a.threatScore)
    .slice(0, 12)
    .map((a, i) => {
      const loc = inferLocation(`${a.title} ${a.summary}`);
      return {
        id: `warn-${Date.now()}-${i}`,
        title: a.title,
        severity: severityForArticle(a),
        lat: loc.lat,
        lon: loc.lon,
        type: warningTypeForArticle(a),
        desc: a.summary || a.title,
        ts: timeAgoLabel(a.publishedAt),
        country: loc.name,
        riskScore: Math.max(20, Math.min(100, Math.round(a.threatScore))),
      };
    });
}

function buildBrief(articles) {
  // Brief Me is about what's happening NOW, so this sorts by publish date
  // (not threatScore like the rest of this file) — a day-old high-severity
  // headline should never outrank a fresh one here.
  const sorted = articles.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const top = sorted.slice(0, 4);
  const hotspots = [...new Set(top.map((a) => inferLocation(`${a.title} ${a.summary}`).name))].slice(0, 3);
  const conflictCount = sorted.filter((a) => a.tag === 'CONFLICT' || a.tag === 'MILITARY').length;
  const nuclearCount = sorted.filter((a) => a.tag === 'NUCLEAR').length;
  const cyberCount = sorted.filter((a) => a.tag === 'CYBER').length;

  const s1 = `Current reporting from ${articles.length} live headlines (last few hours) indicates elevated risk across ${hotspots.length || 1} primary theaters: ${hotspots.join(', ') || 'global domains'}.`;
  const s2 = top[0] ? `The most recent development is "${top[0].title}" (${timeAgoLabel(top[0].publishedAt)}), with additional pressure from "${top[1]?.title || top[0].title}".` : 'No high-confidence recent development is available in the current feed.';
  const s3 = `Operational pattern: ${conflictCount} kinetic or military items, ${nuclearCount} nuclear-related items, and ${cyberCount} cyber-related items were identified in this cycle.`;
  const s4 = `Actor overlap across these reports suggests concurrent stress on Euro-Atlantic and Middle East decision cycles, increasing escalation risk in short windows.`;
  const s5 = `Near-term outlook: maintain watch for rapid retaliation chains, especially where headlines indicate repeated references to the same actors and corridors.`;
  return [s1, s2, s3, s4, s5].join(' ');
}

function buildCorrelations(articles) {
  const text = articles.map((a) => a.title).join(' ').toLowerCase();
  const count = (re) => (text.match(re) || []).length;

  const me = count(/israel|gaza|iran|hezbollah|hamas|houthi|yemen|lebanon/g);
  const ua = count(/ukraine|russia|nato|missile|drone|sanction/g);
  const apac = count(/taiwan|china|pla|north korea|icbm|south china sea/g);
  const cyber = count(/cyber|hack|breach|ransomware/g);

  const rows = [];
  if (ua > 0) {
    rows.push({
      title: 'Euro-Atlantic attrition linkage',
      score: `CORRELATION: ${Math.min(93, 58 + ua * 6)}%`,
      desc: `${ua} recurring references connect battlefield updates, sanctions messaging, and force-posture signaling around Ukraine/Russia timelines.`,
      actors: ['RUSSIA', 'UKRAINE', 'NATO', 'USA'],
    });
  }
  if (me > 0) {
    rows.push({
      title: 'Middle East proxy escalation chain',
      score: `CORRELATION: ${Math.min(94, 57 + me * 6)}%`,
      desc: `${me} linked mentions of Iran, Israel, and partner militias indicate interconnected pressure across Gaza, Lebanon, and Red Sea routes.`,
      actors: ['IRAN', 'ISRAEL', 'HAMAS', 'HEZBOLLAH', 'HOUTHIS'],
    });
  }
  if (apac > 0) {
    rows.push({
      title: 'Indo-Pacific deterrence strain',
      score: `CORRELATION: ${Math.min(91, 55 + apac * 7)}%`,
      desc: `${apac} APAC military indicators show synchronized deterrence signaling around Taiwan and DPRK missile narratives.`,
      actors: ['CHINA', 'TAIWAN', 'N.KOREA', 'USA'],
    });
  }
  if (cyber > 0) {
    rows.push({
      title: 'Hybrid cyber-kinetic overlap',
      score: `CORRELATION: ${Math.min(88, 52 + cyber * 8)}%`,
      desc: `${cyber} cyber references co-occur with kinetic headlines, consistent with blended influence and disruption campaigns.`,
      actors: ['RUSSIA', 'CHINA', 'EU', 'USA'],
    });
  }

  if (!rows.length) {
    rows.push({
      title: 'Distributed geopolitical pressure',
      score: 'CORRELATION: 61%',
      desc: 'Current headline mix shows low-concentration but multi-theater stress with no single dominant axis.',
      actors: ['USA', 'RUSSIA', 'CHINA'],
    });
  }

  return rows.slice(0, 4);
}

function extractActors(articles) {
  const actorMap = new Map();
  const pairCount = new Map();

  articles.forEach((article) => {
    const found = ACTOR_DB.filter((a) => a.key.test(article.title)).map((a) => a.id);
    found.forEach((id) => actorMap.set(id, ACTOR_DB.find((a) => a.id === id)));

    for (let i = 0; i < found.length; i += 1) {
      for (let j = i + 1; j < found.length; j += 1) {
        const pair = [found[i], found[j]].sort().join('::');
        pairCount.set(pair, (pairCount.get(pair) || 0) + 1);
      }
    }
  });

  const actors = [...actorMap.values()];
  if (!actors.length) {
    return {
      actors: [
        { id: 'USA', label: 'USA', type: 'state', x: 0.18, y: 0.3 },
        { id: 'RUSSIA', label: 'RUSSIA', type: 'state', x: 0.62, y: 0.2 },
        { id: 'CHINA', label: 'CHINA', type: 'state', x: 0.8, y: 0.36 },
      ],
      links: [
        { from: 'USA', to: 'RUSSIA', type: 'adversarial', label: 'Tension' },
        { from: 'USA', to: 'CHINA', type: 'economic', label: 'Competition' },
      ],
    };
  }

  const placedActors = actors.slice(0, 14).map((a, idx, arr) => {
    const angle = (idx / arr.length) * Math.PI * 2;
    return {
      id: a.id,
      label: a.label,
      type: a.type,
      x: 0.5 + Math.cos(angle) * 0.36,
      y: 0.5 + Math.sin(angle) * 0.34,
    };
  });

  const links = [...pairCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([pair, c]) => {
      const [from, to] = pair.split('::');
      const type = /IRAN|HAMAS|HEZBOLLAH|HOUTHIS/.test(pair)
        ? 'adversarial'
        : c >= 2
          ? 'allied'
          : 'diplomatic';
      return { from, to, type, label: c >= 2 ? `x${c}` : 'Linked' };
    });

  return { actors: placedActors, links };
}

async function runGroqAnalyze(type, articles) {
  if (!isConfigured()) return null;

  const prompts = {
    brief: `Write a concise 5-sentence intelligence brief covering what is happening RIGHT NOW. These headlines are sorted newest first and are all from the last few hours — focus on the newest ones and do not treat older items in this list as more important just because they read as more severe.\n${articles.map((a) => `- [${a.tag}] (${timeAgoLabel(a.publishedAt)}) ${a.title}`).join('\n')}`,
    correlations: `Return ONLY JSON array with 4 correlation objects (title, score, desc, actors[]) from:\n${articles.map((a) => `[${a.tag}] ${a.title}`).join('\n')}`,
    warnings: `Return ONLY JSON array of warning events (title,severity,lat,lon,type,desc,ts,country) from:\n${articles.map((a) => `[${a.tag}] ${a.title}`).join('\n')}`,
    actors: `Return ONLY JSON object {actors:[...],links:[...]} from:\n${articles.map((a) => a.title).join('\n')}`,
  };

  const prompt = prompts[type];
  if (!prompt) return null;

  try {
    const text = await askAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 900 });
    if (!text.trim()) return null;

    if (['correlations', 'warnings', 'actors'].includes(type)) {
      const clean = text.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }
    return text.trim();
  } catch {
    return null;
  }
}

// Returns the response payload directly (rather than writing to `res`) so
// the router can cache it — see the router's CACHE_CONFIG for 'brief'.
async function computeAnalyzeType(type, req) {
  const { articles } = req.body || {};
  const clean = cleanArticles(articles);
  const forType = type === 'brief'
    ? clean.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    : clean;

  try {
    const aiResult = await runGroqAnalyze(type, forType);
    if (aiResult) return { result: aiResult, fallback: false };

    if (type === 'brief') return { result: buildBrief(forType), fallback: true };
    if (type === 'correlations') return { result: buildCorrelations(clean), fallback: true };
    if (type === 'warnings') return { result: buildWarnings(clean), fallback: true };
    if (type === 'actors') return { result: extractActors(clean), fallback: true };
    return { error: 'Unknown type' };
  } catch (e) {
    if (type === 'brief') return { result: buildBrief(forType), fallback: true, error: e.message };
    if (type === 'correlations') return { result: buildCorrelations(clean), fallback: true, error: e.message };
    if (type === 'warnings') return { result: buildWarnings(clean), fallback: true, error: e.message };
    if (type === 'actors') return { result: extractActors(clean), fallback: true, error: e.message };
    return { error: 'Unknown type' };
  }
}

// ─── entities (was entities.js) ───

const ENTITY_DB = {
  people: {
    'putin': { name: 'Vladimir Putin', role: 'President', country: 'Russia', type: 'leader', threat: 'HIGH' },
    'zelensky': { name: 'Volodymyr Zelensky', role: 'President', country: 'Ukraine', type: 'leader', threat: 'LOW' },
    'xi jinping': { name: 'Xi Jinping', role: 'General Secretary', country: 'China', type: 'leader', threat: 'MEDIUM' },
    'trump': { name: 'Donald Trump', role: 'President', country: 'USA', type: 'leader', threat: 'LOW' },
    'netanyahu': { name: 'Benjamin Netanyahu', role: 'Prime Minister', country: 'Israel', type: 'leader', threat: 'LOW' },
    'khamenei': { name: 'Ali Khamenei', role: 'Supreme Leader', country: 'Iran', type: 'leader', threat: 'HIGH' },
    'kim jong': { name: 'Kim Jong-un', role: 'Supreme Leader', country: 'N.Korea', type: 'leader', threat: 'HIGH' },
    'erdogan': { name: 'Recep Erdoğan', role: 'President', country: 'Turkey', type: 'leader', threat: 'MEDIUM' },
    'mbs': { name: 'Mohammed bin Salman', role: 'Crown Prince', country: 'Saudi Arabia', type: 'leader', threat: 'LOW' },
    'modi': { name: 'Narendra Modi', role: 'Prime Minister', country: 'India', type: 'leader', threat: 'LOW' },
    'macron': { name: 'Emmanuel Macron', role: 'President', country: 'France', type: 'leader', threat: 'LOW' },
    'starmer': { name: 'Keir Starmer', role: 'Prime Minister', country: 'UK', type: 'leader', threat: 'LOW' },
    'merz': { name: 'Friedrich Merz', role: 'Chancellor', country: 'Germany', type: 'leader', threat: 'LOW' },
    'sinwar': { name: 'Yahya Sinwar', role: 'Hamas Leader', country: 'Gaza', type: 'militant', threat: 'HIGH' },
    'nasrallah': { name: 'Hassan Nasrallah', role: 'Hezbollah Chief', country: 'Lebanon', type: 'militant', threat: 'HIGH' },
  },
  orgs: {
    'nato': { name: 'NATO', type: 'alliance', members: 32, threat: 'LOW' },
    'hamas': { name: 'Hamas', type: 'militant', designation: 'terrorist', threat: 'HIGH' },
    'hezbollah': { name: 'Hezbollah', type: 'militant', designation: 'terrorist', threat: 'HIGH' },
    'houthis': { name: 'Houthis', type: 'militant', threat: 'HIGH' },
    'wagner': { name: 'Wagner Group', type: 'pmc', threat: 'HIGH' },
    'iaea': { name: 'IAEA', type: 'un_agency', threat: 'LOW' },
    'irgc': { name: 'IRGC', type: 'military', country: 'Iran', threat: 'HIGH' },
    'idf': { name: 'IDF', type: 'military', country: 'Israel', threat: 'LOW' },
    'un': { name: 'United Nations', type: 'intl_org', threat: 'LOW' },
    'eu': { name: 'European Union', type: 'intl_org', threat: 'LOW' },
    'opec': { name: 'OPEC+', type: 'economic', threat: 'LOW' },
    'brics': { name: 'BRICS', type: 'economic', threat: 'LOW' },
    'isis': { name: 'ISIS/ISIL', type: 'militant', designation: 'terrorist', threat: 'HIGH' },
    'al-shabaab': { name: 'Al-Shabaab', type: 'militant', designation: 'terrorist', threat: 'HIGH' },
    'rsf': { name: 'RSF', type: 'paramilitary', country: 'Sudan', threat: 'HIGH' },
    'ttp': { name: 'Tehrik-i-Taliban', type: 'militant', designation: 'terrorist', threat: 'HIGH' },
  },
  locations: {
    'ukraine': { name: 'Ukraine', type: 'country', lat: 49, lon: 32, conflict: true },
    'gaza': { name: 'Gaza', type: 'territory', lat: 31.5, lon: 34.5, conflict: true },
    'taiwan': { name: 'Taiwan', type: 'territory', lat: 23.5, lon: 121, conflict: false, tension: true },
    'iran': { name: 'Iran', type: 'country', lat: 32, lon: 53, conflict: false, tension: true },
    'north korea': { name: 'North Korea', type: 'country', lat: 40, lon: 127, conflict: false, tension: true },
    'red sea': { name: 'Red Sea', type: 'waterway', lat: 20, lon: 38, strategic: true },
    'strait of hormuz': { name: 'Strait of Hormuz', type: 'waterway', lat: 26.5, lon: 56.3, strategic: true },
    'south china sea': { name: 'South China Sea', type: 'waterway', lat: 15, lon: 115, strategic: true },
    'taiwan strait': { name: 'Taiwan Strait', type: 'waterway', lat: 24, lon: 119, strategic: true },
    'kharkiv': { name: 'Kharkiv', type: 'city', lat: 49.9, lon: 36.2, conflict: true },
    'rafah': { name: 'Rafah', type: 'city', lat: 31.3, lon: 34.2, conflict: true },
    'damascus': { name: 'Damascus', type: 'city', lat: 33.5, lon: 36.3, conflict: false },
    'beirut': { name: 'Beirut', type: 'city', lat: 33.9, lon: 35.5, tension: true },
    'pyongyang': { name: 'Pyongyang', type: 'city', lat: 39.0, lon: 125.7, conflict: false },
  }
};

function extractEntitiesLocal(text) {
  const lower = text.toLowerCase();
  const found = { people: [], orgs: [], locations: [] };

  Object.entries(ENTITY_DB.people).forEach(([key, val]) => {
    if (lower.includes(key)) found.people.push(val);
  });
  Object.entries(ENTITY_DB.orgs).forEach(([key, val]) => {
    if (lower.includes(key)) found.orgs.push(val);
  });
  Object.entries(ENTITY_DB.locations).forEach(([key, val]) => {
    if (lower.includes(key)) found.locations.push(val);
  });

  found.people = [...new Map(found.people.map(p => [p.name, p])).values()];
  found.orgs = [...new Map(found.orgs.map(o => [o.name, o])).values()];
  found.locations = [...new Map(found.locations.map(l => [l.name, l])).values()];
  return found;
}

async function extractEntitiesAI(articles) {
  const headlines = articles.map(a => a.title || a.webTitle).join('\n');
  const text = await askAI({
    messages: [{
      role: 'user',
      content: `Extract all named entities from these headlines. Return ONLY JSON:\n{"people":[{"name":"...","role":"...","country":"...","threatLevel":"HIGH|MEDIUM|LOW"}],"organizations":[{"name":"...","type":"state|militant|alliance|ngo","threatLevel":"HIGH|MEDIUM|LOW"}],"locations":[{"name":"...","type":"country|city|region|waterway","lat":0,"lon":0,"conflictZone":true}],"relationships":[{"from":"...","to":"...","type":"allied|adversarial|economic|diplomatic","strength":"strong|moderate|weak"}]}\n\nHeadlines:\n${headlines}`
    }],
    maxTokens: 1000,
  });
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// Returns the response payload directly (rather than writing to `res`) so
// the router can cache it — see the router's CACHE_CONFIG for 'entities'.
async function computeEntities(req) {
  const { articles, text } = req.body || {};

  try {
    let entities;

    if (isConfigured() && articles?.length) {
      try {
        entities = await extractEntitiesAI(articles);
      } catch {
        const combined = (articles || []).map(a => a.title || a.webTitle || '').join(' ');
        entities = extractEntitiesLocal(combined);
      }
    } else {
      const combined = text || (articles || []).map(a => a.title || a.webTitle || '').join(' ');
      entities = extractEntitiesLocal(combined);
    }

    const highThreatActors = [
      ...(entities.people || []).filter(p => p.threatLevel === 'HIGH' || p.threat === 'HIGH'),
      ...(entities.organizations || entities.orgs || []).filter(o => o.threatLevel === 'HIGH' || o.threat === 'HIGH'),
    ];

    return {
      entities,
      summary: {
        totalEntities: (entities.people?.length || 0) + (entities.organizations?.length || entities.orgs?.length || 0) + (entities.locations?.length || 0),
        highThreatActors: highThreatActors.map(a => a.name),
        conflictZones: (entities.locations || []).filter(l => l.conflictZone || l.conflict).map(l => l.name),
      }
    };
  } catch (e) {
    return { entities: extractEntitiesLocal(text || ''), error: e.message };
  }
}

// ─── forecast: risk matrix + scenarios (was forecast.js) ───

const COUNTRY_RISK_BASE = {
  UA: { name:'Ukraine', baseRisk:95, trend:'stable', factors:['Active war','Russian offensive','NATO support','Front line pressure'], gdpImpact:-35, refugeeFlow:6200000 },
  SD: { name:'Sudan', baseRisk:94, trend:'worsening', factors:['RSF civil war','Darfur genocide','8M displaced','Famine risk'], gdpImpact:-45, refugeeFlow:8100000 },
  MM: { name:'Myanmar', baseRisk:91, trend:'worsening', factors:['Military junta','Resistance control 40%','Airstrike civilians','Ethnic cleansing'], gdpImpact:-30, refugeeFlow:1200000 },
  PS: { name:'Gaza/Palestine', baseRisk:98, trend:'stable', factors:['Active IDF operations','Humanitarian crisis','2M displaced','Infrastructure destroyed'], gdpImpact:-80, refugeeFlow:1900000 },
  YE: { name:'Yemen', baseRisk:87, trend:'stable', factors:['Houthi control north','Red Sea attacks','Civil war','Cholera epidemic'], gdpImpact:-55, refugeeFlow:4300000 },
  SO: { name:'Somalia', baseRisk:82, trend:'stable', factors:['Al-Shabaab active','Drought/famine','Political fragility','Gulf of Aden piracy'], gdpImpact:-20, refugeeFlow:3200000 },
  ML: { name:'Mali', baseRisk:79, trend:'worsening', factors:['Wagner Group presence','French expulsion','Tuareg rebellion','Jihadist expansion'], gdpImpact:-15, refugeeFlow:400000 },
  HT: { name:'Haiti', baseRisk:88, trend:'worsening', factors:['Gang control 85% capital','State collapse','No government','Humanitarian crisis'], gdpImpact:-40, refugeeFlow:200000 },
  LB: { name:'Lebanon', baseRisk:76, trend:'stable', factors:['Hezbollah-Israel conflict','Economic collapse','Political vacuum','Refugee burden'], gdpImpact:-60, refugeeFlow:1300000 },
  SY: { name:'Syria', baseRisk:72, trend:'improving', factors:['Post-Assad transition','HTS governance','ISIS remnants','Reconstruction needed'], gdpImpact:-65, refugeeFlow:5500000 },
  IQ: { name:'Iraq', baseRisk:65, trend:'stable', factors:['PMF militia dominance','ISIS resurgence','US withdrawal pressure','Iranian influence'], gdpImpact:-8, refugeeFlow:1200000 },
  IR: { name:'Iran', baseRisk:71, trend:'worsening', factors:['Nuclear escalation','US sanctions','Regional proxy war','Economy under pressure'], gdpImpact:-20, refugeeFlow:200000 },
  KP: { name:'N.Korea', baseRisk:74, trend:'stable', factors:['ICBM program','Nuclear weapons','Russia arms deal','Starvation'], gdpImpact:0, refugeeFlow:30000 },
  CN: { name:'China', baseRisk:42, trend:'stable', factors:['Taiwan pressure','South China Sea','Economic slowdown','Tech war with US'], gdpImpact:0, refugeeFlow:0 },
  PK: { name:'Pakistan', baseRisk:61, trend:'worsening', factors:['TTP insurgency','IMF default risk','India tension','Nuclear state'], gdpImpact:-12, refugeeFlow:600000 },
  ET: { name:'Ethiopia', baseRisk:67, trend:'stable', factors:['Amhara conflict','Fano militia','Post-Tigray fragility','Drought'], gdpImpact:-10, refugeeFlow:4200000 },
};

function calculateEscalationProbability(countryCode, recentEvents) {
  const base = COUNTRY_RISK_BASE[countryCode];
  if (!base) return null;

  let prob = base.baseRisk;

  if (base.trend === 'worsening') prob = Math.min(99, prob + 8);
  if (base.trend === 'improving') prob = Math.max(10, prob - 8);

  if (recentEvents) {
    const mentionCount = (recentEvents.match(new RegExp(base.name, 'gi')) || []).length;
    prob = Math.min(99, prob + mentionCount * 2);
  }

  return {
    name: base.name,
    code: countryCode,
    escalationProbability: prob,
    riskLevel: prob > 80 ? 'CRITICAL' : prob > 60 ? 'HIGH' : prob > 40 ? 'MEDIUM' : 'LOW',
    trend: base.trend,
    keyFactors: base.factors,
    gdpImpact: base.gdpImpact + '%',
    displaced: base.refugeeFlow.toLocaleString(),
  };
}

// Returns the response payload directly (rather than writing to `res`) so
// the router can cache it — see the router's CACHE_CONFIG for 'risk_matrix'.
function computeRiskMatrix(req) {
  const { articles } = req.query;
  const recentText = (articles || []).map(a => a.title || a.webTitle || '').join(' ');
  const matrix = Object.entries(COUNTRY_RISK_BASE)
    .map(([code]) => calculateEscalationProbability(code, recentText))
    .filter(Boolean)
    .sort((a, b) => b.escalationProbability - a.escalationProbability);

  return { matrix, updatedAt: new Date().toISOString() };
}

// Returns the response payload directly (rather than writing to `res`) so
// the router can cache it — see the router's CACHE_CONFIG for 'scenarios'.
//
// Auto-generated, browsable forward-looking scenarios — distinct from the
// user-driven SIMULATE tab (which requires picking two countries or typing
// a "what if"). Situations are derived from whatever the CURRENT live feed
// actually contains via groupArticlesBySituation() (also used by
// computePredictions below — LOCATION_DB is just a location-name
// recognizer, not a source of which situations are "active"), and real
// articles are attached as `sources` in code rather than trusted from
// Groq's own citation accuracy inside a multi-item JSON array.
async function computeScenarios(req) {
  const { articles } = req.body || {};
  const clean = cleanArticles(articles);
  const situations = groupArticlesBySituation(clean, 6);
  const updatedAt = new Date().toISOString();

  if (!situations.length) return { scenarios: [], fallback: true, updatedAt };

  if (isConfigured()) {
    try {
      const prompt = `For each SITUATION below, generate ONE plausible forward-looking scenario for how it could develop over the coming weeks, grounded ONLY in the headlines given for that situation — never invent facts not implied by them.\n\nReturn ONLY a JSON array, one object per situation, in the SAME ORDER given:\n[{"title":"a specific forward-looking headline, e.g. 'Ukraine ceasefire talks collapse, front reactivates'","probability":0-100,"timeframe":"e.g. '2-6 weeks'","triggerSigns":["early indicator to watch","another"],"ifItHappens":"2-3 sentence cascade of consequences","severity":"CRITICAL|HIGH|MEDIUM"}]\n\n` +
        situations.map((s, i) => `SITUATION ${i + 1}: ${s.name}\n${s.articles.slice(0, 6).map((a) => `- [${a.tag}] ${a.title}`).join('\n')}`).join('\n\n');

      const text = await askAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 1600 });
      const aiItems = JSON.parse(text.replace(/```json|```/g, '').trim());

      const scenarios = situations.map((s, i) => {
        const ai = aiItems[i] || {};
        return {
          title: ai.title || `${s.name}: situation develops further`,
          basedOn: s.name,
          probability: Math.max(0, Math.min(100, Math.round(Number(ai.probability) || 40))),
          timeframe: ai.timeframe || '4-8 weeks',
          triggerSigns: Array.isArray(ai.triggerSigns) ? ai.triggerSigns.slice(0, 3) : [],
          ifItHappens: ai.ifItHappens || 'Insufficient data for detailed cascade analysis.',
          severity: ['CRITICAL', 'HIGH', 'MEDIUM'].includes(ai.severity) ? ai.severity : 'MEDIUM',
          sources: articleSources(s.articles),
        };
      }).sort((a, b) => b.probability - a.probability);

      return { scenarios, fallback: false, updatedAt };
    } catch (e) {
      // Fall through to the heuristic fallback below
    }
  }

  // No Groq / Groq failed — deterministic heuristic, clearly labeled
  // fallback:true so the frontend never presents a guess as an AI-generated
  // scenario (same pattern as computePredictions's fallback).
  const scenarios = situations.map((s) => {
    const avgScore = Math.round(s.articles.reduce((sum, a) => sum + a.threatScore, 0) / s.articles.length);
    return {
      title: `${s.name}: situation continues to develop`,
      basedOn: s.name,
      probability: Math.max(10, Math.min(90, avgScore)),
      timeframe: '4-8 weeks',
      triggerSigns: [],
      ifItHappens: 'AI assessment unavailable — showing a static estimate based on current headline volume and severity only.',
      severity: avgScore > 75 ? 'HIGH' : 'MEDIUM',
      sources: articleSources(s.articles),
    };
  }).sort((a, b) => b.probability - a.probability);

  return { scenarios, fallback: true, updatedAt };
}

// ─── acled: static conflict event list (was acled.js) ───

const ACLED_COUNTRIES = [
  'Ukraine', 'Sudan', 'Myanmar', 'Gaza', 'Israel', 'Ethiopia',
  'Somalia', 'Yemen', 'Syria', 'Mali', 'Nigeria', 'DRC',
  'Haiti', 'Pakistan', 'Afghanistan', 'Lebanon', 'Libya'
];

function intensityScore(fatalities, eventType) {
  let score = 0;
  score += Math.min(fatalities * 2, 60);
  if (/battle|explosion|armed clash/i.test(eventType)) score += 30;
  if (/violence against civilians|attack/i.test(eventType)) score += 20;
  if (/protest|demonstration/i.test(eventType)) score += 5;
  return Math.min(100, score);
}

const STATIC_CONFLICTS = [
  { country: 'Ukraine', region: 'Kharkiv Oblast', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 45, lat: 49.9, lon: 36.2, date: '2026-06-14', notes: 'Russian forces launched ground offensive near Vovchansk' },
  { country: 'Ukraine', region: 'Zaporizhzhia', event: 'Explosion/Remote violence', sub_event: 'Shelling', fatalities: 12, lat: 47.8, lon: 35.2, date: '2026-06-14', notes: 'Artillery exchange along southern front line' },
  { country: 'Sudan', region: 'North Darfur', event: 'Violence against civilians', sub_event: 'Attack', fatalities: 89, lat: 13.6, lon: 25.3, date: '2026-06-13', notes: 'RSF forces attacked civilian settlement near El Fasher' },
  { country: 'Myanmar', region: 'Shan State', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 23, lat: 21.9, lon: 97.0, date: '2026-06-13', notes: 'Resistance forces attacked military convoy on Route 3' },
  { country: 'Gaza', region: 'Gaza City', event: 'Explosion/Remote violence', sub_event: 'Airstrike', fatalities: 67, lat: 31.5, lon: 34.5, date: '2026-06-14', notes: 'IDF airstrikes targeting Hamas infrastructure' },
  { country: 'Yemen', region: "Sa'dah", event: 'Armed clash', sub_event: 'Ground attack', fatalities: 8, lat: 16.9, lon: 43.7, date: '2026-06-12', notes: 'Houthi forces clashed with Saudi-backed coalition near border' },
  { country: 'Somalia', region: 'Middle Shabelle', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 15, lat: 2.9, lon: 45.3, date: '2026-06-13', notes: 'AMISOM forces engaged al-Shabaab near Jowhar' },
  { country: 'Mali', region: 'Mopti', event: 'Violence against civilians', sub_event: 'Attack', fatalities: 34, lat: 14.5, lon: -4.2, date: '2026-06-11', notes: 'Armed group attacked village, Wagner-linked forces present' },
  { country: 'Nigeria', region: 'Borno State', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 19, lat: 11.8, lon: 13.2, date: '2026-06-12', notes: 'Boko Haram/ISWAP attacked military base' },
  { country: 'Ethiopia', region: 'Amhara', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 28, lat: 11.7, lon: 39.5, date: '2026-06-10', notes: 'Federal forces vs Fano militia clashes continuing' },
  { country: 'DRC', region: 'North Kivu', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 41, lat: -1.5, lon: 29.2, date: '2026-06-13', notes: 'M23/Rwanda-backed forces advance toward Goma' },
  { country: 'Haiti', region: 'Port-au-Prince', event: 'Violence against civilians', sub_event: 'Attack', fatalities: 22, lat: 18.5, lon: -72.3, date: '2026-06-14', notes: 'Gang coalition Viv Ansanm controls 85% of capital' },
  { country: 'Pakistan', region: 'KPK', event: 'Explosion/Remote violence', sub_event: 'IED', fatalities: 11, lat: 34.0, lon: 71.6, date: '2026-06-12', notes: 'TTP IED attack on security forces patrol' },
  { country: 'Lebanon', region: 'South Lebanon', event: 'Explosion/Remote violence', sub_event: 'Shelling', fatalities: 6, lat: 33.3, lon: 35.4, date: '2026-06-14', notes: 'Cross-border fire exchange Hezbollah-IDF' },
  { country: 'Syria', region: 'Deir ez-Zor', event: 'Armed clash', sub_event: 'Ground attack', fatalities: 9, lat: 35.3, lon: 40.1, date: '2026-06-11', notes: 'ISIS cells ambushed SDF patrol in eastern Syria' },
];

function handleAcled(req, res) {
  const { country, limit = 20 } = req.query;

  let conflicts = STATIC_CONFLICTS;
  if (country) {
    conflicts = conflicts.filter(c => c.country.toLowerCase().includes(country.toLowerCase()));
  }

  const enriched = conflicts.slice(0, parseInt(limit)).map(c => ({
    ...c,
    severity: c.fatalities > 50 ? 'HIGH' : c.fatalities > 10 ? 'MEDIUM' : 'LOW',
    intensityScore: intensityScore(c.fatalities, c.event),
    type: /explosion|airstrike|shelling|IED/i.test(c.event + ' ' + c.sub_event) ? 'bombardment'
      : /armed clash|battle/i.test(c.event) ? 'combat'
      : /civilians/i.test(c.event) ? 'atrocity'
      : 'conflict',
    daysAgo: Math.floor((Date.now() - new Date(c.date)) / 86400000),
  }));

  const stats = {
    totalEvents: enriched.length,
    totalFatalities: enriched.reduce((s, c) => s + c.fatalities, 0),
    highSeverity: enriched.filter(c => c.severity === 'HIGH').length,
    countriesAffected: [...new Set(enriched.map(c => c.country))].length,
    avgIntensity: Math.round(enriched.reduce((s, c) => s + c.intensityScore, 0) / Math.max(enriched.length, 1)),
  };

  return res.status(200).json({ conflicts: enriched, stats });
}

// ─── predictions: AI-assessed probability questions per live situation ───
//
// "Situations" (Ukraine, Middle East, Taiwan, Sudan, ...) are derived from
// whatever the CURRENT live feed actually contains, not a fixed list —
// LOCATION_DB (already used above for warnings/correlations/brief) is only a
// location-name recognizer for grouping real headlines together; it doesn't
// decide which situations are "active" or what their probabilities are, and
// a situation with no live articles this cycle simply won't appear.

function groupArticlesBySituation(articles, maxSituations = 5) {
  const groups = new Map();
  for (const a of articles) {
    const loc = inferLocation(`${a.title} ${a.summary || ''}`);
    if (loc.name === 'Global') continue; // too vague to forecast on
    if (!groups.has(loc.name)) groups.set(loc.name, { name: loc.name, country: loc.country, articles: [] });
    groups.get(loc.name).articles.push(a);
  }
  return [...groups.values()]
    .sort((a, b) => b.articles.length - a.articles.length)
    .slice(0, maxSituations);
}

function articleSources(articles, limit = 3) {
  return articles.slice(0, limit).map((a) => ({ title: a.title, url: a.url, source: a.source }));
}

async function computePredictions(req) {
  const { articles } = req.body || {};
  const clean = cleanArticles(articles);
  const situations = groupArticlesBySituation(clean);
  const updatedAt = new Date().toISOString();

  if (!situations.length) return { predictions: [], fallback: true, updatedAt };

  if (isConfigured()) {
    try {
      const prompt = `For each SITUATION below, assess the probability of near-term escalation or resolution, grounded ONLY in the headlines given for that situation — never invent facts not implied by them.\n\nReturn ONLY a JSON array, one object per situation, in the SAME ORDER given:\n[{"question":"a specific forecasting question, e.g. 'Ceasefire in Ukraine within 90 days?'","probability":0-100,"trend":"rising|falling|stable","reasoning":"2-3 sentence justification","keyIndicators":["what would raise this probability","what would lower it"]}]\n\n` +
        situations.map((s, i) => `SITUATION ${i + 1}: ${s.name}\n${s.articles.slice(0, 6).map((a) => `- [${a.tag}] ${a.title}`).join('\n')}`).join('\n\n');

      const text = await askAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 1400 });
      const aiItems = JSON.parse(text.replace(/```json|```/g, '').trim());

      const predictions = situations.map((s, i) => {
        const ai = aiItems[i] || {};
        return {
          situation: s.name,
          question: ai.question || `Escalation in ${s.name} within 90 days?`,
          probability: Math.max(0, Math.min(100, Math.round(Number(ai.probability) || 50))),
          trend: ['rising', 'falling', 'stable'].includes(ai.trend) ? ai.trend : 'stable',
          reasoning: ai.reasoning || 'Insufficient data for detailed reasoning.',
          keyIndicators: Array.isArray(ai.keyIndicators) ? ai.keyIndicators.slice(0, 2) : [],
          sources: articleSources(s.articles),
        };
      });
      return { predictions, fallback: false, updatedAt };
    } catch (e) {
      // Fall through to the heuristic fallback below
    }
  }

  // No Groq / Groq failed — deterministic heuristic, clearly labeled
  // fallback:true so the frontend never presents a guess as an AI
  // assessment (see index.html's prediction card rendering).
  const predictions = situations.map((s) => {
    const avgScore = Math.round(s.articles.reduce((sum, a) => sum + a.threatScore, 0) / s.articles.length);
    return {
      situation: s.name,
      question: `Escalation in ${s.name} within 90 days?`,
      probability: Math.max(10, Math.min(90, avgScore)),
      trend: 'stable',
      reasoning: 'AI assessment unavailable — showing a static estimate based on current headline volume and severity only.',
      keyIndicators: [],
      sources: articleSources(s.articles),
    };
  });
  return { predictions, fallback: true, updatedAt };
}

// ─── simulate: conflict simulator + "what if" scenario cascade ───

async function fetchCountrySummary(baseUrl, code) {
  try {
    const r = await fetchWithTimeout(`${baseUrl}/api/country?code=${encodeURIComponent(code)}`, {}, 15000);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function countryProfileLine(c, code) {
  if (!c) return `${code}: (live profile data unavailable)`;
  return `${c.name || code} (${code}): population ${c.population ? c.population.toLocaleString() : 'unknown'}, ` +
    `income level ${c.incomeLevel || 'unknown'}, government type ${c.governmentType || 'unknown'}, ` +
    `leader ${c.leader || 'unknown'}, key allies ${c.keyAllies || 'unknown'}, primary rivals ${c.primaryRivals || 'unknown'}, ` +
    `political leaning ${c.politicalLeaning || 'unknown'}`;
}

async function computeSimulateConflict(req) {
  const { countryA, countryB } = req.body || {};
  const codeA = String(countryA || '').toUpperCase().trim();
  const codeB = String(countryB || '').toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(codeA) || !/^[A-Z]{2}$/.test(codeB) || codeA === codeB) {
    return { error: 'Provide two different 2-letter country codes' };
  }

  // Check before spending a self-fetch round-trip on country data that
  // would just go unused — same "don't do the expensive part if the AI
  // isn't even configured" pattern as api/search.js's synthesize().
  if (!isConfigured()) {
    return {
      countryA: codeA, countryB: codeB, overview: null, likelyTrigger: null,
      militaryComparison: null, likelyOutcome: null, escalationRisk: null,
      wildcards: [], regionalImpact: null, probabilityOfEachSidePrevailing: null,
      error: 'AI simulation requires GROQ_API_KEY', fallback: true,
    };
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;
  const [dataA, dataB] = await Promise.all([
    fetchCountrySummary(baseUrl, codeA),
    fetchCountrySummary(baseUrl, codeB),
  ]);
  const nameA = dataA?.name || codeA;
  const nameB = dataB?.name || codeB;

  const empty = {
    countryA: nameA, countryB: nameB, overview: null, likelyTrigger: null,
    militaryComparison: null, likelyOutcome: null, escalationRisk: null,
    wildcards: [], regionalImpact: null, probabilityOfEachSidePrevailing: null,
  };

  try {
    // Grounded in each country's real, live profile (population, income
    // level, government type, leader, allies, rivals — all from
    // api/country.js's own live World Bank/Wikidata/Groq-filled data);
    // Groq supplies the higher-level military/outcome narrative itself,
    // clearly labeled a simulation, never presented as verified capability.
    const prompt = `Simulate a structured, analytical conflict assessment between two countries for WAR-GAMING / ANALYSIS PURPOSES ONLY — this is NOT a prediction of real events. Ground it in their real profile data below; reason plausibly about military posture from their population/income/alliance profile.\n\n${countryProfileLine(dataA, codeA)}\n${countryProfileLine(dataB, codeB)}\n\nReturn ONLY JSON:\n{"overview":"2-3 sentence scenario overview","likelyTrigger":"the most plausible trigger event","militaryComparison":{"${codeA}":"1-2 sentences on strengths/weaknesses","${codeB}":"1-2 sentences on strengths/weaknesses"},"likelyOutcome":"2-3 sentence assessment","escalationRisk":"HIGH|MEDIUM|LOW","wildcards":["a factor that could change everything","another"],"regionalImpact":"2-3 sentences","probabilityOfEachSidePrevailing":{"${codeA}":0-100,"${codeB}":0-100}}`;

    const text = await askAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 900 });
    const ai = JSON.parse(text.replace(/```json|```/g, '').trim());

    return {
      countryA: nameA, countryB: nameB,
      overview: ai.overview || null,
      likelyTrigger: ai.likelyTrigger || null,
      militaryComparison: ai.militaryComparison || null,
      likelyOutcome: ai.likelyOutcome || null,
      escalationRisk: ai.escalationRisk || null,
      wildcards: Array.isArray(ai.wildcards) ? ai.wildcards.slice(0, 4) : [],
      regionalImpact: ai.regionalImpact || null,
      probabilityOfEachSidePrevailing: ai.probabilityOfEachSidePrevailing || null,
      fallback: false,
    };
  } catch (e) {
    return { ...empty, error: 'AI simulation temporarily unavailable', fallback: true };
  }
}

async function computeSimulateWhatIf(req) {
  const { scenario } = req.body || {};
  const clean = String(scenario || '').trim().slice(0, 300);
  const empty = { scenario: clean, immediateEffects: [], economicImpact: null, likelyResponses: [], escalationPaths: [], timeline: null };

  if (!clean) return { error: 'Provide a scenario, e.g. "Iran closes the Strait of Hormuz"' };
  if (!isConfigured()) return { ...empty, error: 'AI simulation requires GROQ_API_KEY', fallback: true };

  try {
    const prompt = `Assess the plausible cascade effects of this hypothetical geopolitical scenario, for ANALYSIS PURPOSES ONLY — this is NOT a prediction of real events: "${clean}"\n\nReturn ONLY JSON:\n{"immediateEffects":["effect 1","effect 2","effect 3"],"economicImpact":"2-3 sentences","likelyResponses":["response 1","response 2"],"escalationPaths":["path 1","path 2"],"timeline":"e.g. 'Hours: ... Days: ... Weeks: ... Months: ...'"}`;

    const text = await askAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 700 });
    const ai = JSON.parse(text.replace(/```json|```/g, '').trim());

    return {
      scenario: clean,
      immediateEffects: Array.isArray(ai.immediateEffects) ? ai.immediateEffects.slice(0, 5) : [],
      economicImpact: ai.economicImpact || null,
      likelyResponses: Array.isArray(ai.likelyResponses) ? ai.likelyResponses.slice(0, 5) : [],
      escalationPaths: Array.isArray(ai.escalationPaths) ? ai.escalationPaths.slice(0, 5) : [],
      timeline: ai.timeline || null,
      fallback: false,
    };
  } catch (e) {
    return { ...empty, error: 'AI simulation temporarily unavailable', fallback: true };
  }
}

// ─── global forecast: "next 30-90 days" outlook (was nothing before) ───

async function computeGlobalForecast(req) {
  const { articles } = req.body || {};
  const clean = cleanArticles(articles);
  const updatedAt = new Date().toISOString();

  if (!isConfigured() || !clean.length) return { outlook: null, items: [], fallback: true, updatedAt };

  try {
    const headlines = clean.slice(0, 20).map((a, i) => `[A${i + 1}] [${a.tag}] ${a.title}`).join('\n');
    const text = await askAI({
      messages: [{
        role: 'user',
        content: `Based on these live headlines, identify the TOP 3-5 situations most likely to escalate significantly in the next 30-90 days. Ground every item in the headlines given — cite which ones informed it.\n\nReturn ONLY JSON:\n{"outlook":"1-2 sentence overall global summary","items":[{"situation":"...","probability":0-100,"reasoning":"1-2 sentences","citedArticles":[1,2]}]}\n\n"citedArticles" are the plain [A#] numbers below that informed that item.\n\n${headlines}`,
      }],
      maxTokens: 900,
    });
    const ai = JSON.parse(text.replace(/```json|```/g, '').trim());

    const items = (Array.isArray(ai.items) ? ai.items : []).slice(0, 5).map((it) => ({
      situation: it.situation || 'Unspecified',
      probability: Math.max(0, Math.min(100, Math.round(Number(it.probability) || 50))),
      reasoning: it.reasoning || '',
      sources: (Array.isArray(it.citedArticles) ? it.citedArticles : [])
        .map((n) => clean[Number(n) - 1])
        .filter(Boolean)
        .slice(0, 3)
        .map((a) => ({ title: a.title, url: a.url, source: a.source })),
    }));

    return { outlook: ai.outlook || null, items, fallback: false, updatedAt };
  } catch (e) {
    return { outlook: null, items: [], fallback: true, updatedAt };
  }
}

// ─── router ───

// Redis-cached types, per PROGRESS.md's tiered-caching design (with a
// same-shape in-memory fallback if Redis is unavailable). Flat, shared cache
// keys rather than per-input ones — like the rest of this codebase's Redis
// layer, the point is fewer repeat Groq/live calls under real traffic, and
// these all regenerate from "whatever the current live feed looks like"
// rather than needing per-caller precision. `acled` (pure static data, no
// live/AI call — caching it saves nothing) and `correlations`/`warnings`/
// `actors` (confirmed unreachable from the frontend, see gotchas) are
// intentionally left uncached. `simulate` is handled separately below since
// its cache key varies per request (which two countries, or which
// "what if" text) rather than being one shared key.
const CACHE_CONFIG = {
  risk_matrix: { key: 'forecast:risk_matrix', ttl: 1800, fn: (req) => computeRiskMatrix(req) },
  scenarios: { key: 'scenarios:latest', ttl: 3600, fn: (req) => computeScenarios(req) },
  entities: { key: 'entities:latest', ttl: 1800, fn: (req) => computeEntities(req) },
  brief: { key: 'brief:daily', ttl: 3600, fn: (req) => computeAnalyzeType('brief', req) },
  predictions: { key: 'predictions:latest', ttl: 1800, fn: (req) => computePredictions(req) },
  forecast: { key: 'global:forecast', ttl: 3600, fn: (req) => computeGlobalForecast(req) },
};
const SIMULATE_TTL = 3600; // "cache identical requests 1hr" — same TTL as brief/global forecast
const memCache = new Map();

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.method === 'POST' ? (req.body || {}).type : req.query.type;
  if (!type) {
    return res.status(400).json({
      error: 'Provide a ?type= (risk_matrix, acled, scenarios, brief, correlations, warnings, actors, entities, predictions, simulate, forecast)',
    });
  }

  if (type === 'acled') return handleAcled(req, res);
  if (['correlations', 'warnings', 'actors'].includes(type)) {
    return res.status(200).json(await computeAnalyzeType(type, req));
  }

  if (type === 'simulate') {
    const body = req.body || {};
    const mode = body.mode === 'whatif' ? 'whatif' : 'conflict';
    const cacheKey = mode === 'conflict'
      ? `simulate:conflict:${[String(body.countryA || '').toUpperCase(), String(body.countryB || '').toUpperCase()].sort().join('-')}`
      : `simulate:whatif:${hashKey(String(body.scenario || '').trim().toLowerCase())}`;

    const fromRedis = await getCache(cacheKey);
    if (fromRedis) return res.status(200).json(fromRedis);

    const memHit = memCache.get(cacheKey);
    if (memHit && Date.now() - memHit.ts < SIMULATE_TTL * 1000) return res.status(200).json(memHit.data);

    const result = mode === 'conflict' ? await computeSimulateConflict(req) : await computeSimulateWhatIf(req);
    memCache.set(cacheKey, { ts: Date.now(), data: result });
    await setCache(cacheKey, result, SIMULATE_TTL);
    return res.status(200).json(result);
  }

  const cached = CACHE_CONFIG[type];
  if (cached) {
    const { key, ttl, fn } = cached;
    const fromRedis = await getCache(key);
    if (fromRedis) return res.status(200).json(fromRedis);

    const memHit = memCache.get(key);
    if (memHit && Date.now() - memHit.ts < ttl * 1000) return res.status(200).json(memHit.data);

    const result = await fn(req);
    memCache.set(key, { ts: Date.now(), data: result });
    await setCache(key, result, ttl);
    return res.status(200).json(result);
  }

  return res.status(400).json({ error: 'Unknown type' });
};
