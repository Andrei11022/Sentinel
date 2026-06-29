const GEO_HINTS = [
  { keys: ['ukraine', 'kyiv', 'kharkiv', 'donetsk', 'odesa'], lat: 49.0, lon: 32.0, country: 'UA' },
  { keys: ['russia', 'moscow', 'kursk', 'belgorod'], lat: 56.0, lon: 38.0, country: 'RU' },
  { keys: ['gaza', 'west bank', 'palestine'], lat: 31.45, lon: 34.4, country: 'PS' },
  { keys: ['israel', 'tel aviv', 'jerusalem'], lat: 31.8, lon: 35.2, country: 'IL' },
  { keys: ['iran', 'tehran', 'hormuz'], lat: 32.0, lon: 53.5, country: 'IR' },
  { keys: ['lebanon', 'beirut', 'hezbollah'], lat: 33.9, lon: 35.8, country: 'LB' },
  { keys: ['yemen', 'houthi', 'sanaa', 'red sea'], lat: 15.5, lon: 47.5, country: 'YE' },
  { keys: ['syria', 'damascus'], lat: 35.0, lon: 38.5, country: 'SY' },
  { keys: ['iraq', 'baghdad'], lat: 33.2, lon: 43.7, country: 'IQ' },
  { keys: ['sudan', 'darfur', 'khartoum'], lat: 15.6, lon: 30.3, country: 'SD' },
  { keys: ['myanmar'], lat: 19.7, lon: 96.2, country: 'MM' },
  { keys: ['somalia', 'mogadishu'], lat: 4.7, lon: 45.3, country: 'SO' },
  { keys: ['mali'], lat: 17.5, lon: -3.8, country: 'ML' },
  { keys: ['pakistan', 'islamabad'], lat: 30.4, lon: 69.4, country: 'PK' },
  { keys: ['north korea', 'pyongyang', 'icbm'], lat: 40.3, lon: 127.5, country: 'KP' },
  { keys: ['china', 'taiwan', 'pla', 'south china sea'], lat: 24.2, lon: 120.8, country: 'CN' },
  { keys: ['venezuela', 'guyana'], lat: 7.2, lon: -66.5, country: 'VE' },
  { keys: ['nigeria'], lat: 9.0, lon: 8.0, country: 'NG' },
  { keys: ['ethiopia'], lat: 8.8, lon: 39.6, country: 'ET' },
  { keys: ['afghanistan', 'kabul'], lat: 34.4, lon: 66.0, country: 'AF' },
];

function inferType(title, tag) {
  const t = (title || '').toLowerCase();
  if (tag === 'NUCLEAR' || /nuclear|icbm|warhead|enrichment|reactor/.test(t)) return 'nuclear';
  if (tag === 'CYBER' || /cyber|hack|ransomware|breach|malware/.test(t)) return 'cyber';
  if (tag === 'MILITARY' || /army|navy|air force|military|troops|missile|drone/.test(t)) return 'military';
  if (tag === 'DISASTER' || /earthquake|flood|wildfire|hurricane|tsunami/.test(t)) return 'disaster';
  return 'conflict';
}

function inferSeverity(score, title) {
  const t = (title || '').toLowerCase();
  if (score >= 80 || /killed|dead|attack|strike|invasion|massacre|airstrike/.test(t)) return 'HIGH';
  if (score >= 55) return 'MEDIUM';
  return 'LOW';
}

function timeAgoString(dateValue) {
  const ts = new Date(dateValue).getTime();
  if (Number.isNaN(ts)) return 'now';
  const diffMins = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  if (diffMins < 60) return `${diffMins}m ago`;
  const h = Math.floor(diffMins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function locateHeadline(title) {
  const t = (title || '').toLowerCase();
  const hit = GEO_HINTS.find((g) => g.keys.some((k) => t.includes(k)));
  return hit || null;
}

function buildThreatFromArticle(article, index) {
  const loc = locateHeadline(article.title);
  if (!loc) return null;
  const severity = inferSeverity(article.threatScore || 50, article.title);
  const riskScore = Math.max(35, Math.min(99, Math.round(article.threatScore || (severity === 'HIGH' ? 82 : 60))));
  return {
    id: article.id || `news-threat-${index}`,
    title: article.title,
    severity,
    lat: loc.lat,
    lon: loc.lon,
    type: inferType(article.title, article.tag),
    country: loc.country,
    desc: article.summary || `Source: ${article.source || 'Live feed'}`,
    ts: timeAgoString(article.publishedAt),
    riskScore,
    source: article.source || 'Unknown',
    url: article.url,
    updated: true,
  };
}

async function fetchLiveNews(baseUrl) {
  const response = await fetch(`${baseUrl}/api/news?type=world`);
  if (!response.ok) throw new Error(`news upstream ${response.status}`);
  const data = await response.json();
  return data.articles || [];
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const baseUrl = `${proto}://${host}`;

  try {
    const articles = await fetchLiveNews(baseUrl);
    const threats = [];
    const seenCoords = new Set();

    for (let i = 0; i < articles.length; i += 1) {
      const mapped = buildThreatFromArticle(articles[i], i);
      if (!mapped) continue;
      const key = `${mapped.country}:${mapped.type}`;
      if (seenCoords.has(key)) continue;
      seenCoords.add(key);
      threats.push(mapped);
      if (threats.length >= 16) break;
    }

    const highCount = threats.filter((t) => t.severity === 'HIGH').length;
    const medCount = threats.filter((t) => t.severity === 'MEDIUM').length;
    const avgRisk = Math.round(threats.reduce((sum, t) => sum + t.riskScore, 0) / Math.max(threats.length, 1));
    const globalRisk = Math.min(99, Math.max(20, avgRisk));

    return res.status(200).json({
      threats,
      meta: {
        total: threats.length,
        highSeverity: highCount,
        mediumSeverity: medCount,
        globalRiskIndex: globalRisk,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    return res.status(200).json({
      threats: [],
      meta: {
        total: 0,
        highSeverity: 0,
        mediumSeverity: 0,
        globalRiskIndex: 0,
        updatedAt: new Date().toISOString(),
      },
      error: e.message,
    });
  }
};
