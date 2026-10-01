// api/street.js — TTV street check (Charlotte / Mecklenburg)  v1
//
// "Is this a bad street in a good area?" Given a subject parcel, compare the homes on its own stretch of street with
// its assessor neighbourhood, from the county's public assessor (CAMA) records, and say where the street is weaker.
// It also works out where a Street View camera should stand (the nearest point on the subject's street centreline)
// and which way it should face (toward the lot), so the underwriter can walk the street on the Site Intelligence
// screen.
//
// Why county data and not AI on Street View photos: Google Maps Platform terms §3.2.3 forbid taking Street View
// imagery out of Google's service and building data from it (their example: "an index of tree locations within a city
// from Street View imagery"), which a photo-based street score would be. Checked 2026-09-30. The Street View window
// is the plain Maps Embed on its own page, streetview.html (a person looks; nothing is read from the imagery). Google's
// Street View guidelines also ban screenshotting Street View and "using applications to analyze and extract information"
// from it, so no AI looks at it by any route, in the app or out of it. ?mode=view returns only the camera spot and the
// embed key, for streetview.html.
//
// Fair housing: every check is about buildings, lots and land use, never about who lives there. Affordable and
// multi-family housing are NOT counted against a street. Keep it that way.
//
// Screening only. It doesn't feed the ARV, the comps or any number on The Underwrite: same-street comp matching was
// backtested (api/comps.js) and wasn't better, so the street shows up here as a warning, not a price adjustment. The
// thresholds in CHECKS are judgement, not backtested.
//
// Sources, all Mecklenburg County / City of Charlotte public ArcGIS (no key):
//   TaxParcel_camadata   -> land use, vacant/improved, grade, year built, heated sf, building value, last sale
//   TaxParcelSales       -> the sold-as-vacant flag on those last sales (a builder's lot purchase isn't a home sale)
//   TaxParcelBoundaries  -> the subject's centre when the CAMA record has no coordinates
//   Accela 1             -> address points, to tell N Davidson St from S Davidson St (CAMA drops the direction)
//   Accela 2 / 3         -> City / State maintained street centrelines (camera spot for Street View)
// Mecklenburg-only by design, same as api/gis.js and api/comps.js. Hit /api/street?pid=04118535
const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
const CAMA_LAYER   = `${MECK}/TaxParcel_camadata/MapServer/0`;
const SALES_LAYER  = `${MECK}/TaxParcelSales/MapServer/0`;
const PARCEL_LAYER = `${MECK}/TaxParcelBoundaries/MapServer/0`;
const CITY = 'https://gis.charlottenc.gov/arcgis/rest/services/Accela/Accela/MapServer';
const ADDRESS_LAYER = 1, STREET_LAYERS = [2, 3];
const CAMA_FIELDS = 'pid,streetname,streetnumber,neighborhood,neighbordesc,lusecode,landuse_description,vacorimprov,'
  + 'grade,yearbuilt,heatedarea,totalbldgval,saleprice,saledate,validsale,xcoord,ycoord,ownrlstnme,ownrfrstnme';

export const STREET_FT = 1000;   // how far along the street, each way, counts as "this street" (about two blocks)
const NEAR_FT = 300;             // parcels this close stand in for a new lot that has no neighbourhood code yet
const CAMERA_MAX_FT = 400;       // a centreline further than this from the lot isn't its street
const SALE_MONTHS = 60;          // one street has only a few sales a year; the same window applies to both sides
const MIN_SALE = 50000;          // drops family transfers the validity code missed
const NEW_SINCE = 2020;          // same "new build" line as api/comps.js minYear
const AREA_FT = 2640;            // the fallback comparison area: every parcel within half a mile
const MIN_AREA_HOMES = 30;       // fewer homes than this in the assessor neighbourhood: too few to compare with
// The assessor also codes parcels to commercial market areas ("APARTMENT - NORTHWEST SUBMARKET", "RETAIL - …",
// "OFFICE - …", "INDUSTRIAL - …", codes AP / RE / OF / IN), which aren't neighbourhoods.
const COMMERCIAL_AREA = /SUBMARKET/i;
const PAGE = 2000, MAX_PAGES = 4;  // CAMA maxRecordCount is 2000; the largest neighbourhoods are ~3,300 parcels
const PID_CHUNK = 250;             // parcel ids per sales-layer query (POST, so no URL limit)
// Sale-validity codes counted as market sales: blank = arm's length, Z = builder sale (same as api/comps.js).
export const MARKET_VALIDITY = ['', 'Z'];
const GRADE_RANK = { MINIMUM:1, FAIR:2, AVERAGE:3, GOOD:4, 'VERY GOOD':5, EXCELLENT:6, CUSTOM:6 };
// Commercial, industrial and office land uses, plus utility and rail parcels: the traffic, noise and truck
// neighbours that make a street harder to sell. Churches, schools, parks, multi-family and affordable housing are not
// counted.
const NONRES_USE = /^(C|I|O)\d/i, NONRES_CODES = ['9100', '9404'];

// What "weaker" means, check by check. `enough` is the evidence both sides need (else "Too few"); `gap` is the
// street's value relative to the area's ('rel', a fraction) or minus it ('pts', percentage points).
const CHECKS = [
  {key:'sale_psf', label:'Recent sales, $/sf', gap:'rel',
    enough:(s,n)=>s.sale_count>=3 && n.sale_count>=5, weaker:g=>g<=-0.15, stronger:g=>g>=0.10},
  {key:'value_psf', label:'Assessed building value, $/sf', gap:'rel',
    enough:(s,n)=>s.value_count>=5 && n.value_count>=10, weaker:g=>g<=-0.15, stronger:g=>g>=0.15},
  {key:'below_avg_pct', label:'Homes graded below Average', gap:'pts',
    enough:(s,n)=>s.graded>=5 && n.graded>=10, weaker:g=>g>=15},
  {key:'vacant_pct', label:'Vacant lots', gap:'pts',
    enough:(s,n)=>s.parcels>=5 && n.parcels>=10, weaker:(g,s)=>s.vacant>=2 && g>=10},
  {key:'nonres_pct', label:'Commercial / industrial parcels', gap:'pts',
    enough:(s,n)=>s.parcels>=5 && n.parcels>=10, weaker:(g,s)=>s.nonres>=2 && g>=10},
  {key:'new_builds_pct', label:`Homes built ${NEW_SINCE}+`, gap:'pts', info:true,   // a good sign, never a weakness
    enough:(s,n)=>s.homes>=5 && n.homes>=10, stronger:(g,s)=>s.new_builds>=2 && g>=10},
];

async function ajPost(url, params){
  const body = new URLSearchParams(params).toString();
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body});
  if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||''));
  return j;
}
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const sq = s => String(s).replace(/'/g, "''");
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1;
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }
const pct = (n, d) => d ? Math.round(n/d*1000)/10 : null;
// Local plane: feet east / north of a reference point. Good to a fraction of a foot over a few blocks.
function toFt(ref, lat, lng){ const k=364000; return {x:(lng-ref.lng)*k*Math.cos(ref.lat*Math.PI/180), y:(lat-ref.lat)*k}; }
function fromFt(ref, p){ const k=364000; return {lat:ref.lat+p.y/k, lng:ref.lng+p.x/(k*Math.cos(ref.lat*Math.PI/180))}; }
function bearing(a, b){ const r=d=>d*Math.PI/180, y=Math.sin(r(b.lng-a.lng))*Math.cos(r(b.lat)),
  x=Math.cos(r(a.lat))*Math.sin(r(b.lat))-Math.sin(r(a.lat))*Math.cos(r(b.lat))*Math.cos(r(b.lng-a.lng));
  return (Math.atan2(y,x)*180/Math.PI+360)%360; }

// Every row matching a where / spatial filter, paged.
async function allRows(layer, params, outFields){
  const rows = [];
  for(let p=0; p<MAX_PAGES; p++){
    const j = await ajPost(`${layer}/query`, Object.assign({outFields, returnGeometry:'false',
      resultOffset:String(p*PAGE), resultRecordCount:String(PAGE), f:'json'}, params));
    (j.features||[]).forEach(f=>rows.push(f.attributes));
    if(!j.exceededTransferLimit && (j.features||[]).length < PAGE) return {rows, truncated:false};
  }
  return {rows, truncated:true};
}
const camaRows = params => allRows(CAMA_LAYER, Object.assign({orderByFields:'objectid_1'}, params), CAMA_FIELDS);
const within = (lat, lng, ft) => ({geometry:`${lng},${lat}`, geometryType:'esriGeometryPoint', inSR:'4326',
  spatialRel:'esriSpatialRelIntersects', distance:String(ft), units:'esriSRUnit_Foot'});

// isVacant / isNonRes / isHome are exported for api/mcp.js, which labels each house on the street the same way.
export function isVacant(r){ return /^VAC/i.test((r.vacorimprov||'').trim()) && !(num(r.heatedarea)>0); }
// Some homes carry a commercial code ("C700 MULTI FAMILY", "O400 MULTI FAMILY"): the description decides, so housing of
// any kind never counts as a commercial neighbour. A commercial, office or warehouse condominium is still commercial.
const HOUSING_DESC = /RESIDENTIAL|MULTI ?FAMIL|APARTMENT|AFFORDABLE|CONDO|TOWN ?HOUSE|DUPLEX|TRIPLEX|MOBILE HOME|HOME FOR THE AGED/i;
const BUSINESS_DESC = /COMMERCIAL|OFFICE|WAREHOUSE|MEDICAL|RETAIL|INDUSTRIAL|HOTEL/i;
export function isNonRes(r){ const c=(r.lusecode||'').trim(), d=r.landuse_description||'';
  return (NONRES_USE.test(c) || NONRES_CODES.includes(c)) && (BUSINESS_DESC.test(d) || !HOUSING_DESC.test(d)); }
export function isHome(r){ const c=(r.lusecode||'').trim(), d=(r.landuse_description||'');
  return num(r.heatedarea)>0 && (/^R/i.test(c) || (!c && /RESIDENTIAL|TOWN ?HOUSE|CONDO/i.test(d))); }
// The CAMA row carries each parcel's last sale. A home sale counts when it's market-valid (blank or Z), in the window,
// and not before the house was built (that sold the lot or the old house; same rule as api/comps.js).
function isHomeSale(r, since){
  const v=(r.validsale||'').trim().toUpperCase(), d=r.saledate, p=num(r.saleprice);
  if(!isHome(r) || !MARKET_VALIDITY.includes(v) || !(p>=MIN_SALE) || !(typeof d==='number' && d>=since)) return false;
  return !(r.yearbuilt && new Date(d).getUTCFullYear() < r.yearbuilt);
}
// Parcels whose newest market-valid sale in the window was sold as vacant: a builder's lot purchase in the year the house
// was built passes the year-built test, and at lot price it would drag the street's $/sf down (api/comps.js drops these
// too; the county stores the flag as 'Yes' / 'No').
async function lotSalePids(pids, since){
  const lots = new Set(), iso = new Date(since).toISOString().slice(0,10);
  for(let i=0; i<pids.length; i+=PID_CHUNK){
    const chunk = pids.slice(i, i+PID_CHUNK);
    const {rows} = await allRows(SALES_LAYER, {where:`parcelid IN (${chunk.map(p=>`'${sq(p)}'`).join(',')}) AND saledate >= DATE '${iso}'`,
      orderByFields:'objectid'}, 'parcelid,saledate,salesvalidity,soldasvacantflag');
    const newest = new Map();
    rows.forEach(a=>{ if(!MARKET_VALIDITY.includes((a.salesvalidity||'').trim().toUpperCase())) return;
      const prev = newest.get(a.parcelid); if(!prev || (a.saledate||0) > (prev.saledate||0)) newest.set(a.parcelid, a); });
    newest.forEach((a, p)=>{ if(/^Y/i.test((a.soldasvacantflag||'').trim())) lots.add(p); });
  }
  return lots;
}

function profile(rows, since, lots){
  const homes = rows.filter(isHome);
  const vacant = rows.filter(isVacant).length;
  const nonres = rows.filter(isNonRes);
  const uses = {}; nonres.forEach(r=>{ const u=(r.landuse_description||r.lusecode||'').trim(); uses[u]=(uses[u]||0)+1; });
  const rated = homes.map(r=>GRADE_RANK[(r.grade||'').trim().toUpperCase()]).filter(Boolean);
  const below = rated.filter(g=>g<=2).length, goodPlus = rated.filter(g=>g>=4).length;
  const medRank = rated.length ? Math.round(median(rated)) : null;
  const years = homes.map(r=>r.yearbuilt).filter(y=>y>1800);
  const newB = years.filter(y=>y>=NEW_SINCE).length;
  const vpsf = homes.map(r=>num(r.totalbldgval)/num(r.heatedarea)).filter(v=>isFinite(v)&&v>0);
  const sold = rows.filter(r=>isHomeSale(r, since)), lotSales = sold.filter(r=>lots.has(r.pid)).length;
  const sales = sold.filter(r=>!lots.has(r.pid)).map(r=>num(r.saleprice)/num(r.heatedarea));
  return {
    parcels: rows.length, homes: homes.length,
    vacant, vacant_pct: pct(vacant, rows.length),
    nonres: nonres.length, nonres_pct: pct(nonres.length, rows.length),
    nonres_uses: Object.entries(uses).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([use,n])=>({use,n})),
    graded: rated.length, below_avg: below, below_avg_pct: pct(below, rated.length), good_plus_pct: pct(goodPlus, rated.length),
    median_grade: medRank ? Object.keys(GRADE_RANK).find(k=>GRADE_RANK[k]===medRank) : null,
    median_year_built: years.length ? Math.round(median(years)) : null,
    new_builds: newB, new_builds_pct: pct(newB, years.length),
    value_psf: vpsf.length ? Math.round(median(vpsf)) : null, value_count: vpsf.length,
    sale_psf: sales.length ? Math.round(median(sales)) : null, sale_count: sales.length, lot_sales_left_out: lotSales,
  };
}

// Street vs area, check by check. 'thin' = too little evidence on either side to say.
function compare(s, n){
  return CHECKS.map(c=>{
    const a = s[c.key], b = n[c.key];
    const g = (a==null || b==null) ? null : c.gap==='rel' ? (b ? a/b-1 : null) : a-b;
    const verdict = (g==null || !c.enough(s,n)) ? 'thin' : (c.weaker && c.weaker(g,s)) ? 'weaker'
      : (c.stronger && c.stronger(g,s)) ? 'stronger' : 'similar';
    return {key:c.key, label:c.label, verdict, street:a, nbh:b, gap:g==null?null:Math.round(c.gap==='rel'?g*100:g)};
  });
}
// area: 'its neighbourhood' or 'the half mile around it'
function verdictFor(checks, s, area){
  const weak = checks.filter(c=>c.verdict==='weaker'), strong = checks.filter(c=>c.verdict==='stronger');
  const info = new Set(CHECKS.filter(c=>c.info).map(c=>c.key));
  const judged = checks.filter(c=>c.verdict!=='thin' && !info.has(c.key)).length;
  const names = a => a.map(c=>c.label.toLowerCase()).join(', ');
  if(s.homes < 3 && !weak.length) return {level:'thin', text:`Only ${s.homes} home${s.homes===1?'':'s'} on this stretch of street, too few to compare. Walk it in Street View.`};
  if(weak.length >= 2) return {level:'weaker', text:`This street looks weaker than ${area} on ${weak.length} of ${judged} checks (${names(weak)}). Walk it before you trust the area's numbers.`};
  if(weak.length === 1) return {level:'watch', text:`One check is weaker than ${area} (${names(weak)}). Walk the street to see whether it shows.`};
  return {level:'in-line', text:`In line with ${area} on the county data${strong.length?` (stronger on ${names(strong)})`:''}. Still walk it: the records can't see upkeep, traffic or what's across the street.`};
}

// The nearest point on the lot's street centreline, in the local plane around ref (the lot), and that line's name.
function nearestOnLine(ref, layers){
  let best = null;
  (layers||[]).forEach(j=>(j.features||[]).forEach(f=>((f.geometry&&f.geometry.paths)||[]).forEach(path=>{
    for(let i=0;i<path.length-1;i++){
      const A=toFt(ref,path[i][1],path[i][0]), B=toFt(ref,path[i+1][1],path[i+1][0]);
      const dx=B.x-A.x, dy=B.y-A.y, L=dx*dx+dy*dy;
      const t=L?Math.max(0,Math.min(1,(-A.x*dx-A.y*dy)/L)):0;
      const C={x:A.x+t*dx, y:A.y+t*dy}, d=Math.hypot(C.x, C.y);
      if(!best || d<best.d) best={d, pt:C, name:((f.attributes&&f.attributes.WHOLESTNAME)||'').trim().toUpperCase()};
    }
  })));
  return best;
}

// The lot's own street centreline near it (City and State maintained layers). CAMA drops the direction ("DAVIDSON ST"
// for N and S Davidson); the centreline keeps it ("N DAVIDSON ST").
// A layer that doesn't answer comes back empty with `failed` set, so the caller can say so: an outage isn't "no
// centreline here".
function centrelines(street, lat, lng){
  return Promise.all(STREET_LAYERS.map(l=>ajPost(`${CITY}/${l}/query`, Object.assign({
    where:`WHOLESTNAME='${sq(street)}' OR WHOLESTNAME LIKE '% ${sq(street)}'`, outFields:'WHOLESTNAME',
    returnGeometry:'true', outSR:'4326', f:'json'}, within(lat, lng, CAMERA_MAX_FT))).catch(e=>({features:[], failed:e.message}))));
}
// The first centreline layer that didn't answer, as an errors entry (v8.22), or null
function centrelineError(layers){ const f = (layers||[]).find(j=>j && j.failed);
  return f ? `centreline: ${f.failed} (so the street's N / S half and the Street View facing couldn't be checked)` : null; }
// The centreline's name when it's this street with a direction ("N DAVIDSON ST" for CAMA's "DAVIDSON ST"), else null
function directedName(cam, street){ const m = cam && cam.name && cam.name.match(/^(N|S|E|W)\s+(.+)$/); return m && m[2]===street ? cam.name : null; }
// Where a Street View camera should stand (the nearest point on that centreline) and which way it faces (the lot).
// The Maps Embed key goes out only with mode=view, which only streetview.html asks for: the embed must never share a
// screen with the analyzer's non-Google maps (Maps Platform ToS §3.2.3(e)).
function streetviewFor(lat, lng, cam, withKey){
  const camera = cam && cam.d>=5 ? fromFt({lat, lng}, cam.pt) : null;
  const sv = {
    lat, lng,
    camera: camera ? {lat:+camera.lat.toFixed(7), lng:+camera.lng.toFixed(7), ft_from_lot:Math.round(cam.d), street:cam.name||null} : null,
    heading: camera ? Math.round(bearing(camera, {lat, lng})) : null,
  };
  // browser-side by design (it's in the embed URL), so it's restricted to the Maps Embed API and by HTTP referrer in
  // Google Cloud, and set in Vercel env only
  if(withKey) sv.embed_key = process.env.GOOGLE_MAPS_EMBED_KEY || null;
  return sv;
}
const NO_CENTRELINE = 'No City or State maintained centreline for this street near the lot (a private street?), so Street View opens at the lot without a facing.';

export default async function handler(req, res){
  const q = req.query || {};
  const view = q.mode === 'view';   // streetview.html: the lot and its camera spot only, no county profile
  // mode=view carries the embed key, so it is same-origin only: another site can't read the key from here
  if(!view) res.setHeader('Access-Control-Allow-Origin','*');
  const pid = (q.pid||'').trim().toUpperCase();   // county PIDs are upper case ("08308C99"); the CAMA match is exact
  const ft = Math.min(Math.max(parseInt(q.ft)||STREET_FT, 300), 2640);
  if(!/^[0-9A-Z]{8}$/i.test(pid)){ res.setHeader('Cache-Control','no-store'); res.status(400).json({error:'pass ?pid= (an 8-character Mecklenburg parcel id)'}); return; }
  const out = await streetCheck(pid, ft, view);
  // a partial answer (a county layer down) isn't cached, so a re-check can get the whole one
  res.setHeader('Cache-Control', out.errors.length ? 'no-store' : 's-maxage=3600, stale-while-revalidate');
  res.status(200).json(out);
}

// The street check for one parcel: the /api/street answer, for an upper-case 8-character PID. api/mcp.js (the TTV
// Street Data connector's find_street) calls it too, with a `keep` object, and lists the street house by house from
// what it gets back: keep.rows, this street's CAMA rows after the direction filter and before the same-site rule (the
// subject included; null when there's no street), and keep.subject, the subject's own row. Neither goes into the
// answer, so /api/street is unchanged. The rows carry the CAMA owner fields the same-site rule reads: a caller must
// never pass them on.
export async function streetCheck(pid, ft, view, keep){
  const out = {subject:null, params:{pid, ft, months:SALE_MONTHS, new_since:NEW_SINCE}, street:null, neighborhood:null,
    checks:[], verdict:null, streetview:null, notes:[], errors:[]};
  try{
    // 1) the subject: street name, neighbourhood code and a point
    const sj = await ajPost(`${CAMA_LAYER}/query`, {where:`pid='${sq(pid)}'`, outFields:CAMA_FIELDS, returnGeometry:'false', f:'json'});
    const a = (sj.features||[])[0] && sj.features[0].attributes;
    if(!a){ out.errors.push('No assessor record for PID '+pid+'.'); return out; }
    if(keep) keep.subject = a;
    let lat = num(a.xcoord), lng = num(a.ycoord);   // camadata stores latitude in xcoord, longitude in ycoord
    if(lat==null || lng==null){
      try{
        const pj = await ajPost(`${PARCEL_LAYER}/query`, {where:`pid='${sq(pid)}'`, outFields:'pid', returnGeometry:'true', outSR:'4326', f:'json'});
        const r = (pj.features||[])[0] && pj.features[0].geometry && pj.features[0].geometry.rings && pj.features[0].geometry.rings[0];
        if(r && r.length){ lng = r.reduce((t,p)=>t+p[0],0)/r.length; lat = r.reduce((t,p)=>t+p[1],0)/r.length; }
      }catch(e){ out.errors.push('subject_parcel: '+e.message); }
    }
    const street = (a.streetname||'').trim().toUpperCase();
    const nb = {code:(a.neighborhood||'').trim()||null, name:(a.neighbordesc||'').trim()||null, inferred:false};
    out.subject = {pid, street:street||null, number:(a.streetnumber||'').trim()||null, lat, lng, neighborhood:nb};
    if(lat==null || lng==null){ out.errors.push('No location for PID '+pid+'.'); return out; }
    if(!street) out.notes.push('The assessor record has no street name for this lot, so there is no street to compare.');
    if(view){
      let cam = null, lineErr = null;
      if(street){ try{ const lines = await centrelines(street, lat, lng); cam = nearestOnLine({lat, lng}, lines); lineErr = centrelineError(lines); }
        catch(e){ lineErr = 'centreline: '+e.message; } }
      if(lineErr) out.errors.push(lineErr);
      out.subject.street_label = directedName(cam, street) || street || null;
      out.streetview = streetviewFor(lat, lng, cam, true);
      if(street && !out.streetview.camera && !lineErr) out.notes.push(NO_CENTRELINE);
      return out;
    }

    // 2) independent, non-fatal, in parallel: this street, the street centreline, and the neighbourhood when the lot
    //    has a code (else the parcels right around it, to borrow one)
    const useCode = nb.code && !COMMERCIAL_AREA.test(nb.name||'');
    const [stR, lineR, nbR, nearR] = await Promise.allSettled([
      street ? camaRows(Object.assign({where:`streetname='${sq(street)}'`}, within(lat, lng, ft))) : Promise.resolve(null),
      street ? centrelines(street, lat, lng) : Promise.resolve(null),
      useCode ? camaRows({where:`neighborhood='${sq(nb.code)}'`}) : Promise.resolve(null),
      nb.code ? Promise.resolve(null) : camaRows(Object.assign({where:'1=1'}, within(lat, lng, NEAR_FT))),
    ]);
    if(stR.status==='rejected') out.errors.push('street: '+stR.reason.message);
    if(nbR.status==='rejected') out.errors.push('neighborhood: '+nbR.reason.message);
    if(nearR.status==='rejected') out.errors.push('nearby: '+nearR.reason.message);
    const cam = lineR.status==='fulfilled' ? nearestOnLine({lat, lng}, lineR.value) : null;
    // a centreline layer down: no direction filter, so both halves of a N / S street are counted (v8.22: said, not silent)
    const lineErr = lineR.status==='fulfilled' ? centrelineError(lineR.value) : 'centreline: '+lineR.reason.message;
    if(lineErr) out.errors.push(lineErr);

    // 3) the street. With a direction on the centreline ("N DAVIDSON ST"), parcels addressed on the other half
    //    ("S DAVIDSON ST", or no direction) are dropped, since CAMA files both under "DAVIDSON ST".
    let stRows = stR.status==='fulfilled' && stR.value ? stR.value.rows : null, label = street;
    const dm = directedName(cam, street);
    if(stRows && dm){
      label = dm;
      try{
        const nm = street.split(/\s+/).slice(0,-1).join(' ') || street;   // "DAVIDSON ST" -> DAVIDSON (type dropped)
        // the direction letter ("N DAVIDSON ST" -> N). Before v8.22 this compared with dm[1], the name's second
        // character (a space), which dropped the lot's own half too.
        const dir = dm.split(/\s+/)[0];
        const {rows} = await allRows(`${CITY}/${ADDRESS_LAYER}`, Object.assign({
          where:`nme_street='${sq(nm)}' AND (cde_street_dir_prfx IS NULL OR cde_street_dir_prfx<>'${sq(dir)}')`,
          orderByFields:'OBJECTID'}, within(lat, lng, ft)), 'TAX_PID,GIS_PID');
        const other = new Set(); rows.forEach(r=>{ if(r.TAX_PID) other.add(r.TAX_PID); if(r.GIS_PID) other.add(r.GIS_PID); });
        const before = stRows.length; stRows = stRows.filter(r=>!other.has(r.pid));
        if(stRows.length < before) out.notes.push(`${before-stRows.length} parcel${before-stRows.length===1?'':'s'} on the other half of ${street} (not ${cam.name}) left out.`);
      }catch(e){ out.errors.push('direction: '+e.message); }
    }
    if(keep) keep.rows = stRows;
    out.subject.street_label = label || null;
    // The rest of the same site: other vacant lots with the subject's owner on the street (a three-lot sub-division
    // shouldn't count its own lots against the street). Only unbuilt lots, so a builder's finished homes still count.
    const own = (a.ownrlstnme||'').trim().toUpperCase()+'|'+(a.ownrfrstnme||'').trim().toUpperCase();
    const sameSite = r => !!(a.ownrlstnme||'').trim() && !(num(r.heatedarea)>0)
      && ((r.ownrlstnme||'').trim().toUpperCase()+'|'+(r.ownrfrstnme||'').trim().toUpperCase())===own;
    if(stRows){
      const rest = stRows.filter(r=>r.pid!==pid), kept = rest.filter(r=>!sameSite(r));
      if(kept.length < rest.length) out.notes.push(`${rest.length-kept.length} other unbuilt lot${rest.length-kept.length===1?'':'s'} with the subject's owner left out of the street (likely the same site).`);
      stRows = kept;
    }

    // 4) the comparison area: the assessor neighbourhood (the county's own market area, the strongest pricing signal
    //    in the comps backtest). A new lot borrows the most common code within NEAR_FT. A commercial market area
    //    ("RETAIL - NORTHEAST SUBMARKET"), a neighbourhood with few homes, or no code at all: everything within half a mile.
    let areaRows = null, area = null;
    if(nbR.status==='fulfilled' && nbR.value) areaRows = nbR.value;
    if(!nb.code && nearR.status==='fulfilled' && nearR.value){
      const count = {}; nearR.value.rows.forEach(r=>{ const c=(r.neighborhood||'').trim(); if(c && !COMMERCIAL_AREA.test(r.neighbordesc||'')){ count[c]=count[c]||{n:0,name:(r.neighbordesc||'').trim()}; count[c].n++; } });
      const best = Object.entries(count).sort((x,y)=>y[1].n-x[1].n)[0];
      if(best){ nb.code=best[0]; nb.name=best[1].name||null; nb.inferred=true;
        out.notes.push(`The lot has no assessor neighbourhood yet (a new lot), so it takes ${nb.name||nb.code}, the most common one within ${NEAR_FT} ft.`);
        try{ areaRows = await camaRows({where:`neighborhood='${sq(nb.code)}'`}); }catch(e){ out.errors.push('neighborhood: '+e.message); }
      }
    }
    if(areaRows){
      const homes = areaRows.rows.filter(r=>r.pid!==pid && isHome(r)).length;
      if(homes >= MIN_AREA_HOMES){
        area = {label:`${nb.name||'Neighbourhood'} (${nb.code})`, kind:'neighborhood', rows:areaRows.rows.filter(r=>r.pid!==pid)};
        if(areaRows.truncated) out.notes.push(`The neighbourhood has more than ${(PAGE*MAX_PAGES).toLocaleString()} parcels; the first ${(PAGE*MAX_PAGES).toLocaleString()} were used.`);
      } else out.notes.push(`The assessor neighbourhood (${nb.name||nb.code}) has only ${homes} home${homes===1?'':'s'}, so the street is compared with everything within half a mile instead.`);
    } else if(nb.code && !useCode && !nb.inferred) out.notes.push(`The lot's assessor code is a commercial market area (${nb.name}), not a neighbourhood, so the street is compared with everything within half a mile.`);
    else if(!nb.code) out.notes.push('No assessor neighbourhood for this lot or its neighbours, so the street is compared with everything within half a mile.');
    if(!area && stRows){
      try{
        const ar = await camaRows(Object.assign({where:'1=1'}, within(lat, lng, AREA_FT)));
        area = {label:'Everything within half a mile', kind:'radius', rows:ar.rows.filter(r=>r.pid!==pid)};
        if(ar.truncated) out.notes.push(`More than ${(PAGE*MAX_PAGES).toLocaleString()} parcels within half a mile; the first ${(PAGE*MAX_PAGES).toLocaleString()} were used.`);
      }catch(e){ out.errors.push('area: '+e.message); }
    }

    // 5) profiles, after one sold-as-vacant check over every home sale either side counts
    const since = Date.now() - SALE_MONTHS*30.44*86400000;
    let lots = new Set();
    const salePids = [...new Set([...(stRows||[]), ...(area?area.rows:[])].filter(r=>isHomeSale(r, since)).map(r=>r.pid))];
    try{ lots = await lotSalePids(salePids, since); }
    catch(e){ out.errors.push('sales: '+e.message+' (lot purchases may be counted as home sales)'); }
    if(stRows) out.street = Object.assign({label:`${label} within ${ft.toLocaleString()} ft`}, profile(stRows, since, lots));
    if(area) out.neighborhood = Object.assign({label:area.label, kind:area.kind}, profile(area.rows, since, lots));
    if(out.street && out.street.lot_sales_left_out) out.notes.push(`${out.street.lot_sales_left_out} lot purchase${out.street.lot_sales_left_out===1?'':'s'} (sold as vacant) left out of the street's sales.`);
    if(out.street && out.neighborhood){
      out.checks = compare(out.street, out.neighborhood);
      out.verdict = verdictFor(out.checks, out.street, out.neighborhood.kind==='radius'?'the half mile around it':'its neighbourhood');
    }

    // 6) Street View camera: the nearest point on the lot's own street centreline, facing the lot (no key: see mode=view)
    out.streetview = streetviewFor(lat, lng, cam, false);
    if(street && !out.streetview.camera && !lineErr) out.notes.push(NO_CENTRELINE);
  }catch(e){
    out.errors.push('fatal: '+e.message);
  }
  return out;
}
