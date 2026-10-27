// api/deal-sheet.js — v8.21 "Send to deal sheet"
// The Underwrite opens /api/deal-sheet#uw=<deal>. This answers with a redirect to the team's New Deal web app (the
// Apps Script /exec link in NEW_DEAL_URL, a Vercel env var: like the permits feed, the link lives only on Vercel,
// never in client code or git, since this repo is public). Browsers carry the #fragment across the redirect without
// sending it in either request, so the deal doesn't reach this function or Vercel's logs; the New Deal page reads it
// in the browser and passes it to its Apps Script. ?from=analyzer survives Google's sign-in redirect even when the
// fragment doesn't, so the page can say the deal didn't come through instead of showing a blank form.
// The web app runs as management@ and makes the locked deal sheet; see AGENTS.md "Deal-sheet hand-off".
// Signed link: the team-only web app fails ("Sorry, unable to open the file") in a browser also signed in to another
// Google account, so NEW_DEAL_URL is a second deployment open to anyone, which takes only a link signed here: t = now
// (unix seconds), n = a random nonce, s = HMAC-SHA256 of "ttv-deal-sheet.<t>.<n>" keyed with DEAL_SHEET_SECRET (a Vercel
// env var, the same value as the script property dealSheetSecret; never in the repo or the page). The script refuses a
// link that's unsigned, older than 10 minutes or already used. Without the secret the link goes out unsigned, which only
// the team-only deployment accepts.
import crypto from 'node:crypto';
const TEAM_EXEC_BASE = 'https://script.google.com/a/macros/tidetimberventures.com/s/';
const EXEC = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/(exec|dev)$/;

export default function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // the team's own address form: with a plain /macros/s/ link Google swaps in the browser's DEFAULT account's domain
  // (/a/macros/wolfdensdwellings.com/...), which can't see the script ("Sorry, unable to open the file")
  const url = String(process.env.NEW_DEAL_URL || '').trim().replace(/^https:\/\/script\.google\.com\/macros\/s\//, TEAM_EXEC_BASE);
  if(!EXEC.test(url)){
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(501).end('<!doctype html><meta charset="utf-8"><title>Deal sheet link not set up</title>'
      + '<p style="font:15px/1.5 Montserrat,Arial,sans-serif;max-width:520px;margin:48px auto;color:#102538">'
      + 'The deal-sheet link isn’t set up on this deployment yet: set <b>NEW_DEAL_URL</b> on Vercel to the New Deal '
      + 'web app’s /exec link (Production and Preview), then redeploy. Your deal is still in the analyzer.</p>');
    return;
  }
  res.setHeader('Location', url + '?from=analyzer' + signedParams(String(process.env.DEAL_SHEET_SECRET || '').trim()));
  res.status(302).end();
}

function signedParams(secret){
  if(secret.length<32){   // unset (or too short to trust): unsigned, which only the team-only deployment accepts
    if(secret)console.warn('DEAL_SHEET_SECRET is set but shorter than 32 characters, so deal-sheet links go out unsigned');
    return '';
  }
  const t=String(Math.floor(Date.now()/1000)), n=crypto.randomBytes(18).toString('base64url');
  const s=crypto.createHmac('sha256',secret).update('ttv-deal-sheet.'+t+'.'+n,'utf8').digest('base64url');
  return '&t='+t+'&n='+n+'&s='+s;
}
