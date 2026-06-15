const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, articles, context } = req.body || {};

  if (!CLAUDE_KEY) {
    return res.status(200).json({ result: generateFallback(type, articles), fallback: true });
  }

  const prompts = {
    brief: `You are a senior CIA intelligence analyst. Based on these ${articles?.length || 0} live headlines, write a concise 5-sentence intelligence brief in President's Daily Brief style. Cover: key threats, actors, regional hotspots, risk assessment. Be direct and specific.\n\nHeadlines:\n${(articles || []).map((a,i) => `${i+1}. [${a.tag}] ${a.title}`).join('\n')}\n\nWrite ONLY the brief. No headers.`,

    correlations: `You are an intelligence analyst. Analyze these news headlines and identify 4 significant geopolitical correlations or patterns. Consider timing, shared actors, proxy relationships, strategic interests.\n\nReturn ONLY a JSON array:\n[{"title":"...","score":"CORRELATION: X%","desc":"2-sentence specific analysis","actors":["USA","Russia"]}]\n\nHeadlines:\n${(articles || []).map(a => `[${a.tag}] ${a.title}`).join('\n')}`,

    warnings: `Based on these headlines, generate 6-8 precise intelligence warning events with real coordinates.\n\nReturn ONLY JSON:\n[{"title":"...","severity":"HIGH|MEDIUM|LOW","lat":0.0,"lon":0.0,"type":"conflict|cyber|military|nuclear|disaster","desc":"one sentence from the news","ts":"X min ago","country":"..."}]\n\nHeadlines:\n${(articles || []).map(a => `[${a.tag}] ${a.title}`).join('\n')}`,

    actors: `From these headlines, identify 10-14 key geopolitical actors and relationships.\n\nReturn ONLY JSON:\n{"actors":[{"id":"USA","label":"USA","type":"state","x":0.12,"y":0.28}],"links":[{"from":"USA","to":"NATO","type":"allied","label":"Lead"}]}\n\nActor types: state|org|proxy|leader. Link types: adversarial|allied|diplomatic|economic\nSpread actors evenly across x:0.05-0.95, y:0.08-0.92\n\nHeadlines:\n${(articles || []).map(a => a.title).join('\n')}`,

    entities: `Extract all named entities from these headlines. People, organizations, countries, locations.\n\nReturn ONLY JSON:\n{"people":[{"name":"...","role":"...","country":"..."}],"orgs":[{"name":"...","type":"..."}],"locations":[{"name":"...","type":"country|city|region","lat":0,"lon":0}]}\n\nHeadlines:\n${(articles || []).map(a => a.title).join('\n')}`,
  };

  const prompt = prompts[type];
  if (!prompt) return res.status(400).json({ error: 'Unknown type' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(200).json({ result: generateFallback(type, articles), fallback: true, error: err });
    }

    const d = await r.json();
    const text = d.content?.[0]?.text || '';

    // For JSON types, validate and parse
    if (['correlations', 'warnings', 'actors', 'entities'].includes(type)) {
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        return res.status(200).json({ result: parsed, raw: text, fallback: false });
      } catch {
        return res.status(200).json({ result: generateFallback(type, articles), fallback: true, raw: text });
      }
    }

    return res.status(200).json({ result: text, fallback: false });
  } catch (e) {
    return res.status(200).json({ result: generateFallback(type, articles), fallback: true, error: e.message });
  }
}

function generateFallback(type, articles) {
  const arts = articles || [];
  if (type === 'brief') {
    const hi = arts.filter(a => a.threatScore > 70).slice(0, 3).map(a => a.title).join('. ');
    return `Intelligence assessment based on ${arts.length} monitored sources. Priority events: ${hi || 'No critical events detected'}. Global threat environment remains elevated across multiple theaters simultaneously.`;
  }
  if (type === 'correlations') return [
    { title: 'Multi-theater simultaneous pressure', score: 'CORRELATION: 78%', desc: `${arts.length} active events across multiple theaters suggest coordinated timing. Intelligence indicates deliberate distraction strategy targeting Western response capacity.`, actors: ['Russia', 'China', 'Iran'] },
    { title: 'Proxy network activation pattern', score: 'CORRELATION: 71%', desc: 'Proxy forces across Middle East and Africa showing synchronized escalation patterns consistent with Iranian strategic direction.', actors: ['Iran', 'Hamas', 'Hezbollah', 'Houthis'] },
    { title: 'Economic warfare overlay', score: 'CORRELATION: 65%', desc: 'Energy and trade disruptions running parallel to military operations as documented coercive tool.', actors: ['Russia', 'OPEC'] },
  ];
  if (type === 'warnings') return [
    { title: 'Ukraine Front Operations', severity: 'HIGH', lat: 49.5, lon: 31.2, type: 'conflict', desc: 'Active combat operations reported.', ts: '5m ago', country: 'Ukraine' },
    { title: 'Gaza Operations', severity: 'HIGH', lat: 31.5, lon: 34.4, type: 'conflict', desc: 'Ongoing military operations.', ts: '10m ago', country: 'Israel' },
    { title: 'Iran Nuclear Activity', severity: 'HIGH', lat: 32.4, lon: 53.6, type: 'nuclear', desc: 'Enrichment activity detected.', ts: '1hr ago', country: 'Iran' },
    { title: 'Taiwan Strait Tension', severity: 'MEDIUM', lat: 24.0, lon: 121.5, type: 'military', desc: 'PLA naval exercises ongoing.', ts: '2hr ago', country: 'China' },
    { title: 'Houthi Red Sea Attacks', severity: 'MEDIUM', lat: 14.5, lon: 44.0, type: 'military', desc: 'Shipping disruption continues.', ts: '3hr ago', country: 'Yemen' },
  ];
  if (type === 'actors') return {
    actors: [
      { id: 'USA', label: 'USA', type: 'state', x: 0.12, y: 0.3 },
      { id: 'RUSSIA', label: 'RUSSIA', type: 'state', x: 0.6, y: 0.18 },
      { id: 'CHINA', label: 'CHINA', type: 'state', x: 0.78, y: 0.35 },
      { id: 'UKRAINE', label: 'UKRAINE', type: 'state', x: 0.52, y: 0.22 },
      { id: 'IRAN', label: 'IRAN', type: 'state', x: 0.62, y: 0.46 },
      { id: 'ISRAEL', label: 'ISRAEL', type: 'state', x: 0.55, y: 0.52 },
      { id: 'NATO', label: 'NATO', type: 'org', x: 0.3, y: 0.22 },
      { id: 'HAMAS', label: 'HAMAS', type: 'proxy', x: 0.53, y: 0.6 },
      { id: 'HZBLLH', label: 'HEZBOLLAH', type: 'proxy', x: 0.5, y: 0.44 },
      { id: 'HOUTHIS', label: 'HOUTHIS', type: 'proxy', x: 0.58, y: 0.62 },
      { id: 'NKOREA', label: 'N.KOREA', type: 'state', x: 0.82, y: 0.28 },
      { id: 'SAUDI', label: 'SAUDI', type: 'state', x: 0.62, y: 0.55 },
    ],
    links: [
      { from: 'USA', to: 'NATO', type: 'allied', label: 'Lead' },
      { from: 'USA', to: 'UKRAINE', type: 'allied', label: 'Aid' },
      { from: 'USA', to: 'ISRAEL', type: 'allied', label: 'Support' },
      { from: 'RUSSIA', to: 'UKRAINE', type: 'adversarial', label: 'WAR' },
      { from: 'RUSSIA', to: 'IRAN', type: 'allied', label: 'Arms' },
      { from: 'RUSSIA', to: 'NKOREA', type: 'allied', label: 'Ammo' },
      { from: 'IRAN', to: 'HAMAS', type: 'allied', label: 'Fund' },
      { from: 'IRAN', to: 'HZBLLH', type: 'allied', label: 'Control' },
      { from: 'IRAN', to: 'HOUTHIS', type: 'allied', label: 'Support' },
      { from: 'IRAN', to: 'ISRAEL', type: 'adversarial', label: 'Hostile' },
      { from: 'CHINA', to: 'RUSSIA', type: 'economic', label: 'Trade' },
      { from: 'ISRAEL', to: 'HAMAS', type: 'adversarial', label: 'WAR' },
      { from: 'ISRAEL', to: 'HZBLLH', type: 'adversarial', label: 'Conflict' },
      { from: 'SAUDI', to: 'USA', type: 'diplomatic', label: 'Partner' },
    ]
  };
  return null;
}
