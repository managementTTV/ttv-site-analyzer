// api/permit-reminders.js — daily permit due-date email  v1 (Brian 2026-10-13)
// One email to management@ each morning listing every board step that is NOT done and whose due date is
// tomorrow, today, or already past — so a step is flagged the day before, the day of, and every day after
// until it's approved. Nothing due → no email. For steps carrying a City record, Accela's live view says
// where the review is and who has it (each open review step, its department, the City reviewer assigned and
// the City's own due date for that step) — public on the record page, no login.
//
// Sending: the daily cron in api/accela.js calls runReminders({send:true}) right after its Accela sync, so
// the email uses Accela's fresh statuses. Gmail API as management@ with a send-only token in the Vercel env
// var GMAIL_SEND_TOKEN ({client_id, client_secret, refresh_token} JSON, minted by
// ~/projects/ttv-meetings/meeting_mailer/authorize_permit_mailer.py). Only production sends.
// GET ?k=<gate hash>[&format=html][&date=YYYY-MM-DD] — preview only (never sends): what the email would say
// today, or on another ET date.
import { GATE_HASH, loadPermitState } from './permits.js';
import { lookupAll, cityRef, recordUrl, deriveStatus } from './accela.js';

const FROM = 'management@tidetimberventures.com';
const TO = process.env.REMINDER_TO || FROM;
const BOARD = 'https://ttv-site-analyzer.vercel.app/permits.html';
// Brand (ttv-branding; same values as ttv-meetings/meeting_mailer/email_html.py)
const NAVY = '#102538', SLATE = '#5E8095', PINE = '#648370', CREAM = '#F5F0E7', WHITE = '#FFFFFF', AMBER = '#C98A1B', RED = '#B23A3A';
const FONT = "Montserrat,'Helvetica Neue',Helvetica,Arial,sans-serif";

// Step titles — a mirror of permits.html CATALOG (id → t). Steps not listed here (legacy ids old payloads
// still carry) are not on the board, so they never trigger a reminder. Keep in sync when the catalog changes.
const TITLES = {
  'route': 'Path & scope set on this board', 'survey': 'Boundary survey — trees marked',
  'water-cap': 'Charlotte Water flow test / capacity', 'driveway': 'Driveway: CDOT vs NCDOT',
  'ncdot': 'NCDOT driveway / encroachment permit', 'uw': 'Costs loaded into underwrite',
  'neshap': 'Asbestos survey + NESHAP 10-day notice', 'hist': 'Historic review / COA (if applicable)',
  'disc': 'Utility disconnects', 'demo-permit': 'Demolition permit', 'demo-done': 'Demolition complete',
  'dev-ldirl': 'LDIRL — zoning · stormwater · forestry · trees', 'erosion': 'Erosion & Sediment Control permit',
  'subplat-prep': 'Subdivision plat prepared', 'subplat-app': 'Subdivision plat — City approval',
  'subplat-rec': 'Subdivision plat RECORDED — new lots exist', 'plat-prep': 'Sublot plat prepared',
  'plat-app': 'Sublot plat — City approval', 'plat-rec': 'Sublot plat RECORDED — per-unit PIDs',
  'address': 'Address Assignment Request', 'plans': 'Stamped plans ready',
  'bp-sub': 'Building permits submitted — per unit', 'bp-iss': 'Building permits ISSUED',
  'stake': 'Stakeout & foundation survey', 'trades': 'Trade permits pulled', 'taps': 'Water / sewer taps & meters',
  'insp': 'Construction inspections', 'tree-prot': 'Tree protection (TTV-owned)', 'final-insp': 'Final inspections passed',
  'co': 'Certificate of Occupancy', 'closeout': 'Warranty / close-out package'
};
const STATUS = { todo: 'Not started', active: 'In progress', submitted: 'Submitted / in review', blocked: 'Blocked', done: 'Approved / complete' };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// "Today" is Charlotte's date, not the server's (UTC).
export const etDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nice = s => { if(!s || !ISO.test(s)) return s || ''; const [y, m, d] = s.split('-').map(Number); return `${MON[m - 1]} ${d}`; };
const longDay = s => { const [y, m, d] = s.split('-').map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MON[m - 1]} ${d}, ${y}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = n => n === 1 ? 'Due tomorrow' : n === 0 ? 'Due today' : `${-n} day${n === -1 ? '' : 's'} overdue`;

// Every board step not done whose due date is tomorrow or earlier (ET), most overdue first.
export function dueItems(state, today){
  const out = [];
  for(const p of (state && state.projects) || []){
    for(const [mid, c] of Object.entries(p.state || {})){
      if(!TITLES[mid] || !c || c.status === 'done' || !ISO.test(c.due || '')) continue;
      const days = dayNum(c.due) - dayNum(today);
      if(days > 1) continue;
      out.push({ projectId: p.id, addr: p.addr, milestoneId: mid, title: TITLES[mid], status: c.status, owner: c.owner || null,
                 vendor: c.vendor || null, due: c.due, days, ref: cityRef(c.ref) || (c.accela && c.accela.rec) || null, refText: c.ref || null });
    }
  }
  return out.sort((a, b) => a.days - b.days || String(a.addr).localeCompare(b.addr));
}

// Accela's live view for each item with a City record: where it is and who has it.
function accelaView(rec){
  if(!rec || !rec.ok) return rec ? { error: rec.error || 'Accela lookup failed' } : null;
  const d = deriveStatus(rec);
  const open = (rec.tasks || []).filter(t => t.state === 'active').map(t => ({
    step: t.name, status: (t.current && t.current.status) || (t.latest && t.latest.status) || null,
    assignedTo: t.current && t.current.assignedTo, cityDue: t.current && t.current.cityDue }));
  // why only when it adds to the status ("Plan review approved 9/21…", "Fees due…"), not "Accela: Approved" again
  const why = d.why && !(rec.status && d.why.endsWith(rec.status)) ? d.why : null;
  return { ref: rec.ref, url: recordUrl(rec.ref), status: rec.status, type: rec.type, board: d.board, why, open };
}

export function render(items, today){
  const groups = [['overdue', items.filter(i => i.days < 0)], ['today', items.filter(i => i.days === 0)], ['tomorrow', items.filter(i => i.days === 1)]];
  const parts = [];
  if(groups[0][1].length) parts.push(`${groups[0][1].length} overdue`);
  if(groups[1][1].length) parts.push(`${groups[1][1].length} due today`);
  if(groups[2][1].length) parts.push(`${groups[2][1].length} due tomorrow`);
  const subject = `Permits: ${parts.join(' · ')}`;
  const color = n => n < 0 ? RED : n === 0 ? AMBER : SLATE;
  const head = { overdue: 'Overdue — not approved yet', today: 'Due today', tomorrow: 'Due tomorrow' };

  const accelaLines = i => {
    const a = i.accela; if(!a) return [];
    if(a.error) return [`Accela ${i.ref}: couldn't read the record just now (${a.error}).`];
    const out = [`Accela ${a.ref}${a.type ? ` (${a.type})` : ''}: ${a.status || 'no status'}${a.why ? ` — ${a.why}` : ''}`];
    if(a.open.length) a.open.forEach(o => out.push(`  Now with ${o.step}${o.status ? ` (${o.status})` : ''}${o.assignedTo ? ` — ${o.assignedTo}` : ''}${o.cityDue ? `, City due ${nice(o.cityDue)}` : ''}`));
    else if(a.board === 'active') out.push('  Waiting on us — nothing is with the City right now.');
    if(/-rec$/.test(i.milestoneId)) out.push('  Recording happens at the Register of Deeds; Accela only shows the plat\'s City approval.');
    return out;
  };

  // plain text
  const text = [`Permit due dates — ${longDay(today)}`, ''];
  groups.forEach(([k, list]) => {
    if(!list.length) return;
    text.push(head[k].toUpperCase());
    list.forEach(i => {
      text.push(`• ${i.addr} — ${i.title}`);
      text.push(`  ${when(i.days)} (due ${nice(i.due)}) · Board: ${STATUS[i.status] || i.status}${i.owner ? ` · Owner: ${i.owner}` : ''}${i.refText && !i.ref ? ` · Ref: ${i.refText}` : ''}`);
      accelaLines(i).forEach(l => text.push('  ' + l));
      text.push('');
    });
  });
  text.push(`Permit board: ${BOARD}`, '', 'Sent each morning while a step is due tomorrow, due today, or overdue and not approved. Change a due date on the board to move it.');

  // HTML (tables + inline styles for mail clients)
  const card = i => {
    const a = i.accela;
    let acc = '';
    if(a && a.error) acc = `<div style="padding-top:8px;font-size:12px;color:${SLATE};">Accela ${esc(i.ref)}: couldn't read the record just now.</div>`;
    else if(a){
      const rows = a.open.map(o => `<tr><td style="padding:2px 0;font-family:${FONT};font-size:12px;line-height:1.45;color:${NAVY};"><b>${esc(o.step)}</b>${o.status ? ` · ${esc(o.status)}` : ''}${o.assignedTo ? ` — ${esc(o.assignedTo)}` : ''}${o.cityDue ? ` <span style="color:${SLATE};">· City due ${esc(nice(o.cityDue))}</span>` : ''}</td></tr>`).join('');
      acc = `<div style="margin-top:10px;padding:9px 12px;background:${CREAM};border-radius:6px;">
<div style="font-family:${FONT};font-size:12px;line-height:1.45;color:${NAVY};"><a href="${esc(a.url)}" style="color:${NAVY};font-weight:700;">${esc(a.ref)}</a>${a.type ? ` · ${esc(a.type)}` : ''} · Accela: <b>${esc(a.status || 'no status')}</b>${a.why ? ` — ${esc(a.why)}` : ''}</div>
${rows ? `<div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${SLATE};padding-top:7px;">Now with</div><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>`
        : a.board === 'active' ? `<div style="font-family:${FONT};font-size:12px;color:${NAVY};padding-top:5px;">Waiting on us — nothing is with the City right now.</div>` : ''}
${/-rec$/.test(i.milestoneId) ? `<div style="font-family:${FONT};font-size:11px;color:${SLATE};padding-top:5px;">Recording happens at the Register of Deeds; Accela only shows the plat's City approval.</div>` : ''}
</div>`;
    }
    return `<tr><td style="padding:14px 0;border-top:1px solid ${CREAM};font-family:${FONT};">
<div style="font-size:15px;line-height:1.35;font-weight:700;color:${NAVY};">${esc(i.addr)} — ${esc(i.title)}</div>
<div style="font-size:12px;line-height:1.5;color:${NAVY};padding-top:4px;"><span style="display:inline-block;background:${color(i.days)};color:${WHITE};font-weight:700;border-radius:3px;padding:1px 6px;">${esc(when(i.days))}</span>
&nbsp;due ${esc(nice(i.due))} · Board: ${esc(STATUS[i.status] || i.status)}${i.owner ? ` · Owner: ${esc(i.owner)}` : ''}${i.refText && !i.ref ? ` · Ref: ${esc(i.refText)}` : ''}</div>
${acc}</td></tr>`;
  };
  const sections = groups.filter(([, l]) => l.length).map(([k, list]) =>
    `<tr><td style="padding:18px 0 4px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${color(list[0].days)};">${esc(head[k])}</td></tr>${list.map(card).join('')}`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM};font-size:1px;line-height:1px;">${esc(items.map(i => `${i.addr.split(' (')[0]}: ${when(i.days).toLowerCase()}`).join(' · '))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background:${CREAM};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">
<tr><td bgcolor="${WHITE}" style="background:${WHITE};border-top:3px solid ${NAVY};padding:24px 28px 8px;font-family:${FONT};">
<div style="font-size:11px;line-height:1.4;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${SLATE};">Tide &amp; Timber Ventures · Permit due dates · ${esc(longDay(today))}</div>
<div style="font-size:22px;line-height:1.25;font-weight:700;color:${NAVY};padding-top:8px;">${esc(parts.join(', ').replace(/^./, c => c.toUpperCase()))}</div>
</td></tr>
<tr><td bgcolor="${WHITE}" style="background:${WHITE};padding:0 28px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sections}</table></td></tr>
<tr><td bgcolor="${WHITE}" style="background:${WHITE};padding:14px 28px 24px;font-family:${FONT};">
<a href="${BOARD}" style="display:inline-block;background:${NAVY};color:${CREAM};font-weight:700;font-size:13px;text-decoration:none;border-radius:6px;padding:9px 16px;">Open the permit board</a>
<div style="font-size:11px;line-height:1.5;color:${SLATE};padding-top:12px;">Sent each morning while a step is due tomorrow, due today, or overdue and not approved. Change a due date on the board to move it. City review steps and reviewers come from the City's Accela record.</div>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text: text.join('\n'), html };
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
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
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

// state/records: pass the cron's freshly synced copies; otherwise they're read here.
export async function runReminders({ state, records, send = false, today } = {}){
  today = today && ISO.test(today) ? today : etDate(new Date());
  state = state || await loadPermitState();
  const items = dueItems(state, today);
  if(!items.length) return { ok: true, today, count: 0, sent: false, note: 'nothing due tomorrow, today or overdue' };
  const refs = [...new Set(items.map(i => i.ref).filter(Boolean))];
  const looked = refs.length ? await lookupAll(refs.filter(r => !(records && records[r] && records[r].ok))) : {};
  const recs = { ...(records || {}), ...looked };
  items.forEach(i => { i.accela = i.ref ? accelaView(recs[i.ref]) : null; });
  const mail = render(items, today);
  const out = { ok: true, today, count: items.length, subject: mail.subject, to: TO, sent: false, items };
  if(!send) return { ...out, text: mail.text, html: mail.html };
  const env = process.env.VERCEL_ENV;
  if(env && env !== 'production'){ out.note = `${env} deployment — only production sends`; return out; }
  try{ out.id = await gmailSend({ to: TO, ...mail }); out.sent = true; }
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
    const r = await runReminders({ send: false, today: q.date });
    if(q.format === 'html'){
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).end(r.html || `<p style="font-family:sans-serif">No email on ${esc(r.today)} — ${esc(r.note || '')}</p>`);
      return;
    }
    const { html, ...rest } = r;
    res.status(200).json(rest);
  }catch(e){
    res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
}
