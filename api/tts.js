// Text-to-speech for Brief Me — real human-quality voice via ElevenLabs,
// replacing the browser's built-in speechSynthesis (robotic). No key set,
// or an ElevenLabs call failure, returns a JSON error instead of audio;
// the frontend falls back to browser speechSynthesis when that happens
// (see speakBrief() in index.html) rather than going silent.

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';

// "Adam" — a deep, steady male voice well suited to an intelligence
// briefing tone. Premade ElevenLabs voice, stable public ID.
const VOICE_ID = 'pNInz6obpgDQGcFmaJgB';

// Brief Me text is always a handful of sentences (~500-900 chars in
// practice) — this is a generous safety ceiling, not a real constraint.
const MAX_CHARS = 2500;

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text } = req.body || {};
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return res.status(400).json({ error: 'Provide text to speak' });

  if (!ELEVENLABS_KEY) {
    return res.status(200).json({ configured: false, error: 'ELEVENLABS_API_KEY not set' });
  }

  try {
    const r = await fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': ELEVENLABS_KEY,
      },
      body: JSON.stringify({
        text: clean.slice(0, MAX_CHARS),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.62, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      }),
    });

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return res.status(200).json({ configured: true, error: `ElevenLabs ${r.status}: ${errBody.slice(0, 200)}` });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (e) {
    return res.status(200).json({ configured: true, error: e.message });
  }
};
