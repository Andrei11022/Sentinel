// AI Analyst chat: answers questions grounded ONLY in this app's own live
// data (/api/news + /api/threats), never free-floating model knowledge.
//
// Flow: pull live articles + threats -> filter both down to what's actually
// relevant to the question (falling back to the highest-signal items for
// broad questions like "summarize last 24h" that don't name a specific
// topic) -> hand that filtered set to Claude as the ONLY source of truth,
// with instructions to cite it by [A#] label -> parse those citations back
// out of the response so the frontend can render real, clickable source
// links instead of the model just asserting sources exist.

const { askAI, isConfigured } = require('../lib/ai');

const SYSTEM_PROMPT = 'You are SENTINEL, an AI intelligence analyst. Answer using ONLY the ' +
  'provided live intelligence data. Cite sources. If data is insufficient, ' +
  'say so — never invent intelligence. Be direct and analytical.';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'what', 'whats', 'whos', 'when', 'where', 'why', 'how', 'about', 'happening',
  'tell', 'me', 'give', 'summary', 'summarize', 'current', 'latest', 'recent',
  'update', 'please', 'can', 'you', 'biggest', 'risk', 'risks', 'today', 'now',
  'last', 'hours', 'hour', 'days', 'day', 'and', 'or', 'for', 'with', 'that',
  'this', 'of', 'in', 'on', 'to', 'do', 'does', 'any', 'there', 'going',
]);

function extractKeywords(question) {
  return (question || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// Broad questions ("summarize last 24h") won't match any specific keyword —
// fall back to the highest-signal items rather than returning nothing.
function relevanceFilter(items, keywords, textFn, limit) {
  if (keywords.length) {
    const matched = items.filter(it => {
      const text = textFn(it).toLowerCase();
      return keywords.some(k => text.includes(k));
    });
    if (matched.length >= 3) return matched.slice(0, limit);
  }
  return items.slice(0, limit);
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

async function fetchLiveContext(baseUrl) {
  const [newsRes, threatsRes] = await Promise.allSettled([
    fetchWithTimeout(`${baseUrl}/api/news?type=world`).then(r => r.json()),
    fetchWithTimeout(`${baseUrl}/api/threats`).then(r => r.json()),
  ]);
  const articles = newsRes.status === 'fulfilled' ? (newsRes.value.articles || []) : [];
  const threats = threatsRes.status === 'fulfilled' ? (threatsRes.value.threats || []) : [];
  return { articles, threats };
}

function buildPrompt(question, articles, threats) {
  const articleLines = articles.map((a, i) =>
    `[A${i + 1}] (${a.source}, ${a.publishedAt}) ${a.title}${a.summary ? ': ' + a.summary.slice(0, 220) : ''}`
  ).join('\n') || 'None matched this query.';

  const threatLines = threats.map((t, i) =>
    `[T${i + 1}] ${t.severity} severity — ${t.title} (${t.country}, risk score ${t.riskScore}/100): ${(t.desc || '').slice(0, 220)}`
  ).join('\n') || 'None matched this query.';

  return `LIVE INTELLIGENCE DATA (use ONLY this data to answer — it is the current, real feed, not historical knowledge):

ARTICLES:
${articleLines}

ACTIVE THREATS:
${threatLines}

QUESTION: ${question}

Cite specific articles by their [A#] label whenever you draw on one. If the data above doesn't contain enough to answer, say so explicitly rather than guessing.`;
}

function extractCitedSources(answerText, articles) {
  const cited = new Set();
  const re = /\[A(\d+)\]/g;
  let m;
  while ((m = re.exec(answerText))) {
    const idx = Number(m[1]) - 1;
    if (articles[idx]) cited.add(idx);
  }
  return [...cited].map(i => ({
    title: articles[i].title,
    url: articles[i].url,
    source: articles[i].source,
  }));
}

// Groq (OpenAI-compatible chat/completions) also expects clean user/
// assistant alternation with no empty-content turns — the frontend only
// ever appends a complete user+assistant pair after a successful reply, so
// `history` should already alternate correctly and end on 'assistant', but
// this sanitizes properly rather than trusting that: drop empty/whitespace-
// only content, collapse any accidental same-role-twice run, and make sure
// history doesn't itself end on 'user' (the caller is about to append a
// fresh user turn).
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const cleaned = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-8) // last 4 pairs
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, 4000) }));

  const alternated = [];
  for (const m of cleaned) {
    if (alternated.length && alternated[alternated.length - 1].role === m.role) continue;
    alternated.push(m);
  }
  if (alternated.length && alternated[alternated.length - 1].role === 'user') {
    alternated.pop();
  }
  return alternated;
}

async function askAnalyst(question, history, articles, threats) {
  const messages = [
    ...sanitizeHistory(history),
    { role: 'user', content: buildPrompt(question, articles, threats) },
  ];
  return askAI({ system: SYSTEM_PROMPT, messages, maxTokens: 1000, timeoutMs: 25000 });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question, history } = req.body || {};
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) return res.status(400).json({ error: 'Provide a question' });

  if (!isConfigured()) {
    return res.status(200).json({
      answer: 'AI analysis requires configuration — set GROQ_API_KEY in your Vercel project environment variables to enable the SENTINEL analyst.',
      sources: [],
      configured: false,
    });
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  try {
    const { articles, threats } = await fetchLiveContext(baseUrl);
    const keywords = extractKeywords(q);

    const filteredArticles = relevanceFilter(
      articles, keywords, a => `${a.title} ${a.summary || ''}`, 12
    );
    const filteredThreats = relevanceFilter(
      threats, keywords, t => `${t.title} ${t.desc || ''} ${t.country || ''}`, 10
    );

    const answer = await askAnalyst(q, history, filteredArticles, filteredThreats);
    const sources = extractCitedSources(answer, filteredArticles);

    return res.status(200).json({ answer, sources, configured: true });
  } catch (e) {
    return res.status(200).json({
      answer: `Analyst error: ${e.message}. Live intelligence feed or the AI model may be temporarily unavailable — try again shortly.`,
      sources: [],
      configured: true,
      error: e.message,
    });
  }
};
