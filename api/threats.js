const COUNTRY_COORDS=[
  {code:'UA',name:'Ukraine',lat:49.0,lon:32.0},{code:'RU',name:'Russia',lat:56.0,lon:38.0},
  {code:'PS',name:'Palestine',lat:31.45,lon:34.4},{code:'IL',name:'Israel',lat:31.8,lon:35.2},
  {code:'IR',name:'Iran',lat:32.0,lon:53.5},{code:'LB',name:'Lebanon',lat:33.9,lon:35.8},
  {code:'YE',name:'Yemen',lat:15.5,lon:47.5},{code:'SY',name:'Syria',lat:35.0,lon:38.5},
  {code:'IQ',name:'Iraq',lat:33.2,lon:43.7},{code:'SD',name:'Sudan',lat:15.6,lon:30.3},
  {code:'MM',name:'Myanmar',lat:19.7,lon:96.2},{code:'SO',name:'Somalia',lat:6.0,lon:45.0},
  {code:'ML',name:'Mali',lat:17.5,lon:-3.8},{code:'PK',name:'Pakistan',lat:30.4,lon:69.4},
  {code:'KP',name:'North Korea',lat:40.3,lon:127.5},{code:'CN',name:'China',lat:35.0,lon:105.0},
  {code:'TW',name:'Taiwan',lat:24.2,lon:120.8},{code:'VE',name:'Venezuela',lat:7.2,lon:-66.5},
  {code:'NG',name:'Nigeria',lat:9.0,lon:8.0},{code:'ET',name:'Ethiopia',lat:8.8,lon:39.6},
  {code:'AF',name:'Afghanistan',lat:34.4,lon:66.0},{code:'HT',name:'Haiti',lat:19.0,lon:-72.3},
  {code:'LY',name:'Libya',lat:26.0,lon:17.0},{code:'US',name:'United States',lat:38.0,lon:-97.0},
  {code:'TR',name:'Turkey',lat:39.0,lon:35.0},{code:'SA',name:'Saudi Arabia',lat:24.0,lon:45.0},
  {code:'DE',name:'Germany',lat:51.0,lon:10.0},{code:'GB',name:'United Kingdom',lat:54.0,lon:-2.0},
  {code:'FR',name:'France',lat:46.0,lon:2.0},{code:'JP',name:'Japan',lat:36.0,lon:138.0},
  {code:'IN',name:'India',lat:20.0,lon:77.0}
];

const COUNTRY_PATTERNS=[
  {code:'UA',patterns:['ukraine','kyiv','kharkiv','donetsk','odesa','ukrainian']},
  {code:'RU',patterns:['russia','moscow','kremlin','russian','putin']},
  {code:'PS',patterns:['gaza','palestine','palestinian','west bank','rafah']},
  {code:'IL',patterns:['israel','israeli','tel aviv','idf','netanyahu']},
  {code:'IR',patterns:['iran','tehran','iranian','khamenei','irgc']},
  {code:'LB',patterns:['lebanon','beirut','hezbollah','lebanese']},
  {code:'YE',patterns:['yemen','houthi','yemeni','sanaa','aden']},
  {code:'SY',patterns:['syria','damascus','syrian']},
  {code:'IQ',patterns:['iraq','baghdad','iraqi','kurdistan']},
  {code:'SD',patterns:['sudan','khartoum','sudanese','darfur']},
  {code:'MM',patterns:['myanmar','yangon','burma','junta']},
  {code:'SO',patterns:['somalia','mogadishu','somali']},
  {code:'ML',patterns:['mali','bamako','malian','sahel']},
  {code:'PK',patterns:['pakistan','islamabad','pakistani','kpk']},
  {code:'KP',patterns:['north korea','pyongyang','dprk','icbm']},
  {code:'CN',patterns:['china','beijing','chinese','pla','xi jinping']},
  {code:'TW',patterns:['taiwan','taipei','taiwanese']},
  {code:'VE',patterns:['venezuela','guyana','essequibo','venezuelan']},
  {code:'NG',patterns:['nigeria','lagos','nigerian','boko haram']},
  {code:'ET',patterns:['ethiopia','addis ababa','ethiopian']},
  {code:'AF',patterns:['afghanistan','kabul','afghani','taliban']},
  {code:'HT',patterns:['haiti','port-au-prince','haitian']},
  {code:'LY',patterns:['libya','tripoli','benghazi','libyan']},
  {code:'US',patterns:['united states','usa','america','american','washington','trump']},
  {code:'TR',patterns:['turkey','ankara','erdogan','turkish']},
  {code:'SA',patterns:['saudi arabia','riyadh','saudi']},
  {code:'DE',patterns:['germany','berlin','merz','german']},
  {code:'GB',patterns:['united kingdom','britain','london','british','uk']},
  {code:'FR',patterns:['france','paris','french','macron']},
  {code:'JP',patterns:['japan','tokyo','japanese']},
  {code:'IN',patterns:['india','delhi','indian','modi']}
];

function extractCountryCode(headline=''){
  const t=(headline||'').toLowerCase();
  for(const p of COUNTRY_PATTERNS){
    if(p.patterns.some(pat=>t.includes(pat))) return p.code;
  }
  return null;
}

function getCountryCoords(code){
  return COUNTRY_COORDS.find(c=>c.code===code)||null;
}

function inferType(title='',tag=''){
  const t=(title||'').toLowerCase();
  if(tag==='NUCLEAR'||/nuclear|icbm|warhead|enrichment/.test(t)) return 'nuclear';
  if(tag==='CYBER'||/cyber|hack|breach|malware/.test(t)) return 'cyber';
  if(tag==='MILITARY'||/military|missile|army|navy|troops|drone/.test(t)) return 'military';
  if(tag==='DISASTER'||/earthquake|flood|wildfire|hurricane|tsunami/.test(t)) return 'disaster';
  return 'conflict';
}

function inferSeverity(score=50,title=''){
  const t=(title||'').toLowerCase();
  const s=Number(score||50);
  if(s>=80||/killed|dead|attack|strike|invasion|massacre|airstrike/.test(t)) return 'HIGH';
  if(s>=55) return 'MEDIUM';
  return 'LOW';
}

function formatTimeAgo(dateValue){
  const ts=new Date(dateValue).getTime();
  if(Number.isNaN(ts)) return 'now';
  const diffMins=Math.max(1,Math.floor((Date.now()-ts)/60000));
  if(diffMins<60) return `${diffMins}m ago`;
  const h=Math.floor(diffMins/60);
  if(h<48) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

function buildThreatFromArticle(article,index){
  const code=extractCountryCode(article.title+' '+(article.summary||''));
  if(!code) return null;
  
  const coords=getCountryCoords(code);
  if(!coords) return null;
  
  const severity=inferSeverity(article.threatScore||50,article.title);
  const riskScore=Math.max(35,Math.min(99,Math.round(article.threatScore||(severity==='HIGH'?82:60))));
  
  return {
    id:article.id||`threat-${index}-${Date.now()}`,
    title:article.title,
    severity,
    lat:coords.lat,
    lon:coords.lon,
    country:code,
    type:inferType(article.title,article.tag),
    desc:article.summary||`From ${article.source||'live feed'}`,
    ts:formatTimeAgo(article.publishedAt),
    riskScore,
    source:article.source||'Unknown',
    url:article.url||null
  };
}

async function fetchLiveNews(baseUrl){
  try{
    const r=await fetch(`${baseUrl}/api/news?type=world`,{timeout:8000});
    if(!r.ok) throw new Error(`news ${r.status}`);
    const d=await r.json();
    return d.articles||[];
  }catch(e){
    console.error('News fetch error:',e.message);
    return [];
  }
}

module.exports=async function handler(req,res){
  if(req.method==='OPTIONS') return res.status(200).end();
  
  const proto=req.headers['x-forwarded-proto']||'https';
  const host=req.headers.host;
  const baseUrl=`${proto}://${host}`;
  
  try{
    const articles=await fetchLiveNews(baseUrl);
    if(!articles.length){
      return res.status(200).json({
        threats:[],
        meta:{total:0,highSeverity:0,mediumSeverity:0,globalRiskIndex:0,updatedAt:new Date().toISOString()}
      });
    }
    
    const threats=[];
    const seenCountries=new Set();

    // Own severity-first ordering for the purposes of picking the worst
    // threat per country+type, independent of whatever order /api/news
    // returns articles in — that endpoint sorts by publish date for the
    // Briefing feed, which is a different, unrelated concern from "which
    // single article represents this country's worst active threat."
    const bySeverity=articles.slice().sort((a,b)=>(b.threatScore||50)-(a.threatScore||50));

    for(let i=0;i<bySeverity.length;i++){
      const threat=buildThreatFromArticle(bySeverity[i],i);
      if(!threat) continue;
      
      const key=threat.country+':'+threat.type;
      if(seenCountries.has(key)) continue;
      seenCountries.add(key);
      threats.push(threat);
      if(threats.length>=18) break;
    }
    
    const highCount=threats.filter(t=>t.severity==='HIGH').length;
    const medCount=threats.filter(t=>t.severity==='MEDIUM').length;
    const avgRisk=Math.round(threats.reduce((sum,t)=>sum+t.riskScore,0)/Math.max(threats.length,1));
    const globalRisk=Math.min(99,Math.max(20,avgRisk));
    
    return res.status(200).json({
      threats,
      meta:{
        total:threats.length,
        highSeverity:highCount,
        mediumSeverity:medCount,
        globalRiskIndex:globalRisk,
        updatedAt:new Date().toISOString()
      }
    });
  }catch(e){
    return res.status(200).json({
      threats:[],
      meta:{total:0,highSeverity:0,mediumSeverity:0,globalRiskIndex:0,updatedAt:new Date().toISOString()},
      error:e.message
    });
  }
};
