// api/gis.js — TTV GIS auto-fill proxy (Charlotte / Mecklenburg)  v6
// v6 (2026-09-29, audit G1): the geocode matches the exact house number and the whole street (direction, name, type,
// suffix) and uses the ZIP / city to choose; a lookup that can't be matched loads nothing. See chooseAddressPoint().
// v3: right-of-way edge detection — classifies each parcel edge as facing a
// neighboring parcel (interior lot line) or no parcel (street/alley ROW), and
// picks the front edge (ROW edge nearest the address point). Edge indices are
// aligned to the de-duplicated outer ring (closing point removed), matching the
// client lot editor's edge order.
// Server-side fetch avoids the browser CORS block. Deploy on Vercel at /api/gis.js,
// push to main, then hit  /api/gis?address=2723%20Dellinger%20Dr&debug=1
//
// Verified against 2723 Dellinger Dr: zoning N1-B, PCSO district Central Catawba.
// NOTE (2026-09-21): the site was sub-lotted — 2723 now resolves to PID 04118535 (7,145 sf),
// 2727 = 04118536 (3,455 sf), 2731 = 04118537 (4,312 sf). The old "PID 04118526 / 77,575 sf"
// note referred to a neighbouring parcel and is retired. v2 fixes the matched-address field, returns the
// parcel polygon, swaps the bogus "buffer" (layer 32 was a staff review area) for
// the real SWIM/Water-Quality-Buffer layer, and maps the PCO district to its BUA rule.
const BASE = 'https://gis.charlottenc.gov/arcgis/rest/services/Accela/Accela/MapServer';
const SR = 2264;
const LAYER = { parcels:0, address:1, zoning:10, historic:12, pcoDistrict:13, overlayWatershed:14, reviewArea:32 };
// v4: street centerlines live in the SAME Accela service — 2 City Maintained, 3 State Maintained.
const STREET_LAYERS=[2,3];
const FRONT_MAX_ROW_FT=120;   // ROW edge must be within this of the named centerline
const FRONT_MAX_ANY_FT=60;    // non-ROW rescue threshold (mis-flagged slivers)
// Real SWIM / Water Quality Buffer geometry (City Open Data hosted feature layer),
// resolved at runtime from its ArcGIS Online item so we don't hardcode the org URL.
const WQ_BUFFER_ITEM = 'cf66446f36244e2498aa9b3f8e704b84';
// v5: Mecklenburg County's own public ArcGIS servers (no key, no signup). These carry the CAMA
// (assessor) record, building footprints, tree canopy and a 3-ft LiDAR elevation surface — none of
// which exist on the city's Accela service. Verified 2026-09-21 against PIDs 04118535/36/37.
const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
const AERIAL = 'https://meckaerial.mecklenburgcountync.gov/server/rest/services';
const GEOMSVC = MECK + '/Utilities/Geometry/GeometryServer';
// Slope bands drive the lot-factor grading assumption (SOP: flat ~$15k, trees/moderate $25-30k,
// heavy+severe $40k+). Canopy bands drive the clearing dropdown.
const SLOPE_BANDS = [{max:5,label:'flat'},{max:12,label:'moderate'},{max:Infinity,label:'severe'}];
const CANOPY_BANDS = [{max:10,label:'cleared'},{max:30,label:'light'},{max:55,label:'medium'},{max:75,label:'heavy'},{max:Infinity,label:'extreme'}];
function band(v,bands){ for(const b of bands){ if(v<=b.max) return b.label; } return bands[bands.length-1].label; }

// Post-Construction Stormwater Ordinance district -> built-upon-area rule of thumb.
const BUA_RULE = {
  'Central Catawba': 'Over 5,000 sf BUA triggers the stormwater ordinance; keep under 24% of lot area (verify).',
};

// fetchSignal: optional, as in api/street.js ajPost(): api/mcp.js gives each request a timeout and its tool deadline
// through geocodeAddress() / parcelAtPoint(). This file's own handler passes none, so its requests are as before.
async function aj(url, fetchSignal){
  const r = fetchSignal ? await fetch(url, {signal:fetchSignal()}) : await fetch(url);
  if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||'')+((j.error.details&&j.error.details.length)?(' — '+j.error.details.join('; ')):''));
  return j;
}
// ArcGIS geometry operations need POST — the payloads (polygon rings) blow past URL limits.
async function ajPost(url, params){
  const body = new URLSearchParams(params).toString();
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body});
  if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||''));
  return j;
}
// Query any layer with the parcel polygon as the spatial filter.
async function byPolygon(layerUrl, ring, outFields='*', returnGeometry=false){
  const geom = JSON.stringify({rings:[ring], spatialReference:{wkid:SR}});
  const params = {geometry:geom, geometryType:'esriGeometryPolygon', inSR:String(SR),
    spatialRel:'esriSpatialRelIntersects', outFields, returnGeometry:String(!!returnGeometry), f:'json'};
  if(returnGeometry) params.outSR = String(SR);
  return ajPost(layerUrl+'/query', params);
}
const _fields = {};
async function fields(id){ if(_fields[id]) return _fields[id]; const m = await aj(`${BASE}/${id}?f=json`); _fields[id] = (m.fields||[]); return _fields[id]; }
function shoelaceSqft(g){ if(!g||!g.rings||!g.rings.length) return null; let t=0; g.rings.forEach((r,ri)=>{ let a=0; for(let i=0;i<r.length-1;i++){ a+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]; } a=Math.abs(a/2); t+=(ri===0?a:-a); }); return t; }
function centroid(g){ const r=g&&g.rings&&g.rings[0]; if(!r) return null; let x=0,y=0; r.forEach(p=>{x+=p[0];y+=p[1];}); return {x:x/r.length,y:y/r.length}; }
function pointInRing(px,py,ring){ // ray cast; ring = [[x,y],...] (closing dup ok)
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    if(((yi>py)!==(yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function stripClose(ring){ if(ring.length>2){const a=ring[0],b=ring[ring.length-1]; if(a[0]===b[0]&&a[1]===b[1]) return ring.slice(0,-1);} return ring.slice(); }
// Classify each edge of `ring0` (closed dup removed) by offsetting its midpoint
// outward ~OFFSET ft and testing containment in any neighbor ring.
function classifyEdges(ring0, neighborRings, addrPt){
  const OFFSET=10, ring=stripClose(ring0), n=ring.length;
  const edges=[];
  for(let i=0;i<n;i++){
    const a=ring[i], b=ring[(i+1)%n];
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2;
    const dx=b[0]-a[0], dy=b[1]-a[1], len=Math.hypot(dx,dy)||1;
    const nx=dy/len, ny=-dx/len; // unit normal
    // outward = the offset point that lands OUTSIDE the subject ring
    let ox=mx+nx*OFFSET, oy=my+ny*OFFSET;
    if(pointInRing(ox,oy,ring)){ ox=mx-nx*OFFSET; oy=my-ny*OFFSET; }
    const inNeighbor = neighborRings.some(r=>pointInRing(ox,oy,r));
    const distAddr = addrPt? Math.hypot(mx-addrPt.x,my-addrPt.y) : null;
    edges.push({ i, len_ft:Math.round(len), row:!inNeighbor, mid:[Math.round(mx),Math.round(my)], dist_addr_ft:distAddr!=null?Math.round(distAddr):null });
  }
  const rowEdges=edges.filter(e=>e.row && e.len_ft>=8);
  let front=null;
  if(rowEdges.length){
    front=(addrPt? rowEdges.slice().sort((a,b)=>a.dist_addr_ft-b.dist_addr_ft)
                 : rowEdges.slice().sort((a,b)=>b.len_ft-a.len_ft))[0].i;
  }
  return { edges, row:edges.map(e=>e.row), front_index:front, row_count:rowEdges.length };
}
function distPtToSeg(px,py,ax,ay,bx,by){
  const dx=bx-ax,dy=by-ay,L2=dx*dx+dy*dy;
  if(L2===0)return Math.hypot(px-ax,py-ay);
  let t=((px-ax)*dx+(py-ay)*dy)/L2; t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
}
function distPtToPaths(px,py,paths){
  let best=Infinity;
  (paths||[]).forEach(path=>{for(let i=0;i<path.length-1;i++){const d=distPtToSeg(px,py,path[i][0],path[i][1],path[i+1][0],path[i+1][1]);if(d<best)best=d;}});
  return best;
}
// Pure: refine classifyEdges() output with named-street centerlines.
// centerPaths = array of polyline paths for the ADDRESSED street near the parcel.
function applyCenterlineFront(info, centerPaths, streetLabel){
  if(!info||!centerPaths||!centerPaths.length)return info;
  const dists=info.edges.map(e=>({i:e.i,row:e.row,len:e.len_ft,d:distPtToPaths(e.mid[0],e.mid[1],centerPaths)}));
  const rowNear=dists.filter(e=>e.row&&e.len>=8&&e.d<=FRONT_MAX_ROW_FT).sort((a,b)=>a.d-b.d);
  const anyNear=dists.filter(e=>e.len>=8&&e.d<=FRONT_MAX_ANY_FT).sort((a,b)=>a.d-b.d);
  let pick=null, rescued=false;
  if(rowNear.length)pick=rowNear[0];
  else if(anyNear.length){pick=anyNear[0];rescued=true;}
  if(!pick)return info; // centerline too far — keep address-point result
  info.front_index=pick.i;
  info.method='centerline';
  info.street={name:streetLabel,dist_ft:Math.round(pick.d),rescued};
  return info;
}
function bboxWxD(g){ const r=g&&g.rings&&g.rings[0]; if(!r) return null; const xs=r.map(p=>p[0]),ys=r.map(p=>p[1]); return { w:Math.round(Math.max(...xs)-Math.min(...xs)), d:Math.round(Math.max(...ys)-Math.min(...ys)) }; }

// ── v6 geocode (audit G1, 2026-09-29) ─────────────────────────────────────────────────────────────
// The address layer carries the parts separately: txt_street_number (integer), cde_street_dir_prfx, nme_street,
// repl_txt_roadway_abbrev (USPS type; full_address and address print the county's 2-letter cde_roadway_type instead),
// cde_street_dir_suff, txt_addr_unit, cde_zip1, nme_city / nme_po_city. v5 matched the house number and the first word
// after it as substrings and took the first hit, so "1500 N Davidson St" searched for '%1500%' and '%N%' and loaded
// another parcel (15004 Annan Ct in the 2026-09-28 audit, 1500 Eastcrest Dr the next day). Now the number is exact, candidates come from their street names, and each is compared with the
// typed street part by part, after both sides go through the same spelling map.
const DIR_WORDS={NORTH:'N',SOUTH:'S',EAST:'E',WEST:'W',NORTHEAST:'NE',NORTHWEST:'NW',SOUTHEAST:'SE',SOUTHWEST:'SW'};
const DIR_ABBR=new Set(['N','S','E','W','NE','NW','SE','SW']);
// every spelling of a street type -> the USPS abbreviation in repl_txt_roadway_abbrev (the layer's 24 types, plus
// the county's own 2-letter codes; TR and FR aren't mapped, because a typed "Tr" can mean Trail or Terrace; the
// county's own TR / FR still match, through its cde_roadway_type, in compareStreet())
const TYPE_WORDS={ALLEY:'ALY',ALY:'ALY',AL:'ALY',AVENUE:'AVE',AVE:'AVE',AV:'AVE',BOULEVARD:'BLVD',BLVD:'BLVD',BV:'BLVD',
  BYWAY:'BYWY',BYWY:'BYWY',BY:'BYWY',CIRCLE:'CIR',CIR:'CIR',CR:'CIR',CRESCENT:'CRES',CRES:'CRES',CS:'CRES',COURT:'CT',CT:'CT',
  COVE:'CV',CV:'CV',DRIVE:'DR',DR:'DR',FREEWAY:'FWY',FWY:'FWY',HIGHWAY:'HWY',HWY:'HWY',HY:'HWY',LANE:'LN',LN:'LN',LOOP:'LOOP',
  LP:'LOOP',PLACE:'PL',PL:'PL',PARKWAY:'PKWY',PKWY:'PKWY',PKY:'PKWY',PY:'PKWY',ROAD:'RD',RD:'RD',RUN:'RUN',RN:'RUN',ROW:'ROW',
  RW:'ROW',STREET:'ST',ST:'ST',TRACE:'TRCE',TRCE:'TRCE',TC:'TRCE',TRAIL:'TRL',TRL:'TRL',TL:'TRL',TERRACE:'TER',TER:'TER',
  WAY:'WAY',WY:'WAY',CROSSING:'XING',XING:'XING',XG:'XING'};
const TYPE_ABBR=new Set(Object.values(TYPE_WORDS));
const NAME_ALIAS={MOUNT:'MT',SAINT:'ST',FORT:'FT',EXTENSION:'EXT'};
const UNIT_WORDS=new Set(['APT','APARTMENT','UNIT','STE','SUITE','#','BLDG','LOT','RM','FL']);
// fields the geocode reads (outFields=* also returns ~40 others, which matters at 450 points per tower)
const ADDR_FIELDS='OBJECTID,txt_street_number,cde_street_dir_prfx,nme_street,repl_txt_roadway_abbrev,cde_roadway_type,'
  +'cde_street_dir_suff,txt_addr_unit,nme_city,nme_po_city,cde_zip1,cde_status,address,full_address,TAX_PID,GIS_PID';
// one token's canonical spelling; applied to typed and county tokens alike, wherever they sit, so "West Blvd" (the
// county's name WEST, type BLVD) and "W Boulevard" both come out as W BLVD, and "E 37th St" as E 37 ST
function canonTok(t){ const o=String(t).replace(/^(\d+)(ST|ND|RD|TH)$/,'$1'); return DIR_WORDS[o]||NAME_ALIAS[o]||TYPE_WORDS[o]||o; }
// words compare without apostrophes, and a hyphen splits words: the county files "FISHER'S FARM" and
// "MT HOLLY-HUNTERSVILLE", but "BEATTIES FORD"
function splitToks(a){ return a.flatMap(t=>String(t).replace(/^([A-Z])'(?=[A-Z])/,'$1-').replace(/'/g,'').split('-')).filter(Boolean); }
function canonToks(a){ return splitToks(a).map(canonTok); }
const eqToks=(a,b)=>a.length===b.length&&a.every((t,i)=>t===b[i]);
// the same words, spacing aside: "JW Clay" is J W CLAY, "O'Henry" is O HENRY, "W WT Harris" is W W T HARRIS
const sameStreet=(a,b)=>a.join('')===b.join('');
const cleanTok=t=>String(t||'').toUpperCase().replace(/[^A-Z0-9&'\-]/g,'');
// "1500 N Davidson St, Charlotte, NC, 28206" (the client's fullAddr()) -> {num, unit, toks, city, zip}. Also takes the
// whole address typed into the street field ("... Dr Charlotte NC 28269"), a city segment with the state and ZIP in it,
// a unit after the street ("Apt 2", "#2", "2723B") or in its own segment. Periods become spaces, as the county files
// initials spaced: "W.T. Harris" is W T HARRIS.
function parseTypedAddress(address){
  const segs=String(address||'').toUpperCase().replace(/’/g,"'").replace(/\b([NS])\.\s?C\.?(?=[\s,]|$)/g,'$1C').replace(/\./g,' ').replace(/#/g,' # ')
    .split(',').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  let zip='', city='', unit='';
  const street=segs.shift()||'';
  for(const s of segs){
    const z=s.match(/(?:^|\s)(\d{5})(?:-\d{4})?$/);
    if(z&&!zip) zip=z[1];
    const rest=s.replace(/(?:^|\s)\d{5}(?:-\d{4})?$/,'').replace(/(?:^|\s)(NC|SC|NORTH CAROLINA|SOUTH CAROLINA)$/,'').trim();
    if(!rest) continue;
    const w=rest.split(' ');
    if(UNIT_WORDS.has(w[0])){ if(!unit) unit=w.slice(1).map(cleanTok).filter(Boolean).join(' '); continue; }
    if(!city) city=rest.replace(/[^A-Z0-9 '\-]/g,'').replace(/\s+/g,' ').trim();   // it's echoed in messages
  }
  let toks=street.split(' ').filter(Boolean);
  // a ZIP and state typed at the end of the street field
  if(toks.length>2&&/^\d{5}(-\d{4})?$/.test(toks[toks.length-1])){ if(!zip) zip=toks[toks.length-1].slice(0,5); toks.pop(); }
  if(toks.length>2&&/^(NC|SC)$/.test(toks[toks.length-1])) toks.pop();
  const ui=toks.findIndex((t,i)=>i>0&&UNIT_WORDS.has(t));
  if(ui>0){ if(!unit) unit=toks.slice(ui+1).map(cleanTok).filter(Boolean).join(' '); toks=toks.slice(0,ui); }
  const m=(toks[0]||'').match(/^(\d+)(?:-?([A-Z]{1,2}|\d+))?$/);
  const num=m?parseInt(m[1],10):null;
  if(m&&m[2]&&/^[A-Z]/.test(m[2])&&!unit) unit=m[2];   // "2723B"; a range "1500-1502" keeps its first number
  return { num, unit, toks:(m?toks.slice(1):toks).map(cleanTok).filter(Boolean), city, zip };
}
// names the county might file the typed street under: every run of up to 6 typed words, each word as typed or in
// its other common spelling (W/WEST, MT/MOUNT, 37/37TH), capped so the IN list stays short
function streetNameVariants(toks){
  const alt=t=>{ const o=new Set([t]);
    for(const [k,v] of Object.entries(DIR_WORDS)){ if(t===k)o.add(v); if(t===v)o.add(k); }
    for(const [k,v] of Object.entries(NAME_ALIAS)){ if(t===k)o.add(v); if(t===v)o.add(k); }
    const d=t.match(/^(\d+)(ST|ND|RD|TH)?$/);
    if(d){ const n=+d[1], sfx=(n%100>=11&&n%100<=13)?'TH':({1:'ST',2:'ND',3:'RD'}[n%10]||'TH'); o.add(d[1]); o.add(d[1]+sfx); }
    if(/['\-]/.test(t)){ o.add(t.replace(/'/g,'').replace(/-/g,' ')); o.add(t.replace(/['\-]/g,' ').trim()); }
    return [...o]; };
  const out=new Set();
  for(let i=0;i<toks.length&&i<8;i++) for(let j=i;j<toks.length&&j<i+6;j++){
    let combos=[''];
    for(const t of toks.slice(i,j+1)) combos=combos.flatMap(c=>alt(t).map(a=>c?c+' '+a:a)).slice(0,16);
    combos.forEach(c=>{ if(c.length<=30) out.add(c); });
  }
  return [...out].slice(0,80);
}
// the typed street's longest distinctive word, for a LIKE that finds the county's punctuated names (FISHER'S FARM,
// PINEVILLE-MATTHEWS) the IN list can't spell; a trailing S is dropped so "Fishers" finds FISHER'S. null: none.
function likeAnchor(toks){
  const w=splitToks(toks).filter(t=>/^[A-Z0-9]{3,}$/.test(t)&&!/^\d+$/.test(t)&&!DIR_ABBR.has(canonTok(t))&&!TYPE_ABBR.has(canonTok(t)))
    .sort((a,b)=>b.length-a.length)[0];
  return w ? (w.length>=5&&/S$/.test(w)?w.slice(0,-1):w) : null;
}
function pointParts(a){
  const s=v=>String(v==null?'':v).replace(/\s+/g,' ').trim().toUpperCase();
  const P={ num:a.txt_street_number, dir:s(a.cde_street_dir_prfx), name:s(a.nme_street),
    type:s(a.repl_txt_roadway_abbrev||a.cde_roadway_type), cde:s(a.cde_roadway_type), sdir:s(a.cde_street_dir_suff), unit:s(a.txt_addr_unit),
    city:s(a.nme_city), po_city:s(a.nme_po_city), zip:s(a.cde_zip1), status:s(a.cde_status), gpid:s(a.GIS_PID||a.TAX_PID),
    full:s(a.full_address) };
  P.street=streetLine(P);   // USPS types ("111 XAVIER WAY"); the county's address / full_address print "WY"
  return P;
}
const streetLine=P=>[P.num,P.dir,P.name,P.type,P.sdir].filter(Boolean).join(' ');
// how the typed street words compare with one county address point: 'exact' (same words), 'partial' (the analyst
// left out the direction, type or suffix the county has), 'name' (same street name, a typed part conflicts: shown as
// a suggestion, never used) or null. Words at the end that spell the point's city ("... Dr Charlotte") are locality.
// The type matches in the USPS form or the county's own code (its full_address prints Terrace as "TR").
function compareStreet(typedToks, P){
  const nameW=P.name.split(' ').filter(Boolean), nameT=canonToks(nameW);
  const types=[...new Set([P.type,P.cde].filter(Boolean))];
  const build=(dir,type,sdir)=>canonToks([dir,...nameW,type,sdir].filter(Boolean));
  const fulls=(types.length?types:['']).map(t=>build(P.dir,t,P.sdir));
  const parts=[['dir',P.dir,'direction'],['type',P.type,'street type'],['sdir',P.sdir,'suffix']].filter(p=>p[1]);
  let T=canonToks(typedToks), cityFromStreet='';
  for(const c of [P.city,P.po_city]){ const ct=c?canonToks(c.split(' ')):[];
    if(ct.length&&T.length>ct.length&&eqToks(T.slice(-ct.length),ct)&&!fulls.some(f=>sameStreet(T,f))){ T=T.slice(0,-ct.length); cityFromStreet=c; break; } }
  if(fulls.some(f=>sameStreet(T,f))) return {level:'exact',missing:[],cityFromStreet};
  for(let mask=1;mask<(1<<parts.length);mask++){
    const drop=new Set(parts.filter((_,i)=>mask&(1<<i)).map(p=>p[0]));
    for(const t of (types.length?types:[''])){
      const v=build(drop.has('dir')?'':P.dir,drop.has('type')?'':t,drop.has('sdir')?'':P.sdir);
      if(sameStreet(T,v)) return {level:'partial',missing:parts.filter(p=>drop.has(p[0])).map(p=>p[2]+' '+p[1]),cityFromStreet};
    }
  }
  for(let i=0;i+nameT.length<=T.length;i++) if(eqToks(T.slice(i,i+nameT.length),nameT)) return {level:'name',missing:[],cityFromStreet};
  return null;
}
// Pick the county address point for what was typed. Accepted: 'exact', or 'close' (the right number and street, but a
// part was left out, the ZIP / city differs, another street at the number also fits, or it's one unit of several).
// Refused, with no parcel loaded: 'none', 'ambiguous' (two streets, places or unit parcels fit), 'locality' (the street
// exists, but not in the typed city or ZIP). The typed ZIP / city choose FIRST, then the spelling: "2100 Sharon Rd,
// 28210" is 2100 SHARON RD W in 28210, not the exact-spelled 2100 SHARON RD in 28207.
function chooseAddressPoint(typed, feats, near){
  const typedLine=[typed.num,...typed.toks].filter(v=>v!=null&&v!=='').join(' ')+(typed.unit?' #'+typed.unit:'');
  const loc=[typed.city,typed.zip].filter(Boolean).join(' ');
  const out={status:'none',typed:typedLine+(loc?', '+loc:''),matched:null,diffs:[],candidates:[],message:'',feature:null,point:null};
  if(typed.num==null||!typed.toks.length){ out.message='Type the house number and street (e.g. 2723 Dellinger Dr): the county lookup needs an exact street address.'; return out; }
  const scored=feats.map(f=>{ const P=pointParts(f.attributes||{}); return {f,P,c:P.num===typed.num?compareStreet(typed.toks,P):null}; }).filter(x=>x.c);
  const label=x=>streetLine(x.P)+' ('+[x.P.po_city||x.P.city,x.P.zip].filter(Boolean).join(' ')+')';
  const uniq=a=>[...new Set(a)];
  const cands=scored.filter(x=>x.c.level==='exact'||x.c.level==='partial');
  if(!cands.length){
    const same=uniq(scored.map(label)).slice(0,4);
    const nearBy=uniq((near||[]).map(P=>P.num+' '+[P.dir,P.name,P.type,P.sdir].filter(Boolean).join(' ')+(P.zip?' ('+P.zip+')':''))).slice(0,4);
    out.candidates=same.concat(nearBy);
    out.message=`No county address point for “${typedLine}”.`
      +(same.length?` At that number the county has ${same.join(', ')}.`:'')
      +(nearBy.length?` Nearest numbers on that street: ${nearBy.join(', ')}.`:'')
      +' Check the number and street, then run the auto-fill again.';
    return out;
  }
  // locality first: the typed ZIP and city, both if they agree, else whichever does (a ZIP typo, a postal-city name)
  const city=typed.city||cands.map(x=>x.c.cityFromStreet).find(Boolean)||'';
  const zipOK=x=>!typed.zip||x.P.zip===typed.zip, cityOK=x=>!city||x.P.city===city||x.P.po_city===city;
  const strict=cands.filter(x=>zipOK(x)&&cityOK(x));
  const S=strict.length?strict:cands.filter(x=>(typed.zip&&zipOK(x))||(city&&cityOK(x)));
  if(!S.length){
    out.status='locality'; out.candidates=uniq(cands.map(label)).slice(0,5);
    const here=uniq(scored.filter(x=>x.c.level==='name'&&((typed.zip&&zipOK(x))||(city&&cityOK(x)))).map(label)).slice(0,3);
    out.message=`The county has ${out.candidates.join(', ')}, not in ${[city,typed.zip].filter(Boolean).join(' ')}.`
      +(here.length?` There it has ${here.join(', ')}.`:'')+' Auto-fill covers Mecklenburg only: check the street, city and ZIP.';
    return out;
  }
  // then the spelling: the exact street if it's there, else the street with a part left out
  const exact=S.filter(x=>x.c.level==='exact'), pool=exact.length?exact:S;
  const groups=uniq(pool.map(label));
  if(groups.length>1){
    out.status='ambiguous'; out.candidates=groups.slice(0,5);
    out.message=`“${typedLine}” fits ${groups.length} county addresses: ${groups.slice(0,5).join(', ')}. Add the direction, street type or ZIP, then run the auto-fill again.`;
    return out;
  }
  // one street and place. When its units sit on separate GIS parcels (a split duplex, townhomes), they're separate
  // properties: unless the typed unit is one of them, say which, rather than loading one unit's lot as the site. A
  // building point on a common parcel of its own (a condo's ...C99) isn't split; condo units share one parcel.
  const units=pool.filter(x=>x.P.unit), bldg=pool.filter(x=>!x.P.unit);
  const unitParcels=uniq(units.map(x=>x.P.gpid).filter(Boolean)), us=uniq(units.map(x=>x.P.unit));
  const split=unitParcels.length>1&&bldg.every(b=>!b.P.gpid||unitParcels.includes(b.P.gpid));
  if(split&&!(typed.unit&&units.some(x=>x.P.unit===typed.unit))){
    out.status='ambiguous'; out.candidates=us.slice(0,8).map(u=>groups[0].replace(' (',' #'+u+' ('));
    out.message=(typed.unit?`There’s no unit ${typed.unit} at ${groups[0]}. `:'')
      +`The county files ${groups[0]} by unit, and the units are separate parcels (${us.slice(0,8).join(', ')}${us.length>8?'…':''}). Type the unit (e.g. “${streetLine(pool[0].P)} Unit ${us[0]}”) to load that parcel, or draw the whole site.`;
    return out;
  }
  // the typed unit's point, else the building's own (no unit), else any; an active point first
  const rank=x=>(typed.unit&&x.P.unit===typed.unit?0:!x.P.unit?1:2)*2+(x.P.status==='A'?0:1);
  const best=pool.slice().sort((a,b)=>rank(a)-rank(b))[0], P=best.P;
  best.c.missing.forEach(m=>out.diffs.push(`the county address has the ${m}`));
  if(exact.length){ const also=uniq(S.filter(x=>x.c.level==='partial').map(label)).filter(l=>l!==groups[0]);
    if(also.length) out.diffs.push(`the county also has ${also.slice(0,3).join(', ')} at this number`); }
  if(typed.zip&&P.zip&&P.zip!==typed.zip) out.diffs.push(`the ZIP there is ${P.zip}, not ${typed.zip}`);
  if(city&&P.city!==city&&P.po_city!==city) out.diffs.push(`the city there is ${P.po_city||P.city}, not ${city}`);
  if(typed.unit&&P.unit!==typed.unit) out.diffs.push(`there is no unit ${typed.unit} on file, so this is ${P.unit?'unit '+P.unit:'the building’s own point'}`);
  else if(!typed.unit&&P.unit) out.diffs.push(`the county files this address by unit; this is unit ${P.unit}`);
  if(P.status&&P.status!=='A') out.diffs.push(`the county marks this address point inactive (status ${P.status})`);
  out.status=out.diffs.length?'close':'exact'; out.matched=P.full||streetLine(P); out.feature=best.f; out.point=P;
  out.message=out.diffs.length?`County GIS matched ${out.matched}: ${out.diffs.join('; ')}.`:'';
  return out;
}
// every address point for a where clause, a page at a time (a tower can have 450 at one number)
async function addressPoints(where, geometry, fetchSignal){
  const feats=[];
  for(let page=0;page<3;page++){
    const j=await aj(`${BASE}/${LAYER.address}/query?where=${encodeURIComponent(where)}&outFields=${ADDR_FIELDS}&returnGeometry=${geometry}`
      +(geometry?`&outSR=${SR}`:'')+`&orderByFields=OBJECTID&resultOffset=${page*2000}&resultRecordCount=2000&f=json`, fetchSignal);
    feats.push(...(j.features||[]));
    if(!j.exceededTransferLimit) break;
  }
  return feats;
}
// the numbers nearest the typed one on the typed street, one row per address (units collapsed), both directions
async function nearestNumbers(nameWhere, typed, fetchSignal){
  const q=(cmp,dir)=>aj(`${BASE}/${LAYER.address}/query?where=${encodeURIComponent(`${nameWhere} AND txt_street_number ${cmp} ${typed.num}`)}`
    +'&outFields=txt_street_number,cde_street_dir_prfx,nme_street,repl_txt_roadway_abbrev,cde_roadway_type,cde_street_dir_suff,nme_city,nme_po_city,cde_zip1'
    +`&returnDistinctValues=true&orderByFields=${encodeURIComponent('txt_street_number '+dir)}&returnGeometry=false&resultRecordCount=60&f=json`, fetchSignal);
  const rs=await Promise.allSettled([q('<','DESC'),q('>','ASC')]);
  return rs.flatMap(r=>r.status==='fulfilled'?(r.value.features||[]):[]).map(f=>pointParts(f.attributes||{}))
    .filter(P=>{ const c=compareStreet(typed.toks,P); return c&&c.level!=='name'; })
    .sort((a,b)=>Math.abs(a.num-typed.num)-Math.abs(b.num-typed.num));
}
// The geocode of step 1 below, shared with api/mcp.js (the TTV Street Data connector's find_street), so an address
// there finds exactly the parcel /api/gis?address= loads: chooseAddressPoint()'s answer for the typed address (a
// refused match has no .feature). Throws when the address layer doesn't answer. raw.address gets the debug detail;
// fetchSignal is aj()'s (api/mcp.js only).
export async function geocodeAddress(address, raw, debug, fetchSignal){
  const typed = parseTypedAddress(address);
  const names = typed.num!=null ? streetNameVariants(typed.toks) : [];
  const inList = names.map(n=>"'"+n.replace(/'/g,"''")+"'").join(',');
  const anchor = likeAnchor(typed.toks);
  const nameWhere = inList ? `(nme_street IN (${inList})${anchor?` OR nme_street LIKE '%${anchor}%'`:''})` : '';
  let feats=[], near=[];
  if(nameWhere){
    feats = await addressPoints(`txt_street_number = ${typed.num} AND ${nameWhere}`, true, fetchSignal);
    if(raw) raw.address = debug?{where:nameWhere,count:feats.length}:undefined;
    // nothing on that street at that number: the nearest numbers on it, for the message
    if(!feats.some(f=>{ const c=compareStreet(typed.toks,pointParts(f.attributes||{})); return c&&c.level!=='name'; })){
      // the IN list, plus any county name the number query found that compareStreet recognises (FISHER'S FARM),
      // not the LIKE, which on a common word ("Oak") would fill the ordered rows with other streets
      const seen=[...new Set(feats.map(f=>pointParts(f.attributes||{})).filter(P=>compareStreet(typed.toks,P)).map(P=>P.name))];
      const nearWhere=`nme_street IN (${[inList].concat(seen.map(n=>"'"+n.replace(/'/g,"''")+"'")).join(',')})`;
      try{ near = await nearestNumbers(nearWhere, typed, fetchSignal); }catch(_){ /* suggestions only */ }
    }
  }
  return chooseAddressPoint(typed, feats, near);
}
// The parcel under a geocoded address point (state plane feet), with its geometry: step 2 below, and find_street's PID.
export function parcelAtPoint(pt, fetchSignal){
  const geom = encodeURIComponent(JSON.stringify({x:pt.x,y:pt.y,spatialReference:{wkid:SR}}));
  return aj(`${BASE}/${LAYER.parcels}/query?geometry=${geom}&geometryType=esriGeometryPoint&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=${SR}&f=json`, fetchSignal);
}
export function findAttr(a, rx){ if(!a) return null; for(const [k,v] of Object.entries(a)){ if(rx.test(k)&&v!=null&&v!=='') return {field:k,value:v}; } return null; }
async function spatialAt(layerUrl, pt, outFields='*'){
  const geom = encodeURIComponent(JSON.stringify({ x:pt.x, y:pt.y, spatialReference:{wkid:SR} }));
  const url = `${layerUrl}/query?geometry=${geom}&geometryType=esriGeometryPoint&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=${outFields}&returnGeometry=false&f=json`;
  const j = await aj(url);
  return { hit: !!(j.features&&j.features.length), feats:(j.features||[]), attrs:(j.features&&j.features[0]&&j.features[0].attributes)||null, url };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=86400, stale-while-revalidate');
  const address = (req.query.address||'').trim();
  const debug = req.query.debug==='1';
  if(!address){ res.status(400).json({error:'pass ?address='}); return; }

  const out = { address, ok:false, parcel:null, zoning:null, watershed:null, swim_buffer:null, review_area:null, historic:null, notes:[], errors:[] };
  const raw = {};
  try{
    // 1) geocode via Master Address Points (v6, audit G1): exact number, candidates by street name, then
    // chooseAddressPoint() compares each part and the ZIP / city. A refused match loads nothing.
    let pt=null, matched=null;
    try{
      const m = await geocodeAddress(address, raw, debug);
      out.match = { status:m.status, typed:m.typed, matched:m.matched, diffs:m.diffs, candidates:m.candidates, message:m.message,
        point: m.point ? { street:m.point.street, num:m.point.num, dir:m.point.dir||null, name:m.point.name, type:m.point.type||null, sdir:m.point.sdir||null,
          unit:m.point.unit||null, city:m.point.city||null, po_city:m.point.po_city||null, zip:m.point.zip||null } : null };
      if(m.feature){ const f=m.feature; pt=f.geometry; matched = m.matched;
        out._street={name:(f.attributes.nme_street||'').trim(),type:(f.attributes.repl_txt_roadway_abbrev||f.attributes.cde_roadway_type||'').trim()}; }
      else out.notes.push(m.message);
    }catch(e){ out.errors.push('geocode: '+e.message); res.setHeader('Cache-Control','no-store'); }   // don't cache a failed geocode for a day

    // 2) parcel by point (geometry + area)
    let parcelFeat=null;
    if(pt){
      try{
        const j = await parcelAtPoint(pt); raw.parcel = debug?j:undefined;
        if(j.features&&j.features.length) parcelFeat=j.features[0];
      }catch(e){ out.errors.push('parcel: '+e.message); }
    }
    if(parcelFeat){
      const g=parcelFeat.geometry, sqft=shoelaceSqft(g), bb=bboxWxD(g);
      out.parcel = {
        area_sf: sqft?Math.round(sqft):null,
        area_ac: sqft?+(sqft/43560).toFixed(3):null,
        area_attr: findAttr(parcelFeat.attributes,/st_?area/i),
        bbox_w_ft: bb&&bb.w, bbox_d_ft: bb&&bb.d,
        bbox_note: 'Bounding box of the polygon - NOT frontage x depth for irregular lots. Use the polygon below.',
        pid: (findAttr(parcelFeat.attributes,/^pid$/i)||{}).value,
        nc_pin: (findAttr(parcelFeat.attributes,/nc_?pin/i)||{}).value,
        matched_address: matched,
        is_likely_parent: (sqft!=null && sqft>20000) ? 'Large parcel - for a subdivision deal this is the PARENT; enter the intended sublot manually.' : null,
        geometry: g,
        attrs: parcelFeat.attributes
      };
      if(!pt) pt=centroid(g);
      // v3: right-of-way edge classification via neighboring parcels
      try{
        const ring0=g.rings&&g.rings[0];
        if(ring0&&ring0.length>=4){
          const xs=ring0.map(p=>p[0]), ys=ring0.map(p=>p[1]), PAD=40;
          const env={xmin:Math.min(...xs)-PAD,ymin:Math.min(...ys)-PAD,xmax:Math.max(...xs)+PAD,ymax:Math.max(...ys)+PAD,spatialReference:{wkid:SR}};
          const url=`${BASE}/${LAYER.parcels}/query?geometry=${encodeURIComponent(JSON.stringify(env))}&geometryType=esriGeometryEnvelope&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=PID&returnGeometry=true&outSR=${SR}&f=json`;
          const nj=await aj(url); raw.neighbors=debug?{count:(nj.features||[]).length}:undefined;
          const selfPid=out.parcel.pid, selfOID=parcelFeat.attributes&&parcelFeat.attributes.OBJECTID;
          const neighborRings=[];
          (nj.features||[]).forEach(f=>{
            const isSelf=(f.attributes&&((selfPid&&f.attributes.PID===selfPid)||(selfOID&&f.attributes.OBJECTID===selfOID)));
            if(!isSelf&&f.geometry&&f.geometry.rings) f.geometry.rings.forEach(r=>neighborRings.push(r));
          });
          let info=classifyEdges(ring0,neighborRings,pt);
          info.method='address-point';
          // v4: refine with the ADDRESSED street's centerline (Accela layers 2+3)
          const stName=(out._street&&out._street.name)||'';
          if(stName){
            try{
              const PAD2=160;
              const env2={xmin:Math.min(...xs)-PAD2,ymin:Math.min(...ys)-PAD2,xmax:Math.max(...xs)+PAD2,ymax:Math.max(...ys)+PAD2,spatialReference:{wkid:SR}};
              const safe=stName.toUpperCase().replace(/[^A-Z0-9 ]/g,'');
              const centerPaths=[];const usedLayers=[];
              for(const lid of STREET_LAYERS){
                try{
                  const fl=await fields(lid);
                  const nameField=(fl.filter(f=>/string/i.test(f.type)).map(f=>f.name)
                    .find(n=>/whole.?st.?name|^st(reet)?_?name$|^name$/i.test(n)))||null;
                  if(!nameField)continue;
                  const where=encodeURIComponent(`UPPER(${nameField}) LIKE '%${safe}%'`);
                  const url=`${BASE}/${lid}/query?where=${where}&geometry=${encodeURIComponent(JSON.stringify(env2))}&geometryType=esriGeometryEnvelope&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=${nameField}&returnGeometry=true&outSR=${SR}&f=json`;
                  const sj=await aj(url);
                  (sj.features||[]).forEach(f=>{if(f.geometry&&f.geometry.paths){f.geometry.paths.forEach(p=>centerPaths.push(p));}});
                  if(sj.features&&sj.features.length)usedLayers.push(lid);
                }catch(e){/* per-layer non-fatal */}
              }
              raw.streets=debug?{name:safe,paths:centerPaths.length,layers:usedLayers}:undefined;
              if(centerPaths.length)info=applyCenterlineFront(info,centerPaths,(stName+' '+((out._street&&out._street.type)||'')).trim());
            }catch(e){ out.errors.push('centerline: '+e.message); }
          }
          const lbl=info.street?(' facing '+info.street.name+(info.street.rescued?' (edge not flagged ROW - verify)':'')):' facing right-of-way';
          out.parcel.edges={ row:info.row, front_index:info.front_index, row_count:info.row_count,
            method:info.method, street:info.street||null,
            detail:info.edges, neighbors_checked:neighborRings.length,
            note: info.front_index==null?'No street-facing edge detected - front left unset, assign in the editor.'
                 :info.row_count>1?('Corner/alley lot - front set'+lbl+'; confirm in the editor.')
                 :('Front edge set'+lbl+'.') };
        }
      }catch(e){ out.errors.push('edges: '+e.message); }
    } else if(pt){ out.notes.push('No parcel polygon at the geocoded point'); }

    // 3) overlays at the parcel point
    if(pt){
      try{ const z=await spatialAt(`${BASE}/${LAYER.zoning}`,pt); const zv=findAttr(z.attrs,/zonedes|zone|class|district/i); out.zoning={ value:(z.attrs&&z.attrs.ZoneDes)||(zv&&zv.value)||null, class:(z.attrs&&z.attrs.ZoneClass)||null, overlay:(z.attrs&&z.attrs.Overlay)||null, field:'ZoneDes', attrs:z.attrs }; raw.zoning=debug?z:undefined; }
      catch(e){ out.errors.push('zoning: '+e.message); }

      try{
        const wd=await spatialAt(`${BASE}/${LAYER.pcoDistrict}`,pt), ow=await spatialAt(`${BASE}/${LAYER.overlayWatershed}`,pt);
        const dist=(wd.attrs&&wd.attrs.PCO_Name)||((findAttr(wd.attrs,/pco|name|watershed/i)||{}).value)||null;
        out.watershed={ pco_district:dist, basin:(wd.attrs&&wd.attrs.Basin)||null, bua_rule:dist?(BUA_RULE[dist]||('Confirm BUA threshold for '+dist+' district.')):null, overlay:(ow.attrs&&(ow.attrs.Name||(findAttr(ow.attrs,/name|class/i)||{}).value))||null };
        raw.watershed=debug?{wd,ow}:undefined;
      }catch(e){ out.errors.push('watershed: '+e.message); }

      // 3b) REAL SWIM / Water Quality buffer - resolve hosted layer from its AGO item, then spatial query
      try{
        const item = await aj(`https://www.arcgis.com/sharing/rest/content/items/${WQ_BUFFER_ITEM}?f=json`);
        raw.wqItem = debug?{url:item.url,type:item.type}:undefined;
        if(item && item.url){
          const layerUrl = /\/\d+$/.test(item.url) ? item.url : item.url + '/0'; // item.url may already include /0
          const b = await spatialAt(layerUrl, pt);
          out.swim_buffer = { intersects:b.hit, types: b.feats.map(f=>(findAttr(f.attributes,/type|buffer|swim|class|name/i)||{}).value).filter(Boolean), service:item.url, attrs:b.attrs };
          raw.swim=debug?b:undefined;
        } else out.notes.push('Could not resolve Water Quality Buffer service URL from AGO item');
      }catch(e){ out.errors.push('swim_buffer: '+e.message); }

      // staff review area (administrative only - NOT a buffer)
      try{ const ra=await spatialAt(`${BASE}/${LAYER.reviewArea}`,pt); out.review_area={ reviewer:(ra.attrs&&ra.attrs.Reviewer)||null, contact:(ra.attrs&&ra.attrs.Contact)||null, note:'WQ-buffer staff review assignment - administrative, not a buffer on the parcel.' }; }
      catch(e){ /* non-critical */ }

      try{ const h=await spatialAt(`${BASE}/${LAYER.historic}`,pt); out.historic={ in_district:h.hit, name:((findAttr(h.attrs,/name|district/i)||{}).value)||null }; }
      catch(e){ out.errors.push('historic: '+e.message); }
    }

    // 4) v5 county enrichment — assessor record + site facts. Mecklenburg only; every piece is
    // independent and non-fatal, so a layer being down degrades one field instead of the lookup.
    const pid = out.parcel && out.parcel.pid;
    const ring = out.parcel && out.parcel.geometry && out.parcel.geometry.rings && out.parcel.geometry.rings[0];
    if(pid){
      const results = await Promise.allSettled([
        // 4a) CAMA: owner, land use, year built, heated sf, last sale, assessed values
        aj(`${MECK}/TaxParcel_camadata/MapServer/0/query?where=${encodeURIComponent("pid='"+pid+"'")}`
          +'&outFields=pid,address,legaldesc,ownrlstnme,ownrfrstnme,ownr2lstnme,ownr2frstnme,'
          +'lusecode,landuse_description,legalacres,gisacres,neighbordesc,vacorimprov,'
          +'saleprice,saledate,validsale,naldesc,typeofdeed,grantor,deed_book,deed_page,'
          +'totlandval,totalbldgval,totalvalue,totmarkval,'
          +'yearbuilt,effyearblt,heatedarea,totalarea,finarea,bedrooms,fullbath,halfbath,'
          +'grade,bldgtype,storyheight,extwall,foundation,resunits'
          +'&returnGeometry=false&f=json'),
        // 4b) building footprints on the lot (teardown square footage)
        ring ? byPolygon(`${MECK}/BuildingFootprints/MapServer/0`, ring, 'layer,sourceyear', true) : Promise.resolve(null),
        // 4c) tree canopy polygons over the lot (clipped below)
        ring ? byPolygon(`${MECK}/TreeCanopy/TreeCanopy2025/MapServer/0`, ring, 'OBJECTID', true) : Promise.resolve(null),
        // 4d) elevation at the parcel corners -> fall and slope
        ring ? aj(`${AERIAL}/LiDAR/DEM_3ft_2026/ImageServer/getSamples?geometry=`
          +encodeURIComponent(JSON.stringify({points:ring.map(p=>[p[0],p[1]]), spatialReference:{wkid:SR}}))
          +'&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json') : Promise.resolve(null),
      ]);
      const [camaR, fpR, canopyR, demR] = results;
      raw.county = debug ? {cama:camaR.status, footprints:fpR.status, canopy:canopyR.status, dem:demR.status} : undefined;

      // 4a) assessor record
      if(camaR.status==='fulfilled' && camaR.value && camaR.value.features && camaR.value.features.length){
        const a = camaR.value.features[0].attributes;
        const asDate = v => (typeof v==='number' && v>0 && v<4e12) ? new Date(v).toISOString().slice(0,10) : null;
        const nm = (l,f) => [f,l].map(x=>(x||'').trim()).filter(Boolean).join(' ') || null;
        const validity = (a.validsale||'').trim();
        out.cama = {
          owner:nm(a.ownrlstnme,a.ownrfrstnme), owner2:nm(a.ownr2lstnme,a.ownr2frstnme),
          situs:a.address||null, legal:a.legaldesc||null,
          land_use:a.landuse_description||null, use_code:a.lusecode||null,
          vacant: a.vacorimprov ? /^VAC/i.test(a.vacorimprov) : null,
          year_built:a.yearbuilt||null, eff_year:a.effyearblt||null,
          heated_sf:a.heatedarea||null, total_sf:a.totalarea||null, finished_sf:a.finarea||null,
          beds:a.bedrooms||null, baths:((a.fullbath||0)+0.5*(a.halfbath||0))||null,
          grade:a.grade||null, bldg_type:a.bldgtype||null, stories:a.storyheight||null,
          ext_wall:a.extwall||null, foundation:a.foundation||null, res_units:a.resunits||null,
          last_sale_price:a.saleprice||null, last_sale_date:asDate(a.saledate),
          sale_validity:validity||null,
          // blank = arm's length; Z = builder sale (exactly the new-build resales we comp against).
          sale_is_market: validity==='' || validity.toUpperCase()==='Z',
          sale_validity_note:(a.naldesc||'').trim()||null,
          deed_type:a.typeofdeed||null, grantor:a.grantor||null,
          deed:(a.deed_book&&a.deed_page)?`${a.deed_book}/${a.deed_page}`:null,
          land_value:a.totlandval||null, building_value:a.totalbldgval||null,
          total_value:a.totalvalue||null, market_value:a.totmarkval||null,
          legal_acres:a.legalacres||null, neighborhood:a.neighbordesc||null,
          source:'Mecklenburg County CAMA'
        };
      } else if(camaR.status==='rejected'){ out.errors.push('cama: '+camaR.reason.message); }
      else { out.notes.push('No CAMA record for PID '+pid+' — newly created lot? Enter structure size by hand.'); }

      const site = {};
      // 4b) footprints: full footprint area, not clipped — a building straddling the line is rare and
      // the demo estimate wants the whole structure anyway.
      if(fpR.status==='fulfilled' && fpR.value){
        const feats = fpR.value.features || [];
        let sf = 0; feats.forEach(f=>{ const a = shoelaceSqft(f.geometry); if(a) sf += a; });
        site.footprint_count = feats.length;
        site.footprint_sf = feats.length ? Math.round(sf) : 0;
      } else if(fpR.status==='rejected'){ out.errors.push('footprints: '+fpR.reason.message); }

      // 4c) canopy clipped to the parcel via the county geometry service
      if(canopyR.status==='fulfilled' && canopyR.value){
        const feats = (canopyR.value.features||[]).filter(f=>f.geometry&&f.geometry.rings);
        if(!feats.length){ site.canopy_sf = 0; site.canopy_pct = 0; }
        else {
          try{
            const clipped = await ajPost(GEOMSVC+'/intersect', {
              sr:String(SR), f:'json',
              geometries:JSON.stringify({geometryType:'esriGeometryPolygon', geometries:feats.map(f=>({rings:f.geometry.rings}))}),
              geometry:JSON.stringify({geometryType:'esriGeometryPolygon', geometry:{rings:[ring]}})
            });
            const polys = (clipped.geometries||[]).filter(g=>g&&g.rings&&g.rings.length);
            if(polys.length){
              const areas = await ajPost(GEOMSVC+'/areasAndLengths', {
                sr:String(SR), f:'json', calculationType:'planar',
                polygons:JSON.stringify(polys), areaUnit:JSON.stringify({areaUnit:'esriSquareFeet'})
              });
              const total = (areas.areas||[]).reduce((t,v)=>t+Math.abs(v||0),0);
              site.canopy_sf = Math.round(total);
            } else site.canopy_sf = 0;
          }catch(e){ out.errors.push('canopy_clip: '+e.message); }
        }
        if(site.canopy_sf!=null && out.parcel.area_sf) site.canopy_pct = Math.round(site.canopy_sf/out.parcel.area_sf*100);
      } else if(canopyR.status==='rejected'){ out.errors.push('canopy: '+canopyR.reason.message); }

      // 4d) slope from the elevation samples at the parcel corners
      if(demR.status==='fulfilled' && demR.value){
        const samples = (demR.value.samples||[])
          .map(s=>({v:parseFloat(s.value), x:s.location&&s.location.x, y:s.location&&s.location.y}))
          .filter(s=>isFinite(s.v));
        if(samples.length>=2){
          let lo=samples[0], hi=samples[0];
          samples.forEach(s=>{ if(s.v<lo.v)lo=s; if(s.v>hi.v)hi=s; });
          const fall = hi.v-lo.v;
          const run = Math.hypot((hi.x-lo.x)||0,(hi.y-lo.y)||0);
          const pct = run>0 ? fall/run*100 : null;
          site.elev_min_ft = +lo.v.toFixed(1); site.elev_max_ft = +hi.v.toFixed(1);
          site.fall_ft = +fall.toFixed(1);
          site.run_ft = Math.round(run);
          site.slope_pct = pct!=null ? +pct.toFixed(1) : null;
          site.slope_class = pct!=null ? band(pct, SLOPE_BANDS) : null;
          site.samples = samples.length;
        }
      } else if(demR.status==='rejected'){ out.errors.push('elevation: '+demR.reason.message); }

      if(site.canopy_pct!=null) site.canopy_class = band(site.canopy_pct, CANOPY_BANDS);
      if(Object.keys(site).length){
        site.note = 'Slope is corner-to-corner across the whole parcel, not the pad. Canopy is the 2025 county layer clipped to the lot. Both are screening estimates — confirm on site.';
        out.site = site;
      }
    }

    out.note_easements = 'No private-easement layer here - verify easements on the recorded plat. (Storm-water easements are a separate Open Data layer if needed.)';
    out.ok = !!(out.parcel || out.zoning);
    if(debug) out.raw = raw;
    res.status(200).json(out);
  }catch(e){ out.errors.push('fatal: '+e.message); res.status(200).json(out); }
}
