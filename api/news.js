const { getCache, setCache } = require('../lib/cache');

const GUARDIAN_KEY = process.env.GUARDIAN_KEY || '473fcab8-81fa-4e79-a17e-429debaa4bc1';

// Main news feed / briefing feed — Redis-cached 5min (with a same-shape
// in-memory fallback per PROGRESS.md's tiered-caching design), so repeat
// polling of the same feed type doesn't re-hit Guardian/GDELT/RSS every
// time. Cache is an optimization only — see lib/cache.js for the
// no-Upstash/Redis-throws fallback behavior.
const NEWS_CACHE_TTL = 300;
const memCache = new Map();

const QUERIES = [
  { q: 'war+OR+conflict+OR+military+OR+troops+OR+invasion+OR+offensive', sec: 'world|politics', label: 'Conflict' },
  { q: 'sanctions+OR+nuclear+OR+geopolitics+OR+diplomacy+OR+summit+OR+treaty', sec: 'world|politics', label: 'Geopolitics' },
  { q: 'israel+OR+gaza+OR+iran+OR+ukraine+OR+russia+OR+china+OR+taiwan', sec: 'world', label: 'Hotspots' },
  { q: 'cyber+attack+OR+missile+OR+coup+OR+terrorism+OR+insurgency', sec: 'world|politics', label: 'Security' },
];

const RSS_SOURCES = [
  { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', credibility: 90, section: 'BBC' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', credibility: 78, section: 'AlJazeera' },
  { name: 'NPR', url: 'https://feeds.npr.org/1004/rss.xml', credibility: 86, section: 'NPR' },
  { name: 'France24', url: 'https://www.france24.com/en/rss', credibility: 82, section: 'France24' },
];

function scoreArticle(title, section) {
  const t = `${title || ''} ${section || ''}`.toLowerCase();
  let score = 50;
  if (/killed|dead|casualties|attack|war|invasion|strike|airstrike/.test(t)) score += 30;
  if (/nuclear|missile|icbm|warhead|uranium|enrichment/.test(t)) score += 25;
  if (/coup|collapse|crisis|emergency|genocide|famine/.test(t)) score += 20;
  if (/sanction|diplomat|summit|treaty/.test(t)) score += 10;
  if (/analysis|opinion|review|explainer|podcast/.test(t)) score -= 20;
  return Math.min(100, Math.max(0, score));
}

function tagArticle(title) {
  const t = (title || '').toLowerCase();
  if (/nuclear|icbm|warhead|enrichment|reactor/.test(t)) return 'NUCLEAR';
  if (/war|attack|killed|bomb|strike|invasion|offensive|troops|casualties/.test(t)) return 'CONFLICT';
  if (/nato|military|missile|navy|army|air force|airforce|weapon|defense|fighter/.test(t)) return 'MILITARY';
  if (/cyber|hack|ransomware|breach|malware/.test(t)) return 'CYBER';
  if (/earthquake|flood|volcano|hurricane|tsunami|wildfire/.test(t)) return 'DISASTER';
  if (/sanction|diplomat|summit|treaty|election|president|minister/.test(t)) return 'GEOPOLITICS';
  return 'INTEL';
}

function credibilityScore(source) {
  const scores = {
    'theguardian.com': 88,
    'reuters.com': 95,
    'bbc.com': 90,
    'bbc.co.uk': 90,
    'ap.org': 94,
    'npr.org': 86,
    'aljazeera.com': 78,
    'france24.com': 82,
    'dw.com': 85,
  };
  for (const [domain, score] of Object.entries(scores)) {
    if (source && source.includes(domain)) return score;
  }
  return 70;
}

function decodeXml(value) {
  return (value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssItems(xml) {
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return itemBlocks.map((block) => {
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const pubDateRaw = decodeXml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    const description = decodeXml((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '');
    const pubDate = new Date(pubDateRaw);
    return {
      title,
      link,
      description,
      publishedAt: Number.isNaN(pubDate.getTime()) ? new Date().toISOString() : pubDate.toISOString(),
    };
  }).filter((item) => item.title && item.link);
}

async function fetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'sentinel-intel-feed/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function isMideastHeadline(title) {
  return /israel|gaza|iran|hezbollah|hamas|yemen|houthi|lebanon|syria|iraq|west bank|middle east/i.test(title || '');
}

async function fetchNews(type) {
  const seen = new Set();
  const articles = [];

  const addArticle = (item) => {
    if (!item || !item.url || !item.title) return;
    if (type === 'mideast' && !isMideastHeadline(item.title)) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    articles.push(item);
  };

  const queriesToRun = type === 'mideast'
    ? [{ q: 'israel+OR+gaza+OR+iran+OR+hezbollah+OR+hamas+OR+yemen+OR+houthis+OR+%22middle+east%22+OR+lebanon+OR+syria+OR+iraq', sec: 'world', label: 'ME' }]
    : QUERIES;

  await Promise.allSettled(
    queriesToRun.map(async (qry) => {
      const url = `https://content.guardianapis.com/search?q=${qry.q}&section=${qry.sec}&order-by=newest&page-size=12&show-fields=trailText,thumbnail&api-key=${GUARDIAN_KEY}`;
      const data = await fetchJson(url);
      (data.response?.results || []).forEach((a) => {
        addArticle({
          id: `guardian:${a.id}`,
          title: a.webTitle,
          url: a.webUrl,
          source: 'The Guardian',
          sourceCredibility: 88,
          publishedAt: a.webPublicationDate || new Date().toISOString(),
          tag: tagArticle(a.webTitle),
          threatScore: scoreArticle(a.webTitle, a.sectionName),
          summary: a.fields?.trailText || '',
          section: qry.label,
        });
      });
    })
  );

  if (type === 'world') {
    try {
      const gdeltUrl = 'https://api.gdeltproject.org/api/v2/doc/doc?query=war+conflict+military+sanctions+OR+nuclear&mode=artlist&maxrecords=15&format=json&timespan=24h&sourcelang=english';
      const gd = await fetchJson(gdeltUrl);
      (gd.articles || []).forEach((a) => {
        const publishedAt = a.seendate
          ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')
          : new Date().toISOString();
        addArticle({
          id: `gdelt:${a.url}`,
          title: a.title,
          url: a.url,
          source: a.domain || 'GDELT',
          sourceCredibility: credibilityScore(a.domain),
          publishedAt,
          tag: tagArticle(a.title),
          threatScore: scoreArticle(a.title, ''),
          summary: '',
          section: 'GDELT',
        });
      });
    } catch (e) {
      // GDELT is optional, continue with other providers.
    }
  }

  await Promise.allSettled(
    RSS_SOURCES.map(async (src) => {
      const xml = await fetchText(src.url);
      const items = parseRssItems(xml).slice(0, 12);
      items.forEach((item) => {
        addArticle({
          id: `${src.name.toLowerCase().replace(/\s+/g, '-')}:${item.link}`,
          title: item.title,
          url: item.link,
          source: src.name,
          sourceCredibility: src.credibility,
          publishedAt: item.publishedAt,
          tag: tagArticle(item.title),
          threatScore: scoreArticle(item.title, src.section),
          summary: item.description,
          section: src.section,
        });
      });
    })
  );

  // Pure newest-first. This used to sort by threatScore first (date only
  // broke close ties), which silently overrode publish order — the
  // Briefing feed's top item could be a high-score article from a day ago
  // while genuinely fresh headlines sat further down. A live feed's own
  // top-to-bottom order should mean newest-to-oldest; severity is already
  // visible per-article (color-coded threat score) without needing the
  // whole list re-ordered around it. (Consumers that specifically want the
  // worst-severity item, like /api/threats.js's per-country selection, do
  // their own severity sort locally instead of relying on this order.)
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const maxArticles = type === 'mideast' ? 18 : 30;
  const sliced = articles.slice(0, maxArticles);

  return {
    articles: sliced,
    meta: {
      total: sliced.length,
      sources: [...new Set(sliced.map((a) => a.source))],
      fetchedAt: new Date().toISOString(),
      avgThreatScore: Math.round(sliced.reduce((s, a) => s + a.threatScore, 0) / Math.max(sliced.length, 1)),
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const type = req.query.type || 'world';
  const cacheKey = `news:${type}`;

  const fromRedis = await getCache(cacheKey);
  if (fromRedis) return res.status(200).json(fromRedis);

  const memHit = memCache.get(cacheKey);
  if (memHit && Date.now() - memHit.ts < NEWS_CACHE_TTL * 1000) {
    return res.status(200).json(memHit.data);
  }

  const result = await fetchNews(type);
  memCache.set(cacheKey, { ts: Date.now(), data: result });
  await setCache(cacheKey, result, NEWS_CACHE_TTL);
  return res.status(200).json(result);
};
