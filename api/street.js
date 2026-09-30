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
// on the page is the plain Maps Embed (a person looks; nothing is read from the imagery).
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
//   TaxParcelBoundaries  -> the subject's centre when the CAMA record has no coordinates
//   Accela 2 / 3         -> City / State maintained street centrelines (camera spot for Street View)
// Mecklenburg-only by design, same as api/gis.js and api/comps.js. Hit /api/street?pid=04118535
const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
const CAMA_LAYER   = `${MECK}/TaxParcel_camadata/MapServer/0`;
const PARCEL_LAYER = `${MECK}/TaxParcelBoundaries/MapServer/0`;
const CITY = 'https://gis.charlottenc.gov/arcgis/rest/services/Accela/Accela/MapServer';
const STREET_LAYERS = [2, 3];
const CAMA_FIELDS = 'pid,streetname,streetnumber,neighborhood,neighbordesc,lusecode,landuse_description,vacorimprov,'
  + 'grade,yearbuilt,heatedarea,totalbldgval,saleprice,saledate,validsale,xcoord,ycoord,ownrlstnme,ownrfrstnme';

const STREET_FT = 1000;          // how far along the street, each way, counts as "this street" (about two blocks)
const NEAR_FT = 300;             // parcels this close stand in for a new lot that has no neighbourhood code yet
const CAMERA_MAX_FT = 400;       // a centreline further than this from the lot isn't its street
const SALE_MONTHS = 60;         // one street has only a few sales a year; the same window applies to both sides
const MIN_SALE = 50000;          // drops lot and family transfers the validity code missed
const NEW_SINCE = 2020;
const AREA_FT = 2640;            // the fallback comparison area: every parcel within half a mile
const MIN_AREA_HOMES = 30;       // fewer homes than this in the assessor neighbourhood: too few to compare with
// The assessor also codes parcels to commercial market areas ("APARTMENT - NORTHWEST SUBMARKET", "RETAIL - …",
// "OFFICE - …", "INDUSTRIAL - …", codes AP / RE / OF / IN), which aren't neighbourhoods.
const COMMERCIAL_AREA = /SUBMARKET/i;          // same "new build" line as api/comps.js minYear
const PAGE = 2000, MAX_PAGES = 4;  // CAMA maxRecordCount is 2000; the largest neighbourhoods are ~3,300 parcels
// Sale-validity codes counted as market sales: blank = arm's length, Z = builder sale (same as api/comps.js).
const MARKET_VALIDITY = ['', 'Z'];
const GRADE_RANK = { MINIMUM:1, FAIR:2, AVERAGE:3, GOOD:4, 'VERY GOOD':5, EXCELLENT:6, CUSTOM:6 };
// Commercial, industrial and office land uses, plus utility and rail parcels: the traffic, noise and truck
// neighbours that make a street harder to sell. Churches, schools, parks, multi-family and affordable housing are not
// counted.
const NONRES_USE = /^(C|I|O)\d/i, NONRES_CODES = ['9100', '9404'];

// What "weaker" means for each check. Minimum evidence on the street first, then the gap to the neighbourhood.
const CHECKS = {
  sale_psf:   { min:3, weaker:-0.15, stronger:0.10 },   // median recent sale $/sf, relative gap
  value_psf:  { min:5, weaker:-0.15, stronger:0.15 },   // median assessed building value $/sf, relative gap
  below_avg:  { min:5, weaker:15 },                     // % of homes graded Fair / Minimum, points above
  vacant:     { minCount:2, weaker:10 },                // % of parcels that are vacant lots, points above
  nonres:     { minCount:2, weaker:10 },                // % commercial / industrial / utility, points above
  new_builds: { minCount:2, stronger:10 },              // % of homes built NEW_SINCE+, points above (a good sign)
};

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
// Metres-free local plane: feet east / north of a reference point. Good to a fraction of a foot over a few blocks.
function toFt(ref, lat, lng){ const k=364000; return {x:(lng-ref.lng)*k*Math.cos(ref.lat*Math.PI/180), y:(lat-ref.lat)*k}; }
function fromFt(ref, p){ const k=364000; return {lat:ref.lat+p.y/k, lng:ref.lng+p.x/(k*Math.cos(ref.lat*Math.PI/180))}; }
function bearing(a, b){ const r=d=>d*Math.PI/180, y=Math.sin(r(b.lng-a.lng))*Math.cos(r(b.lat)),
  x=Math.cos(r(a.lat))*Math.sin(r(b.lat))-Math.sin(r(a.lat))*Math.cos(r(b.lat))*Math.cos(r(b.lng-a.lng));
  return (Math.atan2(y,x)*180/Math.PI+360)%360; }

// Every CAMA row matching a where / spatial filter, paged.
async function camaRows(params){
  const rows = [];
  for(let p=0; p<MAX_PAGES; p++){
    const j = await ajPost(`${CAMA_LAYER}/query`, Object.assign({outFields:CAMA_FIELDS, returnGeometry:'false',
      orderByFields:'objectid_1', resultOffset:String(p*PAGE), resultRecordCount:String(PAGE), f:'json'}, params));
    (j.features||[]).forEach(f=>rows.push(f.attributes));
    if(!j.exceededTransferLimit && (j.features||[]).length < PAGE) return {rows, truncated:false};
  }
  return {rows, truncated:true};
}
const within = (lat, lng, ft) => ({geometry:`${lng},${lat}`, geometryType:'esriGeometryPoint', inSR:'4326',
  spatialRel:'esriSpatialRelIntersects', distance:String(ft), units:'esriSRUnit_Foot'});

function isVacant(r){ return /^VAC/i.test((r.vacorimprov||'').trim()) && !(num(r.heatedarea)>0); }
// Some homes carry a commercial code ("C700 MULTI FAMILY", "O400 MULTI FAMILY"): the description decides, so housing of
// any kind never counts as a commercial neighbour.
const HOUSING_DESC = /RESIDENTIAL|MULTI ?FAMIL|APARTMENT|AFFORDABLE|CONDO|TOWN ?HOUSE|DUPLEX|TRIPLEX|MOBILE HOME|HOME FOR THE AGED/i;
function isNonRes(r){ const c=(r.lusecode||'').trim();
  return (NONRES_USE.test(c) || NONRES_CODES.includes(c)) && !HOUSING_DESC.test(r.landuse_description||''); }
function isHome(r){ const c=(r.lusecode||'').trim(), d=(r.landuse_description||'');
  return num(r.heatedarea)>0 && (/^R/i.test(c) || (!c && /RESIDENTIAL|TOWN ?HOUSE|CONDO/i.test(d))); }

function profile(rows, since){
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
  // The CAMA row carries each parcel's last sale. Counted: a market-valid sale in the window, not before the house
  // was built (that sold the lot or the old house; same rule as api/comps.js).
  const sales = homes.filter(r=>{
    const v=(r.validsale||'').trim().toUpperCase(), d=r.saledate, p=num(r.saleprice);
    if(!MARKET_VALIDITY.includes(v) || !(p>=MIN_SALE) || !(typeof d==='number' && d>=since)) return false;
    return !(r.yearbuilt && new Date(d).getUTCFullYear() < r.yearbuilt);
  }).map(r=>num(r.saleprice)/num(r.heatedarea));
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
    sale_psf: sales.length ? Math.round(median(sales)) : null, sale_count: sales.length,
  };
}

// Street vs neighbourhood, check by check. 'thin' = too little on the street to say.
function compare(s, n){
  const out = [];
  const rel = (a, b) => (a!=null && b) ? a/b-1 : null;
  const push = (key, label, verdict, street, nbh, gap) => out.push({key, label, verdict, street, nbh, gap});
  { const c=CHECKS.sale_psf, g=rel(s.sale_psf, n.sale_psf);
    push('sale_psf', 'Recent sales, $/sf', s.sale_count<c.min||g==null?'thin':g<=c.weaker?'weaker':g>=c.stronger?'stronger':'similar',
      s.sale_psf, n.sale_psf, g==null?null:Math.round(g*100)); }
  { const c=CHECKS.value_psf, g=rel(s.value_psf, n.value_psf);
    push('value_psf', 'Assessed building value, $/sf', s.value_count<c.min||g==null?'thin':g<=c.weaker?'weaker':g>=c.stronger?'stronger':'similar',
      s.value_psf, n.value_psf, g==null?null:Math.round(g*100)); }
  { const c=CHECKS.below_avg, g=(s.below_avg_pct!=null&&n.below_avg_pct!=null)?s.below_avg_pct-n.below_avg_pct:null;
    push('below_avg', 'Homes graded below Average', s.graded<c.min||g==null?'thin':g>=c.weaker?'weaker':'similar',
      s.below_avg_pct, n.below_avg_pct, g==null?null:Math.round(g)); }
  { const c=CHECKS.vacant, g=(s.vacant_pct!=null&&n.vacant_pct!=null)?s.vacant_pct-n.vacant_pct:null;
    push('vacant', 'Vacant lots', g==null?'thin':(s.vacant>=c.minCount&&g>=c.weaker)?'weaker':'similar',
      s.vacant_pct, n.vacant_pct, g==null?null:Math.round(g)); }
  { const c=CHECKS.nonres, g=(s.nonres_pct!=null&&n.nonres_pct!=null)?s.nonres_pct-n.nonres_pct:null;
    push('nonres', 'Commercial / industrial parcels', g==null?'thin':(s.nonres>=c.minCount&&g>=c.weaker)?'weaker':'similar',
      s.nonres_pct, n.nonres_pct, g==null?null:Math.round(g)); }
  { const c=CHECKS.new_builds, g=(s.new_builds_pct!=null&&n.new_builds_pct!=null)?s.new_builds_pct-n.new_builds_pct:null;
    push('new_builds', `Homes built ${NEW_SINCE}+`, g==null?'thin':(s.new_builds>=c.minCount&&g>=c.stronger)?'stronger':'similar',
      s.new_builds_pct, n.new_builds_pct, g==null?null:Math.round(g)); }
  return out;
}
// area: 'its neighbourhood' or 'the half mile around it'
function verdictFor(checks, s, area){
  const weak = checks.filter(c=>c.verdict==='weaker'), strong = checks.filter(c=>c.verdict==='stronger');
  const judged = checks.filter(c=>c.verdict!=='thin' && c.key!=='new_builds').length;
  const names = a => a.map(c=>c.label.toLowerCase()).join(', ');
  if(s.homes < 3 && !weak.length) return {level:'thin', text:`Only ${s.homes} home${s.homes===1?'':'s'} on this stretch of street, too few to compare. Walk it in Street View.`};
  if(weak.length >= 2) return {level:'weaker', text:`This street looks weaker than ${area} on ${weak.length} of ${judged} checks (${names(weak)}). Walk it before you trust the area's numbers.`};
  if(weak.length === 1) return {level:'watch', text:`One check is weaker than ${area} (${names(weak)}). Walk the street to see whether it shows.`};
  return {level:'in-line', text:`In line with ${area} on the county data${strong.length?` (stronger on ${names(strong)})`:''}. Still walk it: the records can't see upkeep, traffic or what's across the street.`};
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate');
  const q = req.query || {};
  const pid = (q.pid||'').trim();
  const ft = Math.min(Math.max(parseInt(q.ft)||STREET_FT, 300), 2640);
  const out = {subject:null, params:{pid, ft, months:SALE_MONTHS, new_since:NEW_SINCE}, street:null, neighborhood:null,
    checks:[], verdict:null, streetview:null, notes:[], errors:[]};
  if(!/^[0-9A-Z]{8}$/i.test(pid)){ res.status(400).json({error:'pass ?pid= (an 8-character Mecklenburg parcel id)'}); return; }

  try{
    // 1) the subject: street name, neighbourhood code and a point
    const sj = await ajPost(`${CAMA_LAYER}/query`, {where:`pid='${sq(pid)}'`, outFields:CAMA_FIELDS, returnGeometry:'false', f:'json'});
    const a = (sj.features||[])[0] && sj.features[0].attributes;
    if(!a){ out.errors.push('No assessor record for PID '+pid+'.'); res.status(200).json(out); return; }
    let lat = num(a.xcoord), lng = num(a.ycoord);   // camadata stores latitude in xcoord, longitude in ycoord
    if(lat==null || lng==null){
      try{
        const pj = await ajPost(`${PARCEL_LAYER}/query`, {where:`pid='${sq(pid)}'`, outFields:'pid', returnGeometry:'true', outSR:'4326', f:'json'});
        const r = (pj.features||[])[0] && pj.features[0].geometry && pj.features[0].geometry.rings && pj.features[0].geometry.rings[0];
        if(r && r.length){ lng = r.reduce((t,p)=>t+p[0],0)/r.length; lat = r.reduce((t,p)=>t+p[1],0)/r.length; }
      }catch(e){ out.errors.push('subject_parcel: '+e.message); }
    }
    const street = (a.streetname||'').trim().toUpperCase();
    out.subject = {pid, street:street||null, number:(a.streetnumber||'').trim()||null, lat, lng,
      neighborhood:{code:(a.neighborhood||'').trim()||null, name:(a.neighbordesc||'').trim()||null, inferred:false}};
    if(lat==null || lng==null){ out.errors.push('No location for PID '+pid+'.'); res.status(200).json(out); return; }
    if(!street) out.notes.push('The assessor record has no street name for this lot, so there is no street to compare.');

    // 2) this street, the parcels right around the lot, and the street centreline: independent, non-fatal
    const [stR, nearR, lineR] = await Promise.allSettled([
      street ? camaRows(Object.assign({where:`streetname='${sq(street)}'`}, within(lat, lng, ft))) : Promise.resolve(null),
      camaRows(Object.assign({where:'1=1'}, within(lat, lng, NEAR_FT))),
      street ? Promise.all(STREET_LAYERS.map(l=>ajPost(`${CITY}/${l}/query`, Object.assign({
        // CAMA drops the direction ("DAVIDSON ST" for N and S Davidson); the centreline keeps it ("N DAVIDSON ST")
        where:`WHOLESTNAME='${sq(street)}' OR WHOLESTNAME LIKE '% ${sq(street)}'`, outFields:'WHOLESTNAME',
        returnGeometry:'true', outSR:'4326', f:'json'}, within(lat, lng, CAMERA_MAX_FT))).catch(()=>({features:[]})))) : Promise.resolve(null),
    ]);
    if(stR.status==='rejected') out.errors.push('street: '+stR.reason.message);
    if(nearR.status==='rejected') out.errors.push('nearby: '+nearR.reason.message);

    // a new lot has no neighbourhood code yet: take the most common one right around it
    const nb = out.subject.neighborhood;
    if(!nb.code && nearR.status==='fulfilled'){
      const count = {}; nearR.value.rows.forEach(r=>{ const c=(r.neighborhood||'').trim(); if(c && !COMMERCIAL_AREA.test(r.neighbordesc||'')){ count[c]=count[c]||{n:0,name:(r.neighbordesc||'').trim()}; count[c].n++; } });
      const best = Object.entries(count).sort((x,y)=>y[1].n-x[1].n)[0];
      if(best){ nb.code=best[0]; nb.name=best[1].name||null; nb.inferred=true;
        out.notes.push(`The lot has no assessor neighbourhood yet (a new lot), so it takes ${nb.name||nb.code}, the most common one within ${NEAR_FT} ft.`); }
    }

    // 3) the neighbourhood
    const since = Date.now() - SALE_MONTHS*30.44*86400000;
    const own = (a.ownrlstnme||'').trim().toUpperCase()+'|'+(a.ownrfrstnme||'').trim().toUpperCase();
    // The subject and anything else its owner holds on the street (usually the rest of the same site) are left out,
    // so a three-lot sub-division doesn't count its own vacant lots against the street.
    const others = rows => rows.filter(r=>r.pid!==pid && !((r.ownrlstnme||'').trim() && ((r.ownrlstnme||'').trim().toUpperCase()+'|'+(r.ownrfrstnme||'').trim().toUpperCase())===own));
    if(stR.status==='fulfilled' && stR.value){
      const rows = others(stR.value.rows), mine = stR.value.rows.length - rows.length - (stR.value.rows.some(r=>r.pid===pid)?1:0);
      out.street = Object.assign({label:`${street} within ${ft.toLocaleString()} ft`}, profile(rows, since));
      if(mine>0) out.notes.push(`${mine} other parcel${mine===1?'':'s'} with the subject's owner left out of the street (likely the same site).`);
    }
    // The comparison area is the assessor neighbourhood: the county's own market area, the strongest pricing signal in
    // the comps backtest. Some homes sit in a commercial market area ("RETAIL - NORTHEAST SUBMARKET") with a handful
    // of homes, and some have no code at all; those compare with every parcel within half a mile instead.
    if(nb.code && COMMERCIAL_AREA.test(nb.name||'')) out.notes.push(`The lot's assessor code is a commercial market area (${nb.name}), not a neighbourhood, so the street is compared with everything within half a mile.`);
    else if(nb.code){
      try{
        const nr = await camaRows({where:`neighborhood='${sq(nb.code)}'`});
        const p = profile(others(nr.rows), since);
        if(p.homes >= MIN_AREA_HOMES){
          out.neighborhood = Object.assign({label:`${nb.name||'Neighbourhood'} (${nb.code})`, kind:'neighborhood'}, p);
          if(nr.truncated) out.notes.push(`The neighbourhood has more than ${(PAGE*MAX_PAGES).toLocaleString()} parcels; the first ${(PAGE*MAX_PAGES).toLocaleString()} were used.`);
        } else out.notes.push(`The assessor neighbourhood (${nb.name||nb.code}) has only ${p.homes} home${p.homes===1?'':'s'}, so the street is compared with everything within half a mile instead.`);
      }catch(e){ out.errors.push('neighborhood: '+e.message); }
    } else out.notes.push('No assessor neighbourhood for this lot or its neighbours, so the street is compared with everything within half a mile.');
    if(!out.neighborhood){
      try{
        const ar = await camaRows(Object.assign({where:'1=1'}, within(lat, lng, AREA_FT)));
        out.neighborhood = Object.assign({label:'Everything within half a mile', kind:'radius'}, profile(others(ar.rows), since));
        if(ar.truncated) out.notes.push(`More than ${(PAGE*MAX_PAGES).toLocaleString()} parcels within half a mile; the first ${(PAGE*MAX_PAGES).toLocaleString()} were used.`);
      }catch(e){ out.errors.push('area: '+e.message); }
    }

    if(out.street && out.neighborhood){
      out.checks = compare(out.street, out.neighborhood);
      out.verdict = verdictFor(out.checks, out.street, out.neighborhood.kind==='radius'?'the half mile around it':'its neighbourhood');
    }

    // 4) Street View camera: the nearest point on the lot's own street centreline, facing the lot
    const ref = {lat, lng};
    let cam = null;
    if(lineR.status==='fulfilled' && lineR.value){
      const P = {x:0, y:0};
      lineR.value.forEach(j=>(j.features||[]).forEach(f=>((f.geometry&&f.geometry.paths)||[]).forEach(path=>{
        for(let i=0;i<path.length-1;i++){
          const A=toFt(ref,path[i][1],path[i][0]), B=toFt(ref,path[i+1][1],path[i+1][0]);
          const dx=B.x-A.x, dy=B.y-A.y, L=dx*dx+dy*dy;
          const t=L?Math.max(0,Math.min(1,((P.x-A.x)*dx+(P.y-A.y)*dy)/L)):0;
          const C={x:A.x+t*dx, y:A.y+t*dy}, d=Math.hypot(C.x, C.y);
          if(!cam || d<cam.d) cam={d, pt:C, name:f.attributes&&f.attributes.WHOLESTNAME};
        }
      })));
    }
    const camera = cam && cam.d>=5 ? fromFt(ref, cam.pt) : null;
    out.streetview = {
      lat, lng,
      camera: camera ? {lat:+camera.lat.toFixed(7), lng:+camera.lng.toFixed(7), ft_from_lot:Math.round(cam.d), street:cam.name||null} : null,
      heading: camera ? Math.round(bearing(camera, ref)) : null,
      // Maps Embed API key: browser-side by design, so it's restricted by HTTP referrer in Google Cloud, and set in
      // Vercel env only. Without it the page links out to Google Maps instead of embedding.
      embed_key: process.env.GOOGLE_MAPS_EMBED_KEY || null,
    };
    if(!camera) out.notes.push('No City or State maintained centreline for this street near the lot (a private street?), so Street View opens at the lot without a facing.');

    res.status(200).json(out);
  }catch(e){
    out.errors.push('fatal: '+e.message);
    res.status(200).json(out);
  }
}
