const { askAI, isConfigured } = require('./lib/ai');

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

function extractEntities(articles) {
  const people = [];
  const orgs = [];
  const locations = [];

  const seen = { people: new Set(), orgs: new Set(), locations: new Set() };

  ACTOR_DB.forEach((actor) => {
    const mentions = articles.some((a) => actor.key.test(a.title));
    if (!mentions) return;
    if (actor.type === 'state' || actor.type === 'org' || actor.type === 'proxy') {
      if (!seen.orgs.has(actor.label)) {
        seen.orgs.add(actor.label);
        orgs.push({ name: actor.label, type: actor.type });
      }
    }
  });

  articles.forEach((a) => {
    const loc = inferLocation(`${a.title} ${a.summary}`);
    if (!seen.locations.has(loc.name)) {
      seen.locations.add(loc.name);
      locations.push({ name: loc.name, type: 'country', lat: loc.lat, lon: loc.lon, conflict: a.tag === 'CONFLICT' || a.tag === 'MILITARY' });
    }

    const personMatches = a.title.match(/\b[A-Z][a-z]+\s[A-Z][a-z]+\b/g) || [];
    personMatches.slice(0, 2).forEach((name) => {
      if (seen.people.has(name)) return;
      seen.people.add(name);
      people.push({ name, role: 'Referenced in headline', country: loc.name });
    });
  });

  return { people: people.slice(0, 16), orgs: orgs.slice(0, 18), locations: locations.slice(0, 18) };
}

async function runGroq(type, articles) {
  if (!isConfigured()) return null;

  const prompts = {
    brief: `Write a concise 5-sentence intelligence brief covering what is happening RIGHT NOW. These headlines are sorted newest first and are all from the last few hours — focus on the newest ones and do not treat older items in this list as more important just because they read as more severe.\n${articles.map((a) => `- [${a.tag}] (${timeAgoLabel(a.publishedAt)}) ${a.title}`).join('\n')}`,
    correlations: `Return ONLY JSON array with 4 correlation objects (title, score, desc, actors[]) from:\n${articles.map((a) => `[${a.tag}] ${a.title}`).join('\n')}`,
    warnings: `Return ONLY JSON array of warning events (title,severity,lat,lon,type,desc,ts,country) from:\n${articles.map((a) => `[${a.tag}] ${a.title}`).join('\n')}`,
    actors: `Return ONLY JSON object {actors:[...],links:[...]} from:\n${articles.map((a) => a.title).join('\n')}`,
    entities: `Return ONLY JSON object {people:[...],orgs:[...],locations:[...]} from:\n${articles.map((a) => a.title).join('\n')}`,
  };

  const prompt = prompts[type];
  if (!prompt) return null;

  try {
    const text = await askAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 900 });
    if (!text.trim()) return null;

    if (['correlations', 'warnings', 'actors', 'entities'].includes(type)) {
      const clean = text.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }
    return text.trim();
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, articles } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Unknown type' });

  const clean = cleanArticles(articles);
  // Defensive: brief must be newest-first regardless of what order the
  // caller sent articles in (the main feed itself sorts by severity).
  const forType = type === 'brief'
    ? clean.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    : clean;

  try {
    const aiResult = await runGroq(type, forType);
    if (aiResult) return res.status(200).json({ result: aiResult, fallback: false });

    if (type === 'brief') return res.status(200).json({ result: buildBrief(forType), fallback: true });
    if (type === 'correlations') return res.status(200).json({ result: buildCorrelations(clean), fallback: true });
    if (type === 'warnings') return res.status(200).json({ result: buildWarnings(clean), fallback: true });
    if (type === 'actors') return res.status(200).json({ result: extractActors(clean), fallback: true });
    if (type === 'entities') return res.status(200).json({ result: extractEntities(clean), fallback: true });

    return res.status(400).json({ error: 'Unknown type' });
  } catch (e) {
    // In error conditions, still provide deterministic local output from live headlines.
    if (type === 'brief') return res.status(200).json({ result: buildBrief(forType), fallback: true, error: e.message });
    if (type === 'correlations') return res.status(200).json({ result: buildCorrelations(clean), fallback: true, error: e.message });
    if (type === 'warnings') return res.status(200).json({ result: buildWarnings(clean), fallback: true, error: e.message });
    if (type === 'actors') return res.status(200).json({ result: extractActors(clean), fallback: true, error: e.message });
    if (type === 'entities') return res.status(200).json({ result: extractEntities(clean), fallback: true, error: e.message });
    return res.status(400).json({ error: 'Unknown type' });
  }
};
