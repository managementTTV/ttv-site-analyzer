// api/comps.js — TTV new-construction comps (Charlotte / Mecklenburg)  v1
//
// Phase 2 of the underwriting flow: given a subject parcel, return the recent NEW-BUILD sales
// around it and a suggested retail $/sf, following the Deal Analyst SOP's own comping rules.
//
// Source: Mecklenburg County's public ArcGIS servers — no key, no signup.
//   TaxParcelSales     -> every recorded transfer with the assessor's sale-validity code
//   TaxParcel_camadata -> year built, heated area, beds/baths, grade, lat/lng for each parcel
// The two are joined on PID, because the sales layer carries no building attributes.
// v8.34: TaxParcel_camadata came back empty (count 0) from 2026-10-09. The same assessor data sits in the county's
// CamaDataTables (tb_allparceldata + tb_allbuildings), so camaFetch() reads those whenever the main layer gives
// nothing, and says so in notes. If neither answers, the request reports an error instead of "no sales".
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
// The backup assessor tables (v8.34). tb_allparceldata holds the parcel facts (gis1 = longitude, gis2 = latitude),
// tb_allbuildings one row per building (sequence 1 = the main building, which is what TaxParcel_camadata carried).
const CAMA_PARCELS   = `${MECK}/CamaDataTables/MapServer/3`;
const CAMA_BUILDINGS = `${MECK}/CamaDataTables/MapServer/1`;

// Sale-validity codes. Blank = no disqualification (arm's length). Z = builder sale, which is
// exactly the new-build resale TTV is pricing — the assessor excludes those from ratio studies,
// but for us they are the best comps on the board. TEMP = recorded but not yet reviewed by the county: the
// partners decided (2026-10-09) to count these, marked "unverified" on each row, because the review runs
// months behind (about half of the latest month's sales are TEMP) and the team rule only looks back 12.
// Every other code is a disqualified transfer (multi-parcel conveyance, related parties, foreclosure,
// <=$3,000, etc.).
const MARKET_VALIDITY = ['', 'Z', 'TEMP'];
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
// Outlier guard (v8.41, research/12 Q4, Brian 2026-10-12). A new-build sale whose $/sf is more than GUARD_X times, or under
// 1/GUARD_X of, the median $/sf of the planned product's new builds in the radius is left out before the rule runs. It is
// nearly always an odd county heated area (W Tyvola: $625k on 1,300 sf). It needs GUARD_MIN_REF same-product sales to set
// that median. On our 79 deals it dropped 74 comps and moved 2 ARVs by about 1%; on the 47 of 1,077 test sales where it
// moved the ARV, the average miss against the real sale fell from +31% to +10%.
const GUARD_X = 1.5, GUARD_MIN_REF = 5;
// Infill (v8.41, research/12 Q2): fewer than INFILL_MIN other buildings built minYear+ whose assessor point is within
// INFILL_FT of the lot's. On those lots the tool landed 33% within ±5% of the real sale (49% within ±10%, 4.3% low),
// against 58% in new-build projects, so the page tells Pat to check the ARV (vet).
const INFILL_FT = 300, INFILL_MIN = 3;
// Sales come back SALES_PAGE at a time (the layer's maxRecordCount), up to SALES_MAX_PAGES pages (v8.42).
const SALES_PAGE = 2000, SALES_MAX_PAGES = 10;

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
// Assessor records for a list of PIDs, as a Map pid -> attributes named the way TaxParcel_camadata names them
// (address, xcoord = latitude, ycoord = longitude, yearbuilt, heatedarea, bedrooms, fullbath, halfbath, grade,
// landuse_description, gisacres, neighbordesc, bldgtype). Main layer first; for the PIDs it gives nothing for, the
// backup tables (v8.34). used.backup counts the PIDs the backup answered; errors go to errs.
// v8.42: CAMA_CONCURRENCY chunks at a time (they ran one after another; a 1.5 mi wide-area check has ~10 chunks).
const CAMA_CONCURRENCY = 4;
async function camaFetch(pids, errs, used){
  const out = new Map(), chunks = [];
  for(let i=0;i<pids.length;i+=60) chunks.push(pids.slice(i,i+60));
  let next = 0;
  const worker = async () => { while(next < chunks.length) await camaChunk(chunks[next++], out, errs, used); };
  await Promise.all(Array.from({length:Math.min(CAMA_CONCURRENCY, chunks.length)}, worker));
  return out;
}
// one 60-PID chunk: the main layer, then the backup tables for the PIDs it gave nothing for
async function camaChunk(chunk, out, errs, used){
  const list = chunk.map(p=>`'${p}'`).join(',');
  let mainErr = null;
  try{
    const j = await ajPost(`${CAMA_LAYER}/query`, {where:`pid IN (${list})`,
      outFields:'pid,address,yearbuilt,heatedarea,bedrooms,fullbath,halfbath,grade,'
               +'landuse_description,xcoord,ycoord,gisacres,neighbordesc,bldgtype',
      returnGeometry:'false', f:'json'});
    // one row per building; a lot with two buildings comes back twice and the last row wins (audit C-L4, as before
    // v8.34). The backup reads building 1 only.
    (j.features||[]).forEach(f=>out.set(f.attributes.pid, f.attributes));
  }catch(e){ mainErr = 'cama: '+e.message; }
  // the PIDs the main layer didn't answer: all of them while it's empty, a fresh split now and then otherwise
  const rest = chunk.filter(p=>!out.has(p));
  if(!rest.length) return;
  const list2 = rest.map(p=>`'${p}'`).join(',');
  let added = 0;   // this chunk's backup answers (used.backup is shared by chunks running at the same time)
  try{
    const [pj, bj] = await Promise.all([
      ajPost(`${CAMA_PARCELS}/query`, {where:`parcelid IN (${list2})`,
        outFields:'parcelid,yearid,location_address,streetnumber,streetname,gis1,gis2,num_heatedarea,legalacres,neighborhood_description,landuse_description',
        returnGeometry:'false', f:'json'}),
      ajPost(`${CAMA_BUILDINGS}/query`, {where:`parcelid IN (${list2}) AND buildingsequence=1`,
        outFields:'parcelid,yearid,yearbuilt,grade,buildingtype,bedrooms,fullbath,halfbath,finishedarea',
        returnGeometry:'false', f:'json'})]);
    const latest = (rows) => { const m = new Map();
      (rows.features||[]).forEach(f=>{ const a=f.attributes, p=m.get(a.parcelid); if(!p || (a.yearid||0) > (p.yearid||0)) m.set(a.parcelid, a); });
      return m; };
    const P = latest(pj), B = latest(bj);
    P.forEach((a, pid)=>{
      const b = B.get(pid) || {};
      // location_address is the main layer's own address format ("15004 ANNAN CT CHARLOTTE NC"); a pre-v8.34 row
      // and a backup row for the same sale then read the same
      out.set(pid, {pid, address:(a.location_address||'').trim() || [a.streetnumber, a.streetname].filter(Boolean).join(' ').trim() || null,
        yearbuilt:b.yearbuilt||null, heatedarea:a.num_heatedarea!=null ? a.num_heatedarea : (b.finishedarea||null),
        bedrooms:b.bedrooms||null, fullbath:b.fullbath||null, halfbath:b.halfbath||null, grade:b.grade||null,
        landuse_description:a.landuse_description||null, xcoord:num(a.gis2), ycoord:num(a.gis1),
        gisacres:a.legalacres>0 ? a.legalacres : null, neighbordesc:a.neighborhood_description||null,
        bldgtype:(b.buildingtype||'').trim()||null});   // about 48k buildings carry a blank ' ' type
      used.backup++; added++;
    });
    if(mainErr && !added) errs.push(mainErr);   // the backup's answer stands in for a failed main layer
  }catch(e){ if(mainErr) errs.push(mainErr); errs.push('cama_backup: '+e.message); }
}
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
// The infill count (v8.41): the other parcels built minYear+ whose assessor point is within INFILL_FT of the lot's point,
// sold or not, as research/12 counted them. The parcel layer finds the parcels near the lot's centre (SR 2264 feet, with a
// margin, since a parcel's assessor point isn't its outline's centre); the assessor records give each one's year built and
// point. Throws when a layer doesn't answer, so the caller can say the count is unknown instead of "not infill".
async function newBuildsNear(pid, centre, lat, lng, minYear){
  const pj = await ajPost(`${PARCEL_LAYER}/query`, {
    geometry:JSON.stringify({x:centre.x, y:centre.y, spatialReference:{wkid:SR}}), geometryType:'esriGeometryPoint',
    inSR:String(SR), spatialRel:'esriSpatialRelIntersects', distance:String(INFILL_FT+150), units:'esriSRUnit_Foot',
    outFields:'pid', returnGeometry:'false', f:'json'});
  const pids = [...new Set((pj.features||[]).map(f=>f.attributes && f.attributes.pid).filter(p=>p && p!==pid))];
  const errs = [], cama = pids.length ? await camaFetch(pids, errs, {backup:0}) : new Map();
  if(pids.length && !cama.size && errs.length) throw new Error(errs.join('; '));
  let n = 0;
  cama.forEach(c=>{
    const yb = num(c.yearbuilt), cLat = num(c.xcoord), cLng = num(c.ycoord);   // xcoord = latitude (see milesBetween)
    if(yb && yb>=minYear && cLat!=null && cLng!=null && milesBetween(lat,lng,cLat,cLng)*MI_FT <= INFILL_FT) n++;
  });
  // some chunks didn't answer: a partial count can only be low, so it settles "not infill" but never "infill"
  return {count:n, parcels:pids.length, partial:errs.length>0};
}
// "Pat should check" (v8.41, research/12 Q2, Brian 2026-10-12): the ARV goes to Pat when confidence isn't HIGH (or there is
// no ARV), or the lot is infill. On the 1,077 test sales "not HIGH" alone flagged 29% and caught 64% of the misses over
// 10%; infill adds the weakest group. An infill count that couldn't be made counts as a reason, not as "not infill".
// The wide-spread line (over 1.6x) only caught 12% of the big misses, so it is a note now, not a reason.
function vetOf(out){
  const reasons = [], inf = out.infill;
  if(!out.arv) reasons.push(out.params.subjectSf ? 'There\u2019s no suggested ARV, so it\u2019s priced by hand.' : 'No plan size was sent, so there\u2019s no suggested ARV.');
  else if(out.confidence && out.confidence.level!=='high') reasons.push(`Confidence is ${out.confidence.level.toUpperCase()}, not HIGH.`);
  if(inf && inf.skipped){ /* ?infill=0: the caller has the count from another search */ }
  else if(!inf || !inf.checked) reasons.push(`The new builds within ${INFILL_FT} ft couldn\u2019t be counted, so the lot may be infill.`);
  else if(inf.infill) reasons.push(`Infill lot: ${inf.new_builds} new build${inf.new_builds===1?'':'s'} (built ${inf.min_year}+) within ${INFILL_FT} ft, fewer than ${INFILL_MIN}.`);
  return {check:reasons.length>0, reasons,
    rule:`Pat checks the ARV when confidence isn\u2019t HIGH or the lot is infill (fewer than ${INFILL_MIN} new builds within ${INFILL_FT} ft).`};
}
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
  const countInfill = q.infill !== '0';   // v8.42: ?infill=0 skips the new-builds-within-300-ft count

  const out = { subject:null, params:{pid,radius,months,wideMonths,minYear,solidYear,minPrice,subjectSf,product,finish},
                comps:[], summary:null, arv:null, rule:null, guard:null, infill:null, vet:null, flags:[], notes:[], errors:[] };
  if(!pid){ res.status(400).json({error:'pass ?pid= (Mecklenburg parcel id)'}); return; }

  // v8.41: the infill count runs beside the sales search; every answer waits for it and carries the vet verdict
  let infillP = Promise.resolve(null);
  const settle = async () => {
    const nb = await infillP;
    if(!countInfill){ out.infill = {checked:false, skipped:true, new_builds:null, infill:null, radius_ft:INFILL_FT, min_year:minYear, min_new_builds:INFILL_MIN};
      out.vet = vetOf(out); return; }
    const known = nb && !(nb.partial && nb.count<INFILL_MIN);
    out.infill = known ? {checked:true, new_builds:nb.count, infill:nb.count<INFILL_MIN, partial:!!nb.partial, radius_ft:INFILL_FT, min_year:minYear, min_new_builds:INFILL_MIN}
                       : {checked:false, new_builds:nb?nb.count:null, infill:null, partial:!!(nb&&nb.partial), radius_ft:INFILL_FT, min_year:minYear, min_new_builds:INFILL_MIN};
    if(nb && nb.partial) out.notes.push(`Part of the assessor look-up for the new builds within ${INFILL_FT} ft didn\u2019t answer (${nb.count} found)`);
    out.vet = vetOf(out);
  };

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
      await settle(); res.status(200).json(out); return; }

    const camaUsed = {backup:0}, joinUsed = {backup:0};
    {
      const a = (await camaFetch([pid], out.errors, camaUsed)).get(pid);
      if(a){ subjLat=num(a.xcoord); subjLng=num(a.ycoord);
        out.subject = Object.assign(out.subject||{pid}, {address:a.address||null,
          neighborhood:a.neighbordesc||null, existing_year_built:a.yearbuilt||null,
          existing_heated_sf:a.heatedarea||null, land_use:a.landuse_description||null}); }
    }
    // C-F6 (v8.34): a lot with no assessor record yet (a fresh split, like the Dellinger sub-lots) used to lose its
    // location, and with it the radius clip and the major-road rule, without a word on the page. Its parcel outline
    // still says where it is, so take the centre of that instead.
    if(subjLat==null || subjLng==null){
      try{
        const pj = await ajPost(`${PARCEL_LAYER}/query`, {where:`pid='${pid}'`, outFields:'pid',
          returnGeometry:'true', outSR:'4326', f:'json'});
        const f = (pj.features||[])[0], c = f && f.geometry && ringCentroid(f.geometry.rings);
        if(c){ subjLat = c.y; subjLng = c.x;
          out.subject.location_from = 'parcel';
          out.notes.push('The lot has no assessor record yet, so its location comes from the parcel outline.'); }
      }catch(e){ out.errors.push('subject_location: '+e.message); }
    }
    if(subjLat==null || subjLng==null)
      out.flags.push(`The lot’s location couldn’t be found, so the ${radius} mi radius wasn’t applied: check every row by hand.`);
    else if(countInfill) infillP = newBuildsNear(pid, centre, subjLat, subjLng, minYear)
      .catch(e=>{ out.errors.push('infill_check: '+e.message); return null; });

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
    // v8.42: paged. The layer answers at most 2,000 rows a request and says exceededTransferLimit past that; a 0.5 mi box
    // stays under it, a 1.5 mi wide-area check in a busy pocket may not, and a cut-off list would drop sales silently.
    const allSales = [];
    for(let off=0, pages=0; ; off+=SALES_PAGE){
      const sj = await ajPost(`${SALES_LAYER}/query`, {
        geometry:env, geometryType:'esriGeometryEnvelope', inSR:String(SR),
        spatialRel:'esriSpatialRelIntersects',
        where:`saledate >= DATE '${since}' AND saleprice > ${minPrice}`,
        outFields:'parcelid,saleprice,saledate,salesvalidity,landuse,soldasvacantflag,naldesc,legalreference,transferid',
        orderByFields:'objectid', resultOffset:String(off), resultRecordCount:String(SALES_PAGE),
        returnGeometry:'false', f:'json'});
      const fs = sj.features||[];
      fs.forEach(f=>allSales.push(f.attributes));
      if(!sj.exceededTransferLimit || !fs.length) break;
      if(++pages >= SALES_MAX_PAGES){ out.flags.push(`Over ${allSales.length.toLocaleString()} sales in the search box: only the first ${allSales.length.toLocaleString()} were read.`); break; }
    }
    out.notes.push(`${allSales.length} recorded sales in the ${radius} mi search box since ${since}`);
    // C-F2 (v8.34): one deed can convey several parcels, and the sales layer repeats the deed's whole price on every
    // one of them. A deed is its book-page (legalreference) on one date at one price; transferid when there's no
    // book-page. parcelsOfDeed holds the distinct parcels each deed covers in the search box; step 5b adds the ones
    // outside it.
    const deedOf = a => `${(a.legalreference||'').trim() || ('t'+(a.transferid||''))}|${a.saledate}|${a.saleprice}`;
    const parcelsOfDeed = new Map();
    allSales.forEach(a=>{ const k = deedOf(a); if(!parcelsOfDeed.has(k)) parcelsOfDeed.set(k, new Set()); parcelsOfDeed.get(k).add(a.parcelid); });

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
    out.notes.push(`${market.length} market-valid residential sales (blank, Z or TEMP) on distinct parcels`);
    if(!market.length){ out.summary={count:0}; await settle(); res.status(200).json(out); return; }

    // 4) join the assessor record — the sales layer has no building attributes at all
    const pids = market.map(a=>a.parcelid);
    const cama = await camaFetch(pids, out.errors, joinUsed);
    if(joinUsed.backup) out.notes.push('County data source down — using backup: the building records came from the county’s backup assessor tables.');
    // C-F7 (v8.34): sales with no building record at all is the assessor data being down, not "no new builds here"
    if(!cama.size) out.errors.push(`county_records: no assessor record answered for any of the ${pids.length} sales, so no comp can be built`);

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
    // v8.34: said in flags (which the page shows) and in the rule line, not only in notes
    if(!grid) out.flags.push(`Major roads not checked (${roads?'the lot’s location is unknown':'the City road layer didn’t answer'}): sales on both sides of a major road count as this side.`);
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
      // the backup tables write some grades with a class number ("AVERAGE 03"); the finish classes are the words
      const btype = (c.bldgtype||'').trim().toUpperCase(), grade = (c.grade||'').trim().toUpperCase().replace(/\s+\d+$/,'');
      const saleDate = isoDate(a.saledate);
      rows.push({
        pid:a.parcelid, address:c.address||null,
        sale_price:a.saleprice, sale_date:saleDate,
        in_window: !!saleDate && saleDate >= teamSince,   // inside the team rule's 12 months
        validity:(a.salesvalidity||'').trim() || null,
        builder_sale:(a.salesvalidity||'').trim().toUpperCase()==='Z',
        // TEMP: recorded, not yet reviewed by the county (may still turn out not to be an arm's-length sale)
        unverified:(a.salesvalidity||'').trim().toUpperCase()==='TEMP',
        deed:deedOf(a), _lref:(a.legalreference||'').trim(),
        year_built:yb, heated_sf:sf,
        psf: (sf && sf>0) ? +(a.saleprice/sf).toFixed(2) : null,
        beds:c.bedrooms||null, baths:((c.fullbath||0)+0.5*(c.halfbath||0))||null,
        grade:grade||null, type:btype||c.landuse_description||null,
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
    // C-F2: a deed that sold two or more of these homes at once is a bulk sale (a portfolio, a builder's takedown): its
    // price is for all of them, so none of them is a retail comp, and left in, its total broke the highest-sold cap. A
    // deed of one home plus parcels with no house on them (a side lot, a common area) counts once, as that home's sale.
    // 5b) A deed's other homes can sit outside the search box or the radius, or be filtered out above (resold since,
    // no assessor record, sold before the house was built), so the parcels come from a county-wide look-up of each
    // row's book-page, and a parcel is a home when its assessor record has heated area.
    {
      const deedPids = new Map();
      rows.forEach(r=>{ if(!deedPids.has(r.deed)) deedPids.set(r.deed, new Set(parcelsOfDeed.get(r.deed))); });
      const lrefs = [...new Set(rows.map(r=>r._lref).filter(l=>/^[\w-]+$/.test(l)))];
      const lookups = [];
      for(let i=0;i<lrefs.length;i+=60){
        const list = lrefs.slice(i,i+60).map(l=>`'${l}'`).join(',');
        lookups.push(ajPost(`${SALES_LAYER}/query`, {where:`legalreference IN (${list})`,
          outFields:'parcelid,legalreference,transferid,saledate,saleprice', returnGeometry:'false', f:'json'})
          .then(j=>(j.features||[]).forEach(f=>{ const k = deedOf(f.attributes); if(deedPids.has(k)) deedPids.get(k).add(f.attributes.parcelid); }))
          .catch(e=>out.errors.push('deed_parcels: '+e.message)));
      }
      await Promise.all(lookups);
      const multi = [...deedPids.values()].filter(set=>set.size>1);
      const unknown = [...new Set(multi.flatMap(set=>[...set]))].filter(p=>!cama.has(p));
      const extra = unknown.length ? await camaFetch(unknown, out.errors, {backup:0}) : new Map();
      const isHome = p => { const c = cama.get(p) || extra.get(p); return !!(c && num(c.heatedarea) > 0); };
      const homesOf = new Map();
      deedPids.forEach((set, k)=>homesOf.set(k, set.size>1 ? [...set].filter(isHome).length : 1));
      let bulkRows = 0;
      for(let i=rows.length-1;i>=0;i--){
        if(homesOf.get(rows[i].deed) > 1){ bulkRows++; rows.splice(i,1); }
      }
      if(bulkRows) out.notes.push(`${bulkRows} sale${bulkRows===1?'':'s'} on deeds that sold several homes at once left out`);
      rows.forEach(r=>{ const n = deedPids.get(r.deed).size; if(n>1) r.deed_parcels = n; });
    }
    rows.forEach(r=>{ delete r.deed; delete r._lref; });
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
    const allCand = rows.filter(r=>(r.tier==='solid'||r.tier==='context') && usable(r));
    const wantTypes = product==='any' ? null : PRODUCT_TYPES[product].map(t=>PRODUCT_OF_TYPE[t]);
    // the outlier guard (GUARD_X): over the full new-build pool, before the rule and the cascade (research/12's engine)
    let candidates = allCand;
    {
      const ref = allCand.filter(r=>!wantTypes || wantTypes.includes(r.product)).map(r=>r.psf);
      const m0 = ref.length>=GUARD_MIN_REF ? median(ref) : null;
      if(m0){
        candidates = allCand.filter(r=>{
          if(r.psf > m0*GUARD_X) r.odd_sf = 'high'; else if(r.psf < m0/GUARD_X) r.odd_sf = 'low'; else return true;
          return false;
        });
      }
      const k = allCand.length - candidates.length;
      out.guard = {median_psf:m0, factor:GUARD_X, ref:ref.length, min_ref:GUARD_MIN_REF, dropped:k};
      if(k) out.notes.push(`${k} sale${k===1?'':'s'} with odd county square footage ($/sf over ${GUARD_X}\u00d7, or under ${Math.round(100/GUARD_X)}% of, the ${PRODUCT_LABEL[product]} median here, $${Math.round(m0)}/sf) left out`);
    }
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
    // the rows the guard left out that the chosen step (or the team rule) would otherwise have looked at: the page lists them
    allCand.forEach(r=>{ if(r.odd_sf) r.odd_meets = meets(r, STEPS[basis ? step : 0]); });
    if(basis){
      const s = STEPS[step], relaxed = relaxedOf(s);
      const ps = basis.set.map(r=>r.psf);
      spread = +(Math.max(...ps)/Math.min(...ps)).toFixed(2);
      const used = new Set(basis.set.map(r=>r.pid));
      rows.forEach(r=>{ r.used = used.has(r.pid); });
      const RELAX_TEXT = {older:`sales up to ${wideMonths} months old`, across:'sales across a major road',
        finish:'any finish', product:'any product'};
      const ruleText = `last ${months} months, within ${radius} mi, ${grid?'this side of the major roads':'major roads not checked'}, ${PRODUCT_LABEL[product]}, ${FINISH_LABEL[finish]}`;
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
      const unv = basis.set.filter(r=>r.unverified).length;
      if(unv) out.notes.push(`${unv} of the ${n} comps behind the ARV ${unv===1?'is':'are'} unverified: recorded, not yet reviewed by the county`);
      const mpsf = median(ps);
      const raw = mpsf*subjectSf;
      const cap = Math.max(...basis.set.map(r=>r.sale_price));
      const capped = raw > cap;
      out.arv = {
        tier, step,
        basis:basis.label, comps_used:n, unverified:unv, median_psf:mpsf,
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
    // v8.41: a note, not a flag. It caught 12% of the misses over 10% (research/12); the vet verdict decides who checks.
    if(basis && spread > 1.6) out.notes.push(`The comps\u2019 $/sf spread is wide (${spread}\u00d7 high to low): worth a look at the rows`);
    if(out.arv && out.arv.capped) out.flags.push('ARV capped at the highest sold comp.');
    if(out.confidence && out.confidence.level!=='high') out.flags.push('Confidence '+out.confidence.level+': '+out.confidence.reason);

    await settle();
    res.status(200).json(out);
  }catch(e){
    out.errors.push('fatal: '+e.message);
    try{ await settle(); }catch(_){ out.vet = {check:true, reasons:['The comps lookup failed.'], rule:''}; }
    res.status(200).json(out);
  }
}
