// api/deal-sheet.js — v8.21 "Send to deal sheet"
// The Underwrite opens /api/deal-sheet#uw=<deal>. This answers with a redirect to the team's New Deal web app (the
// Apps Script /exec link in NEW_DEAL_URL, a Vercel env var: like the permits feed, the link lives only on Vercel,
// never in client code or git, since this repo is public). Browsers carry the #fragment across the redirect and
// never send it to a server, so the deal itself doesn't reach this function, Vercel's logs or Google's.
// The web app runs as management@ and makes the locked deal sheet; see AGENTS.md "Deal-sheet hand-off".
const EXEC = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/(exec|dev)$/;

export default function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = String(process.env.NEW_DEAL_URL || '').trim();
  if(!EXEC.test(url)){
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(501).end('<!doctype html><meta charset="utf-8"><title>Deal sheet link not set up</title>'
      + '<p style="font:15px/1.5 Montserrat,Arial,sans-serif;max-width:520px;margin:48px auto;color:#102538">'
      + 'The deal-sheet link isn’t set up on this deployment yet: set <b>NEW_DEAL_URL</b> on Vercel to the New Deal '
      + 'web app’s /exec link (Production and Preview), then redeploy. Your deal is still in the analyzer.</p>');
    return;
  }
  res.setHeader('Location', url);
  res.status(302).end();
}
