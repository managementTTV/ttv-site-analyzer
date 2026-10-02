// api/comps.js — TTV new-construction comps (Charlotte / Mecklenburg)  v1
//
// Phase 2 of the underwriting flow: given a subject parcel, return the recent NEW-BUILD sales
// around it and a suggested retail $/sf, following the Deal Analyst SOP's own comping rules.
//
// Source: Mecklenburg County's public ArcGIS servers — no key, no signup.
//   TaxParcelSales     -> every recorded transfer with the assessor's sale-validity code
//   TaxParcel_camadata -> year built, heated area, beds/baths, grade, lat/lng for each parcel
// The two are joined on PID, because the sales layer carries no building attributes.
//
// SOP rules encoded here (Deal Analyst SOP, LAND DEALS / STEP 3):
//   - comps built 2020+ give market context; comps built 2025+ are the "solid" set
//   - compute BOTH absolute sold prices and average $/sf
//   - cap the ARV at the highest sold comp — never let $/sf math run past a real sale
//   - 0-1 solid comps, or luxury-tier ARV (> $1M), is a red flag to surface, not to hide
//   - comps are SIZE-MATCHED to the subject (SOP: +/-200 sf first, widen only if you must)
//
// Backtested 2026-09-22 against Pat's historical underwritings. A flat median of every new build
// within half a mile missed her number by 10.3% (median absolute error). Size-matching cut that
// to 7.1%. Matching on the assessor's NEIGHBOURHOOD code cut it to ~4.2%: that code is the
// county's own market-area definition, built for mass appraisal, so it captures the pocket
// boundaries that a half-mile radius blurs (the NoDa and Keswick misses were exactly this).
// Same-street matching was tested too and was NOT better (8.7% on a small sample), so the
// cascade below stops at the neighbourhood.
//
// THE TEAM RULE (v8.23, Brian 2026-10-01): comp the way the team actually comps. Sales from the
// last 12 months, within half a mile, that don't cross a major road, of the same product we plan to
// build (townhomes comp townhomes), at the same finish (a Slate build isn't a luxury build).
// The rule set is filtered first, then the neighbourhood / size cascade below runs inside it. When fewer
// than MIN_POOL sales meet the rule, the search steps out one rule at a time in a fixed order (older
// sales, then across a major road, then any finish, then any product), each step at lower confidence,
// and says which rule it relaxed (STEPS).
//   - major roads: the City's thoroughfare map (freeways and major thoroughfares, existing only).
//     A comp is "across" when the straight line from the lot to it crosses one.
//   - product: the assessor's building type (TOWNHOUSE / SINGLE FAMILY RESIDENTIAL / DUPLEX-...).
//     A duet side sells as an attached home, so a duet comps against townhouses.
//   - finish: the assessor's construction grade, the county appraiser's quality class. On 1,012
//     nearby 2020+ sales: Average $211/sf, Good $266, Very Good $313, Excellent $430 (median).
//     Slate-owned homes the county has graded are Average. "Slate standard" = Minimum to Good.
// Backtest 2026-10-01 (research/11), this code against v8.20 on 80 of Pat's sheets: within ±10% of her
// number 68% -> 73%, within ±15% 76% -> 85%, misses over 10% 25 -> 20, bias +2.1% -> +0.4%; within ±5%
// 54% -> 46% and median miss 4.8% -> 5.4%. It fixes most of the old hot-pocket overestimates (Katonah
// +26% -> -6%, Carolyn +29% -> -5%, Briar Creek +32% -> -3%), which were luxury and cross-thoroughfare
// sales. The rule alone prices about half the deals, because deed records are thinner than the MLS.
// Fewer than MIN_POOL new builds even with every rule relaxed = no suggested ARV. v8.20 gave a LOW one off
// 1-2 sales; three of the four deals it priced that way in the backtest missed by 20-43%.
//
// Mecklenburg-only by design, same as api/gis.js. Other counties fall back to DealMachine.
// Deploy on Vercel; hit /api/comps?pid=08915115&sf=1854&radius=0.5&product=duet&finish=standard
const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
const SR = 2264;                 // NC State Plane ft — the county's native projection
const MI_FT = 5280;
const SALES_LAYER = `${MECK}/TaxParcelSales/MapServer/0`;
const CAMA_LAYER  = `${MECK}/TaxParcel_camadata/MapServer/0`;
const PARCEL_LAYER= `${MECK}/TaxParcelBoundaries/MapServer/0`;
// Newly built parcels often carry no situs address in CAMA yet, so fall back to the county's
// Master Address Points, which are assigned as soon as the lot is recorded.
const MAT_LAYER   = `${MECK}/MasterAddressPoints/MapServer/0`;

// Sale-validity codes. Blank = no disqualification (arm's length). Z = builder sale, which is
// exactly the new-build resale TTV is pricing — the assessor excludes those from ratio studies,
// but for us they are the best comps on the board. Every other code is a disqualified transfer
// (multi-parcel conveyance, related parties, foreclosure, <=$3,000, etc.).
const MARKET_VALIDITY = ['', 'Z'];
// Residential land-use codes worth comping against a new single-family / townhome build.
const RES_USE = /^R(1\d\d|2\d\d|3\d\d)$/;
// Size matching. Backtest showed +/-20% of the subject's heated area is the sweet spot; widening
// to +/-40% recovers thin pockets at some cost in accuracy.
const SIZE_BAND = 0.20, SIZE_BAND_WIDE = 0.40, MIN_IN_BAND = 3;

// The team rule (see the header). TEAM_MONTHS is the window the team comps in; WIDE_MONTHS is how far back the
// first fallback step reaches. MIN_POOL sales must meet a step before its comps are used.
const TEAM_MONTHS = 12, WIDE_MONTHS = 24, MIN_POOL = 3;
// City of Charlotte thoroughfare map. Existing freeways (EXFRY), major thoroughfares (EXMJTH, EXMJTH-C3C) and the
// C2EX parkways (Billy Graham, Brookshire, WT Harris, Johnston, Lancaster). Minor thoroughfares (Briar Creek Rd,
// E 36th St) aren't barriers, and PROP* rows are roads that don't exist yet. The layer is in the county's NC State
// Plane, so it takes the same search box as the sales query.
const ROAD_LAYER = 'https://gis.charlottenc.gov/arcgis/rest/services/Accela/Accela/MapServer/5';
const MAJOR_ROAD_TYPES = ['EXFRY','EXMJTH','EXMJTH-C3C','C2EX'];
// The product we plan to build -> the assessor building types that comp it. A duet side is sold as an attached
// home (sublotted), so it comps against townhouses; a duplex package would be an investor sale, not a retail comp.
const PRODUCT_TYPES = {
  sfh: ['SINGLE FAMILY RESIDENTIAL'],
  th: ['TOWNHOUSE'],
  duet: ['TOWNHOUSE'],
  mf: ['DUPLEX-TRIPLEX-QUADRAPLEX','TOWNHOUSE'],
};
const PRODUCT_LABEL = {sfh:'single-family', th:'townhome', duet:'attached (duet / townhome)', mf:'plex / townhome', any:'any product'};
const PRODUCT_OF_TYPE = {'SINGLE FAMILY RESIDENTIAL':'sfh', 'TOWNHOUSE':'th', 'DUPLEX-TRIPLEX-QUADRAPLEX':'plex'};
// Finish, from the assessor's construction grade. 'standard' is the Slate build; 'upgraded' adds Very Good for a
// plan with upgrades; 'any' turns the finish rule off. Each row's `finish` says which class its grade is in
// (Excellent and Custom are 'luxury').
const STANDARD_GRADES = ['MINIMUM','FAIR','AVERAGE','GOOD'], UPGRADED_GRADES = ['VERY GOOD'], LUXURY_GRADES = ['EXCELLENT','CUSTOM'];
const FINISH_GRADES = {standard:STANDARD_GRADES, upgraded:[...STANDARD_GRADES,...UPGRADED_GRADES]};
const FINISH_LABEL = {standard:'Slate-standard finish (county grade Average or Good)',
  upgraded:'standard or upgraded finish (county grade up to Very Good)', any:'any finish'};
// Steps out of the team rule, in order; each relaxes one more rule, and a relaxed rule costs a confidence level.
// Older sales come back before a major road is crossed: in the backtest that order fit Pat's numbers better
// (median miss 5.1% vs 5.3%), and a sale from the same side 13-24 months ago is closer evidence than one
// across Independence Blvd.
const STEPS = [
  {older:false, across:false, finish:true,  product:true},
  {older:true,  across:false, finish:true,  product:true},
  {older:false, across:true,  finish:true,  product:true},
  {older:true,  across:true,  finish:true,  product:true},
  {older:true,  across:true,  finish:false, product:true},
  {older:true,  across:true,  finish:false, product:false},
];

// ArcGIS answers a bad field or where-clause with HTTP 200 and an {error:...} body, so check for it.
async function ajPost(url, params){
  const body = new URLSearchParams(params).toString();
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body});
  if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||''));
  return j;
}
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1;
  return s.length%2 ? s[m] : +((s[m-1]+s[m])/2).toFixed(2); }
function ringCentroid(rings){
  const r = rings && rings[0]; if(!r || !r.length) return null;
  let x=0,y=0; r.forEach(p=>{x+=p[0];y+=p[1];});
  return {x:x/r.length, y:y/r.length};
}
// Great-circle miles. camadata stores latitude in `xcoord` and longitude in `ycoord` — the field
// names are backwards in the source data, which is worth knowing before "fixing" this.
function milesBetween(lat1,lng1,lat2,lng2){
  const R=3958.8, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function isoDate(ms){ return (typeof ms==='number' && ms>0 && ms<4e12) ? new Date(ms).toISOString().slice(0,10) : null; }
// Major-road crossings. Everything goes on a local flat grid in feet around the lot (fine at half a mile): the
// road segments once per request (roadGrid), then each comp's straight line from the lot (roadCrossed). Only a
// proper crossing counts: a line that just touches a road's end doesn't. Roads are {name, paths:[[[lng,lat],...]]}.
const FT_PER_DEG = 364000;   // ~ft per degree of latitude
function roadGrid(subj, roads){
  const cos = Math.cos(subj.lat*Math.PI/180);
  const xy = (lng,lat) => [(lng-subj.lng)*cos*FT_PER_DEG, (lat-subj.lat)*FT_PER_DEG];
  const segs = [];
  for(const road of roads) for(const path of road.paths) for(let i=0;i<path.length-1;i++){
    const p = xy(path[i][0],path[i][1]), q = xy(path[i+1][0],path[i+1][1]);
    segs.push({name:road.name, p, q, x0:Math.min(p[0],q[0]), x1:Math.max(p[0],q[0]), y0:Math.min(p[1],q[1]), y1:Math.max(p[1],q[1])});
  }
  return {xy, segs};
}
function roadCrossed(grid, comp){
  const a = [0,0], b = grid.xy(comp.lng, comp.lat);
  const side = (p,q,r) => (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0]);
  const x0 = Math.min(0,b[0]), x1 = Math.max(0,b[0]), y0 = Math.min(0,b[1]), y1 = Math.max(0,b[1]);
  for(const g of grid.segs){
    if(g.x1<x0 || g.x0>x1 || g.y1<y0 || g.y0>y1) continue;
    if(side(g.p,g.q,a)*side(g.p,g.q,b) < 0 && side(a,b,g.p)*side(a,b,g.q) < 0) return g.name;
  }
  return null;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate');

  const q = req.query || {};
  const pid = (q.pid||'').trim();
  const radius = Math.min(Math.max(parseFloat(q.radius)||0.5, 0.1), 2);        // miles
  const months = Math.min(Math.max(parseInt(q.months)||TEAM_MONTHS, 3), 60);    // the team rule's window
  const wideMonths = Math.max(months, WIDE_MONTHS);                             // how far the fallback reaches
  const minYear = parseInt(q.minYear) || 2020;                                  // context tier
  const solidYear = parseInt(q.solidYear) || 2025;                              // "solid comp" tier
  const minPrice = parseInt(q.minPrice) || 100000;                              // drop lot/teardown transfers
  const subjectSf = parseFloat(q.sf) || null;                                   // plan sf, for the ARV suggestion
  const product = PRODUCT_TYPES[(q.product||'').toLowerCase()] ? q.product.toLowerCase() : 'any';
  const finish = FINISH_GRADES[(q.finish||'').toLowerCase()] ? q.finish.toLowerCase()
               : (q.finish||'').toLowerCase()==='any' ? 'any' : 'standard';

  const out = { subject:null, params:{pid,radius,months,wideMonths,minYear,solidYear,minPrice,subjectSf,product,finish},
                comps:[], summary:null, arv:null, rule:null, flags:[], notes:[], errors:[] };
  if(!pid){ res.status(400).json({error:'pass ?pid= (Mecklenburg parcel id)'}); return; }

  try{
    // 1) subject parcel: centre point for the search envelope, plus its own record for context
    let centre=null, subjLat=null, subjLng=null;
    try{
      const pj = await ajPost(`${PARCEL_LAYER}/query`, {where:`pid='${pid}'`, outFields:'pid,gisacres',
        returnGeometry:'true', outSR:String(SR), f:'json'});
      const f = (pj.features||[])[0];
      if(f && f.geometry) centre = ringCentroid(f.geometry.rings);
      if(f) out.subject = {pid, acres:f.attributes && f.attributes.gisacres || null};
    }catch(e){ out.errors.push('subject_parcel: '+e.message); }
    if(!centre){ out.errors.push('No parcel geometry for PID '+pid+' — cannot centre the search.');
      res.status(200).json(out); return; }

    try{
      const cj = await ajPost(`${CAMA_LAYER}/query`, {where:`pid='${pid}'`,
        outFields:'pid,address,xcoord,ycoord,yearbuilt,heatedarea,neighbordesc,landuse_description',
        returnGeometry:'false', f:'json'});
      const a = (cj.features||[])[0] && cj.features[0].attributes;
      if(a){ subjLat=num(a.xcoord); subjLng=num(a.ycoord);
        out.subject = Object.assign(out.subject||{pid}, {address:a.address||null,
          neighborhood:a.neighbordesc||null, existing_year_built:a.yearbuilt||null,
          existing_heated_sf:a.heatedarea||null, land_use:a.landuse_description||null}); }
    }catch(e){ out.errors.push('subject_cama: '+e.message); }

    // 2) every recorded sale in the envelope over the window. ArcGIS takes a rectangle, so this
    // is a square whose corners sit radius*sqrt(2) away — rows are filtered to the true radius
    // in step 5 once each comp's distance is known.
    const halfFt = radius*MI_FT;
    const env = JSON.stringify({xmin:centre.x-halfFt, ymin:centre.y-halfFt,
                                xmax:centre.x+halfFt, ymax:centre.y+halfFt, spatialReference:{wkid:SR}});
    // Sales go back WIDE_MONTHS so the first fallback step has them; the team rule itself uses `months`.
    const teamSince = new Date(Date.now() - months*30.44*86400000).toISOString().slice(0,10);
    const since = new Date(Date.now() - wideMonths*30.44*86400000).toISOString().slice(0,10);
    // The major roads in the same box, alongside the sales. Non-fatal: without them the side check is skipped and
    // the rule says so.
    const roadsP = ajPost(`${ROAD_LAYER}/query`, {
      geometry:env, geometryType:'esriGeometryEnvelope', inSR:String(SR), spatialRel:'esriSpatialRelIntersects',
      where:`TfareType IN (${MAJOR_ROAD_TYPES.map(t=>`'${t}'`).join(',')})`,
      outFields:'WholeStreet', returnGeometry:'true', outSR:'4326', f:'json'})
      .then(j=>(j.features||[]).filter(f=>f.geometry && f.geometry.paths)
        .map(f=>({name:(f.attributes && f.attributes.WholeStreet)||'a major road', paths:f.geometry.paths})))
      .catch(e=>{ out.errors.push('major_roads: '+e.message); return null; });
    const sj = await ajPost(`${SALES_LAYER}/query`, {
      geometry:env, geometryType:'esriGeometryEnvelope', inSR:String(SR),
      spatialRel:'esriSpatialRelIntersects',
      where:`saledate >= DATE '${since}' AND saleprice > ${minPrice}`,
      outFields:'parcelid,saleprice,saledate,salesvalidity,landuse,soldasvacantflag,naldesc',
      returnGeometry:'false', f:'json'});
    const allSales = (sj.features||[]).map(f=>f.attributes);
    out.notes.push(`${allSales.length} recorded sales in the ${radius} mi search box since ${since}`);

    // 3) keep arm's-length + builder sales of residential parcels, newest row per parcel
    const byParcel = new Map();
    allSales.forEach(a=>{
      const v = (a.salesvalidity||'').trim().toUpperCase();
      if(!MARKET_VALIDITY.includes(v)) return;
      if(a.landuse && !RES_USE.test(a.landuse)) return;
      const prev = byParcel.get(a.parcelid);
      if(!prev || (a.saledate||0) > (prev.saledate||0)) byParcel.set(a.parcelid, a);
    });
    // A parcel whose newest market sale was sold as vacant is a lot sale: the house the assessor now shows on it
    // wasn't there yet, so the price says nothing about a finished home. The county stores the flag as 'Yes'/'No'
    // (v8.14: this compared to 'Y', never matched, and builder lot purchases were counted as new-build comps).
    // It's checked on the newest row, not before picking it, so an older sale of the torn-down house can't
    // take the lot sale's place.
    let lotSales = 0;
    const market = [...byParcel.values()].filter(a=>{
      if(/^Y/i.test((a.soldasvacantflag||'').trim())){ lotSales++; return false; }
      return true;
    });
    if(lotSales) out.notes.push(`${lotSales} lot sales (sold as vacant) left out`);
    out.notes.push(`${market.length} market-valid residential sales (blank or Z) on distinct parcels`);
    if(!market.length){ out.summary={count:0}; res.status(200).json(out); return; }

    // 4) join the assessor record — the sales layer has no building attributes at all
    const pids = market.map(a=>a.parcelid);
    const cama = new Map();
    for(let i=0;i<pids.length;i+=60){
      const chunk = pids.slice(i,i+60);
      const where = 'pid IN ('+chunk.map(p=>`'${p}'`).join(',')+')';
      try{
        const j = await ajPost(`${CAMA_LAYER}/query`, {where,
          outFields:'pid,address,yearbuilt,heatedarea,bedrooms,fullbath,halfbath,grade,'
                   +'landuse_description,xcoord,ycoord,gisacres,neighbordesc,bldgtype',
          returnGeometry:'false', f:'json'});
        (j.features||[]).forEach(f=>cama.set(f.attributes.pid, f.attributes));
      }catch(e){ out.errors.push('cama_join: '+e.message); }
    }

    // 4b) fill in addresses the assessor record is missing (common on brand-new lots)
    const missing = pids.filter(p=>{ const c=cama.get(p); return c && !(c.address||'').trim(); });
    if(missing.length){
      for(let i=0;i<missing.length;i+=60){
        const chunk = missing.slice(i,i+60);
        const where = 'num_parent_parcel IN ('+chunk.map(p=>`'${p}'`).join(',')+')';
        try{
          const j = await ajPost(`${MAT_LAYER}/query`, {where,
            outFields:'num_parent_parcel,full_address', returnGeometry:'false', f:'json'});
          (j.features||[]).forEach(f=>{
            const a=f.attributes, c=cama.get(a.num_parent_parcel);
            if(c && !(c.address||'').trim() && a.full_address) c.address = a.full_address;
          });
        }catch(e){ out.errors.push('address_fallback: '+e.message); }
      }
    }

    // 5) build the comp rows
    const roads = await roadsP;
    const grid = (roads && subjLat!=null && subjLng!=null) ? roadGrid({lat:subjLat,lng:subjLng}, roads) : null;
    if(!grid) out.notes.push(`Major roads not checked (${roads?'the lot has no assessor location':'the City road layer didn’t answer'}): sales on both sides count as this side.`);
    const rows = []; let dropped = 0, predates = 0;
    market.forEach(a=>{
      const c = cama.get(a.parcelid); if(!c) return;
      const sf = num(c.heatedarea), yb = c.yearbuilt || null;
      // A sale recorded before the assessor's year built for the current house sold the lot or the old house, not this
      // one (v8.14); priced against today's heated sf it would pass as a new-build comp. The assessor sometimes dates a
      // house to the year after a Q4 closing, so a few real closings go too: county-wide over 24 months, 22 of the 24
      // rows this drops were bulk deeds, lot takedowns or teardowns, and 2 were Oct 2024 closings on 2025 houses.
      // All 24 sit at saleYear = yb-1, so narrowing it to yb-1 needs the multi-parcel-deed check (audit C-F2) and a guard
      // for single-parcel teardown or lot sales (e.g. 18701404, $875k on 6,730 sf) first.
      const saleYear = a.saledate ? new Date(a.saledate).getUTCFullYear() : null;
      if(yb && saleYear && saleYear < yb){ predates++; return; }
      const lat = num(c.xcoord), lng = num(c.ycoord);
      const dist = (lat!=null && lng!=null && subjLat!=null && subjLng!=null)
        ? +milesBetween(subjLat,subjLng,lat,lng).toFixed(2) : null;
      // Honour the advertised radius. The envelope is square, so without this a sale 0.7 mi away
      // could drive the ARV while the UI says "within 0.5 mi". Rows with no coordinates are kept
      // (rare) and simply can't be distance-checked.
      if(dist!=null && dist > radius){ dropped++; return; }
      const btype = (c.bldgtype||'').trim().toUpperCase(), grade = (c.grade||'').trim().toUpperCase();
      const saleDate = isoDate(a.saledate);
      rows.push({
        pid:a.parcelid, address:c.address||null,
        sale_price:a.saleprice, sale_date:saleDate,
        in_window: !!saleDate && saleDate >= teamSince,   // inside the team rule's 12 months
        validity:(a.salesvalidity||'').trim() || null,
        builder_sale:(a.salesvalidity||'').trim().toUpperCase()==='Z',
        year_built:yb, heated_sf:sf,
        psf: (sf && sf>0) ? +(a.saleprice/sf).toFixed(2) : null,
        beds:c.bedrooms||null, baths:((c.fullbath||0)+0.5*(c.halfbath||0))||null,
        grade:c.grade||null, type:c.bldgtype||c.landuse_description||null,
        product: PRODUCT_OF_TYPE[btype] || null,
        finish: STANDARD_GRADES.includes(grade) ? 'standard' : UPGRADED_GRADES.includes(grade) ? 'upgraded'
              : LUXURY_GRADES.includes(grade) ? 'luxury' : null,
        size_vs_plan_pct: (sf && subjectSf) ? Math.round((sf-subjectSf)/subjectSf*100) : null,
        lot_acres:c.gisacres!=null ? +Number(c.gisacres).toFixed(3) : null,
        neighborhood:c.neighbordesc||null,
        distance_mi:dist,
        // the major road between the lot and this comp, or null (same side, or not checked: see rule.roads_checked)
        across: (grid && lat!=null && lng!=null) ? roadCrossed(grid, {lat,lng}) : null,
        tier: (yb && yb>=solidYear) ? 'solid' : (yb && yb>=minYear) ? 'context' : 'older'
      });
    });
    rows.sort((a,b)=> (a.distance_mi??99) - (b.distance_mi??99));
    if(dropped) out.notes.push(`${dropped} sales fell in the search box but outside the ${radius} mi radius and were dropped`);
    if(predates) out.notes.push(`${predates} sales recorded before the assessor's year built were left out`);
    out.comps = rows;

    // 6) summarise each tier over the team rule's window. Two methods, per the SOP: $/sf and absolute sold price.
    //    (rows also carries the older sales, which only the fallback steps use.)
    const usable = r => r.psf!=null && r.heated_sf>0;
    const recent = rows.filter(r=>r.in_window);
    const solid = recent.filter(r=>r.tier==='solid' && usable(r));
    const context = recent.filter(r=>(r.tier==='solid'||r.tier==='context') && usable(r));
    const older = recent.filter(r=>r.tier==='older' && usable(r));
    const stat = set => set.length ? {
      count:set.length,
      median_psf:median(set.map(r=>r.psf)),
      avg_psf:+(set.reduce((t,r)=>t+r.psf,0)/set.length).toFixed(2),
      min_psf:Math.min(...set.map(r=>r.psf)), max_psf:Math.max(...set.map(r=>r.psf)),
      highest_sold:Math.max(...set.map(r=>r.sale_price)),
      median_sf:median(set.map(r=>r.heated_sf)),
      avg_distance_mi:+(set.reduce((t,r)=>t+(r.distance_mi||0),0)/set.length).toFixed(2)
    } : {count:0};
    out.summary = {solid:stat(solid), new_build:stat(context), older:stat(older),
      total_rows:rows.length, builder_sales:rows.filter(r=>r.builder_sale).length,
      window_months:months};

    // 7) the team rule, then the steps out of it (STEPS), then inside the chosen set the neighbourhood / size
    //    cascade. Every new build (minYear+) in the radius is a candidate; the rules narrow it.
    const candidates = rows.filter(r=>(r.tier==='solid'||r.tier==='context') && usable(r));
    const wantTypes = product==='any' ? null : PRODUCT_TYPES[product].map(t=>PRODUCT_OF_TYPE[t]);
    const wantGrades = finish==='any' ? null : FINISH_GRADES[finish];
    const meets = (r, s) => (s.older || r.in_window)
      && (s.across || !r.across)
      && (!s.finish || !wantGrades || wantGrades.includes((r.grade||'').trim().toUpperCase()))
      && (!s.product || !wantTypes || wantTypes.includes(r.product));
    const relaxedOf = s => [s.older&&'older', s.across&&'across', !s.finish&&wantGrades&&'finish', !s.product&&wantTypes&&'product'].filter(Boolean);
    const solidIds = new Set(rows.filter(r=>r.tier==='solid').map(r=>r.pid));
    const subjNbh = (out.subject && out.subject.neighborhood || '').trim();
    const sameNbhOf = set => set.filter(r=>subjNbh && (r.neighborhood||'').trim()===subjNbh);
    const inSize = (set, pct) => set.filter(r => Math.abs(r.heated_sf-subjectSf)/subjectSf <= pct);
    const sf0 = subjectSf ? Math.round(subjectSf).toLocaleString() : '';
    // Tightest tier with enough evidence wins. Neighbourhood beats radius; size breaks ties.
    const ladderFor = set => [
      {set:inSize(sameNbhOf(set), SIZE_BAND), need:MIN_IN_BAND, tier:'neighborhood+size',
       label:`same assessor neighbourhood (${subjNbh}) and within ±${Math.round(SIZE_BAND*100)}% of ${sf0} sf`},
      {set:sameNbhOf(set), need:MIN_IN_BAND, tier:'neighborhood', label:`same assessor neighbourhood (${subjNbh})`},
      {set:inSize(set, SIZE_BAND), need:MIN_IN_BAND, tier:'size', label:`within ±${Math.round(SIZE_BAND*100)}% of ${sf0} sf`},
      {set:inSize(set, SIZE_BAND_WIDE), need:MIN_IN_BAND, tier:'size-wide',
       label:`within ±${Math.round(SIZE_BAND_WIDE*100)}% of ${sf0} sf (widened: too few close in size)`},
      {set, need:MIN_POOL, tier:'pocket', label:'every sale in the set (none close enough in size)'}
    ];
    // rows that meet the whole team rule, for the page to show when there's no ARV (no plan sf)
    candidates.forEach(r=>{ r.meets_rule = meets(r, STEPS[0]); });
    out.rule = {months, wide_months:wideMonths, radius, product, product_label:PRODUCT_LABEL[product],
      finish, finish_label:FINISH_LABEL[finish], roads_checked:!!grid,
      meeting:candidates.filter(r=>r.meets_rule).length, step:null, relaxed:null, label:null};
    const across = candidates.filter(r=>r.across);
    if(across.length){
      const names = [...new Set(across.map(r=>r.across))];
      out.notes.push(`${across.length} new-build sale${across.length===1?'':'s'} sit across ${names.slice(0,3).join(', ')}${names.length>3?' and others':''}: used only if this side is too thin`);
    }
    // The first step with MIN_POOL sales wins, unless all it can do is a widened size band or the whole set: then
    // the time and road steps (never finish or product) are tried for a neighbourhood or size-band match first,
    // since a same-side sale from 14 months ago at the plan's size is better evidence than this year's 1,100 sf
    // unit against a 2,700 sf plan. A tight match found that way still loses a confidence level for the relaxed rule.
    const LOOSE = ['size-wide','pocket'];
    let basis = null, step = null, tier = null, spread = null, poolUsed = null;
    if(subjectSf){
      const tried = new Set();
      let first = null;
      for(let i=0;i<STEPS.length;i++){
        const s = STEPS[i], key = relaxedOf(s).join();
        if(tried.has(key)) continue;   // relaxes only a rule that is off anyway (product or finish 'any')
        tried.add(key);
        if(first && (!s.finish || !s.product)) break;   // don't trade finish or product for a size match
        const pool = candidates.filter(r=>meets(r, s));
        if(pool.length < MIN_POOL) continue;
        const pick = ladderFor(pool).find(l=>l.set.length>=l.need);
        if(!pick) continue;
        const found = {set:pick.set, label:pick.label, tier:pick.tier, step:i, pool};
        if(!LOOSE.includes(pick.tier)){ first = found; break; }   // tight: take it (replaces an earlier loose one)
        if(!first) first = found;                                  // loose: keep the first, keep looking
      }
      // a tight match from a later step replaces a loose one from an earlier step; otherwise the first one found
      if(first){ basis = {set:first.set, label:first.label}; tier = first.tier; step = first.step; poolUsed = first.pool; }
    }
    if(basis){
      const s = STEPS[step], relaxed = relaxedOf(s);
      const ps = basis.set.map(r=>r.psf);
      spread = +(Math.max(...ps)/Math.min(...ps)).toFixed(2);
      const used = new Set(basis.set.map(r=>r.pid));
      rows.forEach(r=>{ r.used = used.has(r.pid); });
      const RELAX_TEXT = {older:`sales up to ${wideMonths} months old`, across:'sales across a major road',
        finish:'any finish', product:'any product'};
      const ruleText = `last ${months} months, within ${radius} mi, this side of the major roads, ${PRODUCT_LABEL[product]}, ${FINISH_LABEL[finish]}`;
      Object.assign(out.rule, {step, relaxed, label: relaxed.length
        ? `Too few sales meet the team rule (${ruleText}), so this widens to ${relaxed.map(k=>RELAX_TEXT[k]).join(', ')}.`
        : `Team rule: ${ruleText}.`});
      // Confidence: the match inside the set sets the level (same assessor neighbourhood = high, size band = medium,
      // a widened band or the whole set = low), and any relaxed rule takes it down one. On the 2026-10-01 backtest
      // (74 priced deals) it barely separates on the ±10% band: high 76%, medium 72%, low 71%. It says how good the
      // match is, not how far off the number will be.
      const base = tier.startsWith('neighborhood') ? 2 : tier==='size' ? 1 : 0;
      const level = ['low','medium','high'][Math.max(0, base - (relaxed.length ? 1 : 0))];
      const solidInSet = basis.set.filter(r=>solidIds.has(r.pid)).length;
      const sameNbh = sameNbhOf(basis.set).length;
      out.summary.matching = {tier, step, comps_used:basis.set.length, in_size_band:inSize(basis.set, SIZE_BAND).length,
        same_neighborhood:sameNbh, subject_neighborhood:subjNbh||null, spread,
        solid_in_set:solidInSet, solid_share:Math.round(solidInSet/basis.set.length*100)};
      if(solidInSet===0)
        out.flags.push(`None of the ${basis.set.length} comps driving this ARV were built ${solidYear}+: the match is older stock, check the dates.`);
      const n = basis.set.length, acrossNames = [...new Set(basis.set.filter(r=>r.across).map(r=>r.across))];
      out.confidence = {
        level, tier, step, relaxed, comps_used:n, same_neighborhood:sameNbh, spread,
        reason: relaxed.length
          ? `${n} comps, after widening to ${relaxed.map(k=>RELAX_TEXT[k]).join(', ')}${acrossNames.length?` (across ${acrossNames.join(', ')})`:''}; ${basis.label}. Weighted lower: check that these sell like the subject.`
          : base===2
          ? `${n} sales meet the team rule, in the lot’s own assessor neighbourhood${tier==='neighborhood+size'?' and size band':''}.`
          : `${n} sales meet the team rule, but ${subjNbh?`fewer than ${MIN_IN_BAND} of them are in the lot’s assessor neighbourhood (${subjNbh})`:'the lot has no assessor neighbourhood yet'}, so this is ${basis.label}. Weighted lower: check the rows.`
      };
      const mpsf = median(ps);
      const raw = mpsf*subjectSf;
      const cap = Math.max(...basis.set.map(r=>r.sale_price));
      const capped = raw > cap;
      out.arv = {
        tier, step,
        basis:basis.label, comps_used:n, median_psf:mpsf,
        subject_sf:subjectSf,
        arv_by_psf:Math.round(raw),
        highest_sold_comp:cap,
        arv:Math.round(capped?cap:raw),
        capped,
        retail_psf:+((capped?cap:raw)/subjectSf).toFixed(2),
        note: capped
          ? 'Capped at the highest sold comp: the $/sf math ran past every real sale nearby (SOP: never assume a bigger house sells for more).'
          : 'Median $/sf of the comp set × the plan square footage.'
      };
    } else if(subjectSf){
      out.rule.label = `Fewer than ${MIN_POOL} new-build sales within ${radius} mi, even with every rule relaxed: pick the comps by hand.`;
      out.flags.push(out.rule.label);
    } else {
      out.notes.push('Pass ?sf= (the plan’s heated square footage) to get a suggested ARV.');
    }

    // 8) flags the SOP wants surfaced loudly rather than buried
    // solid comps in the pool the ARV came from (it can reach past 12 months), else in the window
    const solidN = poolUsed ? poolUsed.filter(r=>r.tier==='solid').length : solid.length;
    const solidWhere = poolUsed && STEPS[step].older ? `in the last ${wideMonths} months` : `in the last ${months} months`;
    if(solidN<=1) out.flags.push(`Only ${solidN} solid comp${solidN===1?'':'s'} (built ${solidYear}+) ${solidWhere}${poolUsed?' among the sales the ARV could use':''}: thin evidence, say so on the sheet.`);
    if(context.length && Math.max(...context.map(r=>r.sale_price))>1000000) out.flags.push('Luxury-tier comp above $1M nearby: outside the normal buy box, flag before underwriting further.');
    if(basis && spread > 1.6) out.flags.push('Comp $/sf spread is wide (>60% high-to-low): the set is not uniform, pick the comps by hand.');
    if(out.arv && out.arv.capped) out.flags.push('ARV capped at the highest sold comp.');
    if(out.confidence && out.confidence.level!=='high') out.flags.push('Confidence '+out.confidence.level+': '+out.confidence.reason);

    res.status(200).json(out);
  }catch(e){
    out.errors.push('fatal: '+e.message);
    res.status(200).json(out);
  }
}
