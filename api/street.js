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
//                           (v8.35: read through api/gis.js camaQuery(), which falls back to the county's backup
//                           assessor tables, CamaDataTables, while this layer gives nothing; it has been empty since
//                           2026-10-09)
//   TaxParcelSales       -> the sold-as-vacant flag on those last sales (a builder's lot purchase isn't a home sale)
//   TaxParcelBoundaries  -> the subject's centre when the CAMA record has no coordinates
//   Accela 1             -> address points, to tell N Davidson St from S Davidson St (CAMA drops the direction)
//   Accela 2 / 3         -> City / State maintained street centrelines (camera spot for Street View)
//   v8.43, condition records (see conditionRecords()):
//   Accela 25            -> Code Enforcement Service Areas: whether the lot is where the City's records reach
//   HNS/CodeEnforcementCasesAll   -> confirmed code violations by the section they cite (counts only)
//   ODP/ServiceRequests311        -> 311 condition complaints (counts only; complaints, not findings)
//   HNS/CodeEnforcementOrderstoDemolish -> demolition orders
//   NCDOT_AADT_Traffic_Segmentation  -> cars a day on the lot's own street (NCDOT, ArcGIS Online; 2021 counts)
//   Accela 5             -> the City's thoroughfare classification (major / minor) of the lot's street
// Mecklenburg-only by design, same as api/gis.js and api/comps.js. Hit /api/street?pid=04118535
import { camaQuery, camaBackupNote } from './gis.js';
const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
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
export const RECORD_MONTHS = 24; // v8.43 condition records: the same window as the connector's code cases (api/mcp.js CASE_MONTHS)
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
  // v8.43: City of Charlotte records, per 100 parcels on each side (records:true rows are left out when there are no
  // records: outside the City, or the City's layers didn't answer). Weaker = 3+ on the street and at least twice the
  // area's rate. 311 complaints are shown, not judged (info): who calls 311 varies street by street, and a street whose
  // new neighbours call more would read worse for it.
  {key:'cases_per100', label:`Code violations, last ${RECORD_MONTHS} months (per 100 parcels)`, gap:'rel', records:true,
    enough:(s,n)=>s.cases!=null && n.cases!=null && s.record_parcels>=5 && n.record_parcels>=10,
    weaker:(g,s)=>s.cases>=3 && g>=1},
  {key:'complaints_per100', label:`311 condition complaints, last ${RECORD_MONTHS} months (per 100 parcels)`, gap:'rel', records:true, info:true,
    enough:(s,n)=>s.complaints!=null && n.complaints!=null && s.record_parcels>=5 && n.record_parcels>=10,
    more:(g,s)=>s.complaints>=3 && g>=1},
];

// ── v8.43: condition records, traffic and demolition orders ───────────────────────────────────────────────────────────
// The City's records of the things a street walk looks for (overgrown yards, junked cars, cars on the lawn, junk and
// dumping, boarded houses), counted for the street's parcels and the comparison area's. Counts only: no record is
// returned, and no complainant, inspector, address or description text is ever requested (TITLE and
// DetailedDescription are matched in the `where` on the City's server). Only buildings and lots, never who lives there.
// Charlotte only: the towns keep no open records like these, so outside the City's code-enforcement area the rows are
// left out and a note says why (no records there isn't a clean street).
const CE_LAYER = 'https://gis.charlottenc.gov/arcgis/rest/services/HNS/CodeEnforcementCasesAll/MapServer/0';
const DEMOLISH_LAYER = 'https://gis.charlottenc.gov/arcgis/rest/services/HNS/CodeEnforcementOrderstoDemolish/MapServer/0';
const SR311_LAYER = 'https://gis.charlottenc.gov/arcgis/rest/services/ODP/ServiceRequests311/MapServer/0';
const CE_AREA_LAYER = 25;   // Accela "Code Enforcement Service Areas"
const AADT = 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/ArcGIS/rest/services/NCDOT_AADT_Traffic_Segmentation/FeatureServer';
const AADT_LAYERS = [1, 2, 3];   // segments: secondary / non-system, primaries, interstates (layer 0 is count stations)
const OID_CHUNK = 500, RECORD_POOL = 4;
const RECORD_PAD_DEG = 0.002;   // ~700 ft around the parcels' points: a record's point can sit off its parcel's centre
// The City's 311 server can stall for a minute; the records and the traffic count get this long between them, then
// give up (an errors entry), so they never hold up the rest of the street check.
const RECORDS_MS = 10000;
export const BUSY_AADT = 10000;   // cars a day; judgement, like CHECKS (a local street runs a few hundred to ~2,000)
const TRAFFIC_FT = 40;            // an NCDOT segment this close to the lot's own centreline point is that street
// A violation found: the owner corrected it, the City cleaned it up or towed the car, or the owner repaired or
// demolished (housing). Dismissed, "no violations" and still-open cases don't count. Conclusion is matched, never returned.
const CONFIRMED = "(Conclusion LIKE '%Compliance%' OR Conclusion = 'Vehicle Towed')";
// Nuisance cases by the section of the City code they cite: section number and title, the same rule as api/mcp.js
// VIOLATIONS (a pattern without its section number would start matching the reporter's own words). Housing (minimum
// housing code) cases count whole. The City's "Parking" case type isn't lawn parking (it doesn't cite 14-216), so lawn
// parking comes only from the citation.
export const CASE_KINDS = [
  {key:'overgrowth', pats:['10-155%Overgrown vegetation']},
  {key:'vehicles', pats:['10-167%Junked Motor Vehicle', '10-166%Hazardous vehicle', '10-165%Abandoned vehicle']},
  {key:'lawn_parking', pats:['14-216%Parking on the Lawn']},
  {key:'junk', pats:['10-136%Neglect of a Premise', '10-138%Illegal dumping']},
];
// 311 complaints by request type, and by keyword in TITLE for the City's catch-all "HNS HEALTH AND SANITATION" (the
// biggest condition type: "High weeds & grass, junk in yard, etc."). Only these three; the catch-all's generic title,
// HNS HOUSING (mostly indoor repairs) and the street-service types aren't counted. The words for each kind live in
// index.html (streetRecordsHtml()).
const COMPLAINT_TYPES = ['HNS HEALTH AND SANITATION', 'DUMPING IN STREET/ROW', 'BOARDED UP STRUCTURE', 'PARKING ON LAWN WORKDAYS', 'PARKING ON LAWN OFFHOURS'];
const HS = "REQUEST_TYPE='HNS HEALTH AND SANITATION'", T = w => `UPPER(TITLE) LIKE '%${w}%'`;
export const COMPLAINT_KINDS = [
  {key:'yard', where:`((${HS} AND (${T('WEED')} OR ${T('GRASS')} OR ${T('TRASH')} OR ${T('DUMP')} OR ${T('DEBRIS')} OR (${T('JUNK')} AND NOT ${T('VEHICLE')}))) OR REQUEST_TYPE='DUMPING IN STREET/ROW')`},
  {key:'vehicles', where:`((${HS} AND (${T('VEHICLE')} OR ${T('PARKING')} OR ${T('PARKED')})) OR REQUEST_TYPE LIKE 'PARKING ON LAWN%')`},
  {key:'boarded', where:`(REQUEST_TYPE='BOARDED UP STRUCTURE' OR ${T('BOARDED')})`},
];

const isoDay = ms => new Date(ms).toISOString().slice(0,10);
const chunked = (a, n) => { const out=[]; for(let i=0; i<a.length; i+=n) out.push(a.slice(i, i+n)); return out; };
const pidKey = v => String(v||'').trim().toUpperCase();
// fn over items, at most n at a time, results in input order
async function pool(items, n, fn){
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({length:Math.min(n, items.length)}, async ()=>{ while(next < items.length){ const k = next++; out[k] = await fn(items[k]); } }));
  return out;
}
async function idsOf(layer, where, fetchSignal){ return (await ajPost(`${layer}/query`, {where, returnIdsOnly:'true', f:'json'}, fetchSignal)).objectIds || []; }
// The box around these parcels' points (CAMA: latitude in xcoord, longitude in ycoord) and the lot, padded, as an
// ArcGIS spatial filter. The City's layers answer a box in well under 2 s; a list of parcel ids in the where can stall
// the 311 layer for a minute, so the records are fetched by box and kept by parcel id here.
function boxAround(rows, lat, lng){
  let x0 = lng, x1 = lng, y0 = lat, y1 = lat;
  rows.forEach(r=>{ const la = num(r.xcoord), lo = num(r.ycoord); if(la==null || lo==null) return;
    x0 = Math.min(x0, lo); x1 = Math.max(x1, lo); y0 = Math.min(y0, la); y1 = Math.max(y1, la); });
  return {geometry:JSON.stringify({xmin:x0-RECORD_PAD_DEG, ymin:y0-RECORD_PAD_DEG, xmax:x1+RECORD_PAD_DEG, ymax:y1+RECORD_PAD_DEG,
    spatialReference:{wkid:4326}}), geometryType:'esriGeometryEnvelope', inSR:'4326', spatialRel:'esriSpatialRelIntersects'};
}
// Each record id's kinds, matched on the City's server on ids only (no text comes back): kinds[i].where(...) per chunk.
async function kindsOf(layer, ids, kinds, whereFor, fetchSignal){
  const map = new Map();
  await pool(kinds, RECORD_POOL, async k=>{
    for(const c of chunked(ids, OID_CHUNK)) (await idsOf(layer, `OBJECTID IN (${c.join(',')}) AND ${whereFor(k)}`, fetchSignal))
      .forEach(id=>{ if(!map.has(id)) map.set(id, new Set()); map.get(id).add(k.key); });
  });
  return map;
}
// {total, by} for the records whose parcel is in `pids`. A record with two kinds counts once in total, once under each.
function tally(rows, pidField, pids, kindMap, keys, wholeKind){
  const by = {}; keys.forEach(k=>{ by[k] = 0; }); let total = 0;
  rows.forEach(r=>{
    if(!pids.has(pidKey(r[pidField]))) return;
    if(wholeKind && wholeKind(r)){ by[wholeKind(r)]++; total++; return; }
    const ks = kindMap.get(r.OBJECTID); if(!ks) return;
    total++; ks.forEach(k=>{ by[k]++; });
  });
  return {total, by};
}
// The City's records for the street's parcels and the area's, last RECORD_MONTHS. {city:false} outside the City's
// code-enforcement area (asked first, so a town lot sends nothing else to the City).
async function conditionRecords(lat, lng, stRows, areaRows, fetchSignal, notes){
  const at = {geometry:`${lng},${lat}`, geometryType:'esriGeometryPoint', inSR:'4326', spatialRel:'esriSpatialRelIntersects'};
  const city = await ajPost(`${CITY}/${CE_AREA_LAYER}/query`, Object.assign({where:'1=1', returnCountOnly:'true', f:'json'}, at), fetchSignal);
  if(!(city.count > 0)) return {city:false};
  const now = Date.now(), since = isoDay(now - RECORD_MONTHS*30.44*86400000), until = isoDay(now + 86400000);
  // v8.44: code violations go back two windows (the RECORD_MONTHS before `since` too) for the trend line
  const priorSince = isoDay(now - 2*RECORD_MONTHS*30.44*86400000), cut = Date.parse(since+'T00:00:00Z');
  const sP = new Set(stRows.map(r=>pidKey(r.pid))), aP = areaRows ? new Set(areaRows.map(r=>pidKey(r.pid))) : null;
  const box = boxAround(stRows.concat(areaRows||[]), lat, lng);
  const [ce, sr, demo] = await Promise.all([
    allRows(CE_LAYER, Object.assign({where:`CaseType IN ('Nuisance','Housing') AND DateCreated >= DATE '${priorSince}' AND ${CONFIRMED}`,
      orderByFields:'OBJECTID'}, box), 'OBJECTID,ParcelId,CaseType,DateCreated', fetchSignal),
    allRows(SR311_LAYER, Object.assign({where:`RECEIVED_DATE >= DATE '${since}' AND RECEIVED_DATE < DATE '${until}' AND REQUEST_TYPE IN (${COMPLAINT_TYPES.map(t=>`'${t}'`).join(',')})`,
      orderByFields:'OBJECTID'}, box), 'OBJECTID,PID', fetchSignal),
    allRows(DEMOLISH_LAYER, {where:'1=1', orderByFields:'OBJECTID'}, 'OBJECTID,ParcelId', fetchSignal)]);
  if(ce.truncated || sr.truncated) notes.push('More City records in this area than one lookup returns, so the counts may run low.');
  const ours = (rows, f) => rows.filter(r=>{ const k = pidKey(r[f]); return sP.has(k) || (aP && aP.has(k)); });
  const ceRows = ours(ce.rows, 'ParcelId'), srRows = ours(sr.rows, 'PID');
  const [caseKinds, complaintKinds] = await Promise.all([
    kindsOf(CE_LAYER, ceRows.filter(r=>r.CaseType==='Nuisance').map(r=>r.OBJECTID), CASE_KINDS,
      k=>'('+k.pats.map(p=>`DetailedDescription LIKE '%${sq(p)}%'`).join(' OR ')+')', fetchSignal),
    kindsOf(SR311_LAYER, srRows.map(r=>r.OBJECTID), COMPLAINT_KINDS, k=>k.where, fetchSignal)]);
  const housing = r => r.CaseType==='Housing' ? 'housing' : null;
  const caseKeys = CASE_KINDS.map(k=>k.key).concat('housing'), compKeys = COMPLAINT_KINDS.map(k=>k.key);
  const ceNow = ceRows.filter(r=>r.DateCreated >= cut), ceBefore = ceRows.filter(r=>!(r.DateCreated >= cut));
  const sc = tally(ceNow, 'ParcelId', sP, caseKinds, caseKeys, housing), scomp = tally(srRows, 'PID', sP, complaintKinds, compKeys);
  const demolition = demo.rows.filter(r=>sP.has(pidKey(r.ParcelId))).length;
  const out = {city:true, months:RECORD_MONTHS, since, prior_since:priorSince, truncated:!!(ce.truncated || sr.truncated),
    street:{parcels:sP.size, cases:sc.total, cases_by:sc.by, cases_prior:tally(ceBefore, 'ParcelId', sP, caseKinds, caseKeys, housing).total,
      complaints:scomp.total, complaints_by:scomp.by, demolition_orders:demolition},
    area:null};
  if(aP) out.area = {parcels:aP.size, cases:tally(ceNow, 'ParcelId', aP, caseKinds, caseKeys, housing).total,
    cases_prior:tally(ceBefore, 'ParcelId', aP, caseKinds, caseKeys, housing).total,
    complaints:tally(srRows, 'PID', aP, complaintKinds, compKeys).total};
  return out;
}
// How busy the lot's own street is, from the centreline point in front of the lot:
//  - aadt: cars a day on the nearest NCDOT traffic segment within TRAFFIC_FT (NCDOT's HPMS file, calendar year 2021;
//    it covers roads above Local, so most neighbourhood streets have none);
//  - thoroughfare: the City's classification of that same street (Accela Thoroughfares, existing ones only, matched by
//    the centreline's name), which reaches city streets the NCDOT file skips (N Davidson St is a minor thoroughfare).
// busy = 10,000+ cars a day or a major thoroughfare / freeway. null = no centreline point to look from.
const THOROUGHFARE_LAYER = 5, THOROUGHFARE = {EXMJTH:'major', 'EXMJTH-C3C':'major', EXFRY:'freeway', EXMINTH:'minor'};
export const AADT_YEAR = 2021;
// The thoroughfare layer spells the type out ("Central Ave") where the centreline abbreviates it ("CENTRAL AV"), so the
// match is on the name before the type ("N DAVIDSON ST" -> 'N DAVIDSON %'); a one-word name matches whole.
function thoroughfareWhere(name){
  const w = name.trim().toUpperCase().split(/\s+/), base = w.length > 1 ? w.slice(0, -1).join(' ') : w[0];
  return `UPPER(WholeStreet)='${sq(base)}' OR UPPER(WholeStreet) LIKE '${sq(base)} %'`;
}
async function trafficAt(lat, lng, cam, fetchSignal){
  if(!cam || !cam.pt) return null;
  const p = fromFt({lat, lng}, cam.pt), near = within(p.lat, p.lng, TRAFFIC_FT);
  const [layers, tf] = await Promise.all([
    Promise.all(AADT_LAYERS.map(l=>ajPost(`${AADT}/${l}/query`, Object.assign({where:'AADT > 0', outFields:'AADT',
      returnGeometry:'true', outSR:'4326', f:'json'}, near), fetchSignal))),
    cam.name ? ajPost(`${CITY}/${THOROUGHFARE_LAYER}/query`, Object.assign({where:thoroughfareWhere(cam.name),
      outFields:'TfareType', returnGeometry:'false', f:'json'}, near), fetchSignal) : Promise.resolve({features:[]})]);
  let best = null;
  layers.forEach(j=>(j.features||[]).forEach(f=>{
    const n = nearestOnLine(p, [{features:[{geometry:f.geometry, attributes:{}}]}]);
    if(n && (!best || n.d < best.d)) best = {d:n.d, aadt:num(f.attributes && f.attributes.AADT)};
  }));
  const kinds = (tf.features||[]).map(f=>THOROUGHFARE[((f.attributes||{}).TfareType||'').trim()]).filter(Boolean);
  const thoroughfare = ['freeway', 'major', 'minor'].find(k=>kinds.includes(k)) || null;
  const aadt = best && best.aadt>0 ? Math.round(best.aadt) : null;
  return {aadt, aadt_year: aadt ? AADT_YEAR : null, thoroughfare,
    busy: (aadt||0) >= BUSY_AADT || thoroughfare==='major' || thoroughfare==='freeway'};
}

// ── v8.44: the street's direction (Brian, 2026-10-12: "streets will gentrify and change and nice streets could also go
// down hill") ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Three signals, each the street against its comparison area, so a market-wide rise doesn't read as the street rising:
//  - price: the median home-sale $/sf of the last TREND_MONTHS against the TREND_MONTHS before (TaxParcelSales, every
//    market sale, not only each home's last one; same filters as the street's sales: market-valid, $50k+, not sold as
//    vacant, not before the house was built), as a change in % street minus area;
//  - builds: homes built in the last TREND_BUILD_YEARS, street share against area share (only ever points up);
//  - violations: confirmed code violations in the last RECORD_MONTHS against the RECORD_MONTHS before (City only).
// Rising = 2+ up and none down. Slipping = 2+ down and none up, or one strong down (price 20+ pts behind the area, or
// violations at least doubled to 5+) with nothing up and prices not keeping pace (no price signal, or behind the area).
// Mixed signals read Steady. Too little history = no price and no violations signal. Code violations rise on streets
// that are being rebuilt too (construction, new neighbours who call), so a lot of new building counts as up and a
// violations rise alone can't call a rebuilding street Slipping.
// Display only, like the rest of the check; the thresholds are judgement, not backtested.
export const TREND_MONTHS = 36, TREND_BUILD_YEARS = 5;
const TREND_GAP_PTS = 10;
async function salesTrend(lat, lng, stRows, areaRows, fetchSignal){
  const now = Date.now(), mid = now - TREND_MONTHS*30.44*86400000, start = now - 2*TREND_MONTHS*30.44*86400000;
  const {rows, truncated} = await allRows(SALES_LAYER, Object.assign({where:`saledate >= DATE '${isoDay(start)}' AND saleprice >= ${MIN_SALE}`,
    orderByFields:'objectid'}, boxAround(stRows.concat(areaRows), lat, lng)), 'parcelid,saleprice,saledate,salesvalidity,soldasvacantflag', fetchSignal);
  const home = new Map(); stRows.concat(areaRows).forEach(r=>{ if(isHome(r)) home.set(pidKey(r.pid), r); });
  const sP = new Set(stRows.map(r=>pidKey(r.pid))), aP = new Set(areaRows.map(r=>pidKey(r.pid)));
  // one sale per house per window (the newest), so a flip can't fill a street's window; the area's baseline leaves the
  // street's own houses out, so the gap is the street against the rest of its area
  const w = {s:{recent:new Map(), earlier:new Map()}, a:{recent:new Map(), earlier:new Map()}};
  rows.forEach(x=>{
    const k = pidKey(x.parcelid), h = home.get(k), d = x.saledate, p = num(x.saleprice), sf = h && num(h.heatedarea);
    if(!h || !(sf>0) || !(p>=MIN_SALE) || typeof d!=='number') return;
    if(!MARKET_VALIDITY.includes((x.salesvalidity||'').trim().toUpperCase()) || /^Y/i.test((x.soldasvacantflag||'').trim())) return;
    if(h.yearbuilt && new Date(d).getUTCFullYear() < h.yearbuilt) return;   // the lot or the old house, not this one
    const win = d >= mid ? 'recent' : 'earlier', side = sP.has(k) ? w.s : aP.has(k) ? w.a : null;
    if(side && !(side[win].has(k) && side[win].get(k).d >= d)) side[win].set(k, {d, psf:p/sf});
  });
  const side = m => { const r = [...m.recent.values()].map(v=>v.psf), e = [...m.earlier.values()].map(v=>v.psf);
    return {recent_psf:r.length ? Math.round(median(r)) : null, earlier_psf:e.length ? Math.round(median(e)) : null,
      n_recent:r.length, n_earlier:e.length, change:r.length && e.length ? Math.round((median(r)/median(e)-1)*100) : null}; };
  return {months:TREND_MONTHS, street:side(w.s), area:side(w.a), truncated};
}
function buildsTrend(stRows, areaRows){
  const since = new Date().getUTCFullYear() - TREND_BUILD_YEARS;
  const side = rows => { const homes = [...new Map(rows.filter(isHome).map(r=>[pidKey(r.pid), r])).values()];
    const n = homes.filter(r=>r.yearbuilt >= since).length; return {homes:homes.length, new:n, pct:homes.length ? Math.round(n/homes.length*1000)/10 : null}; };
  return {since, street:side(stRows), area:side(areaRows)};
}
// sales / builds / rec may each be null (a lookup down, or outside the City for rec). area: 'its neighbourhood' etc.
export function trendFor(sales, builds, rec, area){
  const sig = {}, words = [];
  const ss = sales && sales.street, sa = sales && sales.area;
  // a truncated lookup drops the newest rows (objectid order), so it gives no price signal rather than a biased one
  if(ss && !sales.truncated && ss.n_recent>=3 && ss.n_earlier>=3 && sa.n_recent>=10 && sa.n_earlier>=10){
    const gap = ss.change - sa.change;
    sig.price = {dir:gap>=TREND_GAP_PTS ? 'up' : gap<=-TREND_GAP_PTS ? 'down' : 'flat', gap, strong:gap<=-2*TREND_GAP_PTS};
    words.push(`home sales ${ss.change>0?'up '+ss.change+'%':ss.change<0?'down '+(-ss.change)+'%':'flat'} a sq ft over ${TREND_MONTHS/12} years, against ${sa.change>=0?'+':''}${sa.change}% for ${area}`);
  } else sig.price = {dir:'thin'};
  const bs = builds && builds.street, ba = builds && builds.area;
  if(bs && ba && bs.homes>=5 && ba.homes>=10){
    // up: well ahead of the area, or a fifth of the street rebuilt in TREND_BUILD_YEARS whatever the area is doing
    sig.builds = {dir:bs.new>=2 && (bs.pct >= ba.pct + TREND_GAP_PTS || (bs.new>=3 && bs.pct>=20)) ? 'up' : 'flat'};
    if(bs.new) words.push(`${bs.new} of ${bs.homes} homes built since ${builds.since} (${ba.pct}% for ${area})`);
  } else sig.builds = {dir:'thin'};
  if(rec && rec.city && rec.area && !rec.truncated && rec.street.parcels>=5){
    const s = rec.street, a = rec.area, ratio = (r, p) => p>0 ? r/p : (r>0 ? Infinity : 1);
    const rs = ratio(s.cases, s.cases_prior), ra = ratio(a.cases, a.cases_prior);
    const down = s.cases>=3 && rs>=1.5 && rs>=ra+0.5, up = !down && s.cases_prior>=3 && rs<=0.5 && rs<=ra-0.3;
    sig.violations = {dir:down ? 'down' : up ? 'up' : 'flat', strong:down && rs>=2 && s.cases>=5, recent:s.cases, prior:s.cases_prior};
    words.push(`code violations ${s.cases} in the last ${RECORD_MONTHS/12} years against ${s.cases_prior} in the ${RECORD_MONTHS/12} before`);
  } else sig.violations = {dir:'thin'};
  const all = Object.values(sig), ups = all.filter(x=>x.dir==='up').length, downs = all.filter(x=>x.dir==='down').length;
  const level = sig.price.dir==='thin' && sig.violations.dir==='thin' ? 'thin'
    : ups>=2 && !downs ? 'rising'
    : !ups && (downs>=2 || (downs===1 && all.some(x=>x.dir==='down' && x.strong) && !(sig.price.gap > 0))) ? 'slipping' : 'steady';
  const head = {rising:'Rising', steady:'Steady', slipping:'Slipping', thin:'Too little history to tell'}[level];
  return {level, signals:sig, text: words.length ? `${head}: ${words.join('; ')}.` : `${head}.`};
}

// fetchSignal (every helper below passes it on): optional, a function giving each request its own AbortSignal. api/mcp.js
// passes one carrying a per-request timeout and its tool deadline, so a stalled layer fails on its own (and its catch
// degrades just that layer) and nothing runs past the tool's budget. /api/street passes none: no signal, as before.
async function ajPost(url, params, fetchSignal){
  const body = new URLSearchParams(params).toString();
  const init = {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body};
  if(fetchSignal) init.signal = fetchSignal();
  const r = await fetch(url, init);
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
async function allRows(layer, params, outFields, fetchSignal){
  const rows = [];
  for(let p=0; p<MAX_PAGES; p++){
    const j = await ajPost(`${layer}/query`, Object.assign({outFields, returnGeometry:'false',
      resultOffset:String(p*PAGE), resultRecordCount:String(PAGE), f:'json'}, params), fetchSignal);
    (j.features||[]).forEach(f=>rows.push(f.attributes));
    if(!j.exceededTransferLimit && (j.features||[]).length < PAGE) return {rows, truncated:false};
  }
  return {rows, truncated:true};
}
// Assessor rows for q ({where}, {near:{lat, lng, ft}} or both; see camaQuery()), paged like allRows(). ctx: the
// request's camaQuery() state, so once one query falls back to the backup tables the rest do too.
const camaRows = (q, ctx, fetchSignal) => camaQuery(q, CAMA_FIELDS, {ctx, maxPages:MAX_PAGES, fetchSignal});
const within = (lat, lng, ft) => ({geometry:`${lng},${lat}`, geometryType:'esriGeometryPoint', inSR:'4326',
  spatialRel:'esriSpatialRelIntersects', distance:String(ft), units:'esriSRUnit_Foot'});

// isVacant / isNonRes / isHome are exported for api/mcp.js, which labels each house on the street the same way.
export function isVacant(r){ return /^VAC/i.test((r.vacorimprov||'').trim()) && !(num(r.heatedarea)>0); }
// Some homes carry a commercial code ("C700 MULTI FAMILY", "O400 MULTI FAMILY"): the description decides, so housing of
// any kind never counts as a commercial neighbour. A commercial, office or warehouse condominium is still commercial.
const HOUSING_DESC = /RESIDENTIAL|MULTI ?FAMIL|APARTMENT|AFFORDABLE|CONDO|TOWN ?HOUSE|DUPLEX|TRIPLEX|MOBILE HOME|HOME FOR THE AGED|HOUSING AUTHORITY|PATIO HOME/i;
const BUSINESS_DESC = /COMMERCIAL|OFFICE|WAREHOUSE|MEDICAL|RETAIL|INDUSTRIAL|HOTEL/i;
// v8.47: the county files many civic and open-land parcels under C / I / O codes too ("C700 CHURCH", "I600 REC AREA",
// "O400 OTHER MUNICIPAL", flood plain, right of way). The description decides: these are never a business neighbour.
const NOT_NEIGHBOUR_DESC = /CHURCH|SCHOOL|COLLEGE|REC AREA|GREENWAY|GOLF COURSE|DAY CARE|NURSING HOME|FIRE DEPARTMENT|OTHER MUNICIPAL|OTHER COUNTY|OTHER FEDERAL|STATE PROP|FLOOD|RIGHT OF WAY|ROADWAY CORRIDOR|EASEMENT|RETENTION POND|WELL LOT|WASTELAND|SUBMERGED|CONSERVATION|AIR RIGHTS|NO LAND INTEREST|MINERAL RIGHTS|CLUB, LODGES|MARINA|WATER FRONTAGE/i;
export function isNonRes(r){ const c=(r.lusecode||'').trim(), d=r.landuse_description||'';
  return (NONRES_USE.test(c) || NONRES_CODES.includes(c)) && !NOT_NEIGHBOUR_DESC.test(d) && (BUSINESS_DESC.test(d) || !HOUSING_DESC.test(d)); }
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
async function lotSalePids(pids, since, fetchSignal){
  const lots = new Set(), iso = new Date(since).toISOString().slice(0,10);
  for(let i=0; i<pids.length; i+=PID_CHUNK){
    const chunk = pids.slice(i, i+PID_CHUNK);
    const {rows} = await allRows(SALES_LAYER, {where:`parcelid IN (${chunk.map(p=>`'${sq(p)}'`).join(',')}) AND saledate >= DATE '${iso}'`,
      orderByFields:'objectid'}, 'parcelid,saledate,salesvalidity,soldasvacantflag', fetchSignal);
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

// ── v8.47: what's right around the lot (research/13 rubric v2, S2 and S3) ─────────────────────────────────────────────
// next door: business parcels (isNonRes) whose shape comes within NEXT_DOOR_FT of the lot's point: the neighbours on
// each side, behind and across the street. A busy road's kind of flag: it turns "in line" into "watch".
// stores: convenience stores and gas stations within STORE_FT (¼ mile). Shown, never judged (a store is a building,
// never the people there; Pat makes her own call on it). The county's land use names only 121 stores county-wide, its
// building records 333 (most stores sit on a "COMMERCIAL" parcel), so the list is both, fetched once per warm instance.
export const NEXT_DOOR_FT = 300, STORE_FT = 1320;
const CAMA_TABLES = `${MECK}/CamaDataTables/MapServer`;   // 1 = buildings, 3 = parcels (gis2 = latitude, gis1 = longitude)
const STORE_BUILDINGS = ['CONVENIENCE STORE', 'MINI MART CONVENIENCE STORE', 'FAST FOOD/CONVENIENCE STORE'];
const STORE_USES = ['CONVENIENCE STORE', 'CONVIENCE/FAST FOOD STORE', 'SERVICE STATION'];   // the county's spelling
const STORE_TTL_MS = 12*3600000, AROUND_MS = 8000;
let _stores = null;   // {at, p}: one fetch shared by concurrent requests; a failed fetch isn't kept
// Its own deadline, not a caller's signal: one request's abort mustn't fail the fetch every other request is waiting on.
function storeList(){
  if(_stores && Date.now()-_stores.at < STORE_TTL_MS) return _stores.p;
  const fetchSignal = () => AbortSignal.timeout(AROUND_MS);
  const p = (async ()=>{
    const b = await allRows(`${CAMA_TABLES}/1`, {where:`buildingtype IN (${STORE_BUILDINGS.map(t=>`'${t}'`).join(',')})`, orderByFields:'objectid'}, 'parcelid', fetchSignal);
    const pids = [...new Set(b.rows.map(r=>r.parcelid).filter(Boolean))];
    const where = `landuse_description IN (${STORE_USES.map(t=>`'${sq(t)}'`).join(',')})` + (pids.length ? ` OR parcelid IN (${pids.map(x=>`'${sq(x)}'`).join(',')})` : '');
    const {rows} = await allRows(`${CAMA_TABLES}/3`, {where, orderByFields:'objectid'}, 'parcelid,yearid,gis1,gis2', fetchSignal);
    const latest = new Map(); rows.forEach(r=>{ const o = latest.get(r.parcelid); if(!o || (r.yearid||0) > (o.yearid||0)) latest.set(r.parcelid, r); });
    return [...latest.values()].map(r=>({pid:r.parcelid, lat:num(r.gis2), lng:num(r.gis1)})).filter(x=>x.lat!=null && x.lng!=null);
  })();
  _stores = {at:Date.now(), p};
  p.catch(()=>{ if(_stores && _stores.p===p) _stores = null; });
  return p;
}
// ctx: a copy of the request's camaQuery() state, so a hiccup on this late, parallel read doesn't move the rest of the
// request (and its note) onto the backup tables. fetchSignal: AROUND_MS, with the caller's when it has one.
async function aroundLot(pid, lat, lng, ctx, fetchSignal){
  const sig = () => fetchSignal && AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(AROUND_MS), fetchSignal()]) : AbortSignal.timeout(AROUND_MS);
  const [nd, stores] = await Promise.all([camaRows({near:{lat, lng, ft:NEXT_DOOR_FT}}, Object.assign({}, ctx), sig), storeList()]);
  // one per parcel; a parcel needs a land-use description to be named a business (a blank one on a C code is a remnant)
  const biz = new Map(); nd.rows.forEach(r=>{ if(r.pid!==pid && (r.landuse_description||'').trim() && isNonRes(r)) biz.set(r.pid, r); });
  const uses = {}; biz.forEach(r=>{ const u=(r.landuse_description||r.lusecode||'').trim(); uses[u]=(uses[u]||0)+1; });
  const ref = {lat, lng}, near = stores.filter(x=>x.pid!==pid).map(x=>{ const q=toFt(ref, x.lat, x.lng); return Math.round(Math.hypot(q.x, q.y)); })
    .filter(d=>d<=STORE_FT).sort((a,b)=>a-b);
  return {next_door_ft:NEXT_DOOR_FT, next_door:biz.size, next_door_uses:Object.entries(uses).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([use,n])=>({use,n})),
    store_ft:STORE_FT, stores:near.length, nearest_store_ft:near.length ? near[0] : null};
}

// Street vs area, check by check. 'thin' = too little evidence on either side to say.
// v8.43: the records rows (records:true) only when there are records (s.cases set); 'more' is the info-only 311 row's
// "higher than the area" (shown, never counted as weaker). A records row whose area rate is 0 compares as "far above"
// when the street has any (b=0 would otherwise read "too few").
function compare(s, n){
  return CHECKS.filter(c=>!c.records || s.cases!=null).map(c=>{
    const a = s[c.key], b = n[c.key];
    const g = (a==null || b==null) ? null : c.gap==='rel' ? (b ? a/b-1 : c.records ? (a>0 ? Infinity : 0) : null) : a-b;
    const verdict = (g==null || !c.enough(s,n)) ? 'thin' : (c.weaker && c.weaker(g,s)) ? 'weaker'
      : (c.stronger && c.stronger(g,s)) ? 'stronger' : (c.more && c.more(g,s)) ? 'more' : 'similar';
    return {key:c.key, label:c.label, verdict, street:a, nbh:b, gap:g==null||!isFinite(g)?null:Math.round(c.gap==='rel'?g*100:g)};
  });
}
// The record rows' names in the verdict sentence
const SHORT = {cases_per100:'code violations'};
// area: 'its neighbourhood' or 'the half mile around it'. flags (v8.43): {aadt, busy, demolition_orders}; a busy road
// or a demolition order on the street turns "in line" into "watch" and is named in every verdict.
function verdictFor(checks, s, area, flags){
  const weak = checks.filter(c=>c.verdict==='weaker'), strong = checks.filter(c=>c.verdict==='stronger');
  const info = new Set(CHECKS.filter(c=>c.info).map(c=>c.key));
  const judged = checks.filter(c=>c.verdict!=='thin' && !info.has(c.key)).length;
  const names = a => a.map(c=>SHORT[c.key]||c.label.toLowerCase()).join(', ');
  const f = flags || {}, extra = [];
  if(f.busy){
    const cars = f.aadt ? `about ${f.aadt.toLocaleString('en-US')} cars a day (NCDOT, ${AADT_YEAR})` : null;
    const tf = f.thoroughfare==='major' || f.thoroughfare==='freeway' ? `a City ${f.thoroughfare} thoroughfare` : null;
    // busy on the count leads with the count; busy on the class alone leads with the class (a 5,000-car major road)
    const parts = (f.aadt >= BUSY_AADT ? [cars, tf] : [tf, cars]).filter(Boolean);
    extra.push(`It's a busy road: ${parts.join(', ')}.`);
  }
  if(f.demolition_orders) extra.push(`${f.demolition_orders} parcel${f.demolition_orders===1?' is':'s are'} on the City's demolition-order list.`);
  if(f.next_door) extra.push(`${f.next_door} business parcel${f.next_door===1?'':'s'} within ${NEXT_DOOR_FT} ft of the lot (${f.next_door_uses.map(u=>u.use.toLowerCase()).join(', ')}).`);
  const add = t => extra.length ? t+' '+extra.join(' ') : t;
  if(s.homes < 3 && !weak.length) return {level:'thin', text:add(`Only ${s.homes} home${s.homes===1?'':'s'} on this stretch of street, too few to compare. Walk it in Street View.`)};
  if(weak.length >= 2) return {level:'weaker', text:add(`This street looks weaker than ${area} on ${weak.length} of ${judged} checks (${names(weak)}). Walk it before you trust the area's numbers.`)};
  if(weak.length === 1) return {level:'watch', text:add(`One check is weaker than ${area} (${names(weak)}). Walk the street to see whether it shows.`)};
  // With no City records and no traffic count (outside the City, or a layer down) the sentence is the v8.18 one.
  const data = f.records ? 'the records' : 'the county data';
  const lead = `In line with ${area} on ${data}${strong.length?` (stronger on ${names(strong)})`:''}.`;
  if(extra.length) return {level:'watch', text:`${lead} ${extra.join(' ')} Walk it.`};
  const miss = f.records ? "the records miss upkeep nobody reported and what's across the street"
    : `the records can't see upkeep, ${f.traffic ? '' : 'traffic '}or what's across the street`.replace(', or', ' or');
  return {level:'in-line', text:`${lead} Still walk it: ${miss}.`};
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
function centrelines(street, lat, lng, fetchSignal){
  return Promise.all(STREET_LAYERS.map(l=>ajPost(`${CITY}/${l}/query`, Object.assign({
    where:`WHOLESTNAME='${sq(street)}' OR WHOLESTNAME LIKE '% ${sq(street)}'`, outFields:'WHOLESTNAME',
    returnGeometry:'true', outSR:'4326', f:'json'}, within(lat, lng, CAMERA_MAX_FT)), fetchSignal).catch(e=>({features:[], failed:e.message}))));
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
// never pass them on. fetchSignal is ajPost()'s (api/mcp.js only).
export async function streetCheck(pid, ft, view, keep, fetchSignal){
  const out = {subject:null, params:{pid, ft, months:SALE_MONTHS, new_since:NEW_SINCE}, street:null, neighborhood:null,
    checks:[], verdict:null, streetview:null, notes:[], errors:[]};
  // v8.43: the City's records and the traffic count, only in the full answer (not mode=view)
  if(!view){ out.params.record_months = RECORD_MONTHS; out.params.busy_aadt = BUSY_AADT; out.params.trend_months = TREND_MONTHS;
    out.records = null; out.traffic = null; out.trend = null;
    out.params.next_door_ft = NEXT_DOOR_FT; out.params.store_ft = STORE_FT; out.nearby = null; }
  const ctx = {};   // camaQuery()'s state for this request
  let recTimer = null;   // v8.43: the records' deadline, cleared in finally whichever way this ends
  try{
    // 1) the subject: street name, neighbourhood code and a point
    const a = (await camaQuery({pids:[pid]}, CAMA_FIELDS, {ctx, fetchSignal})).rows[0];
    if(!a){ out.errors.push('No assessor record for PID '+pid+(ctx.down ? ': the county\u2019s main assessor layer is down and its backup tables have none either.' : '.')); return out; }
    if(keep) keep.subject = a;
    let lat = num(a.xcoord), lng = num(a.ycoord);   // camadata stores latitude in xcoord, longitude in ycoord
    if(lat==null || lng==null){
      try{
        const pj = await ajPost(`${PARCEL_LAYER}/query`, {where:`pid='${sq(pid)}'`, outFields:'pid', returnGeometry:'true', outSR:'4326', f:'json'}, fetchSignal);
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
      if(street){ try{ const lines = await centrelines(street, lat, lng, fetchSignal); cam = nearestOnLine({lat, lng}, lines); lineErr = centrelineError(lines); }
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
      street ? camaRows({where:`streetname='${sq(street)}'`, near:{lat, lng, ft}}, ctx, fetchSignal) : Promise.resolve(null),
      street ? centrelines(street, lat, lng, fetchSignal) : Promise.resolve(null),
      useCode ? camaRows({where:`neighborhood='${sq(nb.code)}'`}, ctx, fetchSignal) : Promise.resolve(null),
      nb.code ? Promise.resolve(null) : camaRows({near:{lat, lng, ft:NEAR_FT}}, ctx, fetchSignal),
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
          orderByFields:'OBJECTID'}, within(lat, lng, ft)), 'TAX_PID,GIS_PID', fetchSignal);
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
        try{ areaRows = await camaRows({where:`neighborhood='${sq(nb.code)}'`}, ctx, fetchSignal); }catch(e){ out.errors.push('neighborhood: '+e.message); }
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
        const ar = await camaRows({near:{lat, lng, ft:AREA_FT}}, ctx, fetchSignal);
        area = {label:'Everything within half a mile', kind:'radius', rows:ar.rows.filter(r=>r.pid!==pid)};
        if(ar.truncated) out.notes.push(`More than ${(PAGE*MAX_PAGES).toLocaleString()} parcels within half a mile; the first ${(PAGE*MAX_PAGES).toLocaleString()} were used.`);
      }catch(e){ out.errors.push('area: '+e.message); }
    }

    // 5) profiles, after one sold-as-vacant check over every home sale either side counts. v8.43: the City's condition
    //    records and the NCDOT traffic count run alongside; either one down costs only itself (an errors entry).
    const recAbort = new AbortController(); recTimer = setTimeout(()=>recAbort.abort(), RECORDS_MS);
    // AbortSignal.any is Node 20.3+; without it the connector's per-request signal is dropped here and the deadline still holds
    const recSignal = () => fetchSignal && AbortSignal.any ? AbortSignal.any([recAbort.signal, fetchSignal()]) : recAbort.signal;
    const late = e => recAbort.signal.aborted ? `didn't answer within ${RECORDS_MS/1000} s` : e.message;
    const recP = stRows ? conditionRecords(lat, lng, stRows, area ? area.rows : null, recSignal, out.notes)
      .catch(e=>{ out.errors.push('records: '+late(e)+' (no City code violations or 311 complaints counted)'); return null; }) : Promise.resolve(null);
    const trafficP = street ? trafficAt(lat, lng, cam, recSignal)
      .catch(e=>{ out.errors.push('traffic: '+late(e)+' (busy road not checked)'); return null; }) : Promise.resolve(null);
    // v8.44: every market sale over the last two TREND_MONTHS windows, for the direction line
    const salesP = stRows && area ? salesTrend(lat, lng, stRows, area.rows, recSignal)
      .catch(e=>{ out.errors.push('trend sales: '+late(e)+' (direction without the price signal)'); return null; }) : Promise.resolve(null);
    // v8.47: business parcels next door and stores within ¼ mile (county data, so the normal signal, not the City deadline)
    const aroundP = aroundLot(pid, lat, lng, ctx, fetchSignal)
      .catch(e=>{ out.errors.push('next door: '+e.message+' (business neighbours and stores not checked)'); return null; });
    const since = Date.now() - SALE_MONTHS*30.44*86400000;
    let lots = new Set();
    const salePids = [...new Set([...(stRows||[]), ...(area?area.rows:[])].filter(r=>isHomeSale(r, since)).map(r=>r.pid))];
    try{ lots = await lotSalePids(salePids, since, fetchSignal); }
    catch(e){ out.errors.push('sales: '+e.message+' (lot purchases may be counted as home sales)'); }
    if(stRows) out.street = Object.assign({label:`${label} within ${ft.toLocaleString()} ft`}, profile(stRows, since, lots));
    if(area) out.neighborhood = Object.assign({label:area.label, kind:area.kind}, profile(area.rows, since, lots));
    if(out.street && out.street.lot_sales_left_out) out.notes.push(`${out.street.lot_sales_left_out} lot purchase${out.street.lot_sales_left_out===1?'':'s'} (sold as vacant) left out of the street's sales.`);
    const [rec, traffic, sales, around] = await Promise.all([recP, trafficP, salesP, aroundP]);
    out.traffic = traffic; out.nearby = around;
    if(rec && rec.city === false) out.notes.push('Outside the City of Charlotte’s code-enforcement area, so no City code violations or 311 complaints are counted (the towns keep no open records like these). No records here doesn’t mean a clean street.');
    if(rec && rec.city){
      out.records = rec;
      const per = (k, p) => p.parcels ? Math.round(k/p.parcels*1000)/10 : null;
      // record_parcels: distinct parcel ids, the rates' base (the assessor rows can repeat a parcel, one per building)
      if(out.street) Object.assign(out.street, {record_parcels:rec.street.parcels, cases:rec.street.cases, cases_per100:per(rec.street.cases, rec.street),
        complaints:rec.street.complaints, complaints_per100:per(rec.street.complaints, rec.street)});
      if(out.neighborhood && rec.area) Object.assign(out.neighborhood, {record_parcels:rec.area.parcels, cases:rec.area.cases, cases_per100:per(rec.area.cases, rec.area),
        complaints:rec.area.complaints, complaints_per100:per(rec.area.complaints, rec.area)});
    }
    if(out.street && out.neighborhood){
      out.checks = compare(out.street, out.neighborhood);
      out.verdict = verdictFor(out.checks, out.street, out.neighborhood.kind==='radius'?'the half mile around it':'its neighbourhood',
        {records:!!out.records, traffic:!!traffic, aadt:traffic&&traffic.aadt, thoroughfare:traffic&&traffic.thoroughfare, busy:!!(traffic&&traffic.busy),
          demolition_orders:out.records ? out.records.street.demolition_orders : 0,
          next_door:around ? around.next_door : 0, next_door_uses:around ? around.next_door_uses : []});
      // v8.44: the street's direction, beside the verdict (it doesn't change the verdict)
      if(sales && sales.truncated) out.notes.push('More county sales in this area than one lookup returns, so the direction\u2019s price signal may be off.');
      const builds = buildsTrend(stRows, area.rows);
      out.trend = Object.assign(trendFor(sales, builds, out.records,
        out.neighborhood.kind==='radius' ? 'the half mile around it' : 'its neighbourhood'), {sales, builds});
    }

    // 6) Street View camera: the nearest point on the lot's own street centreline, facing the lot (no key: see mode=view)
    out.streetview = streetviewFor(lat, lng, cam, false);
    if(street && !out.streetview.camera && !lineErr) out.notes.push(NO_CENTRELINE);
  }catch(e){
    out.errors.push('fatal: '+e.message);
  }finally{
    clearTimeout(recTimer);
    // v8.35: say so when any of it came from the county's backup assessor tables
    if(ctx.backup && out.subject && !view) out.notes.unshift(camaBackupNote(ctx));
  }
  return out;
}
