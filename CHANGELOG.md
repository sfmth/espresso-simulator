# Changelog

All notable changes are recorded here. Versions follow semantic versioning. While the major version is 0, minor versions add features and patch versions fix problems.

## [0.11.0] - 2026-10-19

M6 offline scalar surrogate tooling. The browser continues to use physics; the
first neural baseline fails its declared accuracy target and is retained as an
experimental result. Physics, calibration and all 218,221 golden numerical
values remain unchanged.

### Fixed
- New/reset browser recipes enable group venting by default. The standard 36 g
  recipe finishes at 36.000000014 g on Tier 1 (36.000000018 g on Tier 0), with
  zero modeled drip, instead of 56.812 g on unvented Tier 1. Explicit settings,
  imported/saved recipes and machine preset precedence remain intact. Solver
  defaults and the frozen unvented surrogate experiment are unchanged.

### Added
- A scalable machine/grinder/portafilter drawing with six connected, expandable
  setting bubbles. Quick controls share the full recipe editor's state, preset
  rules and validation; keyboard users can expand, close and move to full controls.
- Required first-visit equipment and starting-shot setup, native builder checks,
  editable local profiles and graceful session-only use when storage is blocked.
  A fixed first-party completion cookie contains no equipment values or identifier.
  This owner-requested exception to the no-cookie policy is documented in D9 and
  the privacy page; settings remain in local browser storage.
- Reproducible native Tier 1 sampling: 256 training, 64 residual-calibration,
  128 final-test and 16 boundary rows, with no failed/capped samples. Generation
  took 99.20 seconds with four local workers; this is not a device performance gate.
- A fixed three-member 4 → 16 tanh → 3 ensemble using existing NumPy/SciPy
  dependencies. Time, final cup mass and EY are learned; derived TDS preserves
  the final-mass identity, including post-stop drip.
- Frozen evaluation, separate approximation-error bands and explicit failed
  qualification. Maximum test/boundary mass errors are 1.287/3.837 g; all three
  fits reached the fixed 2,000-iteration limit. The full
  [evaluation](docs/validation/m6-surrogate-validation.md) records every output
  and coverage result. No settings were tuned after viewing held-out errors.
- Bounded JSON artifacts, strict recipe-domain and current-teacher checks,
  replay of sampling/scales/metrics from saved data and weights, cancellation
  checkpoints and actual Tier 1 fallback. CI replays the committed evaluation;
  models stay outside the production app. Scientific, personal accuracy,
  hardware performance and M6 launch gates remain open.

## [0.10.1] - 2026-10-19

M6 accessibility fixes. Physics, calibration and all 218,221 golden numerical values
remain unchanged.

### Fixed
- Explore camera orbit, zoom and reset are available from the keyboard, with an
  explicit way to cancel frame-rate measurement. The timeline announces actual
  seconds; selected cells and particles expose the values used for their colours.
- Chart text readers cover every plotted sample and pinned run, including values
  absent from the existing 11-row current-run table.
- Journal actions identify their shot, focus the measurement form when opened,
  and restore focus after save/delete. Editing the full recipe focuses Lab.
- Initially invalid recipe sections open, filtered compound groups can be
  collapsed, parameter override names identify the parameter, and recipe heading
  levels and preset evidence groups have consistent semantics.
- Connection status reconciles browser changes that happen before startup
  listeners attach. The offline browser suite tests native connection signals
  separately from its blocked-transport/cache assertions across Chrome versions.
- Production accessibility and keyboard regressions run alongside offline/update
  checks in CI. Local Chrome audits pass 14 states with zero detected rule
  violations and 30 keyboard/data/layout assertions; all 739 web tests pass.
  Manual-review items remain in the report; assistive technology and
  physical-device testing remain open.

## [0.10.0] - 2026-10-19

M6.1: offline support. The simulator remains experimental; this release does not
close the scientific, prospective accuracy or device-performance gates.

### Added
- Installable app metadata and a complete offline copy of the production app,
  including the WASM engine, both workers, lazy Explore renderer and notices.
- Offline readiness and update controls. A new release waits for an explicit
  reload, and older tabs retain their required assets. Failed downloads preserve
  the previously installed release.
- A local privacy and storage page covering browser databases, cached app files,
  backup/export, reload behavior and GitHub Pages hosting logs.
- Automated offline and update checks under a repository subpath, alongside
  cache-policy and runtime lifecycle regressions.
- Release metadata refreshes retain all 218,221 golden numerical values.

## [0.9.2] - 2026-10-19

### Fixed
- High-resolution Explore cross-sections expose all 150 depth cells in a
  scrollable cell detail view, with visible boundaries and the actual grid
  dimensions. Overview remains available, and cell selection stays in view.
  Local Chrome measurements increased refined row height from 1.21 px to
  4.01 px on desktop; cell detail also retains 4.01 px rows at phone width.
- Changing resolution now identifies the previous grid until Run Explore
  computes its replacement. Display particle count remains independent of the
  solver grid; refinement changes depth, not the number of radial columns.
- Physics and golden numerical outputs remain unchanged.

## [0.9.1] - 2026-10-19

M5 rendering performance measurements and sphere rendering improvements.

### Changed
- Tighter projected sphere bounds and vertex rejection avoid shading outside
  exact sphere coverage or the selected cut/frustum. Conservative enclosed-sphere
  rejection skips redundant opaque rendering with cut, camera, clipping and
  depth-precision guards. Particle counts, radii,
  picking and coupled extraction remain unchanged.
- A reproducible fixed-camera benchmark warms up for at least 1.5 seconds and
  30 submissions before a five-second orbit. Reports include median/p95 frame
  intervals, CPU submissions, optional asynchronous GPU timing, actual backend,
  pixel dimensions, quality and cancellation status, with local JSON export.
  Repeated RAF timestamps are omitted before rendering/counting and reported;
  backward or persistently stalled clocks cancel cleanly instead of freezing.
- A fail-closed normalizer instruments the frozen M5 production build with the
  same measurement protocol without changing its renderer. A local Chrome
  driver repeats measurements at the four standard display counts.
- See the [rendering performance evidence](docs/validation/m5-rendering-performance.md)
  for measured results and quality comparisons: median software cadence changes
  by +6.6% at 30k and +8.8% at 25k, but p95 worsens; 5k regresses by 4.1%.
  The available high-end GPU retains roughly 239 fps RAF cadence at 30k/150k.
  These are local observations, not general speedup or presentation guarantees.
  Midrange laptop and physical
  phone G5 validation remains open; high-end GPU or phone-size viewport results
  do not establish those gates.
- Versioned fixtures and verification reports retain every golden numerical
  value. Physics, parameters, calibration and source splits are unchanged.

## [0.9.0] - 2026-10-18

M5 experimental Explore, including the requested 5× resolution option.

### Added
- A representative 3D particle volume, orbit/zoom and cutaway, particle picking,
  exact coupled kernel-shell inspection, a synchronized puck cross-section and
  stored-snapshot playback. Seven guided scenarios share Lab's recipe and
  controller, support Undo, and retain their assumptions.
- Optional selected-cell exports copy actual Tier 1 shell concentrations,
  surface-pool fractions and class extraction. Statistical particle weights
  reproduce the selected continuum cell's local EY; missing or inconsistent
  coupled data stays unavailable.
- High resolution refines depth from 30 to 150 cells with the same parallel 1D
  model. Independent display options increase desktop particles from 30,000 to
  150,000, or mobile particles from 5,000 to 25,000. This is depth refinement;
  the future 2D Tier 2 model remains deferred.
- Deterministic worker-based approximate packing and an illustrative
  clearance-based pore lattice with CG diagnostics. The geometry does not
  predict absolute permeability or change the continuum simulation.
- Lazy-loaded MIT-licensed Three.js/WebGL2 rendering, current-device frame-rate
  measurement and an SVG/data fallback when 3D is unavailable. WebGPU is not
  required. [M5 contract](docs/model/m5-explore.md),
  [ADR 0015](docs/decisions/0015-explore-state-and-refinement.md) and
  [verification record](docs/validation/m5-validation.md).

### Verification
- All 641 web, 439 Python and 272 Rust tests pass; one existing opt-in Rust
  preset sweep remains ignored. Chrome checks both resolution grids, all four
  particle counts and inspection fallbacks, with no foreign requests or console errors.
- Standard opt-in export preserves every existing numeric output exactly.
  Native and actual-WASM checks verify weighted class/cell consistency and the
  fivefold refined depth grid. Full default refined runs retain finite bounded
  concentrations and hydraulic/solute residuals below 1e-9.
- A native default-recipe measurement took 0.951 s standard and 4.866 s refined;
  these are local samples, not target-device performance guarantees. Software
  renderer measurements and remaining hardware G5 gates are recorded in the
  M5 verification record. Existing empirical accuracy gates remain open.
- Default golden fixtures retain every numeric value; only core-version metadata
  changes. No physical parameters, calibration coefficients or data splits change.

## [0.8.0] - 2026-10-18

M4 experimental Dial-in, selected by the owner. Personal measurements remain
optional; the prospective V9 accuracy target remains open.

### Added
- Shared barista recipe controls and an IndexedDB shot journal with immutable
  prediction-before-measurement snapshots, transactional saves, stale-tab
  protection, visible session fallback and JSON backup/restore.
- Validated canonical CSV and inert DE1 shot-log import. Assumed recipe
  conditions and imported forecast provenance remain explicit.
- Bounded finite-grid Bayesian local permeability and optional grinder-size
  calibration, conditional credible intervals, identifiability diagnostics,
  cancellation and Tier 1 training rechecks. Startup, grinder zero,
  heterogeneity and machine offsets remain fixed and disclosed.
- Three inverse modes with equipment lattices, final-yield/drip corrections,
  independent Tier 1 verification, local sensitivity envelopes and stale-result
  protection. A Bayesian personal rating layer supports optional preference
  ranking without changing the chemistry's taste indices.
- Cancellation reaches queued journal updates and native transactions; imported
  record order does not override the newest observation or compatible fit.
  Personal rating displays use the same scope/version as ranking, and custom
  hardware constraints follow the recipe schema and machine basket defaults.
- Timing-only and complete time/EY prospective scorecards, excluding imported,
  backfilled and calibration-training forecasts.
- [M4 contract](docs/model/m4-dial-in.md),
  [ADR 0014](docs/decisions/0014-local-dial-in.md) and
  [verification record](docs/validation/m4-validation.md).

### Verification
- All 583 web tests pass, including 113 M4 checks. A real-WASM synthetic workflow
  recovers a known permeability multiplier and exercises all three inverse
  modes; these generated observations do not establish V9.
- Rust formatting, strict clippy and tests pass. All 437 Python tests are
  verified: 432 pass in the sandbox and five filesystem/process checks pass
  when rerun outside its restrictions.
- Native golden fixtures retain all 214,018 shot and 4,203 kernel values
  exactly. M0/M1/M2/M3 reports are regenerated against version 0.8.0; existing
  scientific failures remain open. No physical coefficients or original
  training/held-out splits change.

## [0.7.0] - 2026-10-18

M3 development: performance, input uncertainty, then explainable taste. M2 is
integrated; the existing calibration and M1/M2 scientific targets remain intact.

### Added
- Reproducible input ensembles for grinder/PSD, roast age, composition and water,
  with unknown/measured/fixed controls, registry-backed scenario widths and
  exported assumptions. Percentile ranges describe input scenarios, not calibrated
  confidence or predictive intervals.
- Relative acidity, bitterness, astringency and body indices in the shared Rust
  model, with chemistry drivers, source references and low trust. Input uncertainty
  propagates to taste; sensory model error and individual differences remain open.
- Browser uncertainty and taste views, cancelable worker runs, stale-result labels
  and full report export. Central Tier 1 predictions remain distinct from Tier 0
  ensemble results.
- [M3 verification report](docs/validation/m3-validation.md) and
  [ADR 0013](docs/decisions/0013-m3-scenario-bands-and-taste.md).

### Performance and verification
- Buffer reuse reduces allocation/reallocation requests from 18,044 to 7,797
  (56.8%) for the browser-default spec. Full M2 Tier 1 runtime is effectively
  unchanged; loaded Tier 0 medians have overlapping ranges. The
  [performance report](docs/validation/performance.md) records timing and exact
  complete-output comparisons; throughput targets remain open.
- Verification passes 263 Rust tests (one existing opt-in sweep ignored), 437
  Python tests, 470 web tests and 19/19 M3 report checks. Native golden fixtures retain all
  214,018 shot and 4,203 kernel values exactly; the browser E2E checks pass.
  Full-shot correctness-test scheduling deadlines are separate from performance
  targets. Existing fitted coefficients and scientific validation gates are unchanged.

## [0.6.0] - 2026-10-17

M2 development: chemistry, beans and water. The owner selected the next milestone after the
novel-shot diagnostic; M1 scientific targets and the v2 calibration remain unchanged.

### Added
- All 55 planned compounds plus legacy acid/unassigned-solids diagnostics, shared K1–K6
  transport bases, separate K5/K6 inventories and explicit independent transport closure.
  Composition and transport estimates carry registry evidence and sources.
- Bean altitude, variety and storage descriptors, explicit storage/process scenarios, and
  three additional generic bean presets. The measured M1 analyte anchors remain intact.
- Source-water controls, effective 25 C polyprotic/carbonate buffering, pH and titratable
  acidity; cup-headspace aroma partition and thiol binding; separate gas/oil recoveries,
  crema-volume proxy and a mineral/temperature-aware optical observation.
- Searchable compound families and a cup-chemistry view, editable observation conditions,
  persistence/import/export support, and optional raw-spec chemistry for old JSON inputs.
- Audited Gloess 2013 publisher data (CC BY 2.0), `m2-validate`, and a conditional comparison
  report. Missing source inputs remain explicit and do not establish a V7 pass.
- Numerical/speciation, phase-accounting, browser and cross-language regression checks.
  Verification and actual comparison results: [M2 report](docs/validation/m2-validation.md).

### Preserved
- The pre-M2 [0.5.0 validation](docs/validation/baseline-v0.5.0/README.md), unchanged fitted
  parameters and M1 case boundary. No new data enter the numerical fit.

### Changed
- Bound the three existing mineral-diffusivity admissibility ranges to the
  supported solver interval as M2 starts using them; their measured values,
  priors and sources are unchanged.

### Verification
- 243 Rust tests pass (one existing opt-in sweep ignored), alongside 413 Python
  and 458 web tests. Formatting, strict clippy, lint/type checks, production
  builds, dependency licences, registry/export/release checks and browser E2E pass.
- Native fixtures match 214,018 shot values and 4,203 kernel values exactly;
  browser/native results agree. Seven legacy raw specs retain all 82,342 numeric
  values bit for bit, including signed zero. Original M1 predictions are unchanged.
- Conditional Gloess comparisons meet the compound band in 5/16 scored pairs;
  independent dissolved transport closure meets 5% in 6/8 scenarios. Missing
  experimental inputs keep independent V7 validation open. The M2 configuration
  also remains above the roadmap's performance targets; see the model notes.

## [0.5.0] — 2026-10-16

Experimental upstream pressure storage for bloom pauses. It is opt-in; default recipes keep
zero compliance and the v2 fit. M1 scientific validation remains open and M2 stays deferred.

### Added
- `machine.hydraulic_compliance_m3_pa` tracks charged carrier volume C P, with a conservative
  implicit pressure step. A pump pause can release stored water through the bed. Pressure caps
  throttle the inlet without venting; a final vent discharges headspace and storage. Without a
  vent, only charged storage supplies the optional tail. [ADR 0011](docs/decisions/0011-upstream-pressure-storage.md)
  records the boundary assumptions and omitted mechanisms.
- Registry override `model.machine.hydraulic_compliance` (mL/bar), with unit conversion,
  provenance and an experimental note. Its default is zero; neither a fitted value nor an
  empirical prior is assigned. The registry now has 231 parameters.
- Cumulative inlet, outlet and vented carrier volumes, charged storage and total retained
  volume in shot results. Interval diagnostics use cumulative-volume differences and keep
  carrier volumes separate from beverage mass and dissolved solids.
- Fixed 0/0.5/2 mL/bar community probes, including logged low-flow and counterfactual zero-flow
  plateaus. They report pressure decline, storage depletion and interval conservation.
  Sources remain local and the original calibration/held-out split and gates stay unchanged.

### Verification
- Analytical RC charge/discharge and pump-curve checks, plus ten compliance regressions covering
  dry waiting, pauses/resumption, low-flow bloom, partial wetting, tail/vent, lowered pressure
  caps, time refinement, mass/pressure events, ramp-flow reporting and charging without a false
  choke. Rejected transport steps restore the stored-pressure state.
- Native/WebAssembly fixtures add pause/resume cases with a stored-water tail and a stop vent;
  browser transfer and export preserve the new arrays, while result validation accepts older
  records without them.
- The output-memory guard includes all five new inventory channels. Full-record tracking
  errors stay unavailable for incomplete community runs, and flow tracking consistently
  excludes the final-stop sample.
- Final local checks pass: 219 Rust tests (one existing opt-in sweep ignored), 406 Python
  tests, 445 web tests and 55 browser assertions. Formatting, clippy, lint, type checks,
  production build, dependency licences, registry export and release-version checks pass.
  Native fixtures are exact over 83,312 shot values and 4,203 kernel values; seven shot
  cases replay exactly in WebAssembly. All 51,614 pre-existing result numbers remain
  bit-identical, including signed zero.

### Experimental results
- All 170 fixed community simulations complete. With the largest hypothesis (2 mL/bar),
  logged-flow-target probes give 5.52–6.08 g of bloom cup gain, versus 3.02–5.85 g observed;
  end-bloom pressure remains only 0.0174–0.0177 bar, versus 0.72–1.08 bar observed. The
  [report](docs/validation/community-shot-comparison.md) retains both observables: these
  scenarios demonstrate a storage response, not a calibrated explanation of the shots.
- Halving the step from 0.05 to 0.025 s in the fixed 0.5 mL/bar zero-command case changes bloom
  outlet volume by 0.00821 mL (3.09%), storage depletion by 0.00960 mL (3.15%) and record-end
  cup mass by 0.0209 g. This one-case sensitivity check does not bound all scenario errors.
- Worst relative hydraulic and solute residuals across the community runs are 7.17×10⁻¹⁴ and
  2.35×10⁻¹⁴; worst bloom-interval volume residual is 7.88×10⁻¹² mL. Numerical conservation
  does not establish experimental accuracy.
- All 117 original validation simulations complete and their predictions, fit-quality blocks,
  scores and diagnostics are unchanged. The v2 coefficients remain untouched; cached
  leave-one-condition-out refits retain their historical identity. No complete M1 scientific
  exit criterion passes.

## [0.4.0] — 2026-10-16

Offline community-shot comparisons. M1.1's physics and fitted values remain unchanged; M2 stays deferred.

### Added
- Safe literal-data parsing of DE1 `.shot` files, without executing Tcl. The Gagné importer verifies source hashes, joins the original 11 traces to their measurement log and preserves signed scale readings and missing observations.
- `puckworks-tools community` runs reproducible comparisons against fixed model scenarios using local source files. Recorded pressure drives are conditional diagnostics, not pressure predictions; unknown PSD and geometry remain explicit scenario assumptions. No community observations are fitted and no validation thresholds change.
- The [community comparison report](docs/validation/community-shot-comparison.md) examines startup and the nominal bloom pause, distinguishing the recorded 0.0625 mL/s flow floor from an exact pump-off command. Downloaded sources and detailed results stay outside tracked data, under an ignored local directory by default.

### Documentation
- Record the owner's decision to calibrate from online research and community measurements, without depending on the owner's equipment or requiring academic publication.
- Audit community shot archives and distinguish measured traces, machine targets, firmware estimates, synthetic examples, and missing metadata. Candidate sources remain separate from accepted calibration datasets.
- Check Gagné's 11 original DE1 traces against the matching measurement log, recording source checksums and observed 0.5/1.0 g crossing ranges without changing the model or interpreting logged clocks as pump-start times ([source audit](docs/research/04-community-shot-data.md)).
- The release adds research tooling, without changing solver equations or fitted values. Rebuilt golden fixtures differ from 0.3.0 only in their version labels.

### Validation
- Rerun the original validation cases with the unchanged v2 fit. Fit-quality blocks and held-out predictions are identical to 0.3.0; the scientific failures remain. Cached leave-one-condition-out refits retain their original 0.3.0 identity and are marked historical after the package/build version change, not presented as newly rerun. The [original M1.1 report](docs/validation/baseline-v0.3.0/README.md) is preserved.
- Complete 124 community simulations across the 11 original shots, with no invalid or incomplete runs. The fixed flow-command probes produce 1.45–1.51 g during bloom against 3.02–5.85 g observed; exact zero-command probes produce effectively no drainage. This motivates pressure/storage and drainage work, but the unmatched inputs do not identify a unique physical cause.
- Halving the time step in the representative pressure replay changes the 0.5 g crossing by 0.0023 s and record-end mass by 0.039 g. Worst relative hydraulic volume and solute mass residuals across the community runs are 7.17×10⁻¹⁴ and 1.54×10⁻¹⁴. Numerical conservation does not establish experimental accuracy.
- All 61 new source-import and comparison tests pass, alongside the existing Python suite. The 72 targeted WebAssembly engine and cross-language tests pass; native fixtures remain exact over 4,203 kernel values and 52,279 shot values. Registry export, release versions and validation-report freshness checks pass.

## [0.3.0] — 2026-10-15

M1.1: startup physics and conservative headspace filling. M2 remains deferred.

### Validation
- **Experimental increment; no complete M1 scientific exit criterion passes.** The [startup investigation](docs/validation/m11-startup.md) compares the preserved v1 baseline with the fully recalibrated v2 model, including all 15 leave-one-condition-out refits and all seven structural sensitivity refits.
- V4 first drops improve from 1.8 to 6.83 s against 12.76 s measured; the flow rise improves from 6.7 to 12.08 s against 25.48 s. Both remain outside their unchanged targets. Interpolation of the same measured curve corrects the archived rise from 25.78 to 25.48 s. The 15-second overshoot check passes; later overshoot remains.
- V4 time to 36 g improves from 22.2 to 30.47 s against 47.69 s. Generic pump-stop times at 36 g improve from 10.5–13.2 to 15.6–17.0 s, still below the 25–35 s sanity range. Final cup EY and TDS include modeled post-stop drip.
- **Extraction regresses:** V1 rates within ±10% fall from 57/60 to 48/60, and cup masses from 167/180 to 163/180. Leave-one-condition-out rates within ±15% fall from 59/60 to 54/60, and cup masses from 179/180 to 178/180.
- V3 peak magnitude passes at 22.09% EY, but the peak location still fails. V2 dispersion now fails its range check; V5 EY/time rank correlation falls from 0.84 to 0.54, below the 0.8 target.
- Fixed-v2 ablations isolate the assumptions without refitting. Disabling pore air changes V4 first drops from 6.83 to 2.21 s; halving the particle-water inventory changes them to 5.51 s. These variants do not reproduce the historical v1 fit.

### Changed
- The recipe builder supplies a full accessible pore-water capacity separately from the effective particle loading scale. The continuum holdup counts this water once; this is an explicit approximation, not a resolved model of mobile and immobile water.
- Trapped pore air reduces early permeability separately from roast-dependent CO₂. The local wetting age, PSD and an independent moisture-diffusion estimate set its relaxation; the new grade-D parameters were fixed before held-out evaluation and are exposed through the registry and sandbox.
- Headspace fill integrates pressure/flow programs and pump caps exactly and lands on the fill event. Zero-pressure phases deliver no water; a dry wait cannot age the pore-air relaxation. Post-stop drainage cannot consume more headspace water than remains.
- A hydraulic carrier-volume diagnostic complements soluble mass conservation. Raw specs without the new optional inputs retain their legacy closure defaults.
- The AMZCHEF preset records the owner's confirmed **58 mm single-wall basket**. Pump characteristics and detailed basket dimensions remain estimated.
- Calibration v1 and its original validation report are preserved. Calibration v2 uses the original calibration/held-out split and unchanged scientific targets. Validation now rejects unobserved time origins and endpoints instead of extrapolating them.
- The project working agreements now record the owner's authorization to use git, commit and push on a feature branch.

### Verification
- New startup verification covers analytical pore-filling times and capped fill ramps, pump-off phases, delayed starts, late-flow recovery, legacy defaults, conservation through partial fill/wetting/drip/vent, and time-step convergence.
- On the controlled startup test, halving the time step from 0.05 to 0.025 s changes first drops by 0.0063 s, shot time by 0.0118 s and EY by 0.0099 percentage point.
- Golden shot cases exercise both cubic and noninteger permeability powers and a disabled pore-air closure across native and WebAssembly builds.
- All 117 validation simulations succeed, with worst relative hydraulic carrier-volume error 1.06×10⁻¹³ and soluble mass error 3.04×10⁻¹⁴. The volume diagnostic does not claim exact solvent-mass conservation.
- **Final local checks:** 201 Rust tests (one additional preset sweep remains opt-in), 338 Python tests, 430 web tests and 55 browser end-to-end checks pass. Formatting, linting, type checks, dependency licences, registry export, version checks, report freshness and both native fixture checks pass. Native shot fixtures agree exactly over 52,279 numerical values and replay exactly in WebAssembly.
- **Browser performance:** tier 1 takes 584 ms for the default 16.18 s shot; tier 0 takes 34.3 ms on first use and 12.5 ms after an edit on the test machine. The warm preview still exceeds the plan's 10 ms target. Release WebAssembly is 982.79 kB (319.72 kB gzip); main JavaScript is 474.99 kB (153.07 kB gzip).

## [0.2.0] — 2026-10-15

Milestone M1: the shot core and the lab view. **The validation exit criteria are not met.** The validation section below says why.

### Validation
The full report is in `docs/validation/m1-validation.md`; the calibration method is in `docs/validation/calibration.md`.
- **Calibration** used Schmieder 2023, Waszkiewicz 2026 (long-time flow against pressure), Corrochano 2017 and Vaca Guerra 2024.
  - The pipeline (`python/scripts/m1-pipeline.sh`) is path-independent and records the solver, inputs and toolchain it ran on.
  - Nine values feed the app. Among them, the bare reference permeability is 1.24e-13 m², but the two datasets disagree about 3×.
  - θ stays at 0 by mechanism; the data cannot choose it.
- **Held-out tests:** Cameron 2020, Smrke 2024 and the Waszkiewicz transient.
- **Exit criteria (PLAN §12), all failed under strict criteria:**
  - V1: λ is within ±10% for 57 of 60 experiment–analyte pairs; leave-one-out gives 59 of 60.
  - V3: the EY peak lands at the edge of the grind range, at 21.9%.
  - V4: the flow rise is too fast. It reaches 90% of final flow at 6.7 s against 25.8 s measured, with first drops at 1.8 s against 12.8 s.
- **Known bias:** shot times come out at 0.43–0.47× the measured times. That holds even for a calibration case, so most of it is the missing slow start-up (dry-bed uptake, gas, headspace filling, preinfusion), not the permeability value.
  - Generic 18 → 36 g, 9 bar recipes run in 10.5–13 s.
  - The app says so under the results.
- **Passing:** V2 dispersion; time falling with coarser grind; EY tracking shot time; tier 0 within 0.4% of tier 1 on time and 0.5 points on EY.
- **Honesty fixes after an independent review of the calibration and validation:**
  - Stricter verdicts.
  - A prior bound that had come from held-out data was re-derived without it.
  - Pump-limited calibration shots are flagged.
  - Lenient held-out checks were tightened.
  - Non-commercial-licence data was trimmed to the values used.
  - CI checks that the report regenerates from its JSON.

### Added
- The M1 contract (`docs/model/m1-contract.md`), covering three JSON documents and five API functions in Rust, JavaScript and Python:
  - **Recipe:** gear and shot as a person describes them.
  - **ShotSpec:** the complete physics, in SI units.
  - **ShotResult:** what the shot produces.
- `puckcore::shot`: the shot types, with serde behind an optional feature.
- **The shot solver** (`puckcore::shot::simulate_shot`, specified in `docs/model/shot-model.md`, decisions in ADR 0009). Tier 1 implements the full M1 model; tier 0 is the same physics coarsened.
  - **Geometry:** any axisymmetric basket, with columns as radial annuli (stream tubes) of the real geometry.
  - **Flow:** Darcy series resistance with the permeability closure (relative Kozeny–Carman, poroelastic saturation, swelling, gas, fines layer), extract viscosity and density, and a sharp wetting front after the headspace fills.
  - **Machine:** pressure and flow control, ideal or vibratory pumps with an optional over-pressure valve, and pressurised orifices.
  - **Extraction:** surface pools with saturation, and diffusing kernels (BDF2/backward Euler, ADR 0005). Bed liquid moves by exponentially fitted advection–dispersion, porosity grows with dissolution, and species ride along as linear passengers.
  - **Also:** a lumped thermal node, stop rules and a decaying post-stop drip.
  - **Numerics:** each step is one implicit tridiagonal M-matrix solve per column. Pool regimes are resolved by policy iteration. Conservation and positivity hold by construction and are checked every step.
  - **Schemas:** `data/schema/shot-spec.schema.json` and `shot-result.schema.json`, tested against the Rust types.
  - New spec and result fields are listed in `docs/model/m1-contract.md` §8.
  - `puckcore::shot::validate_shot_spec` runs the solver's spec check without simulating.
  - **Second round, after an independent review of the solver:**
    - **Wetting front:** water soaking into the grounds now carries its solute into the particle pores. Before, the solute was precipitated: the liquid became supersaturated and local EY reached −18.6%, diverging with the grid. First-drop TDS now equals saturation on every grid.
    - **Drip:** it drains only the water left in the headspace, and a vented (3-way valve) group gives none. Before, a basket with 1 mL of headspace dripped 6 g, and long drip times allowed kilograms.
    - **Bounds:** every input is bounded and the model size is capped. Failures return errors instead of panicking. Mass-balance and positivity checks warn and fail at set thresholds. A new diagnostic compares cup solute with the integral of the outflow.
    - **θ (dissolution porosity share)** defaults to 0. Insoluble cell walls hold each particle's outer size, so dissolution opens intraparticle pores. The old proportional default (0.27) produced most of the flow rise and had no mechanism.
    - **Partition basis:** coefficients follow Corrochano's definition (per particle envelope volume). Kernel re-uptake is capped at the initial content by default.
    - **Heterogeneity:** strata are now equal-probability with conditional means; at σ = 0.7, 8 and 64 columns agree within 0.04 EY points.
    - **Tier 0** carries 3 strata plus the edge and 2-shell coarse kernels. Its EY is within 1–4% of tier 1 in every tested regime; before, it was off by 25% for uneven beds.
    - **Species** with identical parameters share one solve.
  - **Third round, after a verification review:**
    - **Stiff pools:** a step whose pool regimes do not converge is now rejected and retried at half the step. A capped iteration had made some valid fine-grid, coarse-step specs fail.
    - **Front cell:** only the wetted share of its particles exchanges, and very high partition coefficients are rejected. Before, the liquid could exceed saturation.
    - **Imbibed water** is no longer counted twice as liquid volume. EY now barely depends on the wetting-uptake parameter: 21.8–22.1% instead of 20.2–21.8%.
    - **Total work** is bounded, and mass stops land within 0.2 mg.
    - 20,000 random specs and 576 stiff-grid cases pass. Native and WebAssembly are byte-identical on 71,087 numbers.
- New crate `crates/puckmodel`: recipe types, a placeholder builder and presets, and the JSON API. Both bindings expose `presets`, `registry`, `buildShotSpec`/`build_shot_spec`, `simulateShot`/`simulate_shot` and `simulateRecipe`/`simulate_recipe`.
- WebAssembly `lastPanic()` returns the message of the most recent Rust panic, which otherwise surfaces only as an `unreachable` trap. The hook is dependency-free and writes nothing to the console.
- ADR 0008: the model crate and the JSON boundary. ADR 0009: shot solver numerics, and why κ₀ is a bare, calibrated permeability.
- **Input models v1** (`crates/puckmodel`, documented in `docs/model/input-models.md`). Every value comes from the parameter registry; recipe overrides win, an unknown id is an error naming it, and `data/calibration/current.yaml` applies when present. Every spec field records its provenance.
  - **Grinder → PSD:** a three-mode log-normal mixture from a burr family and gap, or a grinder preset and dial setting. It gives 30 size classes (2–60) and a 200-point curve. Measured PSDs are used as given.
  - **Bean v1:** species contents (caffeine, trigonelline, 5-CQA, acids), roast and blend effects on density, porosity and extractable fraction, and CO₂ by age.
  - **Basket:** any axisymmetric wall profile, plain or pressurised; bed height from frustum volumes.
  - **Prep:** porosity, base permeability from the PSD, and heterogeneity from distribution, screens and papers.
  - **Machine:** pressure, flow and full-pump phases with ramps, limits and exits; ideal or vibratory pumps with an optional over-pressure valve; brew temperature, headspace, drip, a thermal node and stop rules.
- **Input-model hardening** (after an independent review):
  - Plausibility bounds on every recipe field, shared by the builder and the schema.
  - Errors name the recipe field or override responsible; "internal error" no longer occurs for user input.
  - One precedence rule: recipe, then override, then calibration, then preset, then derived, then registry. Each provenance token names the real source.
  - The export refuses calibrations the builder would ignore.
  - CO₂ is anchored to the measured ground residual.
  - The edge multiplier accounts for basket taper.
  - The builder runs the solver's own spec check.
- **Third input-model round:**
  - θ comes from the registry and can be overridden.
  - Pump fields left out are filled from a same-type preset pump.
  - New recipe field `machine.vent_headspace`, set on the presets: the E61 group vents; the AMZCHEF Ultra is assumed not to, unverified.
  - Registry ranges match the solver's bounds.
- The base permeability's porosity dependence uses the exponent calibrated on Corrochano's density series (α ≈ 0.33) instead of the full Kozeny–Carman ratio. A porosity override had moved permeability about 6× too much. Defaults are unchanged.
- **Grinder → PSD refit to measured PSDs only** (dry laser and Camsizer: Corrochano, Smrke, Cameron, Waszkiewicz). A logit fines relation lets fine settings reach Turkish-like grinds. The EK43 dial is refitted to Cameron (now grade B).
- **Presets** (`data/presets/`, schema `data/schema/preset.schema.json`):
  - 3 grinder families and 7 grinders;
  - 12 baskets by geometry: 58, 54, 53, 51 and 49 mm, plain and pressurised;
  - 10 machine programs: flat 9 bar, declining, spring lever, blooming, turbo, flow-controlled, allongé, vibratory, E61 and the AMZCHEF Ultra;
  - 6 beans.
  - The owner's AMZCHEF presets are flagged unverified and estimated.
- **Registry:** 70 model records in `data/params/model.yaml`, mostly estimated (grade D). Later rounds bring the registry to 226 parameters.
- `python -m puckworks_tools.export [--check]` validates the presets and the registry, applies calibration, and writes `crates/puckmodel/generated/presets.json` and `registry.json`.
- New optional recipe fields: listed in `docs/model/m1-contract.md` §8.
- **Validation datasets** (`data/datasets/`, 17 new). Each records its licence, method, source checksum and uncertainty.
  - Schmieder 2023 (CC BY 4.0): the design, all 288 fraction rows, the kinetic fits and per-shot data. Its "pressure" column turns out to be the mean of each shot's peak pressure.
  - Waszkiewicz 2026 (CC BY 4.0): flow against time at 11 pressures, long-time flow against pressure, TDS fractions and the PSD.
  - Cameron 2020 and Corrochano 2017 (cited facts): EY against grind, PSDs, the two-class model, permeabilities and a partition coefficient.
  - Smrke 2024 (CC BY 4.0): PSDs and shots, digitised from the figures.
  - Vaca Guerra 2024: residence-time scalars only. The article is CC BY-NC-ND, so its curves are not included.
- **Calibration and validation tooling** (`puckworks-tools`):
  - Case builders turn each experiment into a recipe through the input models, then set the paper's conditions: 65 cases from six sources.
  - `calibrate` refuses to write `data/calibration/` until the real solver is in place.
  - `validate` writes the validation report.
  - `shot-fixtures [--check]` maintains the golden shot file `data/fixtures/shot_cases.json`.
  - `export` now runs the export module.
  - 9 calibration parameters, tagged fitted, in `data/params/calibration.yaml`.
  - The Python tools now depend on SciPy (BSD-3-Clause).
  - Documentation: `docs/validation/case-builders.md` and `calibration.md`.
- **CI:** `python.yml` checks that the generated presets and registry are current, and checks the golden shot file against the native build.
- **The shot lab** (`web/src/shot/`): the Lab view opens on it, and the M0 kernel verification demo becomes a second tab.
  - **Recipe editor:** every recipe block, as a preset or from scratch.
    - Custom basket profiles are drawn to scale with the bed height, and "edit a copy" turns any preset into a custom basket.
    - Measured PSDs can be pasted as CSV or TSV.
    - Machine programs and pumps (ideal, or vibratory with an over-pressure valve) have their own editors.
    - A searchable registry browser handles sandbox overrides.
    - Preset flags and builder notes appear next to the inputs they concern, and errors next to the field they name.
    - Recipes import and export as JSON. Named saves and the draft stay in the browser's local storage.
  - **Runs:** a debounced tier-0 preview while editing, and tier 1 on Run. Superseding and cancelling are race-free, and two workers keep a long run from blocking the preview.
  - **Outputs:**
    - 12 summary tiles and solver warnings;
    - a shot graph of small multiples with a shared crosshair and a table view;
    - up to 6 pinned runs, with a table of recipe differences;
    - the PSD with the solver's size classes, and EY per class;
    - a compound table with provenance;
    - a puck cross-section heatmap on the real basket geometry, with a time scrubber;
    - 1D sweeps over any recipe input or registry parameter;
    - the provenance and ShotSpec panels;
    - exports: result JSON, series and sweep CSV, recipe and spec.
  - **Accessibility:** colour-vision-checked palettes in both themes, keyboard-readable heatmap cells, table alternatives for charts, and no horizontal scroll at 390 px.
  - **After an independent review:**
    - Hidden grinder calibration no longer leaks into presets.
    - Pump placeholders show the values the model actually uses.
    - Unknown override ids can be removed instead of locking the lab.
    - A stale-preview race is fixed.
    - PSD paste refuses cumulative columns, and decimal commas work in every field.
    - Input ranges are read from the recipe schema, and builder errors focus their field.
    - Engine failures are told apart from input errors and include the Rust panic message.
    - Loads can be undone, and focus no longer drops to the page.
    - The tiles carry a model-status caveat.
    - The cross-section shows the wetting front (dry cells grey, partly wetted cells hatched) on the solver's real cell edges, for any number of columns.
    - A checkbox sets the 3-way valve.
  - **Tests:** 192 new web tests (376 in total). The Chrome end-to-end test now runs a shot, the cross-section and a sweep (48 checks). A cross-language replay checks `data/fixtures/shot_cases.json` bit for bit in WebAssembly.
  - **Measured in the browser worker** (32 s shot): tier 0 takes 4.7–4.9 ms warm, tier 1 643–662 ms. The main bundle is 440 KB (142 KB gzipped).
- **Measurements:**
  - A recipe simulated through Python and WebAssembly gives identical summaries; built specs are bit-identical.
  - The release WebAssembly module grows from 49.9 KB to 904 KB (284 KB gzipped) with serde, the input models, the solver and 215 KB of embedded presets and registry.
  - 51 Rust tests in `puckmodel` (one more, the full 7,200-combination sweep, is opt-in) and 59 new Python tests.
  - A random sweep of 10,000 recipes found one panic, now fixed.
  - **Solver verification:**
    - Darcy flow, orifice, pump and wetting time agree with closed forms to round-off; Washburn to 6.6e-4.
    - Perfect sink against Crank: 3.1e-4 at τ = 0.01, 3.6e-6 at τ = 0.6.
    - Conservation within 1e-14; 20,000 random specs pass (worst 8e-12).
  - **Solver speed,** final (native / WebAssembly, on a loaded machine): tier 1 takes 16 / 20 ms for the default spec and 343 / 471 ms with 30 classes + 4 species; tier 0 takes 2.6 / 3.2 ms (7.2 ms in WebAssembly with 30 classes + 4 species).
  - **Determinism:** native and WebAssembly agree bit for bit on 170,654 numbers from replayed shot fixtures.
  - **Final test counts:** 190 Rust tests (plus one opt-in sweep), 326 Python and 430 web tests, and 55 end-to-end checks in Chrome. Every check passes on the release tree.
  - **Final sizes:** the release WebAssembly module is 971 KB (317 KB gzipped) with the calibrated registry embedded; the main JavaScript bundle is 475 KB (153 KB gzipped).
  - **In the browser** (end-to-end test): the tier-0 preview takes 8–29 ms; a tier-1 run takes 495 ms for an 11 s shot.

### Changed
- `docs/PLAN.md`:
  - New design principle 7, "general by design": the owner's gear is only the first set of presets. Any basket profile (straight, tapered, stepped; plain or pressurised), any grinder (family or measured PSD) and any machine program can be described from scratch.
  - D10 records the owner's 58 mm basket, pressure gauge and scale.
  - §15 now asks whether that basket is plain or pressurised.
- `deny.toml` lists `puckmodel` among our own GPL crates.
- `Cargo.toml` optimises `puckcore` in debug and test builds. The tests take seconds instead of minutes, and results are unchanged.
- `scripts/build_wasm.sh` drops the function-name section from release builds: 1,009 KB → 904 KB (284 KB gzipped). ADR 0008 records the measurements.

## [0.1.0] — 2026-10-14

Milestone M0: foundations.

### Added
- **Numerical core** (`crates/puckcore`, Rust, no dependencies). It solves diffusion out of a sphere into a perfect sink:
  - finite volumes, with shell conductances exact for parabolic profiles, on equal-volume or uniform shells;
  - backward Euler, BDF2 and Crank–Nicolson (Rannacher start-up), with start-up sub-stepping and per-scheme mass accounting;
  - a reusable tridiagonal LU solver, and deterministic `exp`/`cbrt` built from basic IEEE-754 operations.
  - Documented in `docs/model/particle-kernel.md` and ADR 0005.
- **Bindings.** WebAssembly (`crates/puckcore-wasm`, wasm-bindgen 0.2.129) and Python (`crates/puckcore-py`, PyO3 abi3, module `puckcore`). `scripts/build_wasm.sh` checks that the wasm-bindgen CLI matches the crate pin.
- **Web app** (`web/`, TypeScript, Vite, React):
  - mode tabs, with a Lab "particle kernel verification" demo that runs the engine in a Web Worker and transfers decimated results;
  - an auto-run guard (at most 200,000 steps and 50 million shell-steps) and worker recycling after large runs;
  - a meta-tag CSP for the page, and a footer linking the source and third-party notices. CI builds fail without a real source URL.
- **Parameter registry** (`data/params/`): 143 parameters transcribed from the research notes. Each has a source, an evidence grade, a tag, a prior and a range; derived entries record which entries they come from. Tags: 56 measured, 37 fitted, 28 estimated, 22 derived. Grades: 49 A, 42 B, 45 C, 7 D. JSON schemas and a unit vocabulary sit in `data/schema/`, alongside the first dataset (Schmieder 2023 centre point, CC BY 4.0).
- **Project tools** (`python/`, `puckworks-tools`): `validate-registry`, `fixtures [--check]` (the golden file `data/fixtures/sphere_cases.json`), `verify` (the report in `docs/validation/`), and `check-versions [--release]`.
- **CI.** Four GitHub Actions workflows:
  - `rust.yml`: rustfmt, clippy, tests, the WebAssembly build and cargo-deny licences;
  - `python.yml`;
  - `web.yml`: lint, types, tests, build, licences and an end-to-end test in Chrome;
  - `pages.yml`: deploys only a build that passed `web.yml`.
- **Project files.** `LICENSE` (canonical GPL-2.0 text), `CONTRIBUTING.md`, `.gitignore`, `rust-toolchain.toml` (Rust 1.99.0) and `deny.toml`.
- **Decision records.** `docs/decisions/` 0001–0007: ADRs, the Rust core, the web stack, GitHub Pages hosting, kernel numerics, the parameter registry, and licensing policy.

### Measurements
- **Verification** on the reference case (a = 150 µm, D = 1e-10 m²/s, 60 s, 64 equal-volume shells, 2000 BDF2 steps):
  - max error against Crank's analytic solution 5.14e-4 (target < 1e-3; the M0 placeholder solver gave 1.03e-2);
  - error at τ = 0.1: −4.99e-6;
  - mass balance 5.4e-14.
- **Observed convergence orders.** Space: 1.98 on equal-volume shells and 2.00 on uniform shells. Time: 1.00 for backward Euler, and 2.00 for BDF2 and Crank–Nicolson.
- **Runtime** on the reference case: 0.63 ms native, 0.68 ms through Python, 0.72 ms in WebAssembly. The release WebAssembly module is 49.9 KB.
- **Determinism.** Native and WebAssembly outputs are bit-identical: 255,640 values in the core's own check, and 893,206 in an independent review. The golden file matches exactly across all 4,203 values.
- **Tests.** 41 Rust, 136 Python and 184 web unit tests pass, and the Chrome end-to-end test passes.

### Changed
- Core validation now rejects τ = D·t_end/a² above 1e200 (overflow guard). Extreme but valid inputs are evaluated as (D/a)·(t/a).
- `docs/PLAN.md`:
  - D10 records the owner's gear: AMZCHEF Ultra machine and AMZCHEF single-dose grinder, no refractometer yet. It previously said "refractometer".
  - G2 and §13 are adjusted to match.
  - New decision D14 sets hosting on GitHub Pages.
  - §15 marks the answered questions as resolved and lists the unverified equipment specs.
  - §16 records that the owner handles git.
  - The swelling relaxation time is now ≈ 20–30 s; it previously said 10–30 s.

### Fixed
Three independent read-only reviews of the M0 work found issues, all fixed before release:
- **Web app:**
  - auto-run could allocate about 320 MB from one keystroke;
  - the deployed source link pointed at a placeholder;
  - cancel and debounce races;
  - the deploy path skipped the licence check;
  - focus was lost on Cancel;
  - the CSP claim was overstated.
- **Registry:** fitted diffusivities were tagged "measured"; two grades were overstated; the dispersion prior was centred on a contradicted assumption; priors cut off cited values; linked quantities were over-determined.
- **Core:** documented error bounds were inaccurate; tests depended on the platform maths library; a mass-balance bound was brittle; the overflow check rejected one valid extreme input.
- **Research notes:**
  - note 02 mislabelled Schmieder's 15-run mean caffeine (4.57 mg/g) as the centre point, and presented a derived EY (19.4%) as reported;
  - note 01's swelling relaxation time was inconsistent with its own data;
  - note 03 now flags a source conflict over the E65S grind scale.

## [0.0.1] — 2026-10-13

### Added
- `docs/PLAN.md`: the consolidated plan and goals, including 13 locked decisions from the planning Q&A:
  - all four roles in scope: dial-in assistant, sandbox, visual explainer, public website;
  - a hybrid particle model: ~30-class continuum plus a 3D micro-view;
  - physics + ML, with forward simulation and an inverse solver;
  - an empirical grinder model first;
  - bean descriptors + presets;
  - ~30 non-volatile and ~25 aroma species;
  - explainable taste that learns from the user's own ratings;
  - no user data collection, ever;
  - GPL-2.0-or-later, under the name Puckworks.
- Research notes in `docs/research/`: 01 extraction and flow physics; 02 chemistry and sensory; 03 grinding, PSD and data sources.
- `README.md`.

### Findings that shaped the plan
- **Permeability is calibrated, not predicted.** In-shot permeability back-calculated from published shots is (2–15)×10⁻¹⁵ m². That is 10–1000× below Kozeny–Carman estimates from measured particle sizes.
- **Most compound kinetics are estimated.** Espresso extraction rates have been measured for only four species. For a 20 g dose the characteristic beverage mass is λ = 16.1 g for trigonelline, 17.5 g for TDS, 20.8 g for 5-CQA and 23.1 g for caffeine (Schmieder 2023). All other species are estimated by kinetic class.
- **The grinder model starts empirical.** No published model maps burr geometry to particle-size distribution.
- **The taste model is explainable and personal.** No espresso dataset links chemistry or TDS/EY to taste, so the model shows uncertainty bands and is personalized in the browser.
