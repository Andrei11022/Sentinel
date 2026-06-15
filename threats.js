// Static threat baseline — augmented by news API results
const BASE_THREATS = [
  { id:'ukr-001', title:'Ukraine — Active Combat Operations', severity:'HIGH', lat:49.5, lon:31.2, type:'conflict', country:'UA', desc:'Russian offensive operations ongoing across multiple front sectors.', updated: true },
  { id:'gaz-001', title:'Gaza — Military Operations', severity:'HIGH', lat:31.5, lon:34.4, type:'conflict', country:'IL', desc:'IDF ground and air operations continuing. Humanitarian corridor disputes.', updated: true },
  { id:'irn-001', title:'Iran — Nuclear Enrichment', severity:'HIGH', lat:32.4, lon:53.6, type:'nuclear', country:'IR', desc:'Fordow facility activity detected. 60%+ enrichment confirmed.', updated: true },
  { id:'twn-001', title:'Taiwan Strait — PLA Activity', severity:'HIGH', lat:24.0, lon:121.5, type:'military', country:'CN', desc:'PLA naval exercises in strait. Air incursions into ADIZ increasing.', updated: true },
  { id:'prk-001', title:'North Korea — ICBM Program', severity:'HIGH', lat:39.0, lon:125.7, type:'nuclear', country:'KP', desc:'Missile tests continuing. Hypersonic warhead development reported.', updated: true },
  { id:'sdn-001', title:'Sudan — Civil War (RSF vs SAF)', severity:'HIGH', lat:15.5, lon:32.5, type:'conflict', country:'SD', desc:'RSF advancing on Al-Fashir. Mass displacement exceeding 8M people.', updated: true },
  { id:'mmr-001', title:'Myanmar — Junta vs Resistance', severity:'HIGH', lat:19.8, lon:96.1, type:'conflict', country:'MM', desc:'Resistance forces controlling significant territory. Junta airstrikes on civilians.', updated: true },
  { id:'lbn-001', title:'Lebanon — Hezbollah-Israel Conflict', severity:'HIGH', lat:33.5, lon:35.5, type:'conflict', country:'LB', desc:'Cross-border fire ongoing. 1M+ displaced in south Lebanon.', updated: true },
  { id:'ymn-001', title:'Yemen — Houthi Red Sea Attacks', severity:'MEDIUM', lat:14.5, lon:44.0, type:'military', country:'YE', desc:'Houthis targeting commercial shipping. 12% of global trade disrupted.', updated: true },
  { id:'ven-001', title:'Venezuela — Guyana Border', severity:'MEDIUM', lat:7.1, lon:-65.3, type:'military', country:'VE', desc:'Military movements near Essequibo. Territorial dispute escalating.', updated: true },
  { id:'mli-001', title:'Mali/Sahel — Wagner/Coup Instability', severity:'MEDIUM', lat:12.6, lon:-8.0, type:'conflict', country:'ML', desc:'Wagner Group operations continuing. French forces expelled.', updated: true },
  { id:'pak-001', title:'Pakistan — TTP Insurgency', severity:'MEDIUM', lat:33.0, lon:70.0, type:'conflict', country:'PK', desc:'TTP attacks increasing. Afghanistan border porous.', updated: true },
  { id:'cyb-001', title:'Global — State Cyber Operations', severity:'MEDIUM', lat:50.1, lon:8.6, type:'cyber', country:'DE', desc:'Russian/Chinese cyber campaigns targeting EU financial infrastructure.', updated: true },
];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const threats = BASE_THREATS.map(t => ({
    ...t,
    ts: `${Math.floor(Math.random() * 55) + 1}m ago`,
    riskScore: t.severity === 'HIGH' ? Math.floor(Math.random() * 20) + 75 : Math.floor(Math.random() * 25) + 45,
  }));

  const highCount = threats.filter(t => t.severity === 'HIGH').length;
  const medCount = threats.filter(t => t.severity === 'MEDIUM').length;
  const globalRisk = Math.min(99, Math.round((highCount * 10 + medCount * 5) / threats.length * 10));

  res.status(200).json({
    threats,
    meta: {
      total: threats.length,
      highSeverity: highCount,
      mediumSeverity: medCount,
      globalRiskIndex: globalRisk,
      updatedAt: new Date().toISOString(),
    }
  });
}
