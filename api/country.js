const COUNTRY_INTEL = {
  US: { flag:'🇺🇸', leader:'Donald Trump', ideology:'Right-Populist', religion:'Christian 65%', currency:'USD', elections:'Presidential / 4yr', gdp:'$27.4T', military:'NATO lead, nuclear', alliance:'NATO, AUKUS, Five Eyes', rivals:'China, Russia, Iran', riskLevel:'LOW' },
  RU: { flag:'🇷🇺', leader:'Vladimir Putin', ideology:'Auth-Nationalist', religion:'Orthodox Christian', currency:'RUB', elections:'Controlled presidential', gdp:'$2.2T (sanctioned)', military:'Nuclear, P5, CSTO', alliance:'China, Belarus, Iran, N.Korea', rivals:'NATO, Ukraine, West', riskLevel:'CRITICAL' },
  CN: { flag:'🇨🇳', leader:'Xi Jinping', ideology:'Auth-Communist', religion:'Atheist state', currency:'CNY', elections:'No free elections', gdp:'$18.5T', military:'Nuclear, P5, PLAN expanding', alliance:'Russia, Pakistan, ASEAN trade', rivals:'USA, India, Taiwan, Japan', riskLevel:'HIGH' },
  UA: { flag:'🇺🇦', leader:'Volodymyr Zelensky', ideology:'Liberal Democrat', religion:'Orthodox Christian', currency:'UAH', elections:'Suspended (wartime)', gdp:'$160B (war economy)', military:'NATO partner, Western-equipped', alliance:'NATO, EU, USA, UK', rivals:'Russia (at war)', riskLevel:'CRITICAL' },
  IR: { flag:'🇮🇷', leader:'Ali Khamenei (Supreme Leader)', ideology:'Theocratic', religion:'Shia Islam 95%', currency:'IRR (collapsed)', elections:'Controlled (Guardian Council)', gdp:'$367B', military:'Missile + proxy network', alliance:'Russia, China, proxies', rivals:'USA, Israel, Saudi Arabia', riskLevel:'CRITICAL' },
  IL: { flag:'🇮🇱', leader:'Benjamin Netanyahu', ideology:'Right-Nationalist', religion:'Jewish 74%', currency:'ILS', elections:'Parliamentary (Knesset)', gdp:'$521B', military:'Nuclear (undeclared), IDF', alliance:'USA, UAE, Morocco', rivals:'Iran, Hamas, Hezbollah', riskLevel:'HIGH' },
  SA: { flag:'🇸🇦', leader:'Mohammed bin Salman (MBS)', ideology:'Absolute Monarchy', religion:'Sunni Islam 90%', currency:'SAR', elections:'No elections', gdp:'$1.1T', military:'US-equipped', alliance:'USA, UAE, Egypt, Jordan', rivals:'Iran, Yemen (Houthis)', riskLevel:'MEDIUM' },
  IN: { flag:'🇮🇳', leader:'Narendra Modi', ideology:'Hindu-Nationalist', religion:'Hindu 80%', currency:'INR', elections:'Parliamentary democracy', gdp:'$3.7T', military:'Nuclear, regional power', alliance:'Quad (USA,Japan,Australia)', rivals:'China, Pakistan', riskLevel:'MEDIUM' },
  TR: { flag:'🇹🇷', leader:'Recep Tayyip Erdoğan', ideology:'Auth-Islamist', religion:'Sunni Islam 99%', currency:'TRY (inflation crisis)', elections:'Presidential', gdp:'$906B', military:'NATO member, S-400 buyer', alliance:'NATO (strained), Azerbaijan', rivals:'Greece, Kurds, Israel', riskLevel:'MEDIUM' },
  DE: { flag:'🇩🇪', leader:'Friedrich Merz', ideology:'Centre-Right', religion:'Christian 50%', currency:'EUR', elections:'Parliamentary (Bundestag)', gdp:'$4.5T', military:'NATO, rearming (2% GDP)', alliance:'NATO, EU', rivals:'None formal, Russia tension', riskLevel:'LOW' },
  GB: { flag:'🇬🇧', leader:'Keir Starmer', ideology:'Centre-Left', religion:'Christian (Anglican)', currency:'GBP', elections:'Parliamentary', gdp:'$3.1T', military:'Nuclear, P5, AUKUS', alliance:'NATO, AUKUS, Five Eyes', rivals:'Russia, post-Brexit EU tension', riskLevel:'LOW' },
  FR: { flag:'🇫🇷', leader:'Emmanuel Macron', ideology:'Centrist-Liberal', religion:'Secular / Catholic', currency:'EUR', elections:'Presidential + Parliamentary', gdp:'$3.1T', military:'Nuclear, P5, NATO', alliance:'NATO, EU', rivals:'Russia, Sahel instability', riskLevel:'LOW' },
  KP: { flag:'🇰🇵', leader:'Kim Jong-un', ideology:'Juche/Totalitarian', religion:'State atheism', currency:'KPW', elections:'No free elections', gdp:'$28B (est)', military:'Nuclear, ICBM program', alliance:'Russia (2024 arms), China', rivals:'USA, South Korea, Japan', riskLevel:'CRITICAL' },
  JP: { flag:'🇯🇵', leader:'Shigeru Ishiba', ideology:'Conservative', religion:'Shinto/Buddhist', currency:'JPY', elections:'Parliamentary', gdp:'$4.2T', military:'Self-Defense + US treaty', alliance:'USA, Quad, ASEAN', rivals:'China, N.Korea, Russia (islands)', riskLevel:'LOW' },
  BR: { flag:'🇧🇷', leader:'Luiz Inácio Lula', ideology:'Left-Progressive', religion:'Catholic 65%', currency:'BRL', elections:'Presidential', gdp:'$2.1T', military:'Regional power', alliance:'BRICS, Mercosur', rivals:'Environmental pressure', riskLevel:'LOW' },
  PK: { flag:'🇵🇰', leader:'Shehbaz Sharif', ideology:'Conservative-Islamic', religion:'Sunni Islam 96%', currency:'PKR', elections:'Parliamentary', gdp:'$340B', military:'Nuclear', alliance:'China (CPEC), Saudi Arabia', rivals:'India, Afghanistan (Taliban)', riskLevel:'HIGH' },
  SY: { flag:'🇸🇾', leader:'Ahmed al-Sharaa (post-Assad)', ideology:'Post-conflict transitional', religion:'Sunni Islam 74%', currency:'SYP (collapsed)', elections:'None (transitional)', gdp:'$25B (devastated)', military:'Fragmented factions', alliance:'Transitional — unclear', rivals:'ISIS remnants, Turkey-Kurd tension', riskLevel:'HIGH' },
  LY: { flag:'🇱🇾', leader:'Divided (GNU vs parliament)', ideology:'Divided governance', religion:'Sunni Islam 97%', currency:'LYD', elections:'Contested', gdp:'$41B (oil)', military:'Fragmented militia', alliance:'Turkey (west), Russia/UAE (east)', rivals:'Internal: Haftar vs GNU', riskLevel:'HIGH' },
  MM: { flag:'🇲🇲', leader:'Min Aung Hlaing (junta)', ideology:'Military Authoritarian', religion:'Buddhist 88%', currency:'MMK', elections:'None (coup 2021)', gdp:'$65B (declining)', military:'Tatmadaw vs resistance', alliance:'China, Russia', rivals:'NUG/resistance forces, West', riskLevel:'CRITICAL' },
  SD: { flag:'🇸🇩', leader:'SAF vs RSF (civil war)', ideology:'Military factions', religion:'Sunni Islam 97%', currency:'SDG (collapsed)', elections:'None', gdp:'$30B', military:'SAF vs RSF civil war', alliance:'SAF: Egypt. RSF: UAE/Wagner', rivals:'Internal civil war since 2023', riskLevel:'CRITICAL' },
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code } = req.query;

  if (code) {
    const intel = COUNTRY_INTEL[code.toUpperCase()];
    if (intel) {
      return res.status(200).json({ code: code.toUpperCase(), ...intel });
    }
    // Try to fetch from REST Countries API
    try {
      const r = await fetch(`https://restcountries.com/v3.1/alpha/${code}?fields=name,capital,population,area,region,languages,currencies,flags`);
      const [d] = await r.json();
      return res.status(200).json({
        code: code.toUpperCase(),
        name: d.name?.common,
        capital: d.capital?.[0],
        population: d.population?.toLocaleString(),
        region: d.region,
        flag: d.flags?.png,
        currency: Object.values(d.currencies || {})[0]?.name || 'Unknown',
        riskLevel: 'UNKNOWN',
      });
    } catch {
      return res.status(404).json({ error: 'Country not found' });
    }
  }

  // Return all country intel
  return res.status(200).json({ countries: COUNTRY_INTEL });
}
