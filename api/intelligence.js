// Consolidated intelligence endpoint — merges four formerly-separate
// serverless functions (analyze.js, entities.js, forecast.js, acled.js) into
// one, routed by a flat `type` value, to stay under Vercel Hobby's
// 12-Serverless-Function cap. One physical function, several behaviors:
//
//   GET  ?type=risk_matrix                    -> country risk matrix (was forecast.js)
//   GET  ?type=acled[&country=&limit=]        -> conflict event list (was acled.js)
//   POST {type:'scenarios', articles}         -> AI conflict scenarios + static fallback (was forecast.js)
//   POST {type:'brief', articles}             -> AI intel brief + local fallback (was analyze.js)
//   POST {type:'correlations'|'warnings'|'actors', articles} -> same, other analyze.js behaviors
//   POST {type:'entities', articles, text}    -> entity + relationship extraction (was entities.js)
//
// Note: analyze.js used to have its own internal `type:'entities'` behavior
// (a simpler ACTOR_DB-based extractor with no relationships) that was never
// actually called from the frontend — superseded here by entities.js's real,
// used implementation under the same `type:'entities'` name. No live feature
// was dropped; that branch was dead code even before this merge.
const { askAI, isConfigured } = require('../lib/ai');

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
    }));
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

async function handleAnalyzeType(type, req, res) {
  const { articles } = req.body || {};
  const clean = cleanArticles(articles);
  const forType = type === 'brief'
    ? clean.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    : clean;

  try {
    const aiResult = await runGroqAnalyze(type, forType);
    if (aiResult) return res.status(200).json({ result: aiResult, fallback: false });

    if (type === 'brief') return res.status(200).json({ result: buildBrief(forType), fallback: true });
    if (type === 'correlations') return res.status(200).json({ result: buildCorrelations(clean), fallback: true });
    if (type === 'warnings') return res.status(200).json({ result: buildWarnings(clean), fallback: true });
    if (type === 'actors') return res.status(200).json({ result: extractActors(clean), fallback: true });
    return res.status(400).json({ error: 'Unknown type' });
  } catch (e) {
    if (type === 'brief') return res.status(200).json({ result: buildBrief(forType), fallback: true, error: e.message });
    if (type === 'correlations') return res.status(200).json({ result: buildCorrelations(clean), fallback: true, error: e.message });
    if (type === 'warnings') return res.status(200).json({ result: buildWarnings(clean), fallback: true, error: e.message });
    if (type === 'actors') return res.status(200).json({ result: extractActors(clean), fallback: true, error: e.message });
    return res.status(400).json({ error: 'Unknown type' });
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

async function handleEntities(req, res) {
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

    return res.status(200).json({
      entities,
      summary: {
        totalEntities: (entities.people?.length || 0) + (entities.organizations?.length || entities.orgs?.length || 0) + (entities.locations?.length || 0),
        highThreatActors: highThreatActors.map(a => a.name),
        conflictZones: (entities.locations || []).filter(l => l.conflictZone || l.conflict).map(l => l.name),
      }
    });
  } catch (e) {
    return res.status(200).json({ entities: extractEntitiesLocal(text || ''), error: e.message });
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

function handleRiskMatrix(req, res) {
  const { articles } = req.query;
  const recentText = (articles || []).map(a => a.title || a.webTitle || '').join(' ');
  const matrix = Object.entries(COUNTRY_RISK_BASE)
    .map(([code]) => calculateEscalationProbability(code, recentText))
    .filter(Boolean)
    .sort((a, b) => b.escalationProbability - a.escalationProbability);

  return res.status(200).json({ matrix, updatedAt: new Date().toISOString() });
}

async function handleScenarios(req, res) {
  const { articles } = req.body || {};

  if (isConfigured()) {
    try {
      const headlines = (articles || []).slice(0, 8).map(a => a.title || a.webTitle).join('\n');
      const text = await askAI({
        messages: [{
          role: 'user',
          content: `Based on these headlines, generate 3 geopolitical scenarios for the next 30-90 days. For each: probability, timeline, trigger event, cascade effects.\n\nReturn ONLY JSON:\n[{"title":"...","probability":"X%","timeline":"30|60|90 days","trigger":"...","cascade":["effect1","effect2","effect3"],"severity":"HIGH|MEDIUM|LOW"}]\n\nHeadlines:\n${headlines}`
        }],
        maxTokens: 800,
      });
      const scenarios = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json({ scenarios, fallback: false });
    } catch (e) {
      // Fall through to static scenarios
    }
  }

  const staticScenarios = [
    { title: 'Iran nuclear threshold crossed', probability: '34%', timeline: '90 days', trigger: 'Iran enriches to 90% weapons-grade', cascade: ['Israeli strike on Fordow', 'Iranian retaliation via proxies', 'US carrier group engagement', 'Oil price spike >$150/bbl', 'Global recession risk'], severity: 'HIGH' },
    { title: 'Ukraine front collapse (eastern)', probability: '28%', timeline: '60 days', trigger: 'Russian breakthrough at Pokrovsk or Kramatorsk', cascade: ['Zelensky requests NATO Article 5 consultation', 'Western escalation debate', 'Nuclear rhetoric intensifies', 'European refugee crisis 2.0'], severity: 'HIGH' },
    { title: 'Taiwan Strait military incident', probability: '18%', timeline: '90 days', trigger: 'PLA vessel fires on Taiwan coast guard', cascade: ['US carrier strike group deployment', 'Japan activates self-defense', 'TSMC production halt risk', 'Global semiconductor shock'], severity: 'HIGH' },
    { title: 'Gulf oil infrastructure attack', probability: '22%', timeline: '30 days', trigger: 'Houthi/Iran strikes Saudi Abqaiq facility', cascade: ['Oil price spike to $200', 'Global inflation surge', 'US military response', 'Saudi retaliation on Yemen'], severity: 'MEDIUM' },
    { title: 'Pakistan nuclear security event', probability: '8%', timeline: '90 days', trigger: 'TTP seizes military base with nuclear components', cascade: ['US/India emergency response', 'China mediation', 'Global security alert', 'NATO Article 5 consultations'], severity: 'HIGH' },
  ];

  return res.status(200).json({ scenarios: staticScenarios, fallback: true });
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

// ─── router ───

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.method === 'POST' ? (req.body || {}).type : req.query.type;
  if (!type) return res.status(400).json({ error: 'Provide a ?type= (risk_matrix, acled, scenarios, brief, correlations, warnings, actors, entities)' });

  if (type === 'risk_matrix') return handleRiskMatrix(req, res);
  if (type === 'acled') return handleAcled(req, res);
  if (type === 'scenarios') return handleScenarios(req, res);
  if (type === 'entities') return handleEntities(req, res);
  if (['brief', 'correlations', 'warnings', 'actors'].includes(type)) return handleAnalyzeType(type, req, res);

  return res.status(400).json({ error: 'Unknown type' });
};
