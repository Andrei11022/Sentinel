// Shared Groq client for every AI-backed endpoint in this codebase.
// Groq is OpenAI-compatible (chat/completions with a messages array, system
// as a role:"system" message rather than Anthropic's top-level `system`
// param) — this wraps that shape so callers just pass {system, messages}.

const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

function isConfigured() {
  return !!GROQ_KEY;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroq(model, system, messages, maxTokens, timeoutMs) {
  const r = await fetchWithTimeout(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + GROQ_KEY,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    }),
  }, timeoutMs);

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    console.error('Groq API error', model, r.status, errBody);
    throw new Error(`Groq API ${r.status} (${model}): ${errBody.slice(0, 300)}`);
  }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`Empty response from Groq API (${model})`);
  return text;
}

// One retry against the smaller/faster fallback model if the primary model
// call fails for any reason (down, decommissioned, rate-limited) — callers
// still get to catch a final failure and use their own non-AI fallback.
async function askAI({ system, messages, maxTokens = 1000, timeoutMs = 25000 }) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured');
  try {
    return await callGroq(PRIMARY_MODEL, system, messages, maxTokens, timeoutMs);
  } catch (e) {
    console.error('Groq primary model failed, retrying with fallback model', e.message);
    return await callGroq(FALLBACK_MODEL, system, messages, maxTokens, timeoutMs);
  }
}

module.exports = { askAI, isConfigured };
