// api/permits.js — TTV Permitting Dashboard data proxy  v2
// GET  — serves the permit-state JSON that the TTV Permit Listener (scheduled Claude
//        task) maintains in Google Drive ("ttv-permit-state.json", link-shared).
// POST — v4 team-edit write path: forwards a small patch (setMilestone / addProject /
//        delProject) to the "TTV Permit Feed" Apps Script, which updates the Drive
//        JSON in place. The feed's write token + exec URL live ONLY in Vercel env
//        vars (PERMITS_FEED_TOKEN, PERMITS_FEED_URL) — never in client code or git.
//
// Access: both methods require the same gate hash the page computes (?k= on GET,
// body.k on POST). Deterrent consistent with the page gate, not a hard boundary —
// Mecklenburg permit statuses are public record. Don't put non-public data in the
// permit-state file.
//
// The Drive FILE ID below is deliberately committed — it points at a link-shared
// file holding the same data the board renders, so it is not a secret. If the file
// ever moves, set the PERMITS_FILE_ID env var on Vercel instead of editing code.
export const FILE_ID = process.env.PERMITS_FILE_ID || '1BKJf7_fDSw8nKBogxU2rD6vC5WqrbrPC';
export const GATE_HASH = '9b748ce71c59791771ab14a3de4bb0a2822eac70555d3e292ac7160af8fa1cc6'; // keep in sync with permits.html (api/accela.js imports it)

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');

  if(req.method === 'POST'){
    res.setHeader('Cache-Control','no-store');
    let body = req.body;
    if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(_){ body = null; } }
    if(!body || (body.k || '') !== GATE_HASH){ res.status(401).json({ok:false,error:'unauthorized'}); return; }
    const FEED_URL = process.env.PERMITS_FEED_URL, FEED_TOKEN = process.env.PERMITS_FEED_TOKEN;
    if(!FEED_URL || !FEED_TOKEN){ res.status(501).json({ok:false,error:'write path not configured (set PERMITS_FEED_URL + PERMITS_FEED_TOKEN on Vercel)'}); return; }
    if(!body.patch || typeof body.patch !== 'object'){ res.status(400).json({ok:false,error:'missing patch'}); return; }
    try{
      const r = await fetch(FEED_URL, {
        method:'POST', redirect:'follow',
        headers:{'Content-Type':'text/plain'},
        body: JSON.stringify({ token: FEED_TOKEN, patch: body.patch, editor: String(body.editor || 'team').slice(0,40) })
      });
      const text = await r.text();
      let out; try{ out = JSON.parse(text); }catch(_){ throw new Error('feed returned non-JSON (HTTP '+r.status+')'); }
      res.status(out && out.ok ? 200 : 502).json(out);
    }catch(e){
      res.status(502).json({ok:false,error:String(e && e.message || e)});
    }
    return;
  }

  if((req.query.k || '') !== GATE_HASH){ res.status(401).json({error:'unauthorized'}); return; }
  try{
    const r = await fetch(`https://drive.google.com/uc?export=download&id=${FILE_ID}`, {redirect:'follow'});
    if(!r.ok) throw new Error('drive HTTP '+r.status);
    const text = await r.text();
    let data;
    try{ data = JSON.parse(text); }
    catch(_){ throw new Error('drive returned non-JSON (file sharing changed?)'); }
    if(!data || !Array.isArray(data.projects)) throw new Error('unexpected payload shape');
    // Short edge cache: the board is interactive now (team edits write back), so a
    // long TTL would make a just-saved edit look lost on reload. 30s is enough to
    // absorb team-wide load bursts without hiding fresh writes.
    res.setHeader('Cache-Control','s-maxage=30, stale-while-revalidate=300');
    res.status(200).json(data);
  }catch(e){
    res.setHeader('Cache-Control','no-store');
    res.status(502).json({error:String(e && e.message || e)});
  }
}
