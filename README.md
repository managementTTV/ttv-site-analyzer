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

### Deal-sheet link (`NEW_DEAL_URL`)

The Underwrite's **Send to deal sheet** button hands the deal to the team's New Deal web app (Google Apps Script, run
as management@), which makes the deal's locked Google Sheet in Underwritten with its inputs filled in. Set
`NEW_DEAL_URL` in Vercel (Production + Preview) to that web app's `/exec` link (Apps Script › Deploy › Manage
deployments). Without it the button opens a "not set up" page. Keep the link out of the repo: it's public. See
AGENTS.md "Deal-sheet hand-off".

## Structure

```
index.html      # the entire app (UI + logic + plan data)
streetview.html # the lot's Street View on its own page (Maps Embed only, no other maps)
api/            # Vercel functions: gis.js, comps.js, street.js (Mecklenburg county data), permits.js, deal-sheet.js
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
