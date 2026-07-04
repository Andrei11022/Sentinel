// Entity extraction + relationship mapping from news articles
const { askAI, isConfigured } = require('./lib/ai');

// Known entity database for fast lookup
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

  // Deduplicate
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { articles, text } = req.body || {};

  try {
    let entities;

    if (isConfigured() && articles?.length) {
      try {
        entities = await extractEntitiesAI(articles);
      } catch {
        // Fall back to local extraction
        const combined = (articles || []).map(a => a.title || a.webTitle || '').join(' ');
        entities = extractEntitiesLocal(combined);
      }
    } else {
      const combined = text || (articles || []).map(a => a.title || a.webTitle || '').join(' ');
      entities = extractEntitiesLocal(combined);
    }

    // Add threat summary
    const highThreatActors = [
      ...(entities.people || []).filter(p => p.threatLevel === 'HIGH' || p.threat === 'HIGH'),
      ...(entities.organizations || entities.orgs || []).filter(o => o.threatLevel === 'HIGH' || o.threat === 'HIGH'),
    ];

    res.status(200).json({
      entities,
      summary: {
        totalEntities: (entities.people?.length || 0) + (entities.organizations?.length || entities.orgs?.length || 0) + (entities.locations?.length || 0),
        highThreatActors: highThreatActors.map(a => a.name),
        conflictZones: (entities.locations || []).filter(l => l.conflictZone || l.conflict).map(l => l.name),
      }
    });
  } catch (e) {
    res.status(200).json({ entities: extractEntitiesLocal(text || ''), error: e.message });
  }
}
