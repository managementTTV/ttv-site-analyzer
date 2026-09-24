# AGENTS.md — TTV Site Analyzer

Shared rulebook for the two agents that touch this repo:
- **Claude (Cowork)** — *author.* Implements changes, tests headless, opens the PR.
- **Codex** — *reviewer.* Reviews every PR against the guidelines below, flags P0/P1.
- **Brian** — *merge gate.* Reads Codex's findings + Claude's responses, then merges.

Both agents read this file. Claude follows it while writing; Codex enforces it while
reviewing. It is the single source of truth for "what good looks like" here — keep it
in the repo, version it with the code.

---

## Repo context (read before reviewing)

- **What it is:** an internal new-construction underwriting tool for Tide & Timber's
  Charlotte/Carolinas deals. Since v8.0, two screens: **Site Intelligence** (address → zoning →
  lot → buildable area & plan fit; geometry only, no money) and **The Underwrite** (hero numbers,
  live levers and the worst/base/best board first, then collapsible Plan & build / Lot factor /
  Financing / Sales comps inputs; money only, no geometry), plus PDF/Excel/offer-letter exports.
- **UI vs. math (v8.0).** The two-screen layout is presentation only. Sections keep their old
  `page-1`…`page-7` ids (comps are `page-8`) and every input keeps its id, so `goTo(n)` and all
  calculators still address them by step number. Flag any v8 UI change that edits a calculation
  function, renames an input id, or moves an input outside `.page` (serialize/restore and
  `markAllManual()` select `.page input[id]`). Hero tiles and section summaries are display-only,
  filled from `getReportData()` in `updateHero()`.
- **Architecture:** a **single, fully client-side `index.html`** (UI + all logic + all
  plan data, ~4,900 lines) + three serverless functions in `api/`: `gis.js` (Charlotte/Meck
  GIS + county assessor proxy), `comps.js` (county new-build comps) and `permits.js` (the
  permitting board's data proxy) + `plans/` images + `assets/` logos. No framework, no build
  step, no database. Everything runs in the browser.
- **Deploy model — why review matters:** Vercel serves the static files; **every push to
  `main` auto-deploys to production.** There is no build gate and no test suite catching
  regressions. The PR review *is* the safety net. Non-`main` branches get a Vercel
  **preview URL** — use it to eyeball the change live before merge.

---

## Review guidelines

Flag anything that violates these. They encode invariants a generic reviewer will miss.

### Pricing & scaling (highest-risk — these move real dollars)
- **`base` is the source of truth for cost; `c` is derived.** At load,
  `recomputePlanCosts()` sets `p.c = round(p.base × (1 + GC_fee%))` (default fee 14%),
  overwriting whatever literal `c:` each `PLANS` entry already carries — so the per-entry
  `c:` is a stale placeholder, not authoritative. Flag: reading or treating `c` as the
  source of truth, hand-editing `c` to change pricing (edit `base` instead), or any
  new/edited entry that bypasses `recomputePlanCosts()`. Do **not** flag the mere
  presence of a `c:` value — that's the normal data shape.
- **Footprint convention:** Slate publishes footprints as **(D′ × W′)**; `PLANS` store
  them **corrected** to `w=W, d=D`. Flag any new/edited plan whose width/depth looks
  transposed — a swap silently breaks every fit-check and BUA calc.
- **Upgrades are NOT marked up.** The GC fee applies to the Slate base build only; upgrades are
  added at their flat menu price (Brian, 2026-09-22). Flag any path that applies the fee to upgrades.
- **Scaling rule.** Per-**unit** costs scale ×N: build, upgrades, water tap, sewer tap.
  Per-**lot** costs stay singular ×1: lot factor, septic, survey, appraisal, insurance.
  Flag anything miscategorized (e.g. a per-lot cost multiplied by units).
- **Per-unit special cases stay intact:** Arcadia Triplex priced per unit
  ($416,608 ÷ 3) with the footprint kept as the whole 3-unit building; duets priced per
  side (`u:2`); townhomes per single unit (`u:1`). Flag changes that re-triple-count.

### Financing math (subtle — easy to "simplify" wrongly)
- **Preserve the circular loan solve.** `loan = LTC% × costBase / (1 − LTC%×0.01)`
  because purchase closing (1% of the loan) is itself inside the loan base. Flag any
  naive `loan = LTC% × costBase` that drops the closed-form term.
- **Max-supportable-land back-solve** targets the Deal Analyst **PROFIT RULE** (v7.12,
  2026-09-22): base profit/unit must clear the **greater of $50,000 or 15% of all-in per unit**.
  It solves both rules and takes the lower land ceiling. Don't change either constant silently;
  if they change, it's a deliberate, called-out change.

### Architecture & footguns
- **Stay single-file & buildless.** Flag any added framework, bundler, npm build step, or
  new runtime dependency. Export libs (`jsPDF`, `ExcelJS`) are **CDN, lazy-loaded only on
  export** — keep them that way.
- **Browser storage is limited to the two existing `localStorage` keys** — no others:
  `ttv-analyzer-last-seen-version` (release-notes gate) and `ttv-analyzer-autosave`
  (the v7.4 autosave/resume flow: `scheduleAutosave`, `resumeAutosave`,
  `checkResumeBanner`; writes degrade quietly when storage is unavailable). Flag any
  *new* storage key or any `sessionStorage` use, but do **not** flag routine maintenance
  of those two existing keys.
- **Don't hand-maintain derived data.** `p.val`, `PLAN_KEY_MAP`, `PLANS_FP` and all
  dropdowns are generated from the `const`s (`PLANS`, `SETBACKS`, `COUNTY_ZONES`…). Flag
  edits that set derived values by hand instead of regenerating them.
- **No secrets committed.** No tokens, keys, or private URLs in `index.html` or
  `api/gis.js`. The ArcGIS org URL is resolved at runtime from an item id
  (`cf66446f...`) on purpose — keep it that way; don't hard-code it.

### GIS proxy (`api/gis.js`)
- **County enrichment (v5, 2026-09-22) is a non-fatal fan-out.** After the parcel is resolved, the
  proxy queries Mecklenburg County's own public servers (`meckgis` CAMA / building footprints /
  tree canopy, `meckaerial` LiDAR DEM) through `Promise.allSettled`, so one layer being down costs
  one field, not the lookup. Flag a change that makes any of these awaited serially or fatal.
- **`aj()` throws on an ArcGIS error body.** ArcGIS answers a bad field or `where` with HTTP 200 and
  an `{error:{...}}` payload; treating that as "no features" silently blanked the whole CAMA block
  once already. Keep the error check in `aj()` and `ajPost()`.
- **Sale-validity semantics:** blank = arm's length and **Z = builder sale** (the new-build resales
  TTV comps against) are the two market codes; everything else is a disqualified transfer. Flag a
  comp filter that drops Z or keeps the rest.
- Auto-fill is **Mecklenburg-only** by design. Other counties link out to the county
  viewer — don't "fix" that into a broken universal fetch.
- Parcel area uses the **shoelace** of the geometry, **not** the bounding box. Flag a
  regression to bounding-box area.

### Permitting board (`/permits.html` + `api/permits.js`)
- **`/permits.html` is a blessed second static surface** — the team permitting status
  board. It is deliberately OUTSIDE the single-file calculator: its data refreshes daily
  from Drive, and folding that churn into `index.html` would put automated changes inside
  the underwriting file. The single-file rule above still governs the calculator itself —
  flag calculator logic moving into `permits.html`, or permitting logic into `index.html`.
- **Data path (read):** the TTV Permit Listener (scheduled Claude task) maintains
  `ttv-permit-state.json` in Google Drive; `api/permits.js` GET proxies it (server-side
  fetch, 30-second edge cache, `?k=<gate hash>` check); the page paints its baked-in
  `seed()` snapshot instantly, then swaps to the live payload — and falls back to the
  snapshot with a visible "offline" banner when the API is unreachable. **The listener
  never commits to git** — daily status updates happen in Drive only. Flag any change
  that reintroduces data-update-by-commit.
- **Data path (write, v4):** team edits (milestone changes, add/delete project) POST a
  patch to `api/permits.js`, which forwards it to the "TTV Permit Feed" Apps Script
  using `PERMITS_FEED_URL` + `PERMITS_FEED_TOKEN` from **Vercel env vars only**. Flag
  ANY appearance of the feed token or exec URL in client code, HTML, or this repo —
  the token is a real write credential, unlike the committed FILE_ID. The client-side
  auth on POST is the same gate hash as GET (deterrent-grade, accepted risk). Every
  edit carries an editor name; the Listener reconciles manual edits into the system of
  record each morning.
- **Flow engine (v4):** project shape = two setup booleans `flags.subdiv` × `flags.sublot`
  (plus demo/trees/state/acre). `migrateFlags()` maps legacy `path`/`parentSub` payloads;
  `fixState()` backfills state entries for catalog ids old payloads lack. Flag changes
  that compute layout from completion state instead of flags+catalog (layout must be
  identical for every project with the same flags), and flag removal of the legacy
  migration while old payloads can still exist in Drive.
- **Storage rule:** `permits.html` uses NO browser storage — its `ttv-permit-auth`
  `sessionStorage` key went away with the passcode gate on 2026-09-17. That key now lives
  only in `capital-raise.html` (still gated) and is the one allowed browser-storage key
  outside the calculator's two `localStorage` keys. The editor-name for the edit log is
  held in a plain in-memory variable on purpose. Flag any storage key added to the
  permitting board and additions beyond these three keys.
- **Access model (accepted risk):** the board has no login — the browser passcode gate
  was removed 2026-09-17 at Brian's direction so the team can open it from the hub
  directly. `capital-raise.html` keeps its passcode gate (investor commitments are not
  public). The `?k=` check in `api/permits.js` (GET and POST) still uses `GATE_HASH`
  and is a deterrent, not a security boundary — Mecklenburg permit statuses are public
  record. Flag any non-public data (pricing, contracts, PII) appearing in the
  permit-state file or board, and flag any change that re-adds a client-side gate
  without a decision recorded here.
- The Drive FILE ID in `api/permits.js` is intentionally committed (link-shared file
  holding the same data the board renders — not a secret). `PERMITS_FILE_ID` env var
  overrides it; don't flag the literal.

### Comps (`api/comps.js`, v7.14)
- **Mecklenburg-only**, same rule as the GIS proxy. It joins `TaxParcelSales` to
  `TaxParcel_camadata` on PID because the sales layer carries no building attributes at all.
- **Sale-validity filter is the heart of it.** Keep blank (arm's length) and **Z (builder sale)**;
  everything else is a disqualified transfer. Flag a change that widens this without a reason, or
  that drops Z — builder sales are the new-build resales TTV is actually pricing.
- **The ARV is capped at the highest sold comp.** The SOP is explicit that $/sf math must never run
  past a real nearby sale. Flag removal of the cap or of the `capped` flag it sets.
- **Comps are clipped to the true `radius`.** The ArcGIS query takes a rectangle, so the envelope's
  corners reach `radius × √2`; rows are filtered on the computed great-circle distance before any
  tier is built, and the count dropped is reported in `notes`. Flag a change that drops the filter
  and lets a 0.7 mi sale drive an ARV labelled "within 0.5 mi".
- **Comp selection is a CASCADE, neighbourhood first (v7.16).** In order: same assessor
  neighbourhood + size band → same neighbourhood → size band (`SIZE_BAND`, ±20%) → widened band
  (`SIZE_BAND_WIDE`) → the whole pocket. Each tier needs `MIN_IN_BAND` comps to fire. This is
  evidence-based, from the 2026-09-22 backtest: flat median 10.3% median miss, size-matched 7.7%,
  this cascade 6.3%. The neighbourhood code is the county's own market-area boundary and is the
  single strongest signal (~4.6% on its own tier). Same-STREET matching was tested and was NOT
  better, so it is deliberately absent — don't add it back without new evidence.
- Flag a change that medians the whole pool when a neighbourhood or subject size is known.
- **The `confidence` gate is the headline, not decoration.** `high` = a neighbourhood-based tier,
  OR a size tier with `CONF_MIN_COMPS` (10) in-band comps and spread <= `CONF_MAX_SPREAD` (1.4×).
  Backtested: high covers ~75% of deals at 5.0% median miss; low is ~9% of deals at 20.3%. The
  badge is what tells the analyst whether to apply the number or pick comps by hand, so keep the
  levels tied to measured tiers. Do not loosen these constants without re-running the backtest
  (method and data in `research/05_comps-backtest.md`).
- **Two tiers, both reported:** built `minYear`+ (default 2020) for context, `solidYear`+ (default
  2025) as solid comps. **Selection runs over the full new-build pool; recency is reported, not
  enforced** (`summary.matching.solid_in_set` / `solid_share`, plus a flag when none of the
  chosen comps are solid). This rule changed on 2026-09-22 after it was measured: a Codex P1 on
  PR #18 correctly spotted that the code no longer matched the old "prefer solid" wording, but
  running the ladder over solid-only first backtests at **25.4% within 5% / 10.0% median error**
  versus **44.8% / 6.3%** for the full pool, and loses 37-17 head to head on the deals where the
  two differ. Restricting to 2025+ starves the neighbourhood tier. A same-pocket 2023 sale beats
  a half-mile-away 2025 one. Don't reinstate a hard recency preference without new evidence.
- **`xcoord` holds latitude and `ycoord` holds longitude** in the CAMA layer. The field names are
  backwards in the source data; don't 'fix' the distance maths.
- Comps land in the same `COMPS` model the manual table uses, so the blended $/sf, the PDF and the
  Excel export keep working unchanged. Flag a parallel comps model.

### Lot-factor auto-fill (v7.13)
- **A cached GIS result must not outlive its address.** `window._lastGis` carries the PID the comps
  pull keys off. `onAddrChange()` drops the cache as soon as the typed address stops matching
  `_lastGis.addrSig`, and `pullCountyComps()` re-checks before using the PID. Without this an
  analyst who edits the address after a lookup silently prices the previous parcel. Flag any new
  consumer of `_lastGis` that doesn't verify the signature.
- **Never infer "untouched" from a field's value.** An analyst can legitimately type a number that
  equals a shipped default (a real $2,000 survey quote, a real $2,500 grading allowance), and the
  value-based check silently overwrote it — a Codex P1 on PR #17. Auto-fill gates on the explicit
  `data-manual` flag instead: `markManual()` sets it on any human edit, `restoreDeal()` sets it on
  every field of a saved deal, and `isManual()` is what `applySurveyDefault()` and
  `applyCountyDefaults()` check. Flag any auto-fill that compares against a default value, or an
  input added without `markManual(this)` on its handler.
- **The three mappings are deliberate:** demo square footage from the assessor's heated area (falling
  back to the mapped footprint when there is no CAMA record, e.g. a newly created lot); clearing tier
  from canopy % (`CANOPY_CLEARING`); grading from the slope band (`SLOPE_GRADING`). These are
  screening estimates and the UI says so — don't present them as quotes.

### Domain-correctness (don't let geometry override the rulebook)
> These two rules describe the **target state**; the current code differs. Flag against
> the target, but don't assume the target is already implemented — both are open items.
- **UR-2/UR-3/UR-4 are defunct pre-UDO zones that are still PRESENT in the code today**
  (in both `SETBACKS` and `COUNTY_ZONES`) — a known, not-yet-done cleanup target
  (handoff §4.4, §12), *not* something already removed. Don't add them anywhere new, and
  flag any change that reintroduces them **or that assumes they've already been deleted**.
- Townhome/attached plays *should* be gated by the **permitted-use matrix**, not geometry
  alone (attached is not by-right in N1-A..E). **That matrix is NOT wired into the app
  yet** — today the attached flow runs on plan type + geometry/length checks and only
  shows a "verify the zone permits" note (handoff §10, §12; it's a roadmap item). Flag any
  change that hard-codes a townhome *recommendation* as if the gate already existed, and
  treat wiring the use-matrix gate as still-to-do.

### Versioning & verification (compensates for no test suite)
- Any user-facing change bumps **both** `APP_VERSION` and the header badge together, and
  adds a release-notes / changelog entry. Flag a mismatch.
- Because there's no automated test suite, **every logic change must include a manual
  verification note in the PR** — recompute one known deal and show the before/after numbers.
  **Canonical parcels (verified against Mecklenburg County GIS, 2026-09-21):** the Dellinger site
  was sub-lotted into three townhouse lots — 2723 Dellinger Dr (PID 04118535, 7,145 sf), 2727
  (PID 04118536, 3,455 sf) and 2731 (PID 04118537, 4,312 sf), all N1-B, Central Catawba. The older
  note "PID 04118526 / 77,575 sf" is wrong — that PID is a neighbouring 1.78-acre parcel on
  Milhaven Ln owned by a third party.
  Flag a math-touching PR that ships without one.

---

## PR protocol (the handoff surface between the agents)

1. **Claude** branches off `main` (never commits straight to `main`), implements, tests
   headless, and opens a PR whose description states **what changed, why, and the manual
   verification numbers**.
2. **Codex** auto-reviews against this file and posts P0/P1 findings. Focused passes on
   request: `@codex review for financing-math regressions`.
3. **Claude** responds to each finding in-thread — fix, or justify why it's a
   non-issue — and pushes follow-up commits.
4. **Brian** reads the resolved thread + the Vercel preview, then merges → Vercel deploys.

Nothing reaches production without passing through this loop.
