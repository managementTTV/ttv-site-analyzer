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
  lot → buildable area & plan fit; geometry only, no underwriting money: the county's own facts, such as the GIS card's
  tax value and last sale and the v8.18 street check's $/sf, show there as context and feed nothing) and **The Underwrite** (hero numbers,
  live levers and the worst/base/best board first, then collapsible Plan & build / Lot factor /
  Financing / Sales comps inputs; money only, no geometry), plus PDF/Excel/offer-letter exports.
- **UI vs. math (v8.0).** The two-screen layout is presentation only. Sections keep their old
  `page-1`…`page-7` ids (comps are `page-8`) and every input keeps its id, so `goTo(n)` and all
  calculators still address them by step number. Flag any v8 UI change that edits a calculation
  function, renames an input id, or moves an input outside `.page` (serialize/restore and
  `markAllManual()` select `.page input[id]`). Hero tiles and section summaries are display-only,
  filled from `getReportData()` in `updateHero()`.
- **Architecture:** a **single, fully client-side `index.html`** (UI + all logic + all
  plan data, ~4,900 lines) + five serverless functions in `api/`: `gis.js` (Charlotte/Meck
  GIS + county assessor proxy), `comps.js` (county new-build comps), `street.js` (the street check,
  v8.18), `permits.js` (the permitting board's data proxy), `deal-sheet.js` (v8.21, a redirect to the
  New Deal web app; see Deal-sheet hand-off) and `mcp.js` (the "TTV Street Data" MCP connector for
  claude.ai, 2026-10-01; see Street Data connector) + `plans/` images + `assets/` logos. No framework, no build
  step, no database. Everything runs in the browser. Two small static pages sit beside it: `permits.html` (below) and
  `streetview.html` (v8.20, the lot's Street View on its own page; see Street check).
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
  Its answer always lands in Mecklenburg (v8.16): `applyGisData()` sets `county-sel` to Mecklenburg on any
  applied result, so a county left from the last deal can't turn the GIS zone into another county's stub (audit G2).
- **The geocode matches the address typed, or loads nothing (v8.16, audit G1).** `chooseAddressPoint()` takes the
  exact `txt_street_number` and compares every part of the street (direction, name, type, suffix) after both sides go
  through `canonTok()` ("North" = N, "Drive" = DR, "37th" = 37, "Mount" = MT; apostrophes dropped, hyphens split; the
  county's own type codes such as TR count too). The typed ZIP / city choose the place first, then the spelling, so
  "2100 Sharon Rd, 28210" is SHARON RD W in 28210, not the exact-spelled SHARON RD in 28207. Candidates are paged (a
  tower has 450 unit points at one number). `match.status` is `exact`, `close` (loaded, with `diffs`: a part left out,
  a ZIP or city that differs, another street at the number, one unit of a building), or refused: `none` (with the
  nearest numbers on the street), `ambiguous` (N and S Tryon both fit, or the address's units are separate parcels)
  or `locality` (the street isn't in the typed city or ZIP). Units count as separate parcels by `GIS_PID` (condo units
  share one; a split duplex's don't), and a building point that sits on one of them doesn't stand in for the site. A refused match returns no parcel and no zoning. v5 matched the number and the
  first word after it as substrings and took the first hit, so "1500 N Davidson St" loaded another parcel (15004 Annan
  Ct in the audit, 1500 Eastcrest Dr the next day). Flag a
  geocode that matches the number as a substring, drops the direction or type, takes the first feature without
  comparing, or loads a parcel for a refused match. A close match must stay visible (amber status and card row).
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

### Street check (`api/street.js`, v8.18)
- **What it is:** the lot's own stretch of street (same CAMA `streetname`, `STREET_FT` = 1,000 ft; CAMA drops the
  direction, so when the centreline is "N DAVIDSON ST" the parcels addressed on the other half are dropped via the Accela
  address points) compared with its
  assessor neighbourhood on the county records (recent sale $/sf, assessed building value $/sf, homes graded below
  Average, vacant lots, commercial / industrial parcels, homes built 2020+), for the "bad street in a good area" case.
  Mecklenburg-only, like `gis.js` and `comps.js`. Plus a Street View camera spot: the nearest point on the street's
  City / State centreline, facing the lot.
- **Display only.** The card on Site Intelligence doesn't feed a calculation, `serializeDeal()`, the PDF or the Excel,
  and it doesn't touch the comps or the ARV (same-street comp matching was backtested and not better; see Comps). Flag
  a change that moves a street check number into the math or the save file without a backtest behind it.
- **No AI or data extraction on Google imagery, by any route.** Google Maps Platform terms §3.2.3 forbid exporting Street
  View imagery and creating content from it (their own example is an index built from Street View; (c)(vii) also bars
  using it to train, test or validate AI). §3.2 makes TTV answer for any user doing it through the app, and a breach allows
  immediate suspension (§5.2(d)) of the `tidetimber-crm-maps` project, which also runs the CRM map. Google's Street View
  guidelines (https://about.google/brand-resource-center/products-and-services/geo-guidelines/) separately ban
  screenshotting Street View "for any purpose" and "using applications to analyze and extract information" from it,
  which rules out an AI walking google.com/maps in a browser too (robots.txt only covers crawling). Flag any fetch of
  Street View Static images, any capture of the embed (canvas readback, getDisplayMedia, extensions), any imagery sent
  to a model, or any caching of Google responses.
- **Street View lives on `streetview.html`, never on an analyzer screen (v8.20).** Maps Platform ToS §3.2.3(e) bars showing
  Street View "and non-Google Maps on the same screen", and Site Intelligence draws the county parcel. The card links to
  `streetview.html?pid=…` (new tab) and to Google Maps (Maps URLs); it holds no Maps Embed. `streetview.html` shows only
  the embed, the address, a Google Maps link, text and the terms notice: flag any county map, parcel drawing, aerial or
  other non-Google map added to it, any link from the embed to one, and any calculator logic or browser storage there.
  `GOOGLE_MAPS_EMBED_KEY` lives in Vercel env only and goes out only in `/api/street?mode=view` (which `streetview.html`
  calls), not in the card's full answer. It reaches the browser by design, so it must stay restricted to the Maps Embed
  API and by HTTP referrer to `ttv-site-analyzer.vercel.app/*` only (no `*.vercel.app/*`: any Vercel site could use a
  copied key; previews show Google's referrer error in the frame and keep the Maps link). `mode=view` sends no CORS
  header, so other sites can't read the key from it.
  `streetview.html` refuses to render inside a frame, so it can't be pulled back onto an analyzer screen. The card's
  "Google Maps" link is a plain Maps URLs link-out that opens Google's own product in a new tab; nothing from Google is
  shown on Site Intelligence. Without the key, the page links out.
- **Google Maps terms notice (§3.2.2(a)(i)).** The app footer, and `streetview.html`'s, say the app includes Google Maps
  features and content subject to the Google Maps/Google Earth Additional Terms and the Google Privacy Policy, with links.
  Keep both notices; any new page that uses Google Maps needs one.
- **Fair housing.** Every check is about buildings, lots and land use, never who lives there. Multi-family, affordable
  housing, mobile homes and senior housing never count against a street (`HOUSING_DESC` overrides a commercial land-use
  code). Flag a check that adds occupant, ownership-type or demographic data, or counts housing of any kind as a
  negative.
- **The comparison area.** The assessor neighbourhood, unless it's a commercial market area (`SUBMARKET` in its name:
  "RETAIL - NORTHEAST SUBMARKET") or has fewer than `MIN_AREA_HOMES` homes; then every parcel within half a mile. A new
  lot with no code takes the most common non-commercial code within 300 ft. Unbuilt lots with the subject's owner are
  left out of the street (usually the rest of the same site); a builder's finished homes still count.
- **Sales are home sales.** Each home's CAMA last sale counts when market-valid (blank or Z), in the window, not before
  the year built, and not sold as vacant on `TaxParcelSales` (newest market row, `/^Y/i`, as in comps): a builder's lot
  purchase in the build year would otherwise count at lot price. Both sides need enough evidence (`CHECKS[].enough`)
  or the check reads "Too few". A partial answer (a county layer down) is sent `no-store`.
- **Thresholds are judgement, not backtested** (`CHECKS`), and the card says so. Don't present the verdict as measured
  until it has been backtested against the team's own "bad street" calls.
- **Stale answers.** `checkStreet()` takes `gisAddressSignature()` and `_dealGen` before the fetch and drops an answer
  if either moved or `_lastGis.pid` changed. The card hides when the address moves (`invalidateGisIfAddressMoved()`),
  on a refused match and in `restoreDeal()` step 0; a restore re-runs it for the saved parcel.
- **The other half of the street (v8.22).** CAMA files N and S Davidson St both under "DAVIDSON ST", so when the lot's
  own centreline has a direction ("N DAVIDSON ST"), the street rows drop every parcel with an Accela address point on
  that street name within the stretch whose `cde_street_dir_prfx` is not that letter (or is blank). The comparison is
  with the direction letter (`dm.split(/\s+/)[0]`). Before v8.22 it used `dm[1]`, the name's second character (a
  space), which dropped the lot's own half as well: 1500 N Davidson St (08110205) read 5 parcels and no homes ("too
  few"), now 52 parcels and 38 homes ("watch", building value $/sf); 3116 N Davidson St (08308C99) read 7 parcels,
  now 80 parcels and 38 homes. Flag a direction comparison with anything but the letter.
  - A centreline layer that doesn't answer is an errors entry (`centrelineError()`; the halves can't be told apart, so
    the answer goes out `no-store`), not "no centreline here", and the `NO_CENTRELINE` note ("a private street?") is
    only for a street the layers answered for. Flag a `.catch` that turns an outage into an empty answer.
- **One street check, two callers (2026-10-01).** The handler only validates and sends; the work is `streetCheck()`,
  which `api/mcp.js` also calls. `/api/street` output must stay byte-identical when either side changes (see Street
  Data connector). `keep.rows` / `keep.subject` carry CAMA owner fields for the same-site rule: never send them.

### Street Data connector (`api/mcp.js`, MCP, 2026-10-01)
- **What it is:** "TTV Street Data", a read-only remote MCP server for claude.ai. An org admin adds it once as a custom
  connector (README). The "Street Walk" artifact (a claude.ai page shared with the org) and any Claude chat in the org
  call it on the team's own Claude subscription: no Anthropic API key, no per-use billing. Two tools:
  - `find_street`: an address or PID gives the subject's own stretch of street, house by house (assessor facts, City
    code-enforcement cases opened in the last 24 months), plus the street check's answer.
  - `aerial_crops`: 1–6 PIDs give NC OneMap orthophoto crops, with each parcel's outline in pixels.
  It feeds no analyzer screen, save file, PDF or Excel.
- **Read-only, public data, no secrets.** It's authless, like the other endpoints, and reads only Mecklenburg County,
  City of Charlotte and NC OneMap public services. Flag a write, an auth token, a key, an env var or another data
  source.
- **No Google, by any route** (the street check's rule, above).
  - Nothing from Google passes through the connector or reaches a model: no Street View, Static Maps, Maps JS, Places or
    Google geocodes.
  - `streetview_url` (`streetview.html`) and `maps_url` (a Maps URLs link) are links this file builds for a person. The
    tool descriptions and the server instructions say never to fetch them or read them with a model.
  - The AI's eyes are NC OneMap orthoimagery (licence: free and unrestricted) and county records.
  - Flag a Google host in any fetch, a Google response passed on, or an embed or capture of one.
- **Code enforcement: type, opened, closed and status only.**
  - `CE_FIELDS` is the whole request (explicit `outFields`, never `*`). Never request Inspector, EmailAddress,
    InspectorPhone, FullAddress, CaseOrigin or DetailedDescription.
  - CaseType is coarse: eight in ten cases are "Nuisance". The violation a case cites ("10-167 (b) - Junked Motor
    Vehicles", "14-216 (a)(25) - Parking on the Lawn") sits only in DetailedDescription, which also holds the reporter's
    own words. So `VIOLATIONS` matches each citation line (section number and title) in a `where` clause on the city's
    server and gets object ids back (`returnIdsOnly`).
  - The type returned is always one of `VIOLATIONS`' fixed labels or the CaseType, never text from the record.
  - Flag a fetch of DetailedDescription, a type taken from record text, or a label pattern without its section number,
    which would start matching free text.
  - Status is `CaseStatus` (Open / Closed / New). The `Conclusion` (e.g. "Case Dismissed - No Violations") isn't
    returned.
- **No owner names.** `houseFrom()` copies only the fields it names from each CAMA row. The CAMA `city` / `zipcode` are
  the owner's mailing address, so they stay out too. Flag any owner, mailing, grantor or deed field in the output.
- **"This street" is street.js's, and the geocode is gis.js's.** Flag a second geocoder or a second street definition.
  - `find_street` calls `streetCheck()` with `keep` and lists `keep.rows`: the same CAMA street name within 1,000 ft,
    with the other half (N vs S) dropped via the Accela address points (the direction letter, fixed in v8.22; see the
    street check). That's taken before the same-site rule, so the subject's own other lots are listed.
  - The subject is normally among `keep.rows`. When it isn't, it's listed anyway with a note saying so, so an empty or
    mis-filtered street can't hide behind the subject. The connector test checks 1500 N Davidson St lists 40+ houses
    with no such note.
  - One row per PID (a condo's unit rows share one), at most 80 (the nearest the subject), sorted by house number.
  - An address goes through `geocodeAddress()` and `parcelAtPoint()`, so it finds the parcel `/api/gis` loads. A refused
    match is a tool error carrying the county's message; a close one loads with that message in `notes`.
  - `kind` (`walkKind()`) picks what the Street Walk grades (home and vacant), so it means a house and a house lot. It
    starts from street.js's `isHome` / `isVacant` / `isNonRes` and only changes the label; the street check's counts
    are unchanged.
    - A common area (land use with COMMON: an HOA strip, a town-house, condo or commercial common area) is never home
      or vacant.
    - home: `isHome`, or heated area with a house land use the county codes outside R: duplex / triplex (A562, A500),
      single-family on an exempt or industrial code, a rural or use-value homesite, an affordable-housing town house,
      condo or house (AF09, AF04, AF01). Apartments (MULTI FAMILY, APARTMENT, HIGH RISE) stay other.
    - commercial: `isNonRes`, tested before vacant, so a vacant commercial or industrial lot is commercial.
    - vacant: no building on record (CAMA `VAC`, or no heated area and no building value, which an "IMP" teardown can
      show) on a house lot: an R code or a house land use, never a condo parcel. Parks, greenways, rights of way, rail,
      utilities, floodways, churches and the like are other.
    - Flag a rule that sends a common area, a park or a right of way to the AI read, or leaves a house out of it.
- **Refactor guard.** `/api/street` and `/api/gis` must stay byte-identical: status, headers and body, with both
  handlers called directly against `git show origin/main:api/…`. The 2026-10-01 connector test did this for PIDs
  04118535, 08308C99 and 06107186 (plus `mode=view` and a bad PID), and for 2723 Dellinger Dr (with `debug=1` too),
  1500 Davidson St and "2100 Sharon Rd, 28210". Flag a connector need that changes either endpoint's output.
  - v8.22's direction fix is the one deliberate change: on a N / S street (08308C99, 08110205) the test compares with
    origin/main plus only that one-line fix, and the rest with origin/main itself.
  - The `fetchSignal` arguments of `streetCheck()`, `geocodeAddress()` and `parcelAtPoint()` are for the connector.
    The endpoints pass none, so their requests carry no signal, exactly as before.
- **Crops (`aerial_crops`).** Each crop works like the tested set's `build.py` `crop()`:
  - The parcel ring comes from TaxParcelBoundaries (`outSR=2264`), and the 220 × 220 ft box is centred on the mean of
    its first ring's vertices.
  - The image is NC OneMap `exportImage` at 440 × 440 px, JPEG at quality 90 (the source is JPEG; 90 stays close to the
    tested PNGs).
  - The image carries no outline. `rings_px` holds the rings in image pixels (`(x-minx)*sx, (maxy-y)*sy` against the
    bbox requested), and the artifact draws them in red.
  - Each crop's `flight` is the date in the name of the visible catalog tile under its centre (`identify`), so a
    re-flight changes the artifact's cache key. Flag a hard-coded flight date.
  - 1–6 PIDs per call, one `aerial_crops` per HTTP request. An answer is about 0.25–0.45 MB; Vercel's limit is 4.5 MB.
- **Transport.**
  - MCP Streamable HTTP, stateless, JSON responses only: no SSE stream, no session id.
  - POST takes one JSON-RPC message or a batch. Notifications get 202, GET gets 405 with `Allow: POST`, OPTIONS gets
    204. Responses are `Content-Type: application/json` with `Cache-Control: no-store`.
  - A tool failure (bad input, a layer down) is an `isError` result saying what to do. An unknown method is -32601, an
    unknown tool -32602 and bad JSON -32700.
  - Each tool call has a 25 s budget (`toolControl()`). Every upstream request it makes carries a signal: a 10 s
    timeout plus the call's own abort. That includes the street check's and the geocode's requests, through the
    `fetchSignal` argument. So a stalled layer fails on its own and degrades only itself (an `errors` entry), and
    `callTool` aborts whatever is still running when the call ends, on time or not.
  - `find_street`'s code-case and flight lookups get only what's left of the budget, less 1.5 s. A slow City server
    then costs the cases (an `errors` entry), not the houses already built. Section 6 of the connector test stalls one
    layer at a time (the centrelines, sales, code enforcement, all of gis.charlottenc.gov, the address lookup) and
    checks each.
  - Flag server-side state, an SSE stream, a fetch without the call's signal, or a tool that can run past its budget.
- **Versioning.** The connector sits outside the analyzer. An `api/mcp.js`-only change doesn't bump `APP_VERSION` or
  the badge, because no analyzer screen changes; a change to street.js or gis.js output still does. Bump
  `SERVER_INFO.version` when a tool's input or output shape changes, since the Street Walk artifact is built against it.
- **Fair housing**, as in the street check: buildings, lots and land use only. Flag occupant, ownership-type or
  demographic data.

### Lot-factor auto-fill (v7.13)
- **A cached GIS result must not outlive its address.** `window._lastGis` carries the PID the comps
  pull keys off. `onAddrChange()` drops the cache as soon as the typed address stops matching
  `_lastGis.addrSig`, and `pullCountyComps()` re-checks before using the PID. Without this an
  analyst who edits the address after a lookup silently prices the previous parcel. Flag any new
  consumer of `_lastGis` that doesn't verify the signature.
- **A lookup answers the address it was sent for (v8.16, audit S-F7).** `gisLookup()` takes `gisAddressSignature()`
  before the fetch and drops the answer if the address changed while it ran; `_lastGis.addrSig` is that request-time
  signature. Before this, an edit during the lookup got the old parcel's answer, cached under the new address with the
  old PID, which the comps guard then accepted. Flag a new async county call that stamps a landing-time signature.
- **The site data on screen belongs to one address (v8.16, audit G16).** `_gisLot` ties the lot (polygon and edges,
  or the `SITE_FIELDS` width / depth / areas), the zone and the setbacks to the address a County GIS lookup answered, or
  a reopened deal with a saved parcel. It keeps the county's spelling (`_lastGis.mpt`) too. When the address is committed
  as another property (the fields' `change` event, compared with `addrWords()` so "Dr" / "Drive" is the same street) or
  a lookup starts for one, `clearGisSite()` clears them. So does a refused lookup for the tied address. Every status
  line then carries "Put them back" (`putBackGisSite()`, after which the data is untied) until a lookup loads data. A lot
  drawn on a fresh page is tied once a lookup loads zoning or a parcel for its address. Before this, the last deal's lot and fit
  results stayed under a new address, including after a lookup that found only zoning or nothing. On reopen, a saved
  parcel whose `matched` address isn't the deal's (`gisMatchFits()`: deals saved before v8.16 can hold a G1 parcel) is
  flagged and its whole County GIS record dropped. The flag is saved with the deal (`gisMismatch`) until a lookup loads a
  lot polygon. Only records from before the v8.16 matcher get that check: a record with `mpt` was matched by it.
  Units: `addrWords()` keeps "1207-A" as one house number, and the reopen check ignores a typed unit.
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
  - This was the suffix part of G2; v8.16 did the county part (a GIS result always sets Mecklenburg).
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

### Buildable envelope & plan fit (poly mode, v8.19)
Every County GIS lookup switches the lot to poly mode (`loadParcelPolygon` → `setLotMode('poly')`), so this is the path
most deals take.
- **`loadParcelPolygon()` merges, then designates.**
  - `mergeParcelRing()` drops each vertex that sits within 0.5 ft of the line its neighbours make (1 ft next to a piece
    under 2 ft), but only while the merged line stays within 1 sf of the county's. So a GIS lot's area stays within a
    few sf of the county shoelace. It carries the proxy's ROW flags (by length) and front edge along.
  - `designateParcelEdges()` then sets:
    - front = the proxy's front edge plus the rest of the street line: ROW edges within 45° of it, and collinear
      edges. Past 45°, a run of short ROW chords is front as a cul-de-sac bulb, unless it reaches a longer street edge,
      when it's a side street's corner radius (corner);
    - rear = among the back-facing edges that reach within 30 ft of the deepest point (**ROW edges included**: alley
      and through lots), the most length facing the street, weighted by depth, plus the rest of that line (pieces that
      face away squarely, or within 15° of the last rear piece), plus any other squarely back-facing edge 6 ft+ within
      those 30 ft or at least 40% of the lot's width (an L-shaped lot's step; a notch stays a side);
    - corner = ROW edges running on from the front that turn 45° or more away from it (a side street), and the pieces
      that follow it bending gently (a curving side street). A ROW piece the corner walk reaches that runs back within 45°
      of the street is front (street line past a longer jog). A reached ROW piece never ends up a side;
    - each walk passes over one jog of up to 15 ft, which stays a side (the corner walk starts past a jog the front walk
      stepped over).
  - With no street edge (`front_index` null), the front is `initEdgeDesignations()`'s lowest-edge guess, and
    `#edge-auto-note` says so.
  - Flag a change that goes back to one front and one rear edge, skips ROW edges as rear candidates, or makes every edge
    a side when no front is found (audit G3, G13, G14).
- **Edges are `'front' | 'rear' | 'side' | 'corner'`.**
  - `edgeSetbackFt()` is the single reader. Corner uses `sb-corner`; a blank Corner Side falls back to `sb-sides`.
  - The editor's edge click cycles all four (audit G5).
- **The envelope is the lot minus each edge's setback band** (`buildEnvelopeFt()`).
  - It is worked as disjoint convex pieces cut with `clipHPLabFt`, then joined back into outlines.
  - At a convex corner a band runs on past the edge's end inside the next lot lines, as far as the first concave corner.
    So a convex lot comes out as the lot clipped by every edge's offset half-plane. On a concave lot the run-on can't
    cut across the lot beyond that corner.
  - A straight corner, or one that turns inward by under 0.5° (a GIS dent, a whole-pixel corner from an old save), doesn't
    stop another edge's run-on. Of its own two pieces, only the one with the larger setback runs on past it.
  - At a concave corner the band stops square and a cap covers the corner (true distance). On a concave lot the convex
    corners get caps too, for where the lot carries on past a short neighbour. Each edge's setback also applies on the
    far side of its line there, since a lot that wraps round a sharp corner can come back within it.
  - A repeated corner (a zero-length edge, e.g. a deal saved at whole pixels before v8.19) is dropped first.
  - The result can be several outlines, in `planOverlay.buildPolysFt` (largest first, which is `buildPolyFt`). It can
    also be none, when the setbacks meet across the lot: `clearEnvelope()` then nulls `buildPolyFt`, so nothing is
    fitted into a stale outline.
  - Flag any return to intersecting neighbouring offset lines. That left spikes into the setbacks and turned inside out
    when the setbacks met across the lot (audit G4, G12).
  - This half-plane reading is stricter on irregular lots with obtuse corners than "distance to the nearest point of
    the lot line". Flag a change that switches between the two without saying so.
- **Fit check.**
  - A convex envelope uses the exact half-plane solver (`polyIsConvexFt` ignores turns under 1.5°).
  - A nearly convex one gets the exact solver first, then `planFitsSamplingFt()` if that finds no "fits".
  - A non-convex one uses `planFitsSamplingFt()`: the exact solver on the envelope's kernel, then `rectFitsPolyFt()`.
    That tests the whole rectangle (no envelope edge inside it, and its centre inside). It is exact across x and tries y
    at every vertex height and every 0.25 ft, within the heights where the rectangle fits the convex hull.
  - "Fits" (5 ft clear) on a non-convex envelope is the same test in the envelope shrunk 5 ft (`buildEnvelopeFt` with
    5 ft on every edge, cached on the ring as `_e5`). That's the same distance rule the convex path uses.
  - Neither can report a placement that isn't inside the envelope. Flag a corners-only containment test (audit G6).
  - Speed: each verdict is kept on its ring (`_fit`), and one plan's verdict settles smaller or bigger plans (a fit is
    monotone in size). While a lot corner is dragged, `renderFitCheck()` waits for the release (`_fitHeld`). A first
    draw on an irregular envelope can still take up to ~200 ms.
- **`redrawEditor()` owns `buildableArea` in poly mode**, as the envelope's area (all pieces). `updatePolyStats()` must
  not assign it (v8.3).
- **`polyPoints` keep 1/100 px**, not whole pixels, which moved GIS corners up to 0.15 ft.

### Deal-sheet hand-off (v8.21)
After the first underwrite, a deal moves to its **locked Google Sheet** and every later change happens there (Brian,
2026-10-01). The Underwrite's **Send to deal sheet** (`sendToDealSheet()`) opens `api/deal-sheet#uw=<base64url JSON>`.
`api/deal-sheet.js` answers 302 to `NEW_DEAL_URL?from=analyzer`, the team's **New Deal** web app (Apps Script project "UW Template -
Formula Lock & Color Code", owned by management@, executes as management@ so the copy keeps the template's formula
locks; access: anyone signed in with a Google account). The browser carries the `#fragment` across the redirect without
sending it in either request (Vercel never sees the deal); the New Deal page reads it with
`google.script.url.getLocation()` and passes it to `createDealFromAnalyzer()`, which copies the V1.1 template into Underwritten, fills the green input cells, ticks the matching
Upgrades rows, writes the comps, and adds a locked **Analyzer Snapshot** tab (site facts, the analyzer's
worst/base/best, and analyzer-vs-sheet rows with the reason for each gap). Rules:
- **`NEW_DEAL_URL` is a Vercel env var only** (Production + Preview), like the permits feed: the repo is public. Flag the
  /exec link appearing in `index.html` or any committed file. `deal-sheet.js` refuses anything that isn't a
  `script.google.com/.../exec` (or `/dev`) URL and answers 501 with a set-up note when it's missing.
- **The payload is read through the exporters' readers** (`getReportData()`, `collectModelInputs()`, `moneyIssues()`),
  not from input fields directly, so the sheet starts from the numbers on screen. (Max land is `getReportData().maxLand`,
  the on-screen text; the snapshot only displays it.) Per-site figures (land, lot factor, survey,
  appraisal, insurance) are sent as site totals; the Apps Script divides them by Units for the sheet's per-unit model.
  Its `v` must equal the script's `HANDOFF_VERSION`: changing a field's meaning means bumping both.
- **The sheet is the deal's home after the hand-off.** The script matches an existing Underwritten sheet by street
  (+ city) and then only opens it; it never writes to an existing sheet; the address form uses the same match. A copy that fails while
  being filled is trashed, so it can't block the retry. Don't add an "update the sheet" path.
- **No new storage:** the "sent" record (`_sheetHandoff`, `{ts, street}`) rides in the deal itself (`serializeDeal()` /
  `restoreDeal()`, so the existing autosave key). The banner and the button label are display-only
  (`renderSheetHandoff()`), shown while the deal on screen is the one sent (`isSentDeal()`: same `addrWords()` street,
  same city when both have one). A blocked pop-up is not recorded as sent.
- Sending is blocked without a street, a plan or a Base ARV, or while `moneyIssues()` has a note.
- The sheet's locked formulas don't follow the app's math in several places: it adds 14% to upgrades, finances 60% of
  land + 100% of build, prices survey at $1,000 / $2,000 per unit and sale costs at 5% + 1%, and its Worst / Best are
  Base ∓ $10/sf. The hand-off doesn't force the sheet to match; it records both in the snapshot. Changing the
  template's formulas is a separate decision for the partners.
- The Apps Script source is not in this repo; a reference copy lives in Brian's project folder
  (`New Dev UW'er 5000/Code.gs.v3-analyzer-handoff-*.gs`). The Apps Script side is changed by pasting the whole
  Code.gs and publishing a **new version of the existing deployment** (Deploy › Manage deployments › edit), which
  keeps the /exec link.

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
  Reference numbers since v8.19:
  - 2723 via County GIS: 4 corners, edges `side, front, side, rear`, lot 7,145 sf, envelope **3,309 sf**, fit
    17 / 16 / 17. It was 3,327 sf with fit 10 / 14 / 26 before the envelope rebuild.
  - 3 × Dayton Townhomes, land $75,000, $265/sf: Max land **$262,309**, lot factor $25,850.
  - Rect mode, N1-B: 40×180 → 3,540 sf, 80×180 → 8,260 sf.
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
