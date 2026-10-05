// api/mcp.js — "TTV Street Data": a read-only MCP connector for claude.ai (Charlotte / Mecklenburg)  v1.1 (2026-10-05)
//
// The Street Walk artifact in claude.ai, and any Claude chat in the org, reaches the county's street data through this:
// an org admin adds it once as a custom connector (Organization settings → Connectors → Add → Custom → Web,
// https://ttv-site-analyzer.vercel.app/api/mcp, no auth). Two tools:
//   find_street   an address or PID → the houses on the lot's own stretch of street (street.js's "this street"), their
//                 assessor facts, City code-enforcement cases from the last 24 months, and the street check's answer
//   aerial_crops  1–6 PIDs → NC OneMap orthophoto crops, 220 ft square at 0.5 ft/px, with each parcel's outline in
//                 image pixels (the artifact draws the red outline itself, as scratchpad/aerial/build.py did). With
//                 outline:true (1–3 PIDs, for a model reading the photos itself, e.g. in a Claude chat) the connector
//                 draws it: lossless PNGs with the outline in red along rings_px, as build.py's draw_line() draws.
//
// Rules (AGENTS.md, "Street Data connector (MCP)"):
//   - No Google imagery or Google data, by any route. Nothing here calls a Google service; the AI's eyes are NC OneMap
//     orthoimagery and county records. Street View and Google Maps are link-outs for a person only (streetview_url,
//     maps_url are links built here, not Google responses).
//   - Code enforcement: case type, opened, closed and status only. The Inspector, EmailAddress and InspectorPhone
//     columns, the case address and the free-text DetailedDescription are never fetched (outFields is explicit, never
//     *). The violation a case cites is matched on the city's server (see VIOLATIONS), so the type returned is always
//     one of this file's fixed labels or the city's CaseType, never text from the record.
//   - No owner names. street.js reads the CAMA owner fields for its same-site rule; houseFrom() copies only the fields
//     it names, and the CAMA city / zipcode (the owner's mailing address) are never returned either.
//   - Authless and read-only, with no secrets, like the other /api/* endpoints. Public county, city and state data only.
//   - Fair housing, as in street.js: buildings, lots and land use, never who lives there.
//
// Transport: MCP Streamable HTTP, stateless, JSON responses (no SSE stream, no session id), so it runs as a plain Vercel
// function. POST takes one JSON-RPC 2.0 message or a batch; GET → 405; OPTIONS → 204.
import { streetCheck, STREET_FT, MARKET_VALIDITY, isHome, isVacant, isNonRes } from './street.js';
import { geocodeAddress, parcelAtPoint, findAttr } from './gis.js';
import { inflateSync, deflateSync } from 'node:zlib';

// 1.1.0 (2026-10-05): aerial_crops takes outline (an input shape change, so a minor bump; AGENTS.md)
const SERVER_INFO = {name:'ttv-street-data', title:'TTV Street Data', version:'1.1.0'};
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];   // newest first; an unknown request gets the newest
const UA = 'TTV-Street-Data/1.0 (+https://ttv-site-analyzer.vercel.app/api/mcp)';   // some county / state servers 403 bare agents

const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
const PARCEL_LAYER = `${MECK}/TaxParcelBoundaries/MapServer/0`;
const CE_LAYER = 'https://gis.charlottenc.gov/arcgis/rest/services/HNS/CodeEnforcementCasesAll/MapServer/0';
// the only code-enforcement columns ever requested (confirmed from the layer's ?f=json, 2026-10-01)
const CE_FIELDS = 'OBJECTID,ParcelId,CaseType,DateCreated,DateClosed,CaseStatus';
// NC OneMap serves the same image service from two hosts. services.nconemap.gov is the program's own; services.gis.nc.gov
// went unreachable on 2026-10-02 while it answered, so it's the fallback. A host that fails (timeout, network, 5xx) is
// skipped for the rest of the request.
const NC_IMAGERY_HOSTS = ['https://services.nconemap.gov', 'https://services.gis.nc.gov'];
const NC_IMAGERY_PATH = '/secure/rest/services/Imagery/Orthoimagery_Latest/ImageServer';

const CASE_MONTHS = 24;          // code cases opened in the last 24 months
const CE_CHUNK = 80;             // parcel ids per code-enforcement query (POST)
const CE_PAGE = 2000, CE_MAX_PAGES = 3;
const ID_CHUNK = 500;            // case ids per violation-label query
const MAX_HOUSES = 80;
const MAX_CROPS = 6;             // ~70 KB of base64 per crop keeps a call near 0.5 MB (Vercel's limit is 4.5 MB)
const HALF_FT = 110, CROP_PX = 440, FT_PER_PX = 0.5;   // 220 ft square at the service's native 0.5 ft
const JPEG_QUALITY = 90;         // the service is JPEG at source; 90 keeps detail close to the tested PNG crops
// outline:true: the crop is a lossless PNG (about 0.3 MB, 0.42 MB as base64) with the outline drawn in, so 3 per call
// make an answer of about 1.3 MB. That is under Vercel's 4.5 MB but over 1 MiB, a tool-result cap some MCP clients
// (Claude Desktop) have been reported to enforce. Until a 3-pid outline:true call is seen to reach Claude in a
// claude.ai chat, treat 3 as unproven; 2 (about 0.85 MB) is the fallback, and the page's CHAT_PER_CALL must match.
const MAX_OUTLINED = 3;
const OUTLINE_RGB = [255, 40, 40], OUTLINE_THICK = 2;   // build.py draw_line(col=(255, 40, 40), thick=2)
const PNG_MAX_SIDE = 4096;       // a sanity bound on a decoded crop (we ask for 440 x 440)
const FETCH_MS = 10000;          // per upstream request, the street check's and the geocode's included (see toolControl)
const TOOL_MS = 25000;           // per tool call, under the 30 s maxDuration vercel.json sets for this function
const LATE_MARGIN_MS = 1500;     // find_street's code-case and flight lookups stop this long before the tool's deadline
const REQUEST_MS = 28000;        // per HTTP request (a batch shares it)
const MAX_BODY = 1 << 20;
const PID_RX = /^[0-9A-Z]{8}$/;
const IMAGERY = {source:'NC OneMap Orthoimagery_Latest', ft_per_px:FT_PER_PX, crop_ft:2*HALF_FT, crop_px:CROP_PX,
  licence:'NC OneMap: free and unrestricted'};

// The violation a case cites, as its type. CaseType is coarse (Nuisance, Zoning, Parking, Graffiti, Housing, Commercial;
// eight in ten are Nuisance), and the ordinance a case cites sits only in DetailedDescription, a free-text field that
// also holds the reporter's own words. So that field is never fetched: each label is a where-clause match, run on the
// city's server, against the citation line ("10-167 (b) - Junked Motor Vehicles": section number and title), and a
// case takes the first label in this order that it cites (most visible from the street first), else its CaseType.
const VIOLATIONS = [
  ['Junked Motor Vehicles', ['10-167%Junked Motor Vehicle', '10-167 (d)%concealment']],
  ['Parking on the Lawn', ['14-216%Parking on the Lawn']],
  ['Hazardous vehicles', ['10-166%Hazardous vehicle']],
  ['Abandoned vehicles', ['10-165%Abandoned vehicle']],
  ['Illegal dumping', ['10-138%Illegal dumping']],
  ['Neglect of a Premise', ['10-136%Neglect of a Premise']],
  ['Overgrown vegetation', ['10-155%Overgrown vegetation']],
  ['Items at the curb', ['10-115%Placing or removing items from Curbside']],
  ['Obstruction of rights-of-way', ['10-140%Obstruction of rights-of-way']],
  ['Signs in the right-of-way', ['10-141%Signs within Public Rights-of-Way']],
];

const INSTRUCTIONS = [
  'TTV Street Data: public Mecklenburg County and City of Charlotte records, plus NC OneMap aerial photos, for Tide & Timber\'s street walks. Read-only.',
  'find_street takes a street address or an 8-character parcel id (PID) and returns the houses on the lot\'s own stretch of street (1,000 ft each way): assessor facts, City code-enforcement cases opened in the last 24 months (type, dates and status only), and the analyzer\'s county street check (verdict, checks and notes).',
  'aerial_crops returns 220 ft x 220 ft NC OneMap orthophotos (natural colour, 0.5 ft per pixel, north up, flown in winter, leaf-off) centred on up to 6 parcels, with each parcel\'s outline in image pixel coordinates. The images carry no outline; draw it from rings_px. For a model reading the photos itself (e.g. in a Claude chat), pass outline:true and up to 3 pids: the subject parcel comes back outlined in red.',
  'No Google imagery or Google data passes through this server. streetview_url and maps_url are links for a person to walk the street; never fetch them, screenshot them or read them with a model.',
  'Owner names and inspector details are never returned. Every check is about buildings, lots and land use, never who lives there.',
  'Screening data: the street check\'s thresholds are judgement, not backtested; an aerial "yes" is evidence, and a "no" isn\'t clearance (about half of confirmed violations weren\'t visible from above in testing).',
].join('\n');

const str = {type:'string'}, strN = {type:['string','null']}, numN = {type:['number','null']}, intN = {type:['integer','null']};
const strList = {type:'array', items:str};
const TOOLS = [
  {
    name:'find_street', title:'Find a street',
    description:'Look up the subject lot\'s own stretch of street in Mecklenburg County from the county\'s public records. Pass an address (e.g. "2723 Dellinger Dr") or a pid (an 8-character parcel id such as "04118535"); one of the two is required, and a pid wins when both are given. An address must match the county\'s address points (house number and street, direction and type included); a ZIP or city helps choose. Returns the subject, every parcel on the same street within 1,000 ft each way (at most 80, sorted by house number, subject flagged; for a street with N and S halves, only the subject\'s half), each with kind (home: a house, town house, condo, duplex or triplex; vacant: an unbuilt house lot; commercial; other: apartments, common areas, parks, rights of way and the like), year built, heated sf, assessor grade, land use, last market sale and City code-enforcement cases opened in the last 24 months (type, opened, closed, status). Also the analyzer\'s county street check for the lot (profile: verdict, checks against its assessor neighbourhood, notes), the NC OneMap flight date for aerial_crops, and link-outs for a person: streetview_url (TTV\'s Street View page) and maps_url (Google Maps). Never pass those links to a model.',
    inputSchema:{type:'object', properties:{
      address:{type:'string', description:'Street address in Mecklenburg County, e.g. "2723 Dellinger Dr" or "1500 N Davidson St, Charlotte, NC 28206".'},
      pid:{type:'string', description:'8-character Mecklenburg parcel id (PID), e.g. "04118535" or "08308C99".'},
    }, additionalProperties:false},
    outputSchema:{type:'object', properties:{
      subject:{type:'object', properties:{pid:str, address:strN, lat:numN, lng:numN, street:strN}, required:['pid','address','lat','lng','street']},
      stretch_ft:{type:'number'},
      houses:{type:'array', items:{type:'object', properties:{
        pid:str, address:strN, number:intN, subject:{type:'boolean'}, kind:{type:'string', enum:['home','vacant','commercial','other']},
        year_built:intN, heated_sf:numN, grade:strN, land_use:strN,
        last_sale:{type:['object','null'], properties:{date:str, price:{type:'number'}}, required:['date','price']},
        code_cases:{type:'array', items:{type:'object', properties:{type:str, opened:strN, closed:strN, status:strN},
          required:['type','opened','closed','status'], additionalProperties:false}},
      }, required:['pid','address','number','subject','kind','year_built','heated_sf','grade','land_use','last_sale','code_cases'], additionalProperties:false}},
      code_case_window_months:{type:'integer'},
      profile:{type:['object','null'], properties:{verdict:{type:['object','null']}, checks:{type:'array'}, street:{type:['object','null']},
        neighborhood:{type:['object','null']}, notes:strList}},
      imagery:{type:'object', properties:{source:str, flight:strN, ft_per_px:{type:'number'}, crop_ft:{type:'number'}, crop_px:{type:'integer'}, licence:str},
        required:['source','flight','ft_per_px','crop_ft','crop_px','licence']},
      streetview_url:str, maps_url:strN, notes:strList, errors:strList,
    }, required:['subject','stretch_ft','houses','code_case_window_months','profile','imagery','streetview_url','maps_url','notes','errors']},
    annotations:{readOnlyHint:true, openWorldHint:true},
  },
  {
    name:'aerial_crops', title:'Aerial photo crops',
    description:`NC OneMap orthophoto crops (Orthoimagery_Latest: natural colour, 0.5 ft per pixel, north up, flown in winter, leaf-off) of 1 to ${MAX_CROPS} Mecklenburg parcels, by pid. Each crop is a 440 x 440 px JPEG covering 220 ft x 220 ft centred on the parcel, returned as an image block in input order, with no outline drawn. structuredContent.crops says, for each pid, whether it worked, its image_index among the image blocks, its flight date, and rings_px: the parcel\'s outline in image pixels (x right, y down), for drawing the subject parcel\'s outline before a model reads the photo. For a model reading the photos itself (e.g. in a Claude chat), pass outline:true and up to ${MAX_OUTLINED} pids: the subject parcel comes back outlined in red. Each crop is then a lossless 440 x 440 PNG with the parcel\'s outline drawn in red (rgb 255,40,40, 2 px), marked outlined:true, and the subject parcel is the lot inside the red outline; a short text block right before each photo names its pid. A pid with no parcel geometry or no image comes back with ok:false and the reason.`,
    inputSchema:{type:'object', properties:{
      pids:{type:'array', minItems:1, maxItems:MAX_CROPS, items:{type:'string', pattern:'^[0-9A-Za-z]{8}$'},
        description:`1 to ${MAX_CROPS} 8-character Mecklenburg parcel ids (1 to ${MAX_OUTLINED} with outline:true), e.g. ["04118535","04118536"].`},
      outline:{type:'boolean', default:false,
        description:`true: each crop comes back as a lossless PNG with the parcel\'s outline drawn in red, for a model reading the photos itself (e.g. in a Claude chat); at most ${MAX_OUTLINED} pids per call. false (the default): a JPEG with no outline; draw it from rings_px.`},
    }, required:['pids'], additionalProperties:false},
    outputSchema:{type:'object', properties:{
      crops:{type:'array', items:{type:'object', properties:{
        pid:str, ok:{type:'boolean'}, image_index:{type:'integer'}, width:{type:'integer'}, height:{type:'integer'},
        ft_per_px:{type:'number'}, flight:strN,
        rings_px:{type:'array', items:{type:'array', items:{type:'array', items:{type:'number'}, minItems:2, maxItems:2}}},
        outlined:{type:'boolean', description:'true when the image block is a PNG with the parcel outline drawn in red (outline:true).'},
        error:str,
      }, required:['pid','ok']}},
      flight:strN,
    }, required:['crops','flight']},
    annotations:{readOnlyHint:true, openWorldHint:true},
  },
];

// ── upstream helpers ────────────────────────────────────────────────────────────────────────────────────────────────
const sq = s => String(s).replace(/'/g, "''");
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const round1 = v => Math.round(v*10)/10;
// Each request's signal: its own FETCH_MS timeout and, when a tool passes fetchSignal, the tool's deadline too.
const signalFor = fetchSignal => fetchSignal ? fetchSignal() : AbortSignal.timeout(FETCH_MS);
function anySignal(signals){
  if(typeof AbortSignal.any==='function') return AbortSignal.any(signals);
  const c = new AbortController();
  for(const s of signals){ if(s.aborted){ c.abort(s.reason); break; } s.addEventListener('abort', ()=>c.abort(s.reason), {once:true}); }
  return c.signal;
}
async function arcPost(url, params, fetchSignal){
  const r = await fetch(url, {method:'POST', body:new URLSearchParams(params).toString(), signal:signalFor(fetchSignal),
    headers:{'Content-Type':'application/x-www-form-urlencoded', 'User-Agent':UA}});
  if(!r.ok) throw new Error('HTTP '+r.status+' from '+new URL(url).host);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||''));
  return j;
}
async function arcGet(url, params, fetchSignal){
  const r = await fetch(url+'?'+new URLSearchParams(params).toString(), {signal:signalFor(fetchSignal), headers:{'User-Agent':UA}});
  if(!r.ok) throw new Error('HTTP '+r.status+' from '+new URL(url).host);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||''));
  return j;
}
const msg = e => (e && e.name==='TimeoutError') ? 'timed out' : String((e && e.message) || e);
// Run fn against each NC OneMap host in turn until one answers. A host that times out, can't be reached or answers
// 5xx is marked down for the rest of this tool call (keyed on the call's fetchSignal factory), so six crops don't each
// wait it out. An ArcGIS error, a non-image answer or the tool's own deadline is a real outcome and isn't retried.
const imageryDown = new WeakMap();
async function viaImageryHost(fn, fetchSignal){
  let down = fetchSignal ? imageryDown.get(fetchSignal) : null;
  if(!down){ down = new Set(); if(fetchSignal) imageryDown.set(fetchSignal, down); }
  let last = null;
  for(const host of NC_IMAGERY_HOSTS){
    if(down.has(host)) continue;
    try{ return await fn(host+NC_IMAGERY_PATH); }
    catch(e){
      const m = msg(e), hostFailed = m==='timed out' || /HTTP 5\d\d|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(m);
      if(!hostFailed) throw e;
      down.add(host); last = e;
    }
  }
  throw last || new Error('no NC OneMap host answered');
}
// The city stores DateCreated in UTC and DateClosed / the CAMA sale dates as local midnight, so a date is the
// calendar day in Charlotte.
const DAY = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'});
function localDate(ms){
  if(typeof ms!=='number' || !isFinite(ms) || ms<=0) return null;
  const p = Object.fromEntries(DAY.formatToParts(new Date(ms)).map(x=>[x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function monthsAgoISO(n){ const d = new Date(); d.setUTCMonth(d.getUTCMonth()-n); return d.toISOString().slice(0,10); }

// ── find_street ────────────────────────────────────────────────────────────────────────────────────────────────────
// kind picks what the Street Walk grades (home and vacant), so it means a house and a house lot. It starts from
// street.js's tests and adds the walk's own (only the label changes; the street check's counts stay street.js's):
//   - a common area (an HOA strip, a town-house or condo common area, a commercial one) is no one's house or lot: never
//     home or vacant, whatever its code;
//   - home: street.js's isHome (heated area on an R code, or on no code with a house description), or a residential
//     building the county codes otherwise: a duplex / triplex (A562, A500), a single-family house on an exempt or
//     industrial code (9614, 1000, I600), a rural or use-value homesite, a town house, condo or house on an
//     affordable-housing code (AF09, AF04, AF01). Apartment buildings ("MULTI FAMILY", "… GARDEN", "… HIGH RISE")
//     stay other;
//   - commercial: street.js's isNonRes, checked before vacant, so a vacant commercial or industrial lot is commercial;
//   - vacant: no building on the record (CAMA's VAC, or no heated area and no building value, which an "IMP" teardown
//     can show) on a house lot: an R code or a house land use, never a condo parcel, a park, a greenway, a right of
//     way, rail, a utility or a floodway (those are other).
const COMMON_AREA = /COMMON/i;
const HOUSE_USE = /SINGLE FAMILY|TOWN ?HOUSE|DUPLEX|TRIPLEX|MOBILE HOME|HOMESITE|RESIDENTIAL AFFORDABLE/i;
const CONDO_USE = /^CONDO/i;     // "CONDOMINIUM …", "CONDO AFFORDABLE HOUSING"; not "OFFICE CONDOMINIUM"
function walkKind(r){
  const d = (r.landuse_description||'').trim(), code = (r.lusecode||'').trim(), built = num(r.heatedarea)>0;
  if(COMMON_AREA.test(d)) return isNonRes(r) ? 'commercial' : 'other';
  if(isHome(r) || (built && (HOUSE_USE.test(d) || CONDO_USE.test(d)))) return 'home';
  if(isNonRes(r)) return 'commercial';
  const unbuilt = isVacant(r) || (!built && !(num(r.totalbldgval)>0));
  return unbuilt && !CONDO_USE.test(d) && (/^R/i.test(code) || HOUSE_USE.test(d)) ? 'vacant' : 'other';
}
// One house from its CAMA row: only these fields leave the server (never the owner, mailing city or ZIP).
function houseFrom(r, streetLabel, subjectPid){
  const v = (r.validsale||'').trim().toUpperCase(), price = num(r.saleprice), n = parseInt(r.streetnumber, 10);
  const yb = parseInt(r.yearbuilt, 10), sf = num(r.heatedarea);
  return {
    pid:r.pid, address:(r.streetnumber||'').trim() && streetLabel ? `${(r.streetnumber||'').trim()} ${streetLabel}` : null,
    number:isFinite(n) ? n : null, subject:r.pid===subjectPid,
    kind: walkKind(r),
    year_built: yb>1700 ? yb : null, heated_sf: sf>0 ? Math.round(sf) : null,
    grade:(r.grade||'').trim()||null, land_use:(r.landuse_description||'').trim()||null,
    // the last sale on the assessor record when it's a market sale (blank = arm's length, Z = builder sale)
    last_sale: MARKET_VALIDITY.includes(v) && price>0 && localDate(r.saledate) ? {date:localDate(r.saledate), price:Math.round(price)} : null,
    code_cases:[],
  };
}

// Case ids (from `ids`) whose citation matches one of `pats`, matched on the city's server: nothing of the
// description comes back, only object ids.
async function idsCiting(ids, pats, fetchSignal){
  const hit = new Set();
  for(let i=0; i<ids.length; i+=ID_CHUNK){
    const chunk = ids.slice(i, i+ID_CHUNK);
    const like = pats.map(p=>`DetailedDescription LIKE '%${sq(p)}%'`).join(' OR ');
    const j = await arcPost(`${CE_LAYER}/query`, {where:`OBJECTID IN (${chunk.join(',')}) AND (${like})`, returnIdsOnly:'true', f:'json'}, fetchSignal);
    (j.objectIds||[]).forEach(id=>hit.add(id));
  }
  return hit;
}
// Code-enforcement cases opened in the last CASE_MONTHS on these parcels: {byPid: Map(pid → [case]), notes, errors}
async function codeCases(pids, fetchSignal){
  const since = monthsAgoISO(CASE_MONTHS), rows = [], notes = [], errors = [];
  for(let i=0; i<pids.length; i+=CE_CHUNK){
    const inList = pids.slice(i, i+CE_CHUNK).map(p=>`'${sq(p)}'`).join(',');
    for(let p=0; ; p++){
      const j = await arcPost(`${CE_LAYER}/query`, {where:`ParcelId IN (${inList}) AND DateCreated >= DATE '${since}'`,
        outFields:CE_FIELDS, returnGeometry:'false', orderByFields:'OBJECTID', resultOffset:String(p*CE_PAGE),
        resultRecordCount:String(CE_PAGE), f:'json'}, fetchSignal);
      (j.features||[]).forEach(f=>rows.push(f.attributes||{}));
      if(!j.exceededTransferLimit && (j.features||[]).length < CE_PAGE) break;
      if(p+1 >= CE_MAX_PAGES){ notes.push(`More than ${(CE_PAGE*CE_MAX_PAGES).toLocaleString()} code cases on these parcels; the first ${(CE_PAGE*CE_MAX_PAGES).toLocaleString()} are listed.`); break; }
    }
  }
  const label = new Map(), ids = rows.map(r=>r.OBJECTID).filter(Number.isInteger);
  if(ids.length){
    const rs = await Promise.allSettled(VIOLATIONS.map(([, pats])=>idsCiting(ids, pats, fetchSignal)));
    let failed = 0;
    rs.forEach((r, k)=>{ if(r.status!=='fulfilled'){ failed++; return; } r.value.forEach(id=>{ if(!label.has(id)) label.set(id, VIOLATIONS[k][0]); }); });
    if(failed) errors.push(`code case types: ${failed} of ${VIOLATIONS.length} violation checks didn't answer (${msg(rs.find(r=>r.status==='rejected').reason)}), so some cases show the city's broad case type (e.g. Nuisance) instead of the violation cited.`);
  }
  const byPid = new Map();
  rows.sort((a,b)=>(b.DateCreated||0)-(a.DateCreated||0)).forEach(r=>{
    const pid = (r.ParcelId||'').trim().toUpperCase(); if(!pid) return;
    if(!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push({type:label.get(r.OBJECTID) || (r.CaseType||'').trim() || 'Unknown', opened:localDate(r.DateCreated),
      closed:localDate(r.DateClosed), status:(r.CaseStatus||'').trim()||null});
  });
  return {byPid, notes, errors};
}

// The NC OneMap flight under a point: the visible catalog tile's name carries its date ("OF6i0_37_000_10454602_20230218_0304R0").
async function flightAt(geometry, fetchSignal){
  const j = await viaImageryHost(base=>arcGet(`${base}/identify`, {geometry:JSON.stringify(geometry), geometryType:'esriGeometryPoint',
    returnGeometry:'false', returnCatalogItems:'true', f:'json'}, fetchSignal), fetchSignal);
  const feats = (j.catalogItems && j.catalogItems.features) || [], vis = j.catalogItemVisibilities || [];
  const dated = feats.map((f, i)=>({m:String((f.attributes||{}).name||'').match(/_(20\d\d)(\d\d)(\d\d)_/), v:vis[i]})).filter(x=>x.m);
  const pick = dated.find(x=>x.v>0) || dated[0];
  return pick ? `${pick.m[1]}-${pick.m[2]}-${pick.m[3]}` : null;
}

async function findStreet(args, ctl){
  const notes = [], errors = [];
  if(args.pid!=null && typeof args.pid!=='string') return toolError('pid must be a string: an 8-character Mecklenburg parcel id such as "04118535".');
  if(args.address!=null && typeof args.address!=='string') return toolError('address must be a string, e.g. "2723 Dellinger Dr".');
  let pid = (args.pid||'').trim().toUpperCase();
  const address = (args.address||'').trim();
  if(!pid && !address) return toolError('Pass an address (e.g. "2723 Dellinger Dr") or a pid (an 8-character Mecklenburg parcel id such as "04118535").');
  if(pid && !PID_RX.test(pid)) return toolError(`"${pid.slice(0,24)}" isn't a Mecklenburg parcel id. A PID is 8 letters or digits, e.g. 04118535 or 08308C99.`);
  if(address.length > 200) return toolError('That address is too long. Type the house number and street, e.g. "2723 Dellinger Dr".');
  let geocoded = null;
  if(!pid){
    // the same geocode as /api/gis?address=, so the connector finds the parcel the analyzer loads
    let m;
    try{ m = await geocodeAddress(address, undefined, false, ctl.fetchSignal); }
    catch(e){ return toolError(`The county address lookup didn't answer (${msg(e)}). Try again in a minute, or pass the parcel id.`); }
    // gis.js words its messages for the analyzer's auto-fill button
    const said = s => String(s||'').replace(/,? then run the auto-fill again/g, ', then try again').replace(/Auto-fill covers Mecklenburg only/g, 'This covers Mecklenburg only');
    if(!m.feature) return toolError(said(m.message) || `No county address point matched "${address}".`);
    if(m.status==='close') notes.push(said(m.message));
    let pj;
    try{ pj = await parcelAtPoint(m.feature.geometry, ctl.fetchSignal); }
    catch(e){ return toolError(`County GIS matched ${m.matched}, but the parcel layer didn't answer (${msg(e)}). Try again in a minute.`); }
    const f = (pj.features||[])[0], v = f && findAttr(f.attributes, /^pid$/i);
    if(!v) return toolError(`County GIS matched ${m.matched}, but there's no parcel under that address point. Pass the parcel id instead.`);
    pid = String(v.value).trim().toUpperCase();
    geocoded = m;
  } else if(address) notes.push('Both a pid and an address were given; the pid was used.');

  // the analyzer's street check for the lot, and the same street rows it counted
  const keep = {};
  const sc = await streetCheck(pid, STREET_FT, false, keep, ctl.fetchSignal);
  if(!sc.subject){
    const why = sc.errors.join('; ');
    if(/^No assessor record/.test(why)) return toolError(`No county assessor record for PID ${pid}. Check the parcel id (a newly created lot can take a few weeks to reach the county's records).`);
    return toolError(`The county assessor records didn't answer for PID ${pid} (${why || 'no answer'}). Try again in a minute.`);
  }
  if(sc.subject.lat==null || sc.subject.lng==null) return toolError(`The county has no location for PID ${pid}, so its street can't be found.`);
  sc.errors.forEach(e=>errors.push('street check: '+e));
  const label = sc.subject.street_label || sc.subject.street || null;
  let rows = keep.rows;
  if(!rows){
    if(sc.subject.street) return toolError(`The county didn't answer for the parcels on ${label} (${sc.errors.join('; ') || 'no answer'}). Try again in a minute.`);
    rows = [];   // no street name on the record: the subject alone (street.js's notes say so)
  }
  // the subject is normally among the street's rows; listed anyway when it isn't, and said, so an empty or mis-filtered
  // street can't hide behind it
  if(!rows.some(r=>r.pid===pid) && keep.subject){
    rows = [keep.subject, ...rows];
    if(sc.subject.street) notes.push(`The subject wasn't among the parcels the street check found on ${label}; it's listed anyway.`);
  }
  // one house per parcel (a condo's unit rows share one PID); at most MAX_HOUSES, nearest the subject first
  const seen = new Set(); let list = rows.filter(r=>r.pid && !seen.has(r.pid) && seen.add(r.pid));
  if(list.length > MAX_HOUSES){
    const {lat, lng} = sc.subject, k = Math.cos(lat*Math.PI/180);
    const d = r => { const a = num(r.xcoord), b = num(r.ycoord);   // CAMA: xcoord is latitude, ycoord longitude
      return r.pid===pid ? -1 : (a==null || b==null) ? Infinity : Math.hypot(a-lat, (b-lng)*k); };
    const dropped = list.length - MAX_HOUSES;
    list = list.map(r=>({r, d:d(r)})).sort((x,y)=>x.d-y.d).slice(0, MAX_HOUSES).map(x=>x.r);
    notes.push(`${dropped} parcel${dropped===1?'':'s'} further along the street left out (the list stops at the ${MAX_HOUSES} nearest the subject).`);
  }
  const houses = list.map(r=>houseFrom(r, label, pid))
    .sort((a,b)=>(a.number??Infinity)-(b.number??Infinity) || (a.pid<b.pid?-1:a.pid>b.pid?1:0));

  // code cases (every house, by ParcelId) and the flight date, in parallel; either one down costs only itself. They get
  // only what's left of the tool's budget, so a slow city server costs the cases, not the houses already built.
  const {lat, lng} = sc.subject;
  const stop = AbortSignal.timeout(Math.max(LATE_MARGIN_MS, ctl.deadline - Date.now() - LATE_MARGIN_MS));
  const late = () => anySignal([stop, ctl.fetchSignal()]);
  const [ceR, flR] = await Promise.allSettled([codeCases(houses.map(h=>h.pid), late), flightAt({x:lng, y:lat, spatialReference:{wkid:4326}}, late)]);
  if(ceR.status==='fulfilled'){
    houses.forEach(h=>{ h.code_cases = ceR.value.byPid.get(h.pid) || []; });
    notes.push(...ceR.value.notes); errors.push(...ceR.value.errors);
  } else errors.push(`code cases: the City of Charlotte code-enforcement layer didn't answer (${msg(ceR.reason)}), so no house shows its cases. Some may have them; try again later.`);
  const flight = flR.status==='fulfilled' ? flR.value : null;
  if(flR.status==='rejected') errors.push(`imagery: the NC OneMap catalog didn't answer (${msg(flR.reason)}), so the flight date is unknown.`);
  else if(!flight) notes.push('NC OneMap has no dated imagery tile under this lot.');

  const result = {
    subject:{pid, address: geocoded && geocoded.point ? geocoded.point.street : (houses.find(h=>h.subject)||{}).address || null,
      lat, lng, street:label},
    stretch_ft:STREET_FT,
    houses,
    code_case_window_months:CASE_MONTHS,
    profile: sc.street ? {verdict:sc.verdict, checks:sc.checks, street:sc.street, neighborhood:sc.neighborhood, notes:sc.notes} : null,
    imagery:Object.assign({}, IMAGERY, {flight}),
    streetview_url:`https://ttv-site-analyzer.vercel.app/streetview.html?pid=${encodeURIComponent(pid)}`,
    maps_url:`https://www.google.com/maps/search/?api=1&query=${+lat.toFixed(7)},${+lng.toFixed(7)}`,
    notes, errors,
  };
  return {content:[{type:'text', text:JSON.stringify(result)}], structuredContent:result};
}

// ── aerial_crops ───────────────────────────────────────────────────────────────────────────────────────────────────
// Width and height from a JPEG's start-of-frame marker (null if it has none).
function jpegSize(b){
  for(let i=2; i+9<b.length; ){
    if(b[i]!==0xFF){ i++; continue; }
    const m = b[i+1];
    if(m===0xD8 || m===0x01 || (m>=0xD0 && m<=0xD7)){ i+=2; continue; }
    const len = b.readUInt16BE(i+2);
    if(m>=0xC0 && m<=0xCF && m!==0xC4 && m!==0xC8 && m!==0xCC) return {height:b.readUInt16BE(i+5), width:b.readUInt16BE(i+7)};
    i += 2+len;
  }
  return null;
}
// The crop from NC OneMap, through viaImageryHost's host fallback: a JPEG (format jpg at JPEG_QUALITY), or for
// outline:true a PNG (format png24: lossless, so the outline is drawn on exactly the pixels NC OneMap sent).
const IMAGE_FORMATS = {
  jpeg:{params:{format:'jpg', compressionQuality:String(JPEG_QUALITY)}, magic:[0xFF, 0xD8], name:'a JPEG'},
  png:{params:{format:'png24'}, magic:[0x89, 0x50, 0x4E, 0x47], name:'a PNG'},
};
async function exportImage(bbox, kind, fetchSignal){ return viaImageryHost(base=>exportImageFrom(base, bbox, kind, fetchSignal), fetchSignal); }
async function exportImageFrom(base, bbox, kind, fetchSignal){
  const fmt = IMAGE_FORMATS[kind];
  const r = await fetch(`${base}/exportImage?`+new URLSearchParams({bbox:bbox.join(','), bboxSR:'2264', imageSR:'2264',
    size:`${CROP_PX},${CROP_PX}`, ...fmt.params, f:'image'}).toString(),
    {signal:signalFor(fetchSignal), headers:{'User-Agent':UA}});
  if(!r.ok) throw new Error('HTTP '+r.status+' from NC OneMap');
  const b = Buffer.from(await r.arrayBuffer());
  if(b.length < fmt.magic.length+1 || fmt.magic.some((v, i)=>b[i]!==v)){
    let why = ''; try{ const j = JSON.parse(b.toString('utf8')); why = j && j.error ? `: ${j.error.message||j.error.code}` : ''; }catch(_){ /* not JSON */ }
    throw new Error(`NC OneMap sent ${r.headers.get('content-type')||'something'} instead of ${fmt.name}${why}`);
  }
  return b;
}

// ── outline:true: PNG in, red outline drawn, PNG out ────────────────────────────────────────────────────────────────
// scratchpad/aerial/build.py built the tested crops (research/08, /09) with its own small PNG codec and draw_line();
// pngRead and drawLine are ports of its png_read and draw_line. A crop outlined here is pixel for pixel what build.py's
// png_read + draw_line make when run on the same png24 source along rings_px (the connector test checks exactly that,
// with build.py's own functions). It is not pixel for pixel the research set: build.py's crop() drew full-precision
// points against the unrounded bbox (sx = w/220), while rings_px are rounded to 0.1 px against the 0.1 ft bbox the
// image is requested for, so a few percent of the outline's pixels sit 1 px apart. Keep rings_px: that bbox is the
// one NC OneMap rendered the image for, and it's the outline the artifact draws too.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
// build.py png_read(): 8-bit RGB (colour type 2) or RGBA (6), non-interlaced, every filter type; alpha dropped.
// Returns {w, h, rgb} (rgb: w*h*3 bytes, row by row). Any other PNG throws, with a reason that says what it was.
function pngRead(b){
  if(b.length < PNG_SIG.length || !b.subarray(0, PNG_SIG.length).equals(PNG_SIG)) throw new Error('not a PNG');
  let i = PNG_SIG.length, w = null, h = null, ct = null;
  const idat = [];
  while(i + 12 <= b.length){
    const n = b.readUInt32BE(i), t = b.toString('latin1', i+4, i+8);
    if(i + 12 + n > b.length) throw new Error('the PNG is cut short');
    const data = b.subarray(i+8, i+8+n); i += 12 + n;
    if(t==='IHDR'){
      if(n!==13) throw new Error('the PNG header is malformed');
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      const bd = data[8], il = data[12]; ct = data[9];
      if(bd!==8 || il!==0 || (ct!==2 && ct!==6))
        throw new Error(`the PNG is ${bd}-bit, colour type ${ct}${il ? ', interlaced' : ''}; only 8-bit RGB or RGBA, non-interlaced, can be outlined`);
      if(!(w>0 && h>0 && w<=PNG_MAX_SIDE && h<=PNG_MAX_SIDE)) throw new Error(`the PNG is ${w} x ${h} px`);
    }
    else if(t==='IDAT') idat.push(data);
    else if(t==='IEND') break;
  }
  if(w==null) throw new Error('the PNG has no header');
  const bpp = ct===2 ? 3 : 4, stride = w*bpp;
  let raw;
  try{ raw = inflateSync(Buffer.concat(idat)); }catch(e){ throw new Error('the PNG image data is corrupt'); }
  if(raw.length < h*(stride+1)) throw new Error('the PNG image data is cut short');
  const rgb = Buffer.alloc(w*h*3);
  let prev = Buffer.alloc(stride), p = 0;
  for(let y=0; y<h; y++){
    const f = raw[p], line = Buffer.from(raw.subarray(p+1, p+1+stride)); p += 1+stride;
    if(f > 4) throw new Error(`the PNG has an unknown row filter (${f})`);
    if(f) for(let x=0; x<stride; x++){
      const a = x>=bpp ? line[x-bpp] : 0, c = x>=bpp ? prev[x-bpp] : 0, up = prev[x];
      if(f===1) line[x] = (line[x] + a) & 255;
      else if(f===2) line[x] = (line[x] + up) & 255;
      else if(f===3) line[x] = (line[x] + ((a + up) >> 1)) & 255;
      else {
        const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2*c);
        line[x] = (line[x] + (pa<=pb && pa<=pc ? a : pb<=pc ? up : c)) & 255;
      }
    }
    if(bpp===3) line.copy(rgb, y*w*3);
    else for(let x=0, o=y*w*3; x<w; x++, o+=3){ rgb[o] = line[x*4]; rgb[o+1] = line[x*4+1]; rgb[o+2] = line[x*4+2]; }
    prev = line;
  }
  return {w, h, rgb};
}
// Python's round(): the nearest integer, a tie to the even one (round(2.5) = 2, round(3.5) = 4).
function pyRound(x){ const r = Math.round(x); return Math.abs(x % 1)===0.5 ? 2*Math.round(x/2) : r; }
// build.py draw_line(): n = int(max(|dx|, |dy|)) + 1 steps, each point rounded as Python does, and a thick x thick block
// over range(-thick//2, thick - thick//2) around it (2 px: round(x)-1 .. round(x), the same for y), clipped to the image.
const OUT_FROM = Math.floor(-OUTLINE_THICK/2), OUT_TO = OUTLINE_THICK - Math.floor(OUTLINE_THICK/2);
function drawLine(rgb, w, h, x0, y0, x1, y1){
  const n = Math.trunc(Math.max(Math.abs(x1-x0), Math.abs(y1-y0))) + 1;
  for(let k=0; k<=n; k++){
    const t = k / Math.max(n, 1), x = x0 + (x1-x0)*t, y = y0 + (y1-y0)*t, rx = pyRound(x), ry = pyRound(y);
    for(let dx=OUT_FROM; dx<OUT_TO; dx++) for(let dy=OUT_FROM; dy<OUT_TO; dy++){
      const xi = rx+dx, yi = ry+dy;
      if(xi>=0 && xi<w && yi>=0 && yi<h){ const o = (yi*w+xi)*3; rgb[o] = OUTLINE_RGB[0]; rgb[o+1] = OUTLINE_RGB[1]; rgb[o+2] = OUTLINE_RGB[2]; }
    }
  }
}
// Every ring as build.py crop() walks it: each vertex to the next (zip(pts, pts[1:]); the county's rings are closed).
function drawRings(img, ringsPx){
  ringsPx.forEach(ring=>{ for(let i=0; i+1<ring.length; i++) drawLine(img.rgb, img.w, img.h, ring[i][0], ring[i][1], ring[i+1][0], ring[i+1][1]); });
}
const CRC_TABLE = (()=>{ const t = new Uint32Array(256);
  for(let n=0; n<256; n++){ let c = n; for(let k=0; k<8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t; })();
function crc32(buf){ let c = 0xFFFFFFFF; for(let i=0; i<buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data){
  const head = Buffer.alloc(8), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
// 8-bit RGB PNG, lossless. Each row takes the filter (none, sub, up, average, Paeth) whose bytes have the smallest sum
// of magnitudes, the PNG spec's suggested heuristic; a 440 x 440 photo comes out near 0.3 MB, about the size of the png24 source.
function pngWrite(w, h, rgb){
  const bpp = 3, stride = w*bpp, raw = Buffer.alloc(h*(stride+1)), zero = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(()=>Buffer.alloc(stride));
  for(let y=0; y<h; y++){
    const cur = rgb.subarray(y*stride, (y+1)*stride), up = y ? rgb.subarray((y-1)*stride, y*stride) : zero;
    let best = 0, bestSum = Infinity;
    for(let f=0; f<5; f++){
      const o = cand[f]; let sum = 0;
      for(let x=0; x<stride; x++){
        const a = x>=bpp ? cur[x-bpp] : 0, b = up[x], c = x>=bpp ? up[x-bpp] : 0;
        let pred = 0;
        if(f===1) pred = a; else if(f===2) pred = b; else if(f===3) pred = (a + b) >> 1;
        else if(f===4){ const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2*c); pred = pa<=pb && pa<=pc ? a : pb<=pc ? b : c; }
        const v = (cur[x] - pred) & 255;
        o[x] = v; sum += v < 128 ? v : 256 - v;
      }
      if(sum < bestSum){ bestSum = sum; best = f; }
    }
    raw[y*(stride+1)] = best; cand[best].copy(raw, y*(stride+1)+1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB, deflate, no interlace
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, {level:9})), pngChunk('IEND', Buffer.alloc(0))]);
}
// Parcel rings (state plane feet) for each PID: the first feature per PID, as build.py's parcel_geom() takes.
async function parcelRings(pids, fetchSignal){
  const j = await arcPost(`${PARCEL_LAYER}/query`, {where:`pid IN (${pids.map(p=>`'${sq(p)}'`).join(',')})`, outFields:'pid',
    returnGeometry:'true', outSR:'2264', orderByFields:'objectid', f:'json'}, fetchSignal);
  const m = new Map();
  (j.features||[]).forEach(f=>{ const p = ((f.attributes||{}).pid||'').trim().toUpperCase(), g = f.geometry;
    if(p && !m.has(p) && g && g.rings && g.rings.length && g.rings[0].length) m.set(p, g.rings); });
  return m;
}
// One crop, exactly as build.py crop(): a 220 ft box centred on the mean of the first ring's vertices (closing vertex
// included, as the county returns it), bbox to 0.1 ft. Pixels: (x-minx)*sx, (maxy-y)*sy against the bbox requested.
// outline:true: the PNG is decoded, every ring is drawn along rings_px (the same points the artifact draws from) and
// the result is encoded again; a PNG this can't decode is that crop's ok:false, with the reason.
async function cropOne(pid, rings, fetchSignal, outline){
  if(!rings) return {pid, ok:false, error:'no parcel geometry'};
  const r0 = rings[0], cx = r0.reduce((t,p)=>t+p[0],0)/r0.length, cy = r0.reduce((t,p)=>t+p[1],0)/r0.length;
  const bbox = [cx-HALF_FT, cy-HALF_FT, cx+HALF_FT, cy+HALF_FT].map(v=>+v.toFixed(1));
  const [imgR, flR] = await Promise.allSettled([exportImage(bbox, outline ? 'png' : 'jpeg', fetchSignal), flightAt({x:cx, y:cy, spatialReference:{wkid:2264}}, fetchSignal)]);
  if(imgR.status==='rejected') return {pid, ok:false, error:'imagery: '+msg(imgR.reason)};
  let img = null, size;
  if(outline){
    try{ img = pngRead(imgR.value); }catch(e){ return {pid, ok:false, error:'imagery: NC OneMap sent a PNG that can\'t be outlined: '+msg(e)}; }
    size = {width:img.w, height:img.h};
  } else size = jpegSize(imgR.value) || {width:CROP_PX, height:CROP_PX};
  const sx = size.width/(bbox[2]-bbox[0]), sy = size.height/(bbox[3]-bbox[1]);
  const rings_px = rings.map(ring=>ring.map(([x,y])=>[round1((x-bbox[0])*sx), round1((bbox[3]-y)*sy)]));
  const out = {pid, ok:true, width:size.width, height:size.height, ft_per_px:FT_PER_PX,
    flight: flR.status==='fulfilled' ? flR.value : null, rings_px};
  if(!outline) return Object.assign(out, {_image:{data:imgR.value, mimeType:'image/jpeg'}});
  drawRings(img, rings_px);
  return Object.assign(out, {outlined:true, _image:{data:pngWrite(img.w, img.h, img.rgb), mimeType:'image/png'}});
}

async function aerialCrops(args, ctl){
  const raw = args.pids, outline = args.outline;
  if(outline!=null && typeof outline!=='boolean') return toolError('outline must be true or false (true: PNG crops with the parcel outlined in red, up to 3 pids).');
  if(outline){
    if(!Array.isArray(raw) || !raw.length) return toolError(`Pass pids: a list of 1 to ${MAX_OUTLINED} parcel ids with outline:true, e.g. ["04118535","04118536"].`);
    if(raw.length > MAX_OUTLINED) return toolError(`At most ${MAX_OUTLINED} parcels per call with outline:true (each outlined crop is a PNG of about 0.3 MB). Send ${MAX_OUTLINED} at a time.`);
  }
  if(!Array.isArray(raw) || !raw.length) return toolError(`Pass pids: a list of 1 to ${MAX_CROPS} parcel ids, e.g. ["04118535","04118536"].`);
  if(raw.length > MAX_CROPS) return toolError(`At most ${MAX_CROPS} parcels per call (each crop is about 70 KB). Split the list into calls of ${MAX_CROPS}.`);
  const order = [];
  raw.forEach(p=>{ const s = typeof p==='string' ? p.trim().toUpperCase() : String(p); if(!order.includes(s)) order.push(s); });
  const valid = order.filter(p=>PID_RX.test(p));
  let rings = new Map();
  if(valid.length){
    try{ rings = await parcelRings(valid, ctl.fetchSignal); }
    catch(e){ return toolError(`The county parcel layer didn't answer (${msg(e)}), so no crop could be cut. Try again in a minute.`); }
  }
  const done = await Promise.all(order.map(p=>PID_RX.test(p) ? cropOne(p, rings.get(p), ctl.fetchSignal, outline===true)
    : Promise.resolve({pid:p.slice(0,24), ok:false, error:'not an 8-character Mecklenburg parcel id'})));
  const images = [], imagePids = [];
  const crops = done.map(c=>{ if(!c.ok) return c; const {_image, ...rest} = c; rest.image_index = images.length;
    images.push({type:'image', data:_image.data.toString('base64'), mimeType:_image.mimeType}); imagePids.push(rest.pid);
    const crop = {pid:rest.pid, ok:true, image_index:rest.image_index, width:rest.width, height:rest.height, ft_per_px:rest.ft_per_px,
      flight:rest.flight, rings_px:rest.rings_px};
    if(rest.outlined) crop.outlined = true;
    return crop; });
  const fl = {}; crops.forEach(c=>{ if(c.ok && c.flight) fl[c.flight] = (fl[c.flight]||0)+1; });
  const result = {crops, flight:Object.entries(fl).sort((a,b)=>b[1]-a[1] || (a[0]<b[0]?1:-1)).map(e=>e[0])[0] || null};
  // outline:true (a model reading the photos itself): a short text block right before each photo names its pid, so a
  // photo can't be paired with the wrong parcel when a crop in the middle failed (image_index counts only the crops
  // that worked). image_index still counts image blocks only; outline:false answers carry no labels, as in 1.0.0.
  const blocks = outline===true ? images.flatMap((im, k)=>[{type:'text',
    text:`Photo ${k+1} of ${images.length}: pid ${imagePids[k]} (image_index ${k}). The subject parcel is the lot inside the red outline.`}, im]) : images;
  const out = {content:[{type:'text', text:JSON.stringify(result)}, ...blocks], structuredContent:result};
  if(!images.length){
    out.isError = true;
    out.content.unshift({type:'text', text:'No crop could be made: '+crops.map(c=>`${c.pid}: ${c.error}`).join('; ')+'.'});
  }
  return out;
}

// ── JSON-RPC / MCP plumbing ────────────────────────────────────────────────────────────────────────────────────────
const toolError = text => ({content:[{type:'text', text}], isError:true});
const rpcResult = (id, result) => ({jsonrpc:'2.0', id, result});
const rpcError = (id, code, message) => ({jsonrpc:'2.0', id:id===undefined ? null : id, error:{code, message}});
function withDeadline(p, ms, what){
  let t; const timer = new Promise(res=>{ t = setTimeout(()=>res(toolError(`${what} ran out of time (${Math.round(ms/1000)} s): the county, city or state servers are slow. Try again in a minute.`)), ms); });
  return Promise.race([p, timer]).finally(()=>clearTimeout(t));
}
// One tool call's budget: its deadline, and fetchSignal, which gives every upstream request it makes (street.js's and
// gis.js's included) a FETCH_MS timeout plus the call's own abort. callTool aborts when the call ends, on time or not,
// so no county, city or state request outlives its tool call.
function toolControl(ms){
  const ac = new AbortController();
  return {ac, deadline:Date.now()+ms, fetchSignal:() => anySignal([ac.signal, AbortSignal.timeout(FETCH_MS)])};
}
async function callTool(params, ctx){
  const name = params && params.name, args = params && params.arguments;
  if(args!=null && (typeof args!=='object' || Array.isArray(args))) return toolError('arguments must be an object.');
  const left = REQUEST_MS - (Date.now()-ctx.t0);
  if(left < 3000) return toolError('This batch ran out of time. Send the call on its own.');
  const ms = Math.min(TOOL_MS, left-1000);
  if(name!=='find_street'){
    // the outline:false wording is 1.0.0's, unchanged (outline:false answers stay byte-identical)
    if(ctx.imageSent) return toolError(`Send one aerial_crops call per request (each answer carries ${args && args.outline===true ? 'about 1.3 MB of images with outline:true' : 'up to 0.5 MB of images'}).`);
    ctx.imageSent = true;
  }
  const ctl = toolControl(ms);
  try{
    if(name==='find_street') return await withDeadline(findStreet(args||{}, ctl), ms, 'find_street');
    return await withDeadline(aerialCrops(args||{}, ctl), ms, 'aerial_crops');
  }catch(e){ return toolError(`${name} failed: ${msg(e)}`); }
  finally{ ctl.ac.abort(); }
}
// One JSON-RPC message → its response, or null for a notification (or a response the client sent us).
async function answer(m, ctx){
  if(!m || typeof m!=='object' || Array.isArray(m) || m.jsonrpc!=='2.0') return rpcError(m && m.id, -32600, 'Invalid Request: expected a JSON-RPC 2.0 message');
  if(m.method===undefined && ('result' in m || 'error' in m)) return null;
  if(typeof m.method!=='string') return rpcError(m.id, -32600, 'Invalid Request: no method');
  if(!('id' in m)) return null;   // notifications/initialized, notifications/cancelled, …: nothing to answer
  const id = m.id, p = m.params || {};
  switch(m.method){
    case 'initialize':
      return rpcResult(id, {protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities:{tools:{listChanged:false}}, serverInfo:SERVER_INFO, instructions:INSTRUCTIONS});
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, {tools:TOOLS});
    case 'tools/call':
      if(!p || typeof p.name!=='string') return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
      if(!TOOLS.some(t=>t.name===p.name)) return rpcError(id, -32602, `Unknown tool: ${String(p.name).slice(0,60)}`);
      return rpcResult(id, await callTool(p, ctx));
    default: return rpcError(id, -32601, `Method not found: ${m.method.slice(0,60)}`);
  }
}
// Vercel parses a JSON body into req.body (and throws on bad JSON when it's read); a string, a Buffer or an unread
// stream all work too.
async function readMessage(req){
  let b;
  try{ b = req.body; }catch(_){ return {bad:true}; }
  if(b && typeof b==='object' && !Buffer.isBuffer(b) && !(b instanceof Uint8Array)) return {m:b};
  let text = '';
  if(typeof b==='string') text = b;
  else if(b && (Buffer.isBuffer(b) || b instanceof Uint8Array)) text = Buffer.from(b).toString('utf8');
  else if(req && typeof req[Symbol.asyncIterator]==='function' && !req.readableEnded){
    const parts = []; let n = 0;
    for await (const c of req){ n += c.length; if(n > MAX_BODY) return {bad:true}; parts.push(Buffer.from(c)); }
    text = Buffer.concat(parts).toString('utf8');
  }
  try{ return {m:JSON.parse(text)}; }catch(_){ return {bad:true}; }
}
function send(res, code, body){
  res.setHeader('Content-Type', 'application/json');
  res.status(code).end(JSON.stringify(body));
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');   // public, read-only data, like the other /api/* endpoints
  const method = String(req.method||'GET').toUpperCase();
  if(method==='OPTIONS'){
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end(); return;
  }
  if(method!=='POST'){
    res.setHeader('Allow', 'POST');
    send(res, 405, {error:'TTV Street Data is an MCP server (Streamable HTTP, JSON responses): POST JSON-RPC to this URL. There is no SSE stream.'});
    return;
  }
  const ctx = {t0:Date.now(), imageSent:false};
  const {m, bad} = await readMessage(req);
  if(bad){ send(res, 200, rpcError(null, -32700, 'Parse error: the body is not JSON')); return; }
  if(Array.isArray(m)){
    if(!m.length){ send(res, 200, rpcError(null, -32600, 'Invalid Request: empty batch')); return; }
    const out = [];
    for(const one of m.slice(0, 20)){ const r = await answer(one, ctx); if(r) out.push(r); }   // in order, one budget
    if(m.length > 20) out.push(rpcError(null, -32600, 'Invalid Request: at most 20 messages per batch'));
    if(!out.length){ res.status(202).end(); return; }
    send(res, 200, out); return;
  }
  const r = await answer(m, ctx);
  if(!r){ res.status(202).end(); return; }
  send(res, 200, r);
}
