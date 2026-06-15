// Conflict probability + country risk scoring engine
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';

// Base risk model — updated with current intelligence
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

// Escalation probability model
function calculateEscalationProbability(countryCode, recentEvents) {
  const base = COUNTRY_RISK_BASE[countryCode];
  if (!base) return null;

  let prob = base.baseRisk;

  // Trend modifier
  if (base.trend === 'worsening') prob = Math.min(99, prob + 8);
  if (base.trend === 'improving') prob = Math.max(10, prob - 8);

  // Recent events boost
  if (recentEvents) {
    const mentionCount = (recentEvents.match(new RegExp(base.name, 'gi')) || []).length;
    prob = Math.min(99, prob + mentionCount * 2);
  }

  return {
    country: base.name,
    code: countryCode,
    escalationProbability: prob,
    riskLevel: prob > 80 ? 'CRITICAL' : prob > 60 ? 'HIGH' : prob > 40 ? 'MEDIUM' : 'LOW',
    trend: base.trend,
    keyFactors: base.factors,
    gdpImpact: base.gdpImpact + '%',
    displaced: base.refugeeFlow.toLocaleString(),
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, articles, country } = req.method === 'POST'
    ? (req.body || {})
    : req.query;

  const recentText = (articles || []).map(a => a.title || a.webTitle || '').join(' ');

  if (type === 'risk_matrix') {
    // Return all country risk scores
    const matrix = Object.entries(COUNTRY_RISK_BASE)
      .map(([code]) => calculateEscalationProbability(code, recentText))
      .filter(Boolean)
      .sort((a, b) => b.escalationProbability - a.escalationProbability);

    return res.status(200).json({ matrix, updatedAt: new Date().toISOString() });
  }

  if (type === 'scenarios' && CLAUDE_KEY) {
    // AI scenario generation
    try {
      const headlines = (articles || []).slice(0, 8).map(a => a.title || a.webTitle).join('\n');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: `Based on these headlines, generate 3 geopolitical scenarios for the next 30-90 days. For each: probability, timeline, trigger event, cascade effects.\n\nReturn ONLY JSON:\n[{"title":"...","probability":"X%","timeline":"30|60|90 days","trigger":"...","cascade":["effect1","effect2","effect3"],"severity":"HIGH|MEDIUM|LOW"}]\n\nHeadlines:\n${headlines}`
          }]
        })
      });
      const d = await r.json();
      const text = d.content?.[0]?.text || '[]';
      const scenarios = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json({ scenarios, fallback: false });
    } catch (e) {
      // Fall through to static scenarios
    }
  }

  // Static scenario fallback
  const staticScenarios = [
    { title: 'Iran nuclear threshold crossed', probability: '34%', timeline: '90 days', trigger: 'Iran enriches to 90% weapons-grade', cascade: ['Israeli strike on Fordow', 'Iranian retaliation via proxies', 'US carrier group engagement', 'Oil price spike >$150/bbl', 'Global recession risk'], severity: 'HIGH' },
    { title: 'Ukraine front collapse (eastern)', probability: '28%', timeline: '60 days', trigger: 'Russian breakthrough at Pokrovsk or Kramatorsk', cascade: ['Zelensky requests NATO Article 5 consultation', 'Western escalation debate', 'Nuclear rhetoric intensifies', 'European refugee crisis 2.0'], severity: 'HIGH' },
    { title: 'Taiwan Strait military incident', probability: '18%', timeline: '90 days', trigger: 'PLA vessel fires on Taiwan coast guard', cascade: ['US carrier strike group deployment', 'Japan activates self-defense', 'TSMC production halt risk', 'Global semiconductor shock'], severity: 'HIGH' },
    { title: 'Gulf oil infrastructure attack', probability: '22%', timeline: '30 days', trigger: 'Houthi/Iran strikes Saudi Abqaiq facility', cascade: ['Oil price spike to $200', 'Global inflation surge', 'US military response', 'Saudi retaliation on Yemen'], severity: 'MEDIUM' },
    { title: 'Pakistan nuclear security event', probability: '8%', timeline: '90 days', trigger: 'TTP seizes military base with nuclear components', cascade: ['US/India emergency response', 'China mediation', 'Global security alert', 'NATO Article 5 consultations'], severity: 'HIGH' },
  ];

  res.status(200).json({ scenarios: staticScenarios, fallback: true });
}
