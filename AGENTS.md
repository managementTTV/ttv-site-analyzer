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
- **Exports take the plan from the `plan-sel` value, not the plan card (v8.11).** `getReportData()`
  gets `plan` from `planNameFromVal()` and `footprint` from `planFootprintFromVal()` (custom =
  `cust-w` × `cust-d`; an attached townhome is the per-unit W×D). `onPlanChange()` writes the
  `#plan-info-*` text only for a Slate plan, so on a custom or no-plan deal it still shows the last
  Slate plan, and every reader of `getReportData().plan` / `.footprint` (the PDF, the hero, the Excel
  model) would print that plan. Flag a new read of `#plan-info-*` text as data.
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
  2026-09-22): base profit/unit must clear the **greater of a flat floor or a % of all-in per
  unit**. It solves both rules and takes the lower land ceiling.
- **The profit rule is an input since v8.2** (Financing › Profit Rule: `profit-floor`, `profit-pct`).
  The shipped default is the SOP, **$50,000 and 15%**, and it lives **only in the two inputs' `value`
  attributes** (`getProfitRule()` falls back to `defaultValue` for a blank field, so blank means the
  default, not zero). Don't change the default silently; if it changes, it's a deliberate, called-out
  change (the Sept 2026 offers backtest found the team really offers at about $70k / 23%, so expect
  this to be debated). Every reader goes through `getProfitRule()` and `profitRuleLabels()`: the Max
  land card, `getReportData().fin.profitRule`, the PDF label, the Financing summary and the Excel
  model, whose two thresholds are Inputs cells referenced by the Scenarios max-land formula. Flag a
  path that re-hardcodes 50000 or 1.15 / 0.15, or computes or words the rule a second way.
  `PRE_V82_PROFIT_RULE` is not a default: it's the rule every pre-v8.2 deal was underwritten on, which
  `restoreDeal()` pins for saves without the fields. Never change it.
  The two fields are `type="text"` on purpose, read by `parseRuleValue()` (accepts `$`, `k`, `%` and
  commas **only as thousands groups**, so a decimal comma like "7,5" is unreadable, not 75): a number
  input returns `''` for text the browser can't parse, which silently became the default. A value
  that can't be read, or has to be limited (floor ≥ 0, % within 0–99), must show in
  `#profit-rule-warn`, never be applied quietly; an implausible one (floor under $1,000, % under 1%)
  applies but also shows a "did you mean…?" note. The limits and typo thresholds live once, in
  `PROFIT_RULE_LIMITS`, which `getProfitRule()` and the Excel builder both read. Messages and labels
  format values with `fmtRuleUSD()` / `fmtRulePct()`: to the cent / 4 significant digits (not whole
  dollars) and in a form `parseRuleValue()` reads back in any browser locale. The warning lines are drawn
  by `renderInputWarnings()`, which holds a field's own note while you're typing in it (from the first
  keystroke until the field loses focus), so half-typed values ("70,", "75") don't flash notes, while merely
  focusing a flagged field keeps its note up. Document-level listeners (capture-phase `input`, `focusout`)
  do the tracking and re-render; don't add per-field handlers. The Excel
  model mirrors the same semantics: the Inputs rows "Min profit used" / "% of all-in used" apply the
  default (a blank **or non-numeric** cell, via `ISNUMBER`) and the limits, `Scenarios!B30` reads
  those two cells, and the note in column C beside each rule cell compares what was typed with what
  was used, plus the same typo thresholds. Flag a change to one side that isn't made on the other.
- **Exports read the same raw values the screen uses.** `getReportData()` (`fin`),
  `collectModelInputs()` and the plan-compare header take LTC, rate, points, fees, tax and sale cost
  straight from the fields, as `calcLoanBase()` / `holdingCost()` / `calcScenarios()` do. Flag a
  `pv(x)||default` fallback on a field where 0 is a real answer (0 points, 0% sale cost): it makes
  the PDF and Excel Max Land disagree with the tile. Where blank should mean a default, test for the blank
  field instead, as `calcBUA()` does for `bua-hardscape` since v8.8 (blank = its HTML default, 500 sf; 0 = none).
- **Loan terms go through `getTerms()` (v8.7)**, the one reader for `term-w` / `term-b` / `term-best`:
  the scenario cards, Max land, the hero (via `getReportData().terms`), the PDF, the Excel inputs and
  the plan comparison. A blank term is the field's HTML default (10 / 8 / 6, also its placeholder), not
  0 months, and is silent, as with the profit rule. An unreadable term also gets the default, a term under
  1 month is raised to 1, and one over the field's max (36) applies as typed; each of those shows a note in
  `#term-warn`. Flag a direct `pv('term-…')` read. The Excel model mirrors this once (v8.13): Scenarios row
  16 holds the terms as used (`MAX(1, IF(ISNUMBER(x), x, default))`), and every term formula (holding,
  Max Land's B27/B28, all five Sensitivity rows) reads that row, never the Inputs term cells; a note in
  column C beside each Inputs term cell says when it isn't used as typed or is over the max. The
  sensitivity grids never show a row under 1 month (PDF `Math.max(1,…)`, Excel via row 16 and
  `MAX(1,…)`); keep the two in step.
- **Money text fields are read with `mv()`, never `pv()` (v8.8).** Land cost, asking price and the three
  ARV $/sf fields (`land-cost`, `asking-price`, `arv-w`, `arv-b`, `arv-best`) are `type="text"` so "$185,000"
  can be typed or pasted. `pv()` drops every comma and runs `parseFloat`, which read "$185,000" as 0, "185k"
  as 185 and "385,5" as 3,855 with no warning, and the PDF and Excel then ran on those numbers. `mv()` /
  `readMoney()` parse them with `parseRuleValue()`'s rules (`$`, `k`, commas only as thousands groups; `%` is
  refused). Blank, unreadable and negative all give 0, which every reader already treats as "not entered"
  (no land, no asking line, no base ARV, auto ∓10% for Worst/Best), but unreadable and negative values also
  show in `#lever-warn`, never silently. Readable but implausible values apply and get a note: land or asking
  under $1,000 ("did you mean $185,000?"), an ARV of $1,000/sf or more ("looks like a sale price"); the
  thresholds are data in `MONEY_FIELDS` (`typoBelow` / `typoFrom`). `renderInputWarnings()` draws
  `#lever-warn` with the other warning lines, so a field's note waits while you type in it, through the same
  document-level listeners (no per-field handlers). The exports carry the same notes: a "Check inputs" line on the PDF cover, and a note in column C
  beside the land / ARV cell on the Excel Inputs sheet (only when there is one, so a clean deal's files are
  unchanged). Flag an export path that reads these fields but drops the notes.
  Flag a new reader of these five ids that uses `pv()` or `parseFloat`, or a new `type="text"` money field
  read by `pv()`. `pv()` itself is unchanged and stays right for `type="number"` fields, whose `value` is
  already a plain number or `''`.
- **Comps table cells go through `readComp()` (v8.12).** Sq Ft, Sold $ and Adjustments are free text, read by
  `readCompCell()` through `parseMoneyValue()`, the same step `readMoneyText()` uses for the five money fields
  (`parseRuleValue()`'s rules, `%` refused, and a Unicode minus or en dash counts as "-"), plus three comps-only
  allowances: "(40,000)" is −40,000, a leading "+" is fine, and Sq Ft may end in "sf" / "sq ft". A comp needs a
  Sq Ft and a Sold $ to count; an adjustment alone doesn't make one. The old `compNum()` stripped every comma and ran
  `parseFloat`, so "352.5k" was a $352.50 sale and "352,5" was $3,525, and they fed the median that Apply median
  writes into `arv-b`. A cell that can't be read, or a negative Sq Ft / Sold $, leaves that comp out of
  `compStats()`. The Excel Comps sheet holds exactly the comps `compStats()` counts, so the workbook's `MEDIAN`
  matches the screen. The cell is marked, and `compIssues()` lists it in `#comps-warn` under the table, as a "Check comps" line on the PDF comps
  page and under the Excel stats. Readable but implausible values (a sale under $1,000, an adjusted $/sf of
  $1,000 or more) still count, with a note. Every comps number, whether the table, Apply median, `getReportData()`,
  the PDF or `collectModelInputs().comps`, comes from `readComp()` via `compPPSF()` / `compStats()`. Flag a new
  reader that parses a comp cell another way, or an export that drops `compIssues()`. The notes exist only when
  there's a problem, so a clean comps table gives the same report data and files as before.
- **Plan-comparison ARV overrides are text, read by `readMoneyText()` (v8.12),** the same reader behind `mv()`.
  Blank, unreadable and negative all mean "use the deal's ARV" (`readCmpArv().use` is false), but unreadable and
  negative also get a red cell and a note under the comparison table. They were `type="number"`, which hands back
  `''` for "$265", so the override was dropped with no sign. Don't turn them back into number inputs.
- **`restoreDeal()` starts from a fresh page (v8.2).** Step 0 resets every `.page` input/select to its
  HTML default before anything else, because the blanket restore only writes fields the saved file
  has. A field added in a later version therefore opens at its shipped default, not at the previous
  deal's value. Consequence: a `.page` field's shipped default must be in its HTML (`value`,
  `checked`, `selected`), not set by JS at startup, or a restore will blank it.
  **Validate, then commit (v8.9).** Step 0 only runs once the file passes a check: every `fields`
  entry is an object, at least one is a `.page` input/select, and the collections have the shapes
  `serializeDeal()` writes. The blanket restore writes only `.page` fields. A restore that still throws
  part-way leaves the page half-loaded, so its catch cancels the pending autosave and asks for a
  reload; it doesn't re-run the pipeline to "roll back" (that can't put back data-manual flags or
  entry-time state, and a code error would throw again). Step 0 also clears the previous deal's
  panels outside `.page`: the county GIS card, its status line, and the comps box with its Apply
  button. The offer letter isn't cleared on restore: it's keyed to the address it was opened for
  (`ol-amount.dataset.sig`), so it starts over for any other deal, however that deal arrived. A
  restore also bumps `_dealGen`, so a GIS lookup or comps pull still in flight is dropped instead of
  landing on the new deal (flag a new async county call that doesn't check it), and it dismisses the
  resume bar, whose offer is stale once the autosave writes the new deal.
- **In `restoreDeal()`, saved values land last (v8.9).** Fills that derive fields from other fields
  run *before* the blanket restore: `onCountyChange()` (zone list, taps) and `onZoneChange()` (the
  zone table's setbacks), so an adjusted setback survives. After it, blank setbacks and the read-only
  `sb-minw` / `sb-garage` come from today's `SETBACKS`, because those were never choices. `onPlanChange()`
  has to run after the blanket restore (step 7 needs the rebuilt plan list), so every saved field it
  writes is re-applied afterwards: `units` (plus `updateAttachedBuild()`) and `rot-slider`. The
  entry-time auto-defaults are restored, not guessed. `serializeDeal()` saves `tapSig` / `rankSig`
  (what `applyTapDefaults()` / `applyRankedPlanDefault()` last applied) and `restoreDeal()` puts them
  back, so a switch that was still due when the deal was saved still happens on entering The Underwrite.
  Older files count the taps as applied and a restored plan as the ranking's choice; if no plan could
  be re-selected, the ranking stays open. A GIS re-run on the parcel already loaded (same PID, same
  zone) leaves the setbacks alone too (`setGisZoning`). Flag a table fill moved after the blanket
  restore, a field `onPlanChange()` writes without a re-apply, or an entry-time auto-default whose
  signature isn't saved and restored: each one silently changes a reopened deal's numbers.
- **`onPlanChange()` sets Units only when the plan changes (v8.14).** It also runs for things that
  aren't a plan change: `applyGcBuildFee()` rebuilds the dropdown and calls it, and so does every
  custom-footprint keystroke (`applyCustomDims()`). Writing the plan's default each time put a
  3-townhome deal back to 1 unit on a GC fee edit, which cut Dellinger's Max land from $262,309 to
  $69,756. `_unitsFor` records the plan (or, for a custom footprint, its `cust-u`) whose default
  Units last took, and the default is written only when that changes. Flag a new path that writes
  `units` from a plan default without that check.
- **Taps keep a typed quote (v8.14).** `tap-water` / `tap-sewer` call `markManual(this)`, and
  `applyTapDefaults()` never writes over a `data-manual` tap. `renderTapHint()` builds `#tap-hint` from
  the current record, flags and values (a missing fee reads "no … fee on file", never $0). It runs after
  the defaults, on the tap fields' blur, and after a restore. It names a typed quote next to the schedule
  it differs from, and adds the record's `cityNote` where the default is one city's or the county's
  schedule (Gaston, Catawba, Iredell). It re-defaults only when the fee *record* changes
  (`tapRecordFor()` maps a `county|city` signature to its `CITY_TAP` / `COUNTY_TAP` row), so a city
  edit that lands on the same record (Charlotte → Mint Hill) doesn't run it. Before this, any city
  edit put Charlotte Water's $17,340 back over a typed quote; on Dellinger's real $6,907/lot
  Alternate Install that meant $31k of Max land. `serializeDeal()` saves `tapManual`.
  `restoreDeal()` clears the taps' flags in step 0 and re-applies `tapManual` after `markAllManual()`,
  so a switch still due on reopen can still land on default taps. Files from before v8.14 have no
  `tapManual`, and their taps count as defaults, which is how v8.9–v8.13 treated them.

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
- **Lot sales are not comps (v8.14).** The county stores `soldasvacantflag` as `'Yes'` / `'No'`. The
  old check compared it with `'Y'`, so it never matched, and builder lot purchases were joined to the
  house the assessor now shows and counted as new-build comps (~$94/sf against ~$213/sf for real
  ones). A parcel is left out when its **newest** market-valid sale was sold as vacant. The flag is
  read on the newest row, not before picking it, so an older sale of the torn-down house can't stand
  in for the lot sale. A sale recorded before the year the current house was built is left out as
  well. The assessor sometimes dates a house to the year after a Q4 closing, so a few real closings go too
  (2 of 24 rows county-wide over 24 months; the other 22 were bulk deeds, lot takedowns and teardowns).
  All 24 sit at `saleYear = yb-1`, so narrowing it needs the multi-parcel-deed check and a guard for
  single-parcel teardown or lot sales first. Both counts go into `notes`, and the
  county comps box shows them under "Left out". Flag a vacant check that isn't case- and length-tolerant
  (`/^Y/i`), or one moved ahead of the newest-row pick.
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
  every field of a saved deal, and `isManual()` is what `applySurveyDefault()`,
  `applyCountyDefaults()` and (v8.14) `applyTapDefaults()` check. Flag any auto-fill that compares
  against a default value, or an input added without `markManual(this)` on its handler.
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

**Current state, not target (v8.15):**
- **The Mecklenburg N2 rows follow the UDO** (Charlotte UDO as amended 3/23/2026, text amendment 2025-118).
  - **Detached rows.** `N2-A` / `N2-B` hold the **N1-E** standards (10 / 20 / 5 / 10 ft, 30 ft, 3,000 sf). That's
    what single-family, duplex, triplex and quadraplex buildings are built to there (§5.1, §5.3.A.1, §15.4.HH.1 / EE.3
    / JJ.3 / GG.4). A 2- to 4-unit townhome row is legally a duplex / triplex / quadraplex (§15.3: multi-family =
    5+ units), so it uses these rows too. `N2-C` holds the same values with a note: no single-family, and a standalone
    duplex–quadraplex only on a lot of 0.5 ac or less that existed before 6/1/2023.
  - **Townhome rows.** `N2-x · townhomes 5+` hold Multi-Family Attached (Tables 5-1 / 5-2), with `mfa:true`. The
    frontage is 20 ft from the back of curb on a local or collector street; the app measures it from the lot line,
    which is conservative there. Avenues, boulevards and Main Streets are measured from the future back of curb:
    N2-A 24–30, N2-B 20–30, N2-C 20–24 ft (Table 5-2 row A; N2-C also takes 16 ft on a Secondary frontage). The rear
    comes from `zoneRear()`: for N2-B / N2-C the `rearNotAbuttingN1` 10 ft applies unless `#n2-abuts-n1` is ticked.
    That box is ticked by default, because abutting a Neighborhood 1 Place Type (2040 Policy Map) means 20 ft
    (Brian, 2026-09-29). The townhome card points at the row that matches Units.
  - **No affordability condition in N2.** The only mandatory affordable set-aside for these building types is the
    N1-A..E quadraplex rule (arterial street + 1 unit ≤ 80% AMI for 15 years, §15.4.GG.3.a). Affordability in N2 is
    voluntary bonuses only (§16.3 for N2-C, §16.4).
  - Flag a change that puts back unsourced N2 values, applies the townhome row to a 2–4 unit row, or adds an
    affordability requirement to N2.
- **Suffixed GIS zones map to the base zone (v8.15).** `setGisZoning()` falls back to `zoneSuffix()`, so
  "N1-C(HDO)", "N2-A (CD)" and "N2-B BVO" take the base row. `renderZoneNote()` says what the suffix means; for CD,
  read the rezoning petition, because its conditions govern. Before this, a suffixed zone got a stub option with no
  setbacks of its own: blank (the whole lot buildable) or the previous deal's, silently (audit G2).
  - An exact option wins only when it has a `SETBACKS` row, so an old '(saved)' / '(from GIS)' stub can't block the
    base row.
  - `restoreDeal()` maps a saved stub to its base row.
  - A same-parcel re-run keeps a `· townhomes 5+` row of the same base zone.
  - `renderZoneNote()` compares against the row's base zone, so the CD note survives picking the townhome row.
  - This is only the suffix part of G2. A leftover non-Mecklenburg county on a GIS lookup is still open.
  Flag a zone lookup that drops the suffix note, or one that treats a CD petition's conditions as known.
- **The N2-C base row carries `noNewLots`**: `renderSublot()` warns that lots made by a split can't hold a
  standalone house or plex there (§15.4.EE.6 / JJ.5 / GG.6; single-family not permitted). A `· townhomes 5+` row
  seen with a detached plan gets the same treatment, pointing to the base row. Either way the split rows show
  geometry only, with no checks.
- **Zones with no `SETBACKS` row** (a GIS or saved stub):
  - `onZoneChange()` shows the setback panel.
  - `renderZoneNote()` says the fields are blank or the previous zone's. For a zone that exists in Mecklenburg
    under another county, it says to pick Mecklenburg.
  - The sub-lot estimate shows "?" (minimums unknown), not the "—" of a row with no minimums.
  - When a saved stub reopens on its base row with setbacks that differ from that row, `_zoneRestoreNote` says so.

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
