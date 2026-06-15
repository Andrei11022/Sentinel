const GUARDIAN_KEY = process.env.GUARDIAN_KEY || '473fcab8-81fa-4e79-a17e-429debaa4bc1';

const QUERIES = [
  { q: 'war+OR+conflict+OR+military+OR+troops+OR+invasion+OR+offensive', sec: 'world|politics', label: 'Conflict' },
  { q: 'sanctions+OR+nuclear+OR+geopolitics+OR+diplomacy+OR+summit+OR+treaty', sec: 'world|politics', label: 'Geopolitics' },
  { q: 'israel+OR+gaza+OR+iran+OR+ukraine+OR+russia+OR+china+OR+taiwan', sec: 'world', label: 'Hotspots' },
  { q: 'cyber+attack+OR+missile+OR+coup+OR+terrorism+OR+insurgency', sec: 'world|politics', label: 'Security' },
];

function scoreArticle(title, section) {
  const t = (title || '').toLowerCase();
  let score = 50;
  if (/killed|dead|casualties|attack|war|invasion|strike/.test(t)) score += 30;
  if (/nuclear|missile|icbm|warhead/.test(t)) score += 25;
  if (/coup|collapse|crisis|emergency/.test(t)) score += 20;
  if (/sanction|diplomat|summit|treaty/.test(t)) score += 10;
  if (/analysis|opinion|review|explainer/.test(t)) score -= 20;
  return Math.min(100, Math.max(0, score));
}

function tagArticle(title) {
  const t = (title || '').toLowerCase();
  if (/nuclear|icbm|warhead|enrichment|reactor/.test(t)) return 'NUCLEAR';
  if (/war|attack|killed|bomb|strike|invasion|offensive|troops|casualties/.test(t)) return 'CONFLICT';
  if (/nato|military|missile|navy|army|airforce|weapon|defense|fighter/.test(t)) return 'MILITARY';
  if (/cyber|hack|ransomware|breach|malware/.test(t)) return 'CYBER';
  if (/earthquake|flood|volcano|hurricane|tsunami|wildfire/.test(t)) return 'DISASTER';
  if (/sanction|diplomat|summit|treaty|election|president|minister/.test(t)) return 'GEOPOLITICS';
  return 'INTEL';
}

function credibilityScore(source) {
  const scores = {
    'theguardian.com': 88, 'reuters.com': 95, 'bbc.com': 90,
    'ap.org': 94, 'ft.com': 91, 'nytimes.com': 87,
    'wsj.com': 88, 'economist.com': 92, 'foreignpolicy.com': 85,
    'aljazeera.com': 78, 'france24.com': 82, 'dw.com': 85,
  };
  for (const [domain, score] of Object.entries(scores)) {
    if (source && source.includes(domain)) return score;
  }
  return 70;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const type = req.query.type || 'world';
  const seen = new Set();
  let articles = [];

  // Fetch from Guardian
  const queriesToRun = type === 'mideast'
    ? [{ q: 'israel+OR+gaza+OR+iran+OR+hezbollah+OR+hamas+OR+yemen+OR+houthis+OR+%22middle+east%22+OR+lebanon', sec: 'world', label: 'ME' }]
    : QUERIES;

  await Promise.allSettled(
    queriesToRun.map(async (qry) => {
      try {
        const url = `https://content.guardianapis.com/search?q=${qry.q}&section=${qry.sec}&order-by=newest&page-size=10&show-fields=trailText,thumbnail&api-key=${GUARDIAN_KEY}`;
        const r = await fetch(url);
        const d = await r.json();
        if (d.response?.results) {
          d.response.results.forEach(a => {
            if (!seen.has(a.id)) {
              seen.add(a.id);
              articles.push({
                id: a.id,
                title: a.webTitle,
                url: a.webUrl,
                source: 'The Guardian',
                sourceCredibility: 88,
                publishedAt: a.webPublicationDate,
                tag: tagArticle(a.webTitle),
                threatScore: scoreArticle(a.webTitle, a.sectionName),
                summary: a.fields?.trailText || '',
                section: qry.label,
              });
            }
          });
        }
      } catch (e) { /* skip failed query */ }
    })
  );

  // Also fetch from GDELT for conflict events
  if (type === 'world') {
    try {
      const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=war+conflict+military+sanctions&mode=artlist&maxrecords=10&format=json&timespan=24h&sourcelang=english`;
      const gr = await fetch(gdeltUrl);
      const gd = await gr.json();
      if (gd.articles) {
        gd.articles.forEach(a => {
          const id = a.url;
          if (!seen.has(id)) {
            seen.add(id);
            articles.push({
              id,
              title: a.title,
              url: a.url,
              source: a.domain || 'GDELT',
              sourceCredibility: credibilityScore(a.domain),
              publishedAt: a.seendate ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z') : new Date().toISOString(),
              tag: tagArticle(a.title),
              threatScore: scoreArticle(a.title, ''),
              summary: '',
              section: 'GDELT',
            });
          }
        });
      }
    } catch (e) { /* GDELT optional */ }
  }

  // Sort by threat score desc, then by date
  articles.sort((a, b) => {
    const scoreDiff = b.threatScore - a.threatScore;
    if (Math.abs(scoreDiff) > 10) return scoreDiff;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  const maxArticles = type === 'mideast' ? 12 : 20;

  res.status(200).json({
    articles: articles.slice(0, maxArticles),
    meta: {
      total: articles.length,
      sources: [...new Set(articles.map(a => a.source))],
      fetchedAt: new Date().toISOString(),
      avgThreatScore: Math.round(articles.reduce((s, a) => s + a.threatScore, 0) / Math.max(articles.length, 1)),
    }
  });
}
