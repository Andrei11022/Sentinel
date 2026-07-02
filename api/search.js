// Live OSINT search: any person, country, event, or topic.
// Combines three free, no-extra-key sources server-side:
//   - GDELT doc search      -> latest global news coverage (any language source, English filter)
//   - Guardian search       -> curated, higher-quality news coverage (same key news.js uses)
//   - Wikipedia summary     -> "what/who is this" context card, resolved via
//     opensearch first so lowercase/imprecise queries ("gaza", "ukraine war")
//     still land on the right article
// If ANTHROPIC_API_KEY is set, adds a 2-sentence AI synthesis of the combined
// headlines. All three sources run in parallel and are individually
// best-effort — GDELT rate-limits aggressively (~1 req/5s) and both it and
// Guardian occasionally have connectivity hiccups, so a failure in one never
// blocks the other two.

const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const GUARDIAN_KEY = process.env.GUARDIAN_KEY || '473fcab8-81fa-4e79-a17e-429debaa4bc1';

const CACHE_TTL_MS = 3 * 60 * 1000; // short TTL — news search results move fast
const cache = new Map();

async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGdelt(query) {
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=15&format=json&timespan=7d&sourcelang=english`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) return [];
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return []; } // rate-limit responses are plain text, not JSON
    return (data.articles || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.domain || 'GDELT',
      publishedAt: a.seendate
        ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')
        : new Date().toISOString(),
    }));
  } catch (e) {
    return [];
  }
}

async function fetchGuardian(query) {
  try {
    const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(query)}&order-by=newest&page-size=15&show-fields=trailText&api-key=${GUARDIAN_KEY}`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.response?.results || []).map(a => ({
      title: a.webTitle,
      url: a.webUrl,
      source: 'The Guardian',
      publishedAt: a.webPublicationDate || new Date().toISOString(),
      summary: a.fields?.trailText || '',
    }));
  } catch (e) {
    return [];
  }
}

async function fetchWikipedia(query) {
  try {
    // Resolve to the canonical title first so lowercase/imprecise input still
    // lands on the right page, then fetch its summary.
    const osR = await fetchWithTimeout(
      'https://en.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(query) + '&limit=1&format=json'
    );
    if (!osR.ok) return null;
    const os = await osR.json();
    const title = os?.[1]?.[0];
    if (!title) return null;

    const sumR = await fetchWithTimeout('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
    if (!sumR.ok) return null;
    const sum = await sumR.json();
    if (sum.type === 'disambiguation') return null;

    return {
      title: sum.title || title,
      extract: sum.extract || null,
      thumbnail: sum.thumbnail?.source || null,
      url: sum.content_urls?.desktop?.page || null,
    };
  } catch (e) {
    return null;
  }
}

async function synthesize(query, articles) {
  if (!CLAUDE_KEY || !articles.length) return null;
  try {
    const headlines = articles.slice(0, 10).map(a => `- ${a.title}`).join('\n');
    const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `In exactly 2 sentences, summarize what's currently happening with "${query}" based on these live headlines. Be concrete and specific, no preamble.\n\n${headlines}`,
        }],
      }),
    }, 12000);
    if (!r.ok) return null;
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = String(req.query.q || req.query.query || '').trim();
  if (!q) return res.status(400).json({ error: 'Provide a search query, e.g. ?q=Ukraine' });
  if (q.length > 200) return res.status(400).json({ error: 'Query too long' });

  const cacheKey = q.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.status(200).json(cached.data);
  }

  const [gdelt, guardian, wikipedia] = await Promise.all([
    fetchGdelt(q),
    fetchGuardian(q),
    fetchWikipedia(q),
  ]);

  const seen = new Set();
  const articles = [...guardian, ...gdelt]
    .filter(a => a.title && a.url)
    .filter(a => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 15);

  const synthesis = await synthesize(q, articles);

  const result = { query: q, wikipedia, synthesis, articles };
  cache.set(cacheKey, { ts: Date.now(), data: result });
  return res.status(200).json(result);
};
