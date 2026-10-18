# M4 Dial-in verification

Version 0.8.0 · 2026-10-18. **V9 remains open.** No new real observations enter
the published calibration and no personal measurements are required from the
owner. The numerical and lifecycle checks below do not establish prospective
time, extraction-yield or preference accuracy.

## Reproduction

From the repository root:

```sh
scripts/build_wasm.sh
cd web
npm run lint
npm run format:check
npm run typecheck
npm test
npm run e2e
npm run licenses
```

`web/test/m4.integration.test.ts` calls the same production worker request
handler and WebAssembly module as the browser. The synthetic workflow uses
eight particle-size classes, explicit M2 chemistry and M3 taste, three settings
and a hidden permeability multiplier of √2. It commits each forecast before
attaching its generated observation, fits the grid posterior, recovers √2 to
the asserted eight decimal places, checks every retained shot with Tier 1,
applies the fit and searches all three inverse modes. It round-trips actual
summaries/taste and a profile through journal export/import, exercises personal
learning and confirms training/imported records cannot establish V9.

## Verification results

The complete web suite passes **569 tests**. M4 adds 99 checks:

| Area | Checks | Coverage |
|---|---:|---|
| Journal, imports, personal learning and scoring | 48 | Immutable records, transactions/session fallback, input limits/schema, conflicts, quoted CSV, inert DE1, physical observations, rating uncertainty and prospective exclusions |
| Local calibration | 16 | Synthetic recovery, replay, scope/version refusal, prior dominance/confounding, ignored dial precedence, cancellation, numerical failure exclusion and Tier 1 rejection |
| Inverse search | 30 | All modes, legal hardware lattice and equipment bounds, actual-call budget, final-cup/drip correction, failed Tier 1 exclusion, next-shot reference conditions, optional personal ranking and cancellation |
| Interface | 4 | Commit before measurement, trimmed setup names, invalid observation refusal, cancelling/undoing edits and ignoring late advice after target changes |
| Actual-WASM integration | 1 | End-to-end synthetic local workflow described above |

The production browser smoke checks include save-before-measurement, export,
native IndexedDB persistence across reload, idempotent backup import, CSV import,
stale-tab refusal, phone-width layout and same-origin/no-console-error audits.
Screenshots are generated locally under `web/test-results/` by the test script.

Rust formatting, strict clippy and the existing Rust suite pass. Python has
432 sandbox passes plus five focused passes outside sandbox filesystem/socket
restrictions (437 total). The native fixture checks compare **214,018 shot
values and 4,203 kernel values exactly**. Their version metadata moves to
0.8.0; no fixture numbers are rebaselined.

M0/M1/M2/M3 reports are regenerated with the 0.8.0 native binding and tools.
M1's timing/startup and other held-out failures remain visible; M2's incomplete
experimental inputs still prevent independent V7 validation; M3 still reports
scenario rather than calibrated predictive coverage. Local fits do not update
those reports or the published v2 coefficients.

## What remains unvalidated

V9 needs at least ten future local shots with forecasts saved after calibration
and before measurement. Timing-only scoring can be used without TDS. The full
target also needs measured TDS/EY, with times within ±3 s and EY within ±1 point.
Training residuals, imported forecasts and generated observations cannot close
that target. Sparse personal ratings and their conditional Bayesian ranges do
not validate espresso taste preferences. Startup mechanisms, grinder zero,
heterogeneity and machine offsets remain fixed; finite-grid resolution,
approximate observation noise and unmodelled physics limit the local posterior.
