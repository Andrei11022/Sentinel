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

// GDELT and Guardian both do broad full-text search (GDELT in particular
// will match a query term anywhere in an article's body, not just the
// headline) so their raw results routinely include stuff only tangentially
// related to what was searched. Everything below re-checks relevance
// ourselves against title/description before an article is ever returned.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is',
  'are', 'was', 'were', 'with', 'about', 'news', 'latest', 'today',
]);

function extractKeywords(query) {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

// How many of the query's significant keywords have to actually appear
// before an article counts as relevant.
//
// Requiring ALL keywords for 2-word queries (the previous rule) turned out
// too strict: "Pakistan election" was rejecting genuinely relevant Guardian
// results ("Pakistan roof collapse", "Pakistan PM signs agreement", ...)
// just because none of them also said "election" — confirmed live, this is
// what made the search feel like it returned nothing for real queries.
// A single keyword is enough for a 2-word query; the "no junk" guarantee
// still comes from requiring that keyword to genuinely appear in the
// title/description (not zero matches, which is what let completely
// unrelated articles like Chris Froome's retirement through in the
// original bug this whole filter exists to fix).
// Longer queries still require a majority (not every word) since real
// headlines paraphrase — "China warns Taiwan over defense pact" is clearly
// about "Taiwan China military" even without the literal word "military".
function keywordsRequired(count) {
  if (count <= 1) return count;
  if (count === 2) return 1;
  return Math.max(2, Math.ceil(count * 0.6));
}

// 0 = matched in the title, 1 = matched only once title+description are
// combined, -1 = not actually relevant. The relevance gate itself checks
// title+description together — a genuinely relevant article can split
// "Gaza" (title) and "Israel Defense Forces" (description) across the two
// fields, and requiring the full keyword set in ONE field alone rejected
// real matches like that during testing. Title-only matches still rank
// above description-assisted ones.
function relevanceRank(article, query, keywords) {
  const title = (article.title || '').toLowerCase();
  const desc = (article.summary || '').toLowerCase();
  const combined = `${title} ${desc}`;
  const q = query.toLowerCase();
  const need = keywordsRequired(keywords.length);

  const combinedMatches = keywords.filter(k => combined.includes(k)).length;
  if (!combined.includes(q) && combinedMatches < need) return -1;

  const titleMatches = keywords.filter(k => title.includes(k)).length;
  return (title.includes(q) || titleMatches >= need) ? 0 : 1;
}

function filterAndRankByRelevance(articles, query) {
  const keywords = extractKeywords(query);
  return articles
    .map(a => ({ article: a, rank: relevanceRank(a, query, keywords) }))
    .filter(x => x.rank !== -1)
    .sort((x, y) => x.rank - y.rank || new Date(y.article.publishedAt) - new Date(x.article.publishedAt))
    .map(x => x.article);
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
    // order-by=relevance (not newest) — Guardian's search matches loosely on
    // multi-word queries (full-text OR across the whole corpus), and
    // order-by=newest was discarding Guardian's own relevance ranking in
    // favor of "whatever's newest that matched anything," which is exactly
    // what produced unrelated results in testing. Relevance ranking plus our
    // own title/description keyword filter below is what actually fixes it.
    const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(query)}&order-by=relevance&page-size=15&show-fields=trailText&api-key=${GUARDIAN_KEY}`;
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
  const deduped = [...guardian, ...gdelt]
    .filter(a => a.title && a.url)
    .filter(a => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });

  const articles = filterAndRankByRelevance(deduped, q).slice(0, 15);

  const synthesis = await synthesize(q, articles);

  const result = { query: q, wikipedia, synthesis, articles };
  cache.set(cacheKey, { ts: Date.now(), data: result });
  return res.status(200).json(result);
};
