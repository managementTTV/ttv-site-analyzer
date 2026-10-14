// api/permit-reminders.js — daily Accela review-step alert  v2 (Brian 2026-10-14)
// One email to management@ each morning listing every City review step that is still open with a City
// reviewer and whose CITY due date (Accela's own "Due on" for that step) is tomorrow, today or already past —
// so the team knows who to ping: the step (department), the reviewer assigned, when it was due and how late.
// The day before, the day of, and every day after until the City marks the step done. Nothing due → no email.
// v1 (2026-10-13) used the board's own due dates; Brian: those aren't the City's, the alert is about the City.
//
// Which steps: every City record on the board (the refs the Accela sync reads), each Processing Status step
// that is active with an open assignment and a City due date. Left out: records whose plan review is already
// approved (what stays open — e.g. the Urban Forestry inspection before the CO — isn't a late review), and
// steps the City has handed back to us (revisions requested, fees due, plans awaited: our move, not theirs).
// Records Accela didn't answer this run are named in the email.
//
// Sending: the daily cron in api/accela.js calls runReminders({send:true}) right after its Accela look-up and
// before the writes. Gmail API as management@ with a send-only token in the Vercel env var GMAIL_SEND_TOKEN
// ({client_id, client_secret, refresh_token} JSON, minted by
// ~/projects/ttv-meetings/meeting_mailer/authorize_permit_mailer.py). Only production sends.
// GET ?k=<gate hash>[&format=html][&date=YYYY-MM-DD] — preview only (never sends): what the email would say
// today, or on another ET date.
import { GATE_HASH, loadPermitState } from './permits.js';
import { lookupAll, recordUrl, deriveStatus, targets, cityHolds } from './accela.js';

const FROM = 'management@tidetimberventures.com';
const TO = process.env.REMINDER_TO || FROM;
const BOARD = 'https://ttv-site-analyzer.vercel.app/permits.html';
// Brand (ttv-branding; same values as ttv-meetings/meeting_mailer/email_html.py)
const NAVY = '#102538', SLATE = '#5E8095', CREAM = '#F5F0E7', WHITE = '#FFFFFF', AMBER = '#C98A1B', RED = '#B23A3A';
const FONT = "Montserrat,'Helvetica Neue',Helvetica,Arial,sans-serif";

// Board step titles for context ("Sublot plat — City approval") — a mirror of permits.html CATALOG (id → t)
// for the steps a City record can sit on.
const TITLES = {
  'dev-ldirl': 'LDIRL — zoning · stormwater · forestry · trees', 'erosion': 'Erosion & Sediment Control permit',
  'subplat-app': 'Subdivision plat — City approval', 'subplat-rec': 'Subdivision plat RECORDED — new lots exist',
  'plat-app': 'Sublot plat — City approval', 'plat-rec': 'Sublot plat RECORDED — per-unit PIDs',
  'hist': 'Historic review / COA (if applicable)'
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// a real calendar day (2026-02-30 is not)
const isDay = s => { if(!ISO.test(s || '')) return false; const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
// "Today" is Charlotte's date, not the server's (UTC).
export const etDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nice = s => { if(!s || !ISO.test(s)) return s || ''; const [, m, d] = s.split('-').map(Number); return `${MON[m - 1]} ${d}`; };
const longDay = s => { const [y, m, d] = s.split('-').map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MON[m - 1]} ${d}, ${y}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = n => n === 1 ? 'due tomorrow' : n === 0 ? 'due today' : `${-n} day${n === -1 ? '' : 's'} overdue`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Every open City review step due tomorrow, today or earlier (ET), most overdue first; plus the records
// Accela didn't answer.
export function lateSteps(state, records, today){
  const steps = [], unread = [], seen = new Set();
  for(const t of targets(state)){
    if(seen.has(t.ref)) continue;
    seen.add(t.ref);
    const rec = records[t.ref];
    if(!rec || !rec.ok){ unread.push({ ref: t.ref, addr: t.addr, error: rec ? rec.error : 'not looked up' }); continue; }
    const board = deriveStatus(rec).board;
    if(board === 'done' || board === 'blocked') continue;     // approved, or denied / withdrawn: nothing to chase
    for(const k of rec.tasks || []){
      const c = k.current;
      if(!cityHolds(k) || !isDay(c.cityDue)) continue;
      const days = dayNum(c.cityDue) - dayNum(today);
      if(days > 1) continue;
      steps.push({ ref: rec.ref, url: recordUrl(rec.ref), type: rec.type, recordStatus: rec.status, addr: t.addr,
                   milestoneId: t.milestoneId, title: Object.hasOwn(TITLES, t.milestoneId) ? TITLES[t.milestoneId] : null,
                   step: k.name, assignedTo: c.assignedTo || null, cityDue: c.cityDue, days,
                   stepStatus: c.status || (k.latest && k.latest.status) || null, since: (k.latest && k.latest.date) || null });
    }
  }
  steps.sort((a, b) => a.days - b.days || String(a.addr).localeCompare(b.addr) || a.step.localeCompare(b.step));
  return { steps, unread };
}

export function render(steps, unread, today){
  const over = steps.filter(s => s.days < 0), now = steps.filter(s => s.days === 0), next = steps.filter(s => s.days === 1);
  const parts = [];
  if(over.length) parts.push(`${plural(over.length, 'review step')} overdue`);
  if(now.length) parts.push(`${over.length ? now.length : plural(now.length, 'review step')} due today`);
  if(next.length) parts.push(`${over.length || now.length ? next.length : plural(next.length, 'review step')} due tomorrow`);
  const subject = `Accela ${nice(today)}: ${parts.join(' · ')}`;   // dated, so each day is its own Gmail thread
  const groups = [['The City is late — ping the reviewer', over, RED], ['Due today', now, AMBER], ['Due tomorrow', next, SLATE]];
  // within a group, one block per record
  const byRecord = list => { const m = new Map(); list.forEach(s => { if(!m.has(s.ref)) m.set(s.ref, []); m.get(s.ref).push(s); }); return [...m.values()]; };
  const stepLine = s => `${s.step} — ${s.assignedTo || 'no reviewer assigned'} · City due ${nice(s.cityDue)} (${when(s.days)})${s.stepStatus ? ` · ${s.stepStatus}${s.since ? ' ' + nice(s.since) : ''}` : ''}`;
  const where = u => `${u.ref} (${String(u.addr).split(' (')[0]})`;
  const missing = unread.filter(u => /not found/i.test(u.error || '')), slow = unread.filter(u => !/not found/i.test(u.error || ''));
  const unreadLine = [
    slow.length ? `Couldn't read ${slow.map(where).join(', ')} in Accela this run — checked again tomorrow.` : '',
    missing.length ? `${missing.map(where).join(', ')} isn't in Accela's public search — check the record number on the board.` : ''
  ].filter(Boolean).join(' ');

  const text = [`Accela review steps to chase — ${longDay(today)}`, ''];
  groups.forEach(([head, list]) => {
    if(!list.length) return;
    text.push(head.toUpperCase());
    byRecord(list).forEach(rs => {
      const r = rs[0];
      text.push(`• ${r.addr}${r.title ? ` — ${r.title}` : ''}`, `  ${r.ref}${r.type ? ` (${r.type})` : ''} · Accela: ${r.recordStatus || 'no status'} · ${r.url}`);
      rs.forEach(s => text.push(`  - ${stepLine(s)}`));
      text.push('');
    });
  });
  if(unreadLine) text.push(unreadLine, '');
  text.push(`Permit board: ${BOARD}`, '', 'Sent each morning while a City review step is due tomorrow, due today or overdue. Steps, reviewers and due dates are the City\'s own, from Accela.');

  const block = rs => {
    const r = rs[0];
    const rows = rs.map(s => `<tr><td style="padding:3px 0;font-family:${FONT};font-size:13px;line-height:1.45;color:${NAVY};">
<b>${esc(s.step)}</b> — ${s.assignedTo ? esc(s.assignedTo) : '<i>no reviewer assigned</i>'}
<span style="display:inline-block;background:${s.days < 0 ? RED : s.days === 0 ? AMBER : SLATE};color:${WHITE};font-size:11px;font-weight:700;border-radius:3px;padding:0 6px;margin-left:4px;">${esc(when(s.days))}</span>
<div style="font-size:12px;color:${SLATE};">City due ${esc(nice(s.cityDue))}${s.stepStatus ? ` · ${esc(s.stepStatus)}${s.since ? ' ' + esc(nice(s.since)) : ''}` : ''}</div></td></tr>`).join('');
    return `<tr><td style="padding:14px 0;border-top:1px solid ${CREAM};font-family:${FONT};">
<div style="font-size:15px;line-height:1.35;font-weight:700;color:${NAVY};">${esc(r.addr)}${r.title ? ` — ${esc(r.title)}` : ''}</div>
<div style="font-size:12px;line-height:1.5;color:${NAVY};padding:2px 0 6px;"><a href="${esc(r.url)}" style="color:${NAVY};font-weight:700;">${esc(r.ref)}</a>${r.type ? ` · ${esc(r.type)}` : ''} · Accela: ${esc(r.recordStatus || 'no status')}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
  };
  const sections = groups.filter(([, l]) => l.length).map(([head, list, color]) =>
    `<tr><td style="padding:18px 0 4px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${color};">${esc(head)}</td></tr>${byRecord(list).map(block).join('')}`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM};font-size:1px;line-height:1px;">${esc(steps.map(s => `${s.step} (${s.assignedTo || 'unassigned'}): ${when(s.days)}`).join(' · '))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background:${CREAM};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">
<tr><td bgcolor="${WHITE}" style="background:${WHITE};border-top:3px solid ${NAVY};padding:24px 28px 8px;font-family:${FONT};">
<div style="font-size:11px;line-height:1.4;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${SLATE};">Tide &amp; Timber Ventures · Accela review steps · ${esc(longDay(today))}</div>
<div style="font-size:22px;line-height:1.25;font-weight:700;color:${NAVY};padding-top:8px;">${esc(parts.join(', ').replace(/^./, c => c.toUpperCase()))}</div>
</td></tr>
<tr><td bgcolor="${WHITE}" style="background:${WHITE};padding:0 28px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sections}</table></td></tr>
<tr><td bgcolor="${WHITE}" style="background:${WHITE};padding:14px 28px 24px;font-family:${FONT};">
${unreadLine ? `<div style="font-size:12px;line-height:1.5;color:${AMBER};padding-bottom:12px;">${esc(unreadLine)}</div>` : ''}
<a href="${BOARD}" style="display:inline-block;background:${NAVY};color:${CREAM};font-weight:700;font-size:13px;text-decoration:none;border-radius:6px;padding:9px 16px;">Open the permit board</a>
<div style="font-size:11px;line-height:1.5;color:${SLATE};padding-top:12px;">Sent each morning while a City review step is due tomorrow, due today or overdue. Steps, reviewers and due dates are the City's own, from Accela.</div>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text: text.join('\n'), html };
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

// Same day + same content already sent from this instance → don't send it again (a re-delivered cron event
// usually lands on the warm instance). A changed list the same day still goes out. Per instance only.
let lastSent = null;

// state/records: pass the cron's freshly looked-up copies; otherwise they're read here.
export async function runReminders({ state, records, send = false, today } = {}){
  today = today && isDay(today) ? today : etDate(new Date());
  state = state || await loadPermitState();
  if(!records){
    const refs = [...new Set(targets(state).map(t => t.ref))];
    records = refs.length ? await lookupAll(refs, { deadlineMs: 25 * 1000 }) : {};
  }
  const { steps, unread } = lateSteps(state, records, today);
  const base = { ok: true, today, count: steps.length, unread, to: TO, sent: false, steps };
  if(!steps.length) return { ...base, note: 'no City review step due tomorrow, today or overdue' + (unread.length ? ` (${unread.length} record(s) unread)` : '') };
  const mail = render(steps, unread, today);
  const out = { ...base, subject: mail.subject };
  if(!send) return { ...out, text: mail.text, html: mail.html };
  const env = process.env.VERCEL_ENV;
  if(env && env !== 'production'){ out.note = `${env} deployment — only production sends`; return out; }
  const key = `${today}|${steps.map(s => `${s.ref}/${s.step}/${s.assignedTo}/${s.cityDue}`).join('|')}`;
  if(lastSent === key){ out.note = 'same email already sent today from this instance'; return out; }
  try{ out.id = await gmailSend({ to: TO, ...mail }); out.sent = true; lastSent = key; }
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
