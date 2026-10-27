// api/accela.js — Accela status for the permitting board  v1 (2026-10-13)
// Accela Citizen Access (aca-prod.accela.com/CHARLOTTE) is the SOURCE OF TRUTH for the status of every
// board milestone that carries a City record number (LDIRL-…, LDPLAT-…). Email (the Permit Listener) finds
// new items and puts their record numbers on the board; from then on this endpoint keeps their status.
//
// GET  ?k=&refs=A,B   — read-only lookup of those records (no Drive, no writes). Edge-cached 10 min.
// POST {k, op:'sync', dry?} — reads ttv-permit-state.json from Drive, looks up every City ref on the board,
//                      and writes Accela's status back through the TTV Permit Feed (editor "Accela") for each
//                      milestone where Accela and the board disagree. The board calls this on every load.
// GET  (Vercel cron, daily 10:00 UTC — before the 7:30 ET listener) — the same sync, so the Drive file is
//                      current even on days nobody opens the board; then the due-date reminder email
//                      (api/permit-reminders.js) from the synced state.
//
// What is read: Accela's public record page (no login — "Login is NOT required for searching any
// project/application information"), plus the two calls that page itself makes to fill its Processing
// Status and Related Records tabs. The City reviewer assigned to an open step (task.current) rides only the
// live response and the reminder email; the block written back to Drive carries no names and nothing more
// than the City already publishes. County records (R-TH-… building permits) are not in the public
// search (re-checked 2026-10-13 on aca-prod.accela.com/MECKLENBURG) — they stay email-driven.
import { GATE_HASH, loadPermitState } from './permits.js';

const AGENCY = 'CHARLOTTE';
const ORIGIN = 'https://aca-prod.accela.com';
const UA = 'Mozilla/5.0 (TTV permitting board; read-only status check)';
const REF_RE = /\b(LD[A-Z]{2,6}|ZV|ZUP|CPB|RSVA)-(\d{4})-(\d{3,7})\b/i;
const MAX_REFS = 25;            // one record page + two small calls each; a sync never fans out further
const CACHE_MS = 10 * 60 * 1000; // per-instance memo so a burst of board loads costs Accela one lookup
const MISS_MS = 2 * 60 * 1000;   // a failed / not-found lookup is retried after 2 min, not on every load
// One clock for a sync, from t0 (just before the Drive read; maxDuration 60 counts from about there). Each step has a
// stop counted from t0, not from its own start, so a slow step takes time from the next one and never runs past its stop:
// the Drive read ends by DRIVE_STOP_MS, the Accela look-ups by LOOKUP_STOP_MS (so they get at least 15 s; about 12 s
// for six records on 10/19), the cron's email by SEND_STOP_MS and the feed writes by WRITE_STOP_MS. An email that takes
// until 35 s still leaves 15 s, so at least one write starts after it.
const DRIVE_STOP_MS = 10 * 1000;
const LOOKUP_STOP_MS = 25 * 1000;
const SEND_STOP_MS = 35 * 1000;
// Feed writes: every write is done or abandoned by WRITE_STOP_MS, none starts with less than WRITE_MIN_MS left, and each
// gets at most WRITE_TIMEOUT_MS (or what's left, if less). Most writes take a few seconds. The rest wait for the next sync.
const WRITE_STOP_MS = 50 * 1000;
const WRITE_MIN_MS = 10 * 1000;
const WRITE_TIMEOUT_MS = 25 * 1000;
const cache = new Map();

// Which board milestones a record type may set. Accela knows City approval, never Register-of-Deeds
// recording, so a plat number parked on a "RECORDED" step drives that plat's approval step instead.
const OWNS = { LDIRL: ['dev-ldirl'], LDPLAT: ['plat-app', 'subplat-app'] };
const REC_TO_APP = { 'plat-rec': 'plat-app', 'subplat-rec': 'subplat-app' };

export const recordUrl = ref => `${ORIGIN}/${AGENCY}/Cap/GlobalSearchResults.aspx?QueryText=${encodeURIComponent(ref)}`;
export function cityRef(s){ const m = REF_RE.exec(String(s || '')); return m ? m[0].toUpperCase() : null; }

const decode = s => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = s => decode(String(s).replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const isoDate = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };

// ── page parsing ────────────────────────────────────────────────────────────────────────────────────
export function parseRecordPage(page, ref){
  const num = /id="ctl00_PlaceHolderMain_lblPermitNumber"[^>]*>\s*([^<]+?)\s*</.exec(page);
  if(!num || num[1].trim().toUpperCase() !== ref.toUpperCase()) return null;
  const rec = { ref: num[1].trim(), status: null, type: null, address: null, project: null };
  const st = /id="ctl00_PlaceHolderMain_lblRecordStatus"[^>]*>\s*([^<]+?)\s*</.exec(page);
  if(st) rec.status = decode(st[1]).trim();
  const ty = /id="ctl00_PlaceHolderMain_lblPermitType"[^>]*>\s*([^<]+?)\s*</.exec(page);
  if(ty) rec.type = decode(ty[1]).trim();
  const loc = /id='tbl_worklocation'.*?<span class='fontbold'>\s*([^<]+?)\s*<\/span>\s*<br\s*\/?>\s*([^<]*?)\s*</s.exec(page);
  if(loc) rec.address = `${decode(loc[1])}, ${decode(loc[2])}`.replace(/\s+/g, ' ').replace(/[ ,]+$/, '');
  const pj = /per_permitDetail_label_project[^>]*>Project Description:<\/span>.*?<td>(.*?)<\/td>/s.exec(page);
  if(pj) rec.project = text(pj[1]).slice(0, 160);
  return rec;
}

// Processing Status: one header row per review step (icon title = complete | active | …, then the step
// name), followed by a hidden row holding that step's history ("Due on D, assigned to N · Marked as X on
// D by N", oldest first). `current` is the step's last entry — for an open step, who has it and the City's
// own due date. It carries a City reviewer's name, so it rides the live response and the reminder email
// only, never the block saved to Drive (summary() leaves it out).
// Does the City hold this step right now? Open (active) with an assignment, not handed back to us
// (revisions requested, fees or plans awaited — "Revisions Received" is the City's again) and not already
// marked done (an active icon can lag an "Ok"). The reminder email and the board's late flag both read this.
const STEP_OURS = /(revision|awaiting (revisions?|payment|plans|info|information|applicant|corrections?|resubmittal|mylar(?! to be signed))|payment due|fees due|incomplete|on hold|pending applicant|returned|correction)/i;
const STEP_BACK = /(revisions? received|resubmitted|plans received)/i;
const STEP_DONE = /^(ok|approved|complete|completed|issued|passed|finaled|final)\b/i;
// Same-day entries come back in no fixed order, so one day is read in the order things happen: requested
// (our move) → received / in review → done. Used for a step's current and latest entry alike.
const stepRank = st => STEP_DONE.test(st || '') ? 3 : STEP_BACK.test(st || '') ? 2 : STEP_OURS.test(st || '') ? 1 : 2;
export function cityHolds(t){
  if(!t || t.state !== 'active' || !t.current) return false;
  const st = t.current.status || '';
  if(STEP_DONE.test(st)) return false;
  return !(STEP_OURS.test(st) && !STEP_BACK.test(st));
}

export function parseProcessing(html){
  const tasks = [];
  const head = /<tr[^>]*>\s*<td[^>]*width:38px[^>]*>(.*?)<\/td>\s*<td class='ACA_ALeft' width='770px'\s*>(.*?)<\/td>\s*<\/tr>/gs;
  const marks = [];
  let m;
  while((m = head.exec(html))){
    const icon = /<img title='([^']*)'/.exec(m[1]);
    marks.push({ at: m.index, end: head.lastIndex, name: text(m[2]), state: icon ? icon[1].toLowerCase() : null });
  }
  marks.forEach((t, i) => {
    const body = html.slice(t.end, i + 1 < marks.length ? marks[i + 1].at : html.length);
    const history = [];
    // span contents never hold tags, so [^<]* keeps one entry's fields from bleeding into the next
    const h = /(?:Due on\s*<span[^>]*>([^<]*)<\/span>\s*,\s*assigned to\s*<span[^>]*>([^<]*)<\/span>\s*(?:<br\s*\/?>)?\s*)?Marked as\s*<span[^>]*>([^<]*)<\/span>\s*on\s*<span[^>]*>([^<]*)<\/span>/g;
    const entries = [];
    let x;
    while((x = h.exec(body))){
      const st = text(x[3]), who = x[2] ? text(x[2]) : '';
      const e = { status: st && st !== 'TBD' ? st : null, date: isoDate(text(x[4])),
                  assignedTo: who && who !== 'TBD' ? who : null, cityDue: x[1] ? isoDate(text(x[1])) : null };
      entries.push(e);
      if(e.status) history.push({ status: e.status, date: e.date });
    }
    // who has it now: the open (not yet marked, "TBD") entry; otherwise the newest-dated one — position is
    // unreliable for same-day entries
    const open = entries.filter(e => !e.status);
    // newest day in workflow order (stepRank), so the same history always picks the same entry
    const dated = entries.filter(e => e.date).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : stepRank(a.status) - stepRank(b.status));
    const pick = open.length ? open[open.length - 1] : dated.length ? dated[dated.length - 1] : entries[entries.length - 1];
    const current = pick ? { status: pick.status, assignedTo: pick.assignedTo, cityDue: pick.cityDue } : null;
    const c = /Comment:\s*(?:<\/[^>]+>\s*)*(.*?)(?:Additional Information:|<\/table>)/s.exec(body);
    const task = { name: t.name, state: t.state, history, current, comment: c ? text(c[1]).slice(0, 280) || null : null };
    task.latest = last(task);
    task.cityHolds = cityHolds(task);
    tasks.push(task);
  });
  return tasks;
}

export function parseRelated(html){
  // one <tr name="_001…"> per record; the record number sits in a nested table, then type · project · opened
  return String(html).split('<tr name="').slice(1).map(row => {
    const ref = cityRef(text(row.split('</table>')[0]));
    const cells = [...(row.split('</table>')[1] || '').matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(c => text(c[1]));
    return ref && { ref, type: cells[0] || null, project: cells[1] || null, opened: isoDate(cells[2]) };
  }).filter((r, i, a) => r && a.findIndex(x => x && x.ref === r.ref) === i);
}

// ── Accela → board status ───────────────────────────────────────────────────────────────────────────
// The record's overall status is NOT the approval signal on its own: an LDIRL stays "In Progress" after
// its plan review is approved while the Urban Forestry inspection is open (LDIRL-2026-04500: Plan
// Collection "Approved" 9/21, record "In Progress"). So: a closed/approved record, OR an approved Plan
// Collection step, means done — except a plat whose mylar isn't signed yet. After Plan Collection a plat still
// has "Awaiting Mylar to be Signed" open with a City planner, and it can't be recorded until that's done
// (LDPLAT-2026-00562: Plan Collection Approved 10/16, mylar with Madison Peacock, City due 10/23; Brian
// 2026-10-19: "why is this showing as approved?"). A record whose status says Approved is done either way.
const RELEASE_STEP = /mylar/i;
const DEAD = /(denied|disapproved|withdrawn|expired|void|cancel|rejected|abandoned|revoked)/i;
const DONE = /^(approved|issued|closed|complete|completed|finaled|final|recorded|finalized)\b/i;
const BACK = /(revisions? received|resubmitted|plans received)/i;   // we answered — the City is reviewing again
const OURS = /(revision|awaiting payment|payment due|fees due|incomplete|awaiting plans|awaiting info|additional info|pending applicant|on hold|resubmit|returned|correction)/i;
const REVIEW = /(progress|review|submitted|received|accepted|pending|intake|open|distribution|routing|ready)/i;
const PLAN_OK = /^(approved|ok)\b/i;

// Accela lists a step's history by date, but entries from the same day come back in no fixed order
// (LDPLAT-2026-00501's Plan Collection reads "Approved 8/11 → Revisions 8/11"). So "latest" = the newest
// date, and a step counts as approved when any of its entries on that newest date is an approval.
const newest = t => { const ds = t ? t.history.map(h => h.date).filter(Boolean).sort() : []; return ds.length ? ds[ds.length - 1] : null; };
const last = t => {
  if(!t || !t.history.length) return null;
  const d = newest(t), day = d ? t.history.filter(h => h.date === d) : t.history;
  return day.reduce((best, h) => !best || stepRank(h.status) >= stepRank(best.status) ? h : best, null);
};

export function deriveStatus(rec){
  const s = rec.status || '';
  const tasks = rec.tasks || [];
  const plan = tasks.find(t => /plan collection/i.test(t.name));
  const planOk = plan ? plan.history.filter(h => h.date && h.date === newest(plan)).find(h => PLAN_OK.test(h.status)) : null;
  const now = tasks.filter(t => t.state === 'active').map(t => ({ name: t.name, h: last(t) })).pop()
    || tasks.filter(t => t.history.length).map(t => ({ name: t.name, h: last(t) })).pop() || null;
  const step = now ? { step: now.name, stepStatus: now.h ? now.h.status : null, stepDate: now.h ? now.h.date : null } : {};
  const approved = planOk ? { step: plan.name, stepStatus: planOk.status, stepDate: planOk.date } : step;
  if(DEAD.test(s)) return { board: 'blocked', why: `Accela: ${s}`, ...step };
  if(DONE.test(s)) return { board: 'done', why: `Accela: ${s}`, ...approved };
  if(planOk){
    const mStatus = t => (t.current && t.current.status) || (t.latest && t.latest.status) || '';
    // not signed yet: the step isn't complete and its newest entry isn't a completion (an active icon can lag an Ok);
    // a step not yet started counts too — the plat still can't be recorded
    const mylar = tasks.find(t => RELEASE_STEP.test(t.name) && t.state !== 'complete' && !STEP_DONE.test(mStatus(t)));
    if(mylar){
      const due = mylar.current && mylar.current.cityDue;
      const holds = mylar.state !== 'active' || cityHolds(mylar);
      return { board: holds ? 'submitted' : 'active',
               why: `Plan review approved ${planOk.date || ''} — ${holds ? 'waiting on the City to sign the mylar' : `the mylar is back with us (${mStatus(mylar)})`}${holds && due ? ` (City due ${due})` : ''}`.replace('  ', ' '),
               step: mylar.name, stepStatus: mStatus(mylar) || null, stepDate: (mylar.latest && mylar.latest.date) || null };
    }
    return { board: 'done', why: `Plan review approved ${planOk.date || ''} (record still ${s || 'open'} for inspections)`.replace('  ', ' '), ...approved };
  }
  if(BACK.test(s)) return { board: 'submitted', why: `In City review: ${s}`, ...step };
  if(OURS.test(s)){
    const why = /payment/i.test(s) ? 'Fees due — pay in Accela' : /revision|correction|resubmit|returned/i.test(s)
      ? 'City asked for revisions' : `Waiting on us: ${s}`;
    return { board: 'active', why, ...step };
  }
  if(REVIEW.test(s)) return { board: 'submitted', why: `In City review: ${s}`, ...step };
  return { board: null, why: s ? `Accela status "${s}" isn't mapped — board left as is` : 'No status on the Accela record', ...step };
}

// ── fetching ────────────────────────────────────────────────────────────────────────────────────────
function cookieHeader(jar){ return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); }
function keepCookies(jar, res){
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  set.forEach(c => { const m = /^([^=;\s]+)=([^;]*)/.exec(c); if(m) jar.set(m[1], m[2]); });
}

// Each request stops at 20 s, or sooner when the caller's deadline (`stop`) passes.
function reqSignal(stop){
  const t = AbortSignal.timeout(20000);
  if(!stop) return t;
  if(AbortSignal.any) return AbortSignal.any([t, stop]);
  const c = new AbortController(), fire = () => c.abort();     // runtimes without AbortSignal.any
  if(stop.aborted) c.abort();
  t.addEventListener('abort', fire, { once: true });
  stop.addEventListener('abort', fire, { once: true });
  return c.signal;
}

async function lookup(ref, stop){
  const hit = cache.get(ref);
  if(hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const jar = new Map();
  const out = { ref, ok: false, url: recordUrl(ref), status: null, type: null, address: null, project: null,
                opened: null, tasks: [], related: [], error: null };
  try{
    // Follow redirects by hand: the record page's ASP.NET session is what the two tab calls read.
    let url = out.url, res, page = '';
    for(let hop = 0; hop < 6; hop++){
      res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Cookie: cookieHeader(jar) }, signal: reqSignal(stop) });
      keepCookies(jar, res);
      const loc = res.headers.get('location');
      if(res.status >= 300 && res.status < 400 && loc){ url = new URL(loc, url).href; continue; }
      page = await res.text();
      break;
    }
    if(!res || !res.ok) throw new Error('Accela HTTP ' + (res && res.status));
    const rec = parseRecordPage(page, ref);
    if(!rec){ out.error = 'not found by Accela public search'; return out; }
    Object.assign(out, rec);
    const module = (/[?&]Module=(\w+)/.exec(url) || [])[1] || 'LandDevelopment';
    const call = async (method, body) => {
      const r = await fetch(`${url.split('?')[0]}/${method}`, { method: 'POST', signal: reqSignal(stop),
        headers: { 'User-Agent': UA, Cookie: cookieHeader(jar), Referer: url, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body) });
      if(!r.ok) throw new Error(`${method} HTTP ${r.status}`);
      return (await r.json()).d || '';
    };
    const [proc, tree] = await Promise.allSettled([
      call('GetProcessingData', { agencyCode: AGENCY, moduleName: module }),
      call('GetBuildCapTree', { moduleName: module, isShowAll: 'true' })
    ]);
    if(proc.status === 'fulfilled') out.tasks = parseProcessing(proc.value);
    const rel = tree.status === 'fulfilled' ? parseRelated(tree.value) : [];
    out.related = rel.filter(r => r.ref !== out.ref);
    const self = rel.find(r => r.ref === out.ref);
    out.opened = (self && self.opened) || out.tasks.flatMap(t => t.history.map(h => h.date)).filter(Boolean).sort()[0] || null;
    // No review steps = no status. Without them an approved LDIRL whose record still reads "In Progress"
    // would derive as "submitted" and the sync would write that over "done".
    if(!out.tasks.length) out.error = 'review steps unavailable' + (proc.status === 'rejected' ? ' (' + proc.reason.message + ')' : '');
    else out.ok = true;
  }catch(e){
    out.error = String(e && e.message || e);
  }
  cache.set(ref, { at: Date.now() - (out.ok ? 0 : CACHE_MS - MISS_MS), data: out });
  return out;
}

// deadlineMs: one limit for the whole set (a sync passes what's left of LOOKUP_STOP_MS). A slow Accela (each
// request can take 20 s) must not run the cron past maxDuration 60 and take the morning email with it: past the
// deadline, requests in flight are aborted and records not started are reported unread. 0 or less reads nothing.
export async function lookupAll(refs, { deadlineMs } = {}){
  const uniq = [...new Set(refs)].slice(0, MAX_REFS), out = {};
  const ms = deadlineMs == null ? null : Math.max(0, deadlineMs);
  const end = ms == null ? Infinity : Date.now() + ms, stop = ms == null ? null : AbortSignal.timeout(ms);
  for(let i = 0; i < uniq.length; i += 4){              // four at a time — gentle on a public portal
    if(Date.now() >= end || (stop && stop.aborted)){
      uniq.slice(i).forEach(ref => { out[ref] = { ref, ok: false, url: recordUrl(ref), status: null, type: null, address: null,
        project: null, opened: null, tasks: [], related: [], error: 'not read — Accela too slow this run' }; });
      break;
    }
    const batch = await Promise.all(uniq.slice(i, i + 4).map(ref => lookup(ref, stop)));
    batch.forEach(r => { out[r.ref] = r; });
  }
  return out;
}

// What the board stores per milestone (compact, no staff names, no comments).
export function summary(rec){
  const d = deriveStatus(rec);
  const asOf = rec.tasks.flatMap(t => t.history.map(h => h.date)).filter(Boolean).sort().pop() || null;
  return { rec: rec.ref, status: rec.status, type: rec.type, opened: rec.opened, asOf,
           board: d.board, why: d.why, step: d.step || null, stepStatus: d.stepStatus || null, stepDate: d.stepDate || null };
}

// Board milestones a sync may touch: every milestone holding a City ref, mapped to the step it drives.
export function targets(state){
  const out = [];
  for(const p of (state && state.projects) || []){
    const st = p.state || {};
    const seen = new Map();
    for(const [mid, c] of Object.entries(st)){
      const ref = cityRef(c && c.ref);
      if(!ref) continue;
      const target = REC_TO_APP[mid] || mid;
      const owns = (OWNS[ref.split('-')[0]] || []).includes(target) && !!st[target];
      const key = owns ? target : mid;
      // an owned ref beats a display-only one; a ref on the step itself beats one parked on its RECORDED step
      const prev = seen.get(key);
      if(prev && !((owns && !prev.owns) || (owns && mid === target && prev.refOn !== target))) continue;
      seen.set(key, { projectId: p.id, addr: p.addr, milestoneId: key, refOn: mid, ref, owns });
    }
    out.push(...seen.values());
  }
  return out;
}

// Field by field, not JSON text: the listener republishes the whole file and may reorder keys or drop nulls,
// which must not read as a change (every board load would rewrite every block).
const same = (prev, next) => !!prev && Object.keys(next).every(k => (prev[k] ?? null) === (next[k] ?? null));

export function plan(state, records){
  const tg = targets(state);
  // A block whose ref was removed or moved: clear it, or its lock outlives the record number.
  const stale = [];
  for(const p of state.projects){
    for(const [mid, c] of Object.entries(p.state || {})){
      if(c && c.accela && !tg.some(t => t.projectId === p.id && t.milestoneId === mid))
        stale.push({ projectId: p.id, addr: p.addr, milestoneId: mid, refOn: mid, ref: c.accela.rec || null, owns: false,
                     from: c.status || null, to: c.status || null, accela: null, change: true, upd: { accela: null },
                     note: 'record number removed — Accela block cleared', cleared: true });
    }
  }
  return tg.map(t => {
    const p = state.projects.find(x => x.id === t.projectId), c = p.state[t.milestoneId] || {};
    const rec = records[t.ref];
    const item = { ...t, from: c.status || null, to: c.status || null, accela: c.accela || null, change: false, note: null };
    if(!rec || !rec.ok){ item.note = rec ? rec.error : 'not looked up'; return item; }
    const acc = { ...summary(rec), owns: t.owns };   // owns: this record sets the step's status (the board locks it)
    // the email's "since the last check" snapshot rides in the block; only the morning run replaces it
    // — and only for the same record: a milestone whose number changed (a plat resubmitted under a new LDPLAT) starts over
    if(c.accela && c.accela.seen && c.accela.rec === t.ref) acc.seen = c.accela.seen;
    const upd = {};
    if(t.owns && acc.board && acc.board !== c.status) upd.status = acc.board;
    if(t.owns && acc.board && !c.started && acc.opened) upd.started = acc.opened;
    if(!same(c.accela, acc)) upd.accela = acc;
    item.accela = acc;
    item.to = upd.status || c.status || null;
    item.change = Object.keys(upd).length > 0;
    item.upd = upd;
    if(!t.owns) item.note = `${t.ref.split('-')[0]} on "${t.refOn}" — shown, not used to set status`;
    return item;
  }).concat(stale);
}

async function writeFeed(state, item, ms){
  const FEED_URL = process.env.PERMITS_FEED_URL, FEED_TOKEN = process.env.PERMITS_FEED_TOKEN;
  const p = state.projects.find(x => x.id === item.projectId);
  const { edited, ...cur } = p.state[item.milestoneId] || {};   // the feed stamps its own edited marker
  const changes = { ...cur, ...item.upd };
  const r = await fetch(FEED_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain' },
    signal: AbortSignal.timeout(ms),
    body: JSON.stringify({ token: FEED_TOKEN, editor: 'Accela',
      patch: { op: 'setMilestone', projectId: item.projectId, milestoneId: item.milestoneId, changes } }) });
  const t = await r.text();
  let out; try{ out = JSON.parse(t); }catch(_){ throw new Error('feed returned non-JSON (HTTP ' + r.status + ')'); }
  if(!out || !out.ok) throw new Error((out && out.error) || 'feed refused the patch');
}

async function sync({ dry }){ return commitSync(await prepareSync(), { dry }); }

// Read Drive, look every City record up, plan the changes and apply them to the in-memory state — Accela is
// the truth even before (or without) a successful save, so the reminder email can be built from this state
// before any write starts (a Drive re-read right after the writes can return the old file anyway).
async function prepareSync(){
  const t0 = Date.now();
  const state = await loadPermitState({ timeoutMs: DRIVE_STOP_MS });
  // the look-ups end LOOKUP_STOP_MS from t0, not from here: a slow Drive read shortens them, never the email or the writes
  const records = await lookupAll(targets(state).map(t => t.ref), { deadlineMs: LOOKUP_STOP_MS - (Date.now() - t0) });
  const items = plan(state, records);
  items.forEach(it => {
    const c = it.upd && state.projects.find(p => p.id === it.projectId)?.state[it.milestoneId];
    if(c) Object.assign(c, it.upd);
  });
  return { t0, state, records, items };
}

// Put each record's new snapshot on its Accela block, in memory and as a write for commitSync() (which writes these first).
export function applySeen(prep, list){
  for(const { projectId, milestoneId, seen } of list){
    const it = prep.items.find(i => i.projectId === projectId && i.milestoneId === milestoneId && !i.cleared);
    const c = prep.state.projects.find(p => p.id === projectId)?.state[milestoneId];
    if(!it || !c || !c.accela) continue;
    const block = { ...c.accela, seen };
    c.accela = block;
    it.upd = { ...(it.upd || {}), accela: block };
    it.accela = block;
    it.change = true;
    it.newSeen = true;
  }
}

// stopMs / minMs: the write window (WRITE_STOP_MS / WRITE_MIN_MS); smaller values only in tests.
export async function commitSync({ t0, state, records, items }, { dry, stopMs = WRITE_STOP_MS, minMs = WRITE_MIN_MS } = {}){
  // Only production saves: a branch preview shares the live Drive file and feed, so opening one before
  // merge must not write. Previews (and local runs without the feed vars) report what they would change.
  const env = process.env.VERCEL_ENV;
  const dryWhy = dry ? 'dry run' : !(process.env.PERMITS_FEED_URL && process.env.PERMITS_FEED_TOKEN) ? 'write path not configured'
    : env && env !== 'production' ? `${env} deployment — only production saves` : null;
  // deferred: writes the next sync plans again. seenUnsaved: new snapshots not confirmed saved — nothing plans those again.
  let wrote = 0, failed = 0, deferred = 0, seenUnsaved = 0, halt = null;
  // New email snapshots first. Only the morning run writes one, so a snapshot left for "the next sync" is lost: the
  // next board load carries the old one from Drive, and tomorrow's email repeats today's moves (LDIRL-2026-05530,
  // 10/19). Every other write is planned again by the next sync, so it can wait.
  const queue = [...items.filter(i => i.newSeen), ...items.filter(i => !i.newSeen)];
  for(const it of queue){                                   // one at a time: every patch rewrites the same Drive file
    if(!it.change){ it.wrote = null; continue; }
    if(dryWhy){ it.wrote = false; it.note = dryWhy; if(it.newSeen) seenUnsaved++; continue; }
    const left = stopMs - (Date.now() - t0);
    if(!halt && left < minMs) halt = 'time budget';
    if(halt){
      it.wrote = false;
      if(it.newSeen){ seenUnsaved++; it.note = `not saved (${halt}) — tomorrow's email compares against the older snapshot`; }
      else{ deferred++; it.note = `deferred to the next sync (${halt})`; }
      continue;
    }
    try{ await writeFeed(state, it, Math.min(WRITE_TIMEOUT_MS, left)); it.wrote = true; wrote++; }
    catch(e){
      // A timed-out call may still be running in the feed (aborting the request doesn't stop the script), so start no
      // more writes this run: two read-modify-writes of the one Drive file must never overlap.
      const timedOut = !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      if(timedOut) halt = 'a write timed out';
      it.wrote = false; failed++;
      if(it.newSeen) seenUnsaved++;
      it.note = String(e && e.message || e) + (timedOut ? ' — the feed may still apply it' : '') + (it.newSeen ? '; snapshot not confirmed' : '');
    }
  }
  items.forEach(it => { delete it.upd; });
  return { ok: true, checkedAt: new Date().toISOString(), dry: !!dryWhy, dryWhy, wrote, failed, deferred, seenUnsaved,
           changes: items.filter(i => i.change).length, items, records };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(_){ body = null; } }
  const q = req.query || {};
  const headers = req.headers || {};
  const cronSecret = process.env.CRON_SECRET;
  // Vercel cron sends a GET with this user agent (and a Bearer CRON_SECRET once that env var is set). A sync
  // can only ever write what Accela itself shows, so the trigger is not a privilege worth more than that.
  const isCron = req.method === 'GET' && !q.refs && (cronSecret
    ? headers.authorization === `Bearer ${cronSecret}`
    : /^vercel-cron\//.test(String(headers['user-agent'] || '')));
  const k = (body && body.k) || q.k || '';
  if(!isCron && k !== GATE_HASH){ res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  try{
    if(req.method === 'GET' && q.refs){
      const refs = String(q.refs).split(',').map(cityRef).filter(Boolean);
      if(!refs.length){ res.status(400).json({ ok: false, error: 'no City record numbers in refs' }); return; }
      const records = await lookupAll(refs);
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
      res.status(200).json({ ok: true, checkedAt: new Date().toISOString(),
        records: Object.fromEntries(Object.entries(records).map(([r, x]) => [r, { ...x, derived: x.ok ? deriveStatus(x) : null }])) });
      return;
    }
    if(isCron){
      // The daily morning run: look Accela up, send the due-date email from that fresh state FIRST, then save —
      // the email can't be starved by slow feed writes inside the 60 s limit. The email ends by 35 s (SEND_STOP_MS) and
      // the writes by 50 s (WRITE_STOP_MS), the new snapshots first: a status left over is saved by the next board load,
      // a snapshot is not.
      res.setHeader('Cache-Control', 'no-store');
      const prep = await prepareSync();
      let reminders;
      try{
        const { runReminders } = await import('./permit-reminders.js');
        reminders = await runReminders({ state: prep.state, records: prep.records, send: true, sendBy: prep.t0 + SEND_STOP_MS });
      }catch(e){ reminders = { ok: false, error: String(e && e.message || e) }; }
      // The digest went out (or this instance already sent the same one today): save each record's new snapshot
      // with the other writes. A failed send keeps the old ones, so tomorrow reports the same moves.
      if(reminders && reminders.advance && Array.isArray(reminders.seen)) applySeen(prep, reminders.seen);
      if(reminders) delete reminders.seen;
      const result = await commitSync(prep, { dry: false });
      result.reminders = reminders;
      res.status(200).json(result);
      return;
    }
    if((req.method === 'POST' && body && body.op === 'sync') || (req.method === 'GET' && q.sync)){
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(await sync({ dry: !!((body && body.dry) || q.dry) }));
      return;
    }
    res.status(400).json({ ok: false, error: 'use GET ?refs=… or POST {op:"sync"}' });
  }catch(e){
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
}
