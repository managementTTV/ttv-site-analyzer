# TTV Site Analyzer

Internal new-construction underwriting tool for Tide & Timber Ventures (Charlotte / Carolinas).
A single, fully client-side `index.html` — no backend, no database, no build step.

**Live:** deploys automatically on every push to `main` (Vercel, static).

## Deploy (one-time setup)

1. Push this folder to a new GitHub repo (e.g. `ttv-site-analyzer`).
2. In Vercel → **Add New → Project → Import** the repo.
   - Framework Preset: **Other** (it's static; no build command, output dir = root).
3. Done. Every future push to `main` auto-deploys. Push to any other branch to get a
   preview URL before it goes live.

No `vercel.json` is needed — Vercel serves the static files as-is.

### Optional: Street View window (`GOOGLE_MAPS_EMBED_KEY`)

The Street Check card on Site Intelligence links out to Google Street View with no setup. To show Street View on the
analyzer's own Street View page (`streetview.html`, opened from the card; Google's Maps terms don't allow it on the same
screen as the analyzer's parcel drawing), create a Google Maps Platform API key restricted to the **Maps Embed API** only, with an **HTTP referrer**
restriction for `ttv-site-analyzer.vercel.app/*` only, and set it as
`GOOGLE_MAPS_EMBED_KEY` in Vercel (Production + Preview). The Maps Embed API has no usage charge. The key reaches
the browser by design (it's in the embed URL), which is why the restrictions matter; don't commit it.
Preview deployments aren't on the key's referrer list (a `*.vercel.app/*` entry would let any Vercel site use a copied
key), so on a preview the Street View page shows Google's referrer error inside the frame: use its Google Maps link there.

## Claude connector: TTV Street Data (`api/mcp.js`)

A read-only MCP server that lets Claude (claude.ai, on the team's Claude subscription) read the county's street data
for the Street Walk artifact, or in any chat. It has two tools:

- `find_street`: an address or parcel id gives the houses on the lot's own stretch of street, with assessor facts,
  City code-enforcement cases from the last 24 months, and the analyzer's street check.
- `aerial_crops`: up to 6 parcel ids give NC OneMap aerial photo crops, with each parcel's outline.

It serves public Mecklenburg County, City of Charlotte and NC OneMap data only: no Google data, no owner names and no
inspector details. It needs no login, key or env var. The rules are in AGENTS.md ("Street Data connector").

**Add it for the whole organisation** (an org Owner or Admin, once):

1. In claude.ai, open Organization settings → Connectors → Add → Custom → Web.
2. Name it `TTV Street Data` (the Street Walk artifact looks for this name), with the URL
   `https://ttv-site-analyzer.vercel.app/api/mcp`. Leave the OAuth fields empty: it's authless.
3. Save. Each member then turns it on once in claude.ai → Settings → Connectors (and in a chat's tools menu when they
   want it there).

To check it's up:

```
curl -s https://ttv-site-analyzer.vercel.app/api/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A preview deployment serves its branch's copy at `<preview URL>/api/mcp`, for testing before merge. The org connector
always points at production.

## Structure

```
index.html      # the entire app (UI + logic + plan data)
streetview.html # the lot's Street View on its own page (Maps Embed only, no other maps)
api/            # Vercel functions: gis.js, comps.js, street.js (Mecklenburg county data), permits.js,
                #   mcp.js (the TTV Street Data connector for Claude)
plans/          # plan images (one per Slate plan) — see plans/README.md
README.md
```

## Updating

- **The app:** edit `index.html`, push. That's it.
- **Plan library / pricing:** the master `PLANS` array lives near the top of the
  `<script>` block in `index.html`. Each entry is
  `{n, sf, c, u, w, d, t, g}` (name, sq ft, cost, units, footprint width, depth, type, group).
  The plan dropdown, fit-check grid, and comparison tool are all generated from it.
  Current pricing source: Slate "FINAL One Sheet" (Cost + 14% column).
- **Version badge:** the `hdr-badge` in the header (top of `index.html`).

## Plan images (feature #5)

36 plan images live in `/plans` (full brochure page per plan) and are wired into the
tool: a camera button on each fit-check card, a "View plan drawing" button on Step 5,
and "View" in the comparison — all open a lightbox. See `plans/README.md` for the map.
