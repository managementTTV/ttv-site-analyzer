// api/permit-reminders.js — Accela digest + movement alerts  v3.1 (Brian 2026-10-19: by project)
// Brian: "I want a Monday-Wednesday-Friday email regardless every week, then alert emails on movement on specific
// items" — specific items = every City record on the board, any move (his pick, 2026-10-19).
//   - Mon / Wed / Fri (Charlotte's date): the DIGEST, sent every time. One section per project on the board, by
//     address (Brian 2026-10-19: "always broken down by project … a section for each open project address"), each
//     with its City records: where it stands, each open step (department, reviewer, City due date, late / due
//     soon) and what moved since the last check. A project with no City record yet still gets its section.
//   - Other days: a MOVEMENT ALERT, only when something moved on a record since the last check: a record status
//     change, a step's newest entry (Ok, Revisions, Fees Assessed…), a step opening with a reviewer, a City due
//     date moving, a City-held step going overdue, a record newly on the board. Nothing moved → no email. Grouped
//     by project too, showing only the projects and records that moved.
// To management@, which reaches Brian, Adam and Wendell; the email names Adam and Wendell at the top (Brian 2026-10-19).
// v1 (10/13) used the board's own due dates; v2 (10/14) emailed only steps due or late. Both are replaced.
//
// "Since the last check": each record's Accela block in Drive carries `seen`, a snapshot of its record status
// and each step's state / newest entry / City due date, with no names. The cron sends first, then writes the new
// snapshots with its other saves (api/accela.js); a failed send leaves them, so tomorrow reports the same moves.
// The very first run (no record has a snapshot yet) only takes them — no flood of "moves".
//
// Sending: the daily cron in api/accela.js calls runReminders({state, records, send:true}) after its Accela
// look-up and before the writes. Gmail API as management@ with a send-only token in the Vercel env var
// GMAIL_SEND_TOKEN ({client_id, client_secret, refresh_token} JSON, minted by
// ~/projects/ttv-meetings/meeting_mailer/authorize_permit_mailer.py). Only production sends.
// GET ?k=<gate hash>[&format=html][&date=YYYY-MM-DD][&kind=digest|alert] — preview only (never sends, never saves).
import { GATE_HASH, loadPermitState } from './permits.js';
import { lookupAll, recordUrl, deriveStatus, targets, cityHolds } from './accela.js';

const FROM = 'management@tidetimberventures.com';
const TO = process.env.REMINDER_TO || FROM;
const BOARD = 'https://ttv-site-analyzer.vercel.app/permits.html';
const DIGEST_DAYS = [1, 3, 5];                 // Mon, Wed, Fri
const SOON_DAYS = 3;                           // the digest flags a City step due within this many days
// Brand (ttv-branding; same values as ttv-meetings/meeting_mailer/email_html.py)
const NAVY = '#102538', SLATE = '#5E8095', PINE = '#648370', CREAM = '#F5F0E7', WHITE = '#FFFFFF', AMBER = '#C98A1B', RED = '#B23A3A';
const FONT = "Montserrat,'Helvetica Neue',Helvetica,Arial,sans-serif";

// Board step titles for context ("Sublot plat — City approval") — a mirror of permits.html CATALOG (id → t)
// for the steps a City record can sit on.
const TITLES = {
  'dev-ldirl': 'LDIRL — zoning · stormwater · forestry · trees', 'erosion': 'Erosion & Sediment Control permit',
  'subplat-app': 'Subdivision plat — City approval', 'subplat-rec': 'Subdivision plat RECORDED — new lots exist',
  'plat-app': 'Sublot plat — City approval', 'plat-rec': 'Sublot plat RECORDED — per-unit PIDs',
  'hist': 'Historic review / COA (if applicable)'
};
// How a step's newest entry reads for us: good news, our move, or neutral.
const GOOD = /^(ok|approved|complete|completed|issued|passed|fees paid|finaled)\b/i;
const OURS = /(revision(s)?$|revisions required|^revisions\b|awaiting (revisions?|payment|plans|info|information|applicant|corrections?)|fees assessed|payment due|fees due|incomplete|on hold)/i;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// a real calendar day (2026-02-30 is not)
const isDay = s => { if(!ISO.test(s || '')) return false; const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
// "Today" is Charlotte's date, not the server's (UTC).
export const etDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const dow = s => new Date(dayNum(s) * 86400000).getUTCDay();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nice = s => { if(!s || !ISO.test(s)) return s || ''; const [, m, d] = s.split('-').map(Number); return `${MON[m - 1]} ${d}`; };
const longDay = s => { const [y, m, d] = s.split('-').map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MON[m - 1]} ${d}, ${y}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dueText = n => n == null ? '' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'due today' : n === 1 ? 'due tomorrow' : `due in ${n} days`;
const short = a => String(a || '').split(' (')[0];

// ── the snapshot ("seen") and what moved ─────────────────────────────────────────────────────────────
// One entry per step: state | newest status | its date | City due. No reviewer names: it is saved to Drive.
// SNAP_V: bump when what a snapshot holds changes meaning (v2, 2026-10-19: same-day entries read in workflow order),
// so older snapshots re-baseline quietly instead of reading as moves.
const SNAP_V = 2;
export function snapshot(rec, today){
  const steps = {};
  (rec.tasks || []).forEach(k => {
    let name = k.name, i = 2;
    while(Object.hasOwn(steps, name)) name = `${k.name} #${i++}`;
    steps[name] = [k.state || '', (k.latest && k.latest.status) || '', (k.latest && k.latest.date) || '', (k.current && k.current.cityDue) || ''].join('|');
  });
  return { v: SNAP_V, at: today, status: rec.status || null, steps };
}
const tone = st => GOOD.test(st || '') ? 'good' : OURS.test(st || '') ? 'ours' : 'info';
// Same record status and same steps (key by key — a republished file may reorder them)?
const sameSnap = (a, b) => !!a && !!b && (a.status || null) === (b.status || null) && !!a.steps && !!b.steps &&
  Object.keys(a.steps).length === Object.keys(b.steps).length && Object.keys(b.steps).every(k => a.steps[k] === b.steps[k]);

export function moves(prev, rec, today, stillOpen){
  const out = [], cur = snapshot(rec, today).steps;
  if((prev.status || null) !== (rec.status || null))
    out.push({ tone: tone(rec.status), text: `Record status: ${prev.status || '—'} → ${rec.status || '—'}` });
  const tasks = rec.tasks || [];
  let i = 0;
  for(const [name, val] of Object.entries(cur)){
    const k = tasks[i++] || {};
    const [state, st, date, due] = val.split('|');
    const was = prev.steps && Object.hasOwn(prev.steps, name) ? prev.steps[name].split('|') : null;
    const who = k.current && k.current.assignedTo;
    const holds = cityHolds(k);
    if(!was){
      if(state === 'active') out.push({ tone: 'info', text: `New step: ${name}${who ? ` — ${who}` : ''}${due ? `, City due ${nice(due)}` : ''}` });
      continue;
    }
    const [wState, wSt, wDate, wDue] = was;
    if(st && (st !== wSt || date !== wDate))
      out.push({ tone: tone(st), text: `${name}: ${st}${date ? ` (${nice(date)})` : ''}${who && holds ? ` — with ${who}` : ''}` });
    else if(state === 'active' && wState !== 'active')
      out.push({ tone: 'info', text: `${name} is now open${who ? ` with ${who}` : ''}${due ? `, City due ${nice(due)}` : ''}` });
    if(due && wDue && due !== wDue && state === 'active' && wState === 'active')   // a finished step's date isn't a move
      out.push({ tone: 'info', text: `${name}: City due date moved ${nice(wDue)} → ${nice(due)}` });
    // went late since the last check (a City-held step on a record still in review)
    if(stillOpen && holds && isDay(due) && isDay(prev.at) && dayNum(due) < dayNum(today) && dayNum(due) >= dayNum(prev.at))
      out.push({ tone: 'late', text: `${name}${who ? ` — ${who}` : ''} is now overdue (City due ${nice(due)})` });
  }
  return out;
}

// Every City record on the board with where it stands, its open steps and what moved since its snapshot.
export function board(state, records, today){
  const out = [], unread = [], done = new Set();
  for(const t of targets(state)){
    if(done.has(t.ref)) continue;
    done.add(t.ref);
    const c = (state.projects.find(p => p.id === t.projectId) || { state: {} }).state[t.milestoneId] || {};
    const rec = records[t.ref];
    if(!rec || !rec.ok){ unread.push({ ref: t.ref, addr: t.addr, projectId: t.projectId, error: rec ? rec.error : 'not looked up' }); continue; }
    const d = deriveStatus(rec);
    const bucket = d.board === 'done' ? 'approved' : d.board === 'active' ? 'ours' : d.board === 'blocked' ? 'closed' : 'city';
    const open = (rec.tasks || []).filter(k => k.state === 'active' && k.current).map(k => {
      const due = isDay(k.current.cityDue) ? k.current.cityDue : null;
      return { step: k.name, assignedTo: k.current.assignedTo || null, cityDue: due, holds: cityHolds(k),
               status: k.current.status || (k.latest && k.latest.status) || null, days: due ? dayNum(due) - dayNum(today) : null };
    });
    // `known`: the record has a snapshot of any version, so it isn't new on the board. Only a current-version one
    // (`prev`) is compared; an older one re-baselines quietly (Elkwood, 10/20: its v2 snapshot hadn't been saved on
    // 10/19, and its v1 one read as "Now tracking" a record that had been on the board for a week).
    const raw = c.accela && c.accela.seen && typeof c.accela.seen === 'object' ? c.accela.seen : null;
    const prev = raw && raw.v === SNAP_V ? raw : null;
    const snap = snapshot(rec, today);
    const mv = prev ? moves(prev, rec, today, bucket === 'city' || bucket === 'ours') : [];
    out.push({ ref: rec.ref, url: recordUrl(rec.ref), type: rec.type, status: rec.status, why: d.why, bucket, addr: t.addr,
               projectId: t.projectId, milestoneId: t.milestoneId,
               title: Object.hasOwn(TITLES, t.milestoneId) ? TITLES[t.milestoneId] : null, open,
               moves: mv, seenBefore: !!prev, known: !!raw, seen: snap,
               // save a new snapshot only when something changed or moved — a quiet record keeps its old one, whose
               // date is what "went overdue since the last check" is measured from (no daily re-alert, no daily write)
               saveSeen: !prev || mv.length > 0 || !sameSnap(prev, snap) });
  }
  // a record newly on the board (others already have snapshots) is itself a move; the very first run is quiet
  const firstRun = out.length > 0 && out.every(r => !r.seenBefore);
  if(!firstRun) out.filter(r => !r.known).forEach(r => r.moves.push({ tone: 'info', text: `Now tracking ${r.ref} — Accela: ${r.status || 'no status'}` }));
  const projects = ((state && state.projects) || []).map(p => ({ id: p.id, addr: p.addr }));
  return { records: out, unread, firstRun, projects };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────────
// By project, in the board's own order — never by approved / in progress across projects.
const TAG = 'Adam, Wendell';
const TONE = { good: PINE, ours: AMBER, late: RED, info: SLATE };
const BADGE = n => n == null ? null : n < 0 ? RED : n <= 1 ? AMBER : n <= SOON_DAYS ? SLATE : null;
const STAND = { ours: ['Waiting on us', AMBER], city: ['In City review', SLATE], closed: ['Closed in Accela', SLATE], approved: ['Approved', PINE] };
const ORDER = { ours: 0, city: 1, closed: 2, approved: 3 };      // inside a project: open records first
const lateSteps = r => r.bucket === 'city' || r.bucket === 'ours' ? r.open.filter(o => o.holds && o.days != null && o.days < 0) : [];
const stepLine = o => `${o.step} — ${o.assignedTo || 'no reviewer assigned'}${o.cityDue ? ` · City due ${nice(o.cityDue)}` : ''}${o.holds && o.days != null ? ` (${dueText(o.days)})` : ''}${!o.holds && o.status ? ` · with us: ${o.status}` : ''}`;
// deriveStatus()'s reason without what the line already says (its "In City review: " lead-in, "Accela: <status>" when
// the status is shown just above), with dates as "Oct 16"
function standLine(r){
  const [label] = STAND[r.bucket];
  let why = String(r.why || '').replace(/^(In City review|Waiting on us): /, '');
  if(why === `Accela: ${r.status}` || why === r.status) why = '';
  return why ? `${label}: ${why.replace(/\b\d{4}-\d{2}-\d{2}\b/g, nice)}` : label;
}
const unreadText = u => /not found/i.test(u.error || '') ? `${u.ref} isn't in Accela's public search — check the record number on the board.`
  : `Couldn't read ${u.ref} in Accela this run — checked again tomorrow.`;

// The board's projects in its order, each with its City records and the ones Accela didn't answer for.
// A record whose project isn't in the list (it can't be: targets() reads the same list) still gets a section.
function byProject(view){
  const groups = (view.projects || []).map(p => ({ id: p.id, addr: p.addr, recs: [], unread: [] }));
  const find = (id, addr) => groups.find(g => g.id === id) || groups[groups.push({ id, addr, recs: [], unread: [] }) - 1];
  view.records.forEach(r => find(r.projectId, r.addr).recs.push(r));
  view.unread.forEach(u => find(u.projectId, u.addr).unread.push(u));
  groups.forEach(g => g.recs.sort((x, y) => ORDER[x.bucket] - ORDER[y.bucket]));
  return groups;
}
// A project's one-word place: the most urgent of its records.
function projectStand(g){
  const late = g.recs.reduce((n, r) => n + lateSteps(r).length, 0);
  if(late) return [`${plural(late, 'City step')} late`, RED];
  if(g.recs.some(r => r.bucket === 'ours')) return ['Waiting on us', AMBER];
  if(g.recs.some(r => r.bucket === 'city')) return ['In City review', SLATE];
  if(g.unread.length) return ["Couldn't read Accela", AMBER];
  if(!g.recs.length) return ['No City records yet', SLATE];
  return g.recs.some(r => r.bucket === 'approved') ? ['City records approved', PINE] : ['Closed in Accela', SLATE];
}

function shell(eyebrow, heading, intro, sectionsHtml, foot, today, preheader){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM};font-size:1px;line-height:1px;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background:${CREAM};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">
<tr><td bgcolor="${WHITE}" style="background:${WHITE};border-top:3px solid ${NAVY};padding:24px 28px 8px;font-family:${FONT};">
<div style="font-size:11px;line-height:1.4;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${SLATE};">Tide &amp; Timber Ventures · ${esc(eyebrow)} · ${esc(longDay(today))}</div>
<div style="font-size:22px;line-height:1.25;font-weight:700;color:${NAVY};padding-top:8px;">${esc(heading)}</div>
<div style="font-size:14px;line-height:1.5;color:${NAVY};padding-top:10px;">${esc(intro)}</div>
</td></tr>
<tr><td bgcolor="${WHITE}" style="background:${WHITE};padding:0 28px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sectionsHtml}</table></td></tr>
<tr><td bgcolor="${WHITE}" style="background:${WHITE};padding:14px 28px 24px;font-family:${FONT};">
${foot.warn ? `<div style="font-size:12px;line-height:1.5;color:${AMBER};padding-bottom:12px;">${esc(foot.warn)}</div>` : ''}
<a href="${BOARD}" style="display:inline-block;background:${NAVY};color:${CREAM};font-weight:700;font-size:13px;text-decoration:none;border-radius:6px;padding:9px 16px;">Open the permit board</a>
<div style="font-size:11px;line-height:1.5;color:${SLATE};padding-top:12px;">${esc(foot.note)}</div>
</td></tr></table></td></tr></table></body></html>`;
}
const lineHtml = (text, color, badge) => `<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${NAVY};padding:1px 0;"><span style="color:${color};font-weight:700;">●</span> ${esc(text)}${badge ? ` <span style="display:inline-block;background:${badge.color};color:${WHITE};font-size:11px;font-weight:700;border-radius:3px;padding:0 6px;">${esc(badge.text)}</span>` : ''}</div>`;
const openHtml = o => lineHtml(`${o.step} — ${o.assignedTo || 'no reviewer assigned'}${o.cityDue ? ` · City due ${nice(o.cityDue)}` : ''}${!o.holds && o.status ? ` · with us: ${o.status}` : ''}`,
  o.holds ? SLATE : AMBER, o.holds && BADGE(o.days) ? { color: BADGE(o.days), text: dueText(o.days) } : null);

// One City record inside its project: what it is, where it stands, its open steps (digest only) and what moved.
function recordPart(r, withSteps){
  const color = STAND[r.bucket][1];
  const name = r.title || r.type || 'City record';
  const sub = `${r.ref}${r.type && r.title ? ` · ${r.type}` : ''} · Accela: ${r.status || 'no status'}`;
  const text = [`  ${name}`, `  ${sub} · ${r.url}`, `    ${standLine(r)}`];
  let body = lineHtml(standLine(r), color);
  if(withSteps && (r.bucket === 'city' || r.bucket === 'ours')){
    if(r.open.length){ body += r.open.map(openHtml).join(''); text.push(...r.open.map(o => `    - ${stepLine(o)}`)); }
    else if(r.bucket === 'city'){ body += lineHtml('No step open with a reviewer right now', SLATE); text.push('    - No step open with a reviewer right now'); }
  }
  if(r.moves.length){
    body += `<div style="font-family:${FONT};font-size:11px;line-height:1.4;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${NAVY};padding:6px 0 1px;">Moved since the last check</div>`
         + r.moves.map(m => lineHtml(m.text, TONE[m.tone])).join('');
    text.push('    Moved since the last check:', ...r.moves.map(m => `    - ${m.text}`));
  }
  const html = `<div style="padding:10px 0 4px;font-family:${FONT};">
<div style="font-size:13px;line-height:1.4;font-weight:700;color:${NAVY};">${esc(name)}</div>
<div style="font-size:12px;line-height:1.5;color:${NAVY};padding:1px 0 3px;"><a href="${esc(r.url)}" style="color:${NAVY};font-weight:700;">${esc(r.ref)}</a>${esc(sub.slice(r.ref.length))}</div>${body}</div>`;
  return { text, html };
}
// A project's section: its address and place, then its records (all of them, or only the ones that moved).
function projectPart(g, withSteps, recs){
  const [stand, color] = projectStand(g);
  const text = [`${g.addr} — ${stand}`];
  let inner = '';
  recs.forEach(r => { const p = recordPart(r, withSteps); text.push(...p.text); inner += p.html; });
  if(!g.recs.length && !g.unread.length){
    const t = 'No City record on the board yet — once the email listener adds its number, Accela takes over its status.';
    text.push(`  ${t}`); inner += `<div style="padding:8px 0 2px;">${lineHtml(t, SLATE)}</div>`;
  }
  if(g.unread.length){ g.unread.forEach(u => text.push(`  ! ${unreadText(u)}`)); inner += `<div style="padding:8px 0 2px;">${g.unread.map(u => lineHtml(unreadText(u), AMBER)).join('')}</div>`; }
  const html = `<tr><td style="padding:18px 0 10px;border-top:2px solid ${CREAM};font-family:${FONT};">
<div style="font-size:16px;line-height:1.35;font-weight:700;color:${NAVY};">${esc(g.addr)} <span style="display:inline-block;vertical-align:2px;background:${color};color:${WHITE};font-size:11px;font-weight:700;letter-spacing:0.02em;border-radius:3px;padding:1px 7px;">${esc(stand)}</span></div>${inner}</td></tr>`;
  return { text, html };
}

export function renderDigest(view, today){
  const R = view.records, groups = byProject(view);
  const city = R.filter(r => r.bucket === 'city').length, ours = R.filter(r => r.bucket === 'ours').length;
  const moved = R.filter(r => r.moves.length), late = R.reduce((n, r) => n + lateSteps(r).length, 0);
  const parts = [plural(groups.length, 'project'), `${city} in City review`];
  if(late) parts.push(`${plural(late, 'step')} late`);
  if(ours) parts.push(`${ours} waiting on us`);
  if(moved.length) parts.push(`${moved.length} moved`);
  const subject = `Permit digest ${DOW[dow(today)]} ${nice(today)}: ${parts.join(' · ')}`;
  const intro = `${TAG} — here's where each project stands with the City in Accela.`;
  const text = [`Permit digest — ${longDay(today)}`, '', intro, ''];
  let html = '';
  groups.forEach(g => { const p = projectPart(g, true, g.recs); text.push(...p.text, ''); html += p.html; });
  const note = 'The digest comes every Monday, Wednesday and Friday. On other days an email comes only when something moves in Accela. Steps, reviewers and due dates are the City\'s own.';
  text.push(`Permit board: ${BOARD}`, '', note);
  return { subject, text: text.join('\n'), html: shell('Permit digest', parts.join(', ').replace(/^./, c => c.toUpperCase()), intro, html, { note }, today,
    moved.length ? moved.map(r => `${short(r.addr)}: ${r.moves[0].text}`).join(' · ') : parts.join(' · ')) };
}

export function renderAlert(view, today){
  const moved = view.records.filter(r => r.moves.length);
  const lateNew = moved.reduce((n, r) => n + r.moves.filter(m => m.tone === 'late').length, 0);
  const groups = byProject(view).filter(g => g.recs.some(r => r.moves.length));
  const what = moved.length === 1 ? `${short(moved[0].addr)} moved` : groups.length === 1 ? `${moved.length} records moved at ${short(groups[0].addr)}` : `${moved.length} records moved`;
  const subject = `Accela ${nice(today)}: ${what}${lateNew ? ` · ${lateNew} now overdue` : ''}`;
  const intro = `${TAG} — here's what moved in Accela since the last check.`;
  const text = [`Accela movement — ${longDay(today)}`, '', intro, ''];
  let html = '';
  groups.forEach(g => { const p = projectPart(g, false, g.recs.filter(r => r.moves.length)); text.push(...p.text, ''); html += p.html; });
  // a record Accela didn't answer for, on a project with nothing else moving, goes in the footer
  const shown = new Set(groups.map(g => g.id));
  const warn = view.unread.filter(u => !shown.has(u.projectId)).map(u => `${short(u.addr)}: ${unreadText(u)}`).join(' ');
  const note = 'Sent when something moves in Accela on a City record on the board. Every project\'s full picture comes in the Monday / Wednesday / Friday digest.';
  text.push(...(warn ? [warn, ''] : []), `Permit board: ${BOARD}`, '', note);
  return { subject, text: text.join('\n'), html: shell('Accela movement', what.replace(/^./, c => c.toUpperCase()), intro, html, { warn, note }, today,
    moved.map(r => `${short(r.addr)}: ${r.moves[0].text}`).join(' · ')) };
}

// RFC 2047 encoded words are capped at 75 chars: split on character boundaries into <= 45-byte chunks.
function encodeWords(s){
  const words = []; let cur = '';
  for(const ch of s){
    if(Buffer.byteLength(cur + ch, 'utf8') > 45){ words.push(cur); cur = ''; }
    cur += ch;
  }
  if(cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

async function gmailSend({ to, subject, text, html }){
  let cfg;
  try{ cfg = JSON.parse(process.env.GMAIL_SEND_TOKEN || ''); }catch(_){ throw new Error('GMAIL_SEND_TOKEN is not set or not JSON'); }
  if(!cfg || !cfg.client_id || !cfg.client_secret || !cfg.refresh_token) throw new Error('GMAIL_SEND_TOKEN is missing client_id / client_secret / refresh_token');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token' }) });
  const tj = await tr.json().catch(() => ({}));
  if(!tr.ok || !tj.access_token) throw new Error('Google token refresh failed: ' + (tj.error_description || tj.error || 'HTTP ' + tr.status));
  const b = 'ttv-' + Date.now().toString(36);
  const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const mime = [
    `From: "Tide & Timber Ventures" <${FROM}>`, `To: ${to}`,
    `Subject: ${encodeWords(subject)}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html),
    `--${b}--`, ''
  ].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }) });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error('Gmail send failed: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
  return j.id;
}

// Same day + same email already sent from this instance → don't send it again (a re-delivered cron event
// usually lands on the warm instance). Per instance only.
let lastSent = null;

// state/records: pass the cron's freshly looked-up copies; otherwise they're read here.
// Returns `seen`: the snapshots to save, and `advance`: true when the cron should save them (the email went
// out, or there was nothing to send). The preview never saves.
export async function runReminders({ state, records, send = false, today, kind } = {}){
  today = today && isDay(today) ? today : etDate(new Date());
  state = state || await loadPermitState();
  if(!records){
    const refs = [...new Set(targets(state).map(t => t.ref))];
    records = refs.length ? await lookupAll(refs, { deadlineMs: 25 * 1000 }) : {};
  }
  const view = board(state, records, today);
  kind = kind === 'digest' || kind === 'alert' ? kind : DIGEST_DAYS.includes(dow(today)) ? 'digest' : 'alert';
  const seen = view.records.filter(r => r.saveSeen).map(r => ({ projectId: r.projectId, milestoneId: r.milestoneId, seen: r.seen }));
  const movedCount = view.records.filter(r => r.moves.length).length;
  const base = { ok: true, today, kind, to: TO, sent: false, firstRun: view.firstRun, moved: movedCount, unread: view.unread,
                 records: view.records.map(({ seen: _s, saveSeen: _v, ...r }) => r), seen, advance: false };
  if(kind === 'alert' && !movedCount) return { ...base, advance: !!send, note: view.firstRun ? 'first run — snapshots taken, nothing to compare yet' : 'nothing moved in Accela' };
  if(!view.records.length && !view.unread.length) return { ...base, note: 'no City records on the board' };
  const mail = kind === 'digest' ? renderDigest(view, today) : renderAlert(view, today);
  const out = { ...base, subject: mail.subject };
  if(!send) return { ...out, text: mail.text, html: mail.html };
  const env = process.env.VERCEL_ENV;
  if(env && env !== 'production'){ out.note = `${env} deployment — only production sends`; return out; }
  const key = `${today}|${kind}|${mail.text.replace(/^.*(Couldn't read|isn't in Accela's public search).*$/gm, '')}`;
  if(lastSent === key){ out.note = 'same email already sent today from this instance'; out.advance = true; return out; }
  try{ out.id = await gmailSend({ to: TO, ...mail }); out.sent = true; out.advance = true; lastSent = key; }
  catch(e){ out.ok = false; out.error = String(e && e.message || e); }
  return out;
}

// Preview only — sending happens solely from the daily cron (api/accela.js), so the public gate hash can't
// be used to email management@.
export default async function handler(req, res){
  const q = req.query || {};
  if((q.k || '') !== GATE_HASH){ res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  try{
    const r = await runReminders({ send: false, today: q.date, kind: q.kind });
    if(q.format === 'html'){
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).end(r.html || `<p style="font-family:sans-serif">No email on ${esc(r.today)} (${esc(r.kind)}) — ${esc(r.note || '')}</p>`);
      return;
    }
    const { html, seen, ...rest } = r;
    res.status(200).json(rest);
  }catch(e){
    res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
}
