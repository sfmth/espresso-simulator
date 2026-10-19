<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Puckworks web app

The browser front end of Puckworks: a static site (Vite, React 19, TypeScript)
that runs the Rust core `puckcore` as WebAssembly in Web Workers. Nothing you
enter leaves the browser: no backend, no analytics, no cookies, no third-party
requests (see [docs/PLAN.md §7.7](../docs/PLAN.md)). Recipe drafts and named
recipes use `localStorage`; the Dial-in journal and local fits use IndexedDB.
Unavailable storage is visibly labelled as session-only. Export a backup to
preserve journal data when clearing browser storage.

The header has three modes, **Dial-in**, **Lab** and **Explore** (Explore
arrives in M5). The Lab has two views:

- **Shot lab**, the M1 lab view described below;
- **Kernel verification**, the M0 demo: diffusion out of a sphere into a
  perfect sink, solved by puckcore and compared with Crank's analytic solution.

Version 0.8.0 adds the experimental Dial-in workflow. Basic controls edit the
shared Lab recipe. Save a Tier 1 forecast before pulling, attach measurements,
fit local permeability (optionally particle size), and search recipe, cup or
next-shot targets with equipment constraints and Tier 1 rechecks. A journal
backup round-trips JSON; measured logs import canonical CSV or inert DE1 `.shot`
text. Personal rating estimates remain separate from the core taste indices.
The [M4 contract](../docs/model/m4-dial-in.md) specifies assumptions, limits,
prospective score rules and the distinction between synthetic verification
and V9 accuracy, which remains open.

Local services live in `src/dialin/`: `journal.ts`/`journalValidation.ts` own
transactional persistence and boundaries, `imports.ts` reads shot logs,
`calibration.ts`/`inverse.ts` orchestrate the existing engine worker, and
`learning.ts` fits personal ratings. `DialIn.tsx` renders the workflow;
`useJournal.ts` publishes state only after a committed save.

Version 0.6.0 adds M2 cup chemistry: the compound catalogue, bean storage and
origin descriptors, brew-water analysis, and separate acidity, aroma, phase and
refractometer estimates. Existing recipe files and saved drafts keep working;
omitted M2 inputs use documented defaults. Chemistry can be disabled to use the
legacy four tracked species. The chemistry panel labels assumptions and proxies;
sensory scores remain outside this milestone.

Version 0.3.0 adds M1.1 startup physics. The sandbox exposes the pore-water capacity,
pore-air mobility and moisture-diffusion estimates with their sources and evidence grades.
The results note links to the current [validation report](../docs/validation/m1-validation.md);
remaining timing and extraction limitations are reported there.

## The shot lab

A shot is described as a recipe (`puckworks.recipe/1`,
[docs/model/m1-contract.md](../docs/model/m1-contract.md)): every block can name
a preset or describe the gear from scratch (PLAN §1.2, principle 7). The engine
builds it into a physical spec (`buildShotSpec`) and simulates it
(`simulateShot`; `simulateRecipe` does both).

**Inputs** (left column, one folding section per block, each with a one-line
summary and a problem count; a section opens by itself when a new problem
appears in it):

- **Bean**: preset (or the default bean), Arabica share, roast level, days off
  roast, process, bean temperature, growing altitude, variety group and storage.
  Empty fields show the preset's value. Altitude and variety are recorded
  descriptors; no universal composition multiplier is assumed for them.
- **Brew water**: alkalinity and total hardness (mg/L as CaCO₃), calcium,
  magnesium, source-water TDS (mg/L), and pH. Empty fields retain the illustrative
  defaults; no analysis is inferred from a water brand.
- **Cup chemistry**: enable/disable M2 post-processing, time after extraction,
  closed cup headspace, refractometer sample temperature, and mineral-blank
  subtraction. All choices round-trip through recipe import/export and storage.
- **Grinder**: a preset and its dial (or a burr gap); a burr family with a gap
  (or a dial setting and its calibration); or a measured PSD pasted as two
  columns from a spreadsheet or instrument export (tabs, commas, semicolons or
  spaces, decimal commas accepted; header lines and `#` comments skipped, but a
  line starting with a number that cannot be read is reported; coarse-to-fine
  rows reversed; a cumulative “% passing” or “% retained” column is refused),
  with its measurement method. Calibration (gap at the reference setting, gap
  per unit), PSD shape (X50/gap ratio κ_G, fines at 340 µm u_G, coarse width
  σ_c, boulder share w_b), burr diameter and rpm are under **Advanced**, which
  stays open while any of them is set; the section summary lists them, and
  choosing another preset or mode clears them (switching between a preset and
  a family keeps the burr gap).
- **Basket**: a preset, the machine's default, or a custom shape: a table of
  (height, inner diameter) points (straight, tapered or stepped walls), the
  perforated diameter, the open area, and plain holes or a pressurised orifice
  with its discharge coefficient. Checked as the builder checks it, with inline
  messages, and drawn live in SVG at true proportions, with the bed at the
  height the last build computed. **Edit a copy as a custom basket** starts from
  any preset.
- **Puck preparation**: dose, distribution, tamp, puck screen, papers.
- **Machine**: preset or none; temperature; group headspace; whether a
  three-way valve vents the group after the shot (no drip into the cup; the
  checkbox starts at the preset's value, and only a choice that differs from
  it goes into the recipe as `machine.vent_headspace`); the program (phases
  holding a pressure or a flow, or running the pump at full power, with ramp,
  limit and end conditions; add, remove, reorder; starts as a copy of the
  preset's); the pump (the preset's, ideal, or vibratory with an optional
  OPV). The empty fields of a pump described here take the preset pump's
  values when it is of the same type, else the registry defaults; each
  placeholder says which ("7 from the preset" or "16 (registry default)"), and
  switching to the preset's pump type copies its values into the fields.
  Choosing another machine preset brings its program, pump and vent default
  (with an undo when it drops your own program or pump).
- **Stop and numerics**: beverage mass and/or time; the tier Run uses (0
  preview, 1 standard); the number of size classes.
- **Sandbox overrides**: a searchable browser of the parameter registry (id,
  value, unit, range, tag, evidence grade, sources), by default limited to the
  parameters the last build used, where any parameter can be given your own
  value; overridden parameters are marked and can be reset one by one or all
  at once. Overrides of ids this version's registry lacks (an old file or
  draft) are dropped with a notice, or listed with a Remove button.

Every preset picker shows the preset's description, flags (generic, estimated,
unverified, disputed, maintainer's own gear) and notes. Every field's valid
range is read from `../data/schema/recipe.schema.json`, the builder's
plausibility bounds, so the editor cannot drift from the builder; numbers may
use a decimal comma ("18,5"). After each build, the builder's notes
(assumptions, clamped inputs) appear in the section they concern, and an error
the builder reports (for example a dose that does not fit the basket) is shown
in an alert and next to the field it names; **Go to the field** opens its
section (and Advanced) and focuses it. A failure of the engine itself (a trap
or a lost worker) is reported as such, the worker is replaced, and **Retry**
runs again; after a trap, the worker first reads the Rust panic message from
the same WebAssembly instance (`lastPanic()`), and the alert (and a sweep's)
shows it under **Technical details for a bug report**. Recipes can be exported
and imported as JSON files (up to 5 MB; unknown fields are reported and
dropped), saved by name in this browser, and reset to the defaults; a reset, a
load or a machine change can be undone. The default recipe uses generic
presets, not anyone's own gear, with the generic grinder's own default gap
(published espresso fineness by particle size, not tuned to the model's shot
times).

**Runs.** While you edit, a debounced tier-0 run (≈ 5–20 ms) previews the
result, marked "Preview"; **Run** solves the recipe at its tier (tier 1 takes
up to about a second). A newer run always supersedes an older one, and late
answers are ignored. Returning to inputs that already have a tier-1 result
shows it again. With the live preview off, edits only build the spec (for the
notes and errors).

**Outputs** (right column):

- **Summary tiles**: shot time and stop reason, first drops, beverage mass
  (with the drip), ratio, TDS, EY, maximum pressure, bed height, headspace, the
  spread of local EY (SD, range, mean), mass-balance error, the outflow check
  (the solute in the cup against the integral of outlet flow × concentration,
  when the core reports it), runtime; solver warnings above them; a short
  statement of the model's status (`src/shot/modelStatus.ts`: the published
  experiments it was calibrated against, what the held-out tests show, linked
  to `docs/validation/m1-validation.md` in the source repository or naming it
  in a local build, and no uncertainty bands yet); a glossary; the builder's notes; downloads of the result (JSON), the series
  (CSV) and the recipe of the run. Each result is checked against the
  contract's shape, and a mismatch is reported.
- **Shot graph**: small multiples sharing the time axis and the crosshair,
  one unit each: pressure, flow in and out, beverage mass, TDS of the cup and
  at the outlet, EY, outlet temperature, wetted bed. Each legend reads out
  every series at the cursor and hides a series when clicked. A table view
  repeats the values.
- **Pinned runs** (up to six): each keeps its colour on every chart (current
  run blue, pins in the next palette slots); labels can be edited; a table
  lists the recipe fields that differ between the current inputs and the pins.
- **Particles**: the volume density per unit ln d on a log axis, with the size
  classes handed to the solver drawn as a histogram of the same density; X50,
  fines below 100 µm, D[3,2], D[4,3], the mixture components; EY of each size
  class at the end.
- **Compounds**: total dissolved solids and each tracked species (mass in the
  cup, extracted/recovered share, content in the dose), folded by family and
  searchable by name, family, K1–K6 transport class or phase. Trace inventories
  use µg/ng rather than disappearing into rounded zeros. Each row has a
  provenance column: the weakest evidence behind each, expandable to every
  registry record (tag, grade, sources), preset and recipe field used, plus
  catalogue transport/composition evidence. Gas/lipid recovery is shown as a
  separate phase, not dissolved extraction.
- **Cup chemistry**: estimated pH and titratable acidity at 25 °C, lipid and
  recovered CO₂ inventories, a crema-volume proxy, and a refractometer estimate
  kept separate from true coffee TDS. Expandable tables show acid speciation,
  closed-headspace aroma partitioning and thiol binding, and dissolved-solids
  accounting/transport closure. Water-threshold ratios are not sensory scores.
- **Cross-section**: local EY (or the solubles concentration in the bed
  liquid, per volume of liquid held there) over the solver's columns (however
  many the tier uses) and depth cells, drawn on the actual basket profile
  with the solver's own cell faces (`spatial.depth_edges_m`) and mirrored
  about the axis; a snapshot scrubber with play. Cells the water has not
  fully reached are hatched (dry ones grey), and a dashed line marks the
  wetting front in each column; the read-out says "dry", "wet" or the wetted
  share, and where the front is. A colour legend (each snapshot on its own
  scale, or one for all; local EY is never negative in this core, and a
  diverging red–grey–blue scale remains only as a fallback for results that
  dip below zero); depth optionally stretched; cells readable with the
  pointer or, after focusing the figure, the arrow keys; table views of the
  values and of the wetted shares.
- **Sweep**: vary one input (dial setting or gap, dose, temperature, stop
  mass or time, a program phase's target, roast, age, Arabica share, size
  classes, or any registry parameter) over a range of 2–41 points, at tier 0
  or 1, with progress and Cancel; one small chart per chosen output (EY, TDS,
  shot time, beverage mass, maximum pressure, first drops, EY spread); points
  the builder rejects are listed with the reason; sweeps can be pinned and
  overlaid when they vary the same input; CSV download.
- **Provenance**: every spec field the builder set and where it came from, the
  bean and bed as modelled, and the complete ShotSpec as JSON (to read or
  download).

## Prerequisites

- Node.js `^22.22.2 || ^24.15.0 || >=26` and npm.
- Rust through rustup (the toolchain is pinned by `../rust-toolchain.toml`,
  including the `wasm32-unknown-unknown` target) and the wasm-bindgen CLI at
  exactly the version pinned in `../Cargo.toml`:
  `cargo install wasm-bindgen-cli --version 0.2.129 --locked`. Cargo builds the
  engine, and `npm run build` and `npm run licenses` also ask it which Rust
  crates the engine contains (`cargo metadata --locked`).
- For `npm run e2e` only: Google Chrome (no browser is downloaded).

## Develop

```sh
cd web
npm install
npm run wasm     # builds the engine into src/engine/pkg/ (generated, not committed)
npm run dev      # http://localhost:5173
```

`build`, `typecheck` and `lint` stop with a clear message if `src/engine/pkg/`
is missing. Re-run `npm run wasm` after changing the Rust core.

## Test

| Command                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                        | Vitest. Pure logic: recipe form ↔ Recipe conversion and validation, PSD paste parsing, basket profile checks and geometry, cross-section geometry, sweep targets and plans, series → chart data, CSV export, recipe differences, provenance and note routing, storage fallbacks, thinning of long results, the worker message protocol (against fakes and the real WASM engine in Node) and the engine client. Components (jsdom + Testing Library, with a controllable fake engine, fake timers and a hand-written placeholder result in `test/fixtures/shotFixture.ts`): the shot lab's preview, Run, supersede and cancel races, builder errors next to their fields, every output panel, sweeps, pins, overrides, the custom basket, import/export and blocked storage; the M0 app. The engine in Node (`test/shot-engine.test.ts`): every preset and recipes from scratch build and simulate at tier 0 (two at tier 1) into results of the contract's shape, with cell faces, wetted shares, the outflow check and no negative local EY. The licence tools, and the cross-language checks below                                                                                                                                                                                                                                                                                                                                              |
| `npm run e2e`                     | builds, serves `dist/` with `vite preview` under a sub-path, and drives headless Chrome through playwright-core. Shot lab: presets load from the worker, the tier-0 preview appears, Run gives tier-1 numbers identical to the same recipe (exported from the page) run in Node, the cross-section scrubs and reads cells from the keyboard and hatches exactly the cells the Node result has not yet wetted at the first snapshot, a 5-point sweep runs, a pinned run overlays the charts and its differences are listed, recipe/result/series/sweep downloads work, a builder error lands next to its field, and with the group vented (three-way valve) the tier-0 cup holds the stop mass with no drip, as in Node. A recipe from scratch (measured PSD, custom pressurised basket, vibratory pump, flow program) imported through the file picker gives tier-1 numbers identical to Node. Keyboard focus moves to a neighbour after Unpin. Kernel verification: as in M0 (identical max error, large runs, cancel). Footer links, the model status's link to the validation report (or its file name in a local build), tabs, light/dark/phone screenshots in `test-results/`, no horizontal scrolling at 390 px, no request to another origin (the audit includes the engine workers and the WebAssembly they fetch), no console errors. Prints the tier-0 and tier-1 times measured in the worker. Set `CHROME_PATH` to use another Chrome |
| `npm run lint`                    | ESLint (typescript-eslint with type information, react-hooks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run typecheck`               | `tsc -b` over the app, worker, test and config projects (strict)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run format` / `format:check` | Prettier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `npm run licenses`                | checks the licences of everything shipped, against the allow-list of ADR 0007 (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Zlib, Unicode-3.0, Unicode-DFS-2016, CC0-1.0, BlueOak-1.0.0): every production npm dependency, transitively, and every third-party Rust crate compiled into the engine. It warns when a package can only be used under Apache-2.0, which makes the build GPLv3 (D12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Cross-language checks.** The WASM build, run in Node, must reproduce golden
files written by the Python tools through the native core, bit for bit (every
number identical with `Object.is`, every string and key equal):

- `test/crosslang.test.ts` replays `../data/fixtures/sphere_cases.json`
  (`puckworks.sphere-cases/1`); `PUCKWORKS_SPHERE_FIXTURE` points it at
  another copy.
- `test/crosslang-shot.test.ts` replays `../data/fixtures/shot_cases.json`
  (`puckworks.shot-cases/1`: `{schema, core_version, generator, cases: [{name,
recipe, spec, result}]}`, contract §7), whatever cases it holds: for each,
  `buildShotSpec(recipe).spec` must equal `spec`, and `simulateRecipe(recipe)`
  and `simulateShot(spec)` must return `result` (the result's `core_version` is
  not compared; the file's must equal the engine's). It reports how many values
  differ, how many only in the last bit, and the largest relative difference.
  `PUCKWORKS_SHOT_FIXTURE` points it at another copy;
  `PUCKWORKS_SHOT_RESULTS=skip` skips only the result comparisons (CI never
  sets it).

Without a fixture each check is skipped with a message, except in CI (`CI`
set), where it fails.

## Build and preview

```sh
npm run build    # type-checks, then writes dist/
npm run preview  # serves dist/ locally
```

All asset URLs are relative (`base: './'`), so `dist/` works from any path,
such as a GitHub Pages project site. The build also:

- writes `dist/third-party-licenses.md`, linked from the footer: the notices of
  the bundled npm packages and of the Rust crates in the engine, with their
  licence texts (generated from `cargo metadata` on every build);
- injects the repository URL for the footer's **Source code** link from
  `PUCKWORKS_SOURCE_URL`, or in GitHub Actions from `GITHUB_SERVER_URL` and
  `GITHUB_REPOSITORY`. A local build without either says so in the footer
  instead of linking. With `PUCKWORKS_REQUIRE_SOURCE_URL=1`, which CI sets, a
  build without a URL fails;
- adds a Content-Security-Policy `<meta>` tag (no `unsafe-eval` and no inline
  scripts or styles; `wasm-unsafe-eval` for WebAssembly). It holds the page to
  its own origin, but a `<meta>` policy does not reach the engine workers, and
  GitHub Pages cannot send the HTTP headers a worker policy would need. The
  workers' requests are audited by `npm run e2e` instead. Downloads are made
  from Blob URLs created in the page.

## Deploy (GitHub Pages)

`.github/workflows/web.yml` runs the engine build, lint, format check,
type-check, tests, build, licence check and browser smoke test on pull
requests. `.github/workflows/pages.yml` runs on every push to `main` (and on
manual dispatch): it calls `web.yml` with every one of those checks, then
deploys exactly the build they passed. One-time setup: in the repository's
**Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
Third-party actions in both workflows are pinned to commit SHAs, with the tag
in a comment.

## Layout

```
src/
├── main.tsx, App.tsx, styles.css   shell: header, mode tabs, Lab views, footer, themes
├── store.ts                        Zustand store: mode, Lab view, the M0 panel's inputs and run
├── config.ts                       source URL, app version, notices file
├── engine/
│   ├── types.ts                    the sphere binding contract and the core module's functions
│   ├── shotTypes.ts                TypeScript mirror of Recipe, ShotSpec, ShotResult, derived,
│   │                               presets and registry (the Rust doc comments are the definitions)
│   ├── shotData.ts                 shot results in transfer form (Float64Array series, thinning)
│   ├── shotCheck.ts                checks a ShotResult against the contract's shape
│   ├── protocol.ts                 worker messages and the pure request handler
│   ├── decimate.ts                 thinning of long results inside the worker
│   ├── memory.ts                   memory estimate and worker-recycling limit
│   ├── engine.worker.ts            the worker: one WASM instance
│   ├── engine.ts                   Promise-based client (pool, queue, cancellation, recycling)
│   ├── EngineContext.ts            React access to the engine
│   └── pkg/                        generated by ../scripts/build_wasm.sh
├── shot/                           the shot lab
│   ├── ShotLab.tsx                 layout, catalog loading, run bar, alerts, output tabs
│   ├── shotStore.ts                its state: catalog, form, runs, pins, sweeps
│   ├── useShotRun.ts, useSweep.ts  race-free preview/full runs and sweeps
│   ├── recipeForm.ts, recipeFields.ts   form state ↔ Recipe, validation, labels and ranges
│   ├── RecipeEditor.tsx, editor/   the input sections; RecipeFiles.tsx: import/export/save
│   ├── psdParse.ts, basketGeometry.ts, BasketDiagram.tsx
│   ├── SummaryTiles.tsx, ShotCharts.tsx, shotChartData.ts, PinsPanel.tsx, diff.ts
│   ├── PsdPanel.tsx, CompoundTable.tsx, CrossSection.tsx, crossSection.ts
│   ├── SweepPanel.tsx, sweep.ts, ProvenancePanel.tsx, provenance.ts, RegistryBits.tsx
│   └── csv.ts, download.ts, storage.ts, notes.ts, glossary.ts, format.ts, fields.tsx
├── lab/                            the M0 verification panel, its inputs and run logic
└── components/                     mode tabs, generic tabs, uPlot line chart, chart theme
test/                               cross-language checks, engine test in Node, fixtures, licence tools
scripts/                            check-engine, check-licenses, rust-notices, spdx, e2e
```

**Engine and threads.** The client keeps requests in a FIFO queue and gives
each worker one request at a time. The app runs two workers, so a tier-1 run or
a sweep point never holds up the live preview; each loads its own WASM
instance once. Shot calls send plain recipe and spec objects; the worker writes
them as JSON for the core, parses the answer, and sends shot series back as
transferable `Float64Array`s (at most 4,096 points per series; a shot has a
few hundred to a few thousand). Errors come back as readable messages: a recipe
the builder rejects is `invalid-params` with the builder's text. SharedArrayBuffer
is deliberately not used, because GitHub Pages cannot send the COOP/COEP headers
it requires. Aborting a run that a worker is executing terminates that worker
(WebAssembly cannot be interrupted) and the next request starts a fresh one;
WebAssembly memory never shrinks, so a worker whose memory passes 32 MiB is
replaced after it answers.

**Large sphere runs** (Kernel verification). A run starts by itself only if it
has at most 200,000 steps and 50 million shell-steps; larger runs wait for
**Run**, and runs estimated to need more than 32 MB show their memory estimate
first. The worker sends at most 4,096 points per time series; the tiles'
numbers come from the core and use every point.

**Charts and accessibility.** Charts are uPlot with its CSS bundled locally,
one unit per chart (no second y axis). Colour identifies the run, in the fixed
order of a palette validated for colour-vision deficiencies in light and dark
themes (adjacent ΔE ≥ 8 under protanopia and deuteranopia); line style tells
two quantities of one run apart. Heatmaps use one blue ramp, light to dark (dark
to light in the dark theme), or a diverging ramp around zero, with a legend.
Every chart has a text summary and a table view; legends read out values under
the cursor, sit outside the chart's image role, and toggle series by click or
by keyboard (Enter or Space). A new result updates the charts without
rebuilding them, and charts in hidden tabs update when shown. Inputs are labelled,
errors are tied to their inputs (`aria-describedby`, `aria-invalid`), help
buttons explain terms (EY, TDS, headspace, OPV, open area, discharge
coefficient, …), results for earlier inputs carry a badge, and only the plots
fade, so text keeps its contrast. Screen readers hear run outcomes, not every
edit or preview. Buttons that become unavailable are marked `aria-disabled`, so
the keyboard focus stays on them (Cancel, Pin, Up/Down), and removing a row,
a pin or an override moves the focus to a neighbour. Placeholders (preset and
registry values) clear 4.5:1 contrast. Each result panel has an error boundary,
so a failing panel never blanks the page. Light and dark themes
follow the system setting; the layout works down to phone width.
