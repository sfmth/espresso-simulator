# Equipment setup and inference validation

Version 0.12.0 · 2026-10-21

This record covers the [equipment-inference workflow](../model/setup-inference.md).
Synthetic shots exercise consistency with the same native physics engine. They
do not establish accuracy on measured espresso, unique identification of a real
machine, or completeness of the bounded search.

## Automated application checks

The final local web suite passes **922 tests in 66 files**. ESLint, Prettier,
TypeScript, production build checks and the production dependency-license audit
pass. The audit covers six npm packages and eleven Rust crates; this feature adds
no dependencies. Release-version and generated-registry checks pass at 0.12.0.

Important new coverage includes:

- Twenty-one inference cases for exact locks, bounded numeric/categorical search,
  shared parameters across observations, explicit per-shot changes, optional TDS,
  first-drip timing, final-versus-pump-stop mass/TDS, native failures, cancellation,
  budget limits, stepped bounds and Tier 1 acceptance.
- Twenty-four native catalog audit cases across every existing machine and
  grinder preset and three roast settings. Locking each active parameter at its
  effective value preserves native behavior. Preset-derived geometry, default
  preparation, roast-derived porosity and override precedence are checked.
- Named grinder reference regression: an E65S setting of 1.7 with reference gap
  195 µm, reference dial 1.4 and slope 25 µm/unit has gap 202.5 µm. A family/preset
  replacement must not reinterpret the reference as zero and silently produce
  237.5 µm while claiming the same locks. The search rejects this semantic change.
- Shot-specific categorical changes cannot mask shared locked **or inferred**
  values. An explicitly known different grind setting remains legal for its shot.
- Storage round trips, quota failure, stale-tab writes, unsafe paths, malformed
  imports, bounded backup size, atomic rejection and internal consistency of
  saved recipe, observations, tolerances, residuals and candidate scores. File
  import retains alternatives but requires explicit native-validated activation;
  ordinary reload restores the existing active selection.
- Direct observations before forecasts, displayed-versus-inlet temperature,
  retaining versus activating alternatives, specified settings without a fit,
  cancellation and late-result rejection.
- Compatible future-recipe changes preserve each alternative's equipment.
  Native checks reject clamped dial/gap values and incompatible grind controls;
  one failed alternative does not hide the remaining valid predictions.
- Welcome defaults are builder-checked before replacing a draft. Skipping clears
  a previous active inference selection while retaining alternatives, including
  session-only operation when persistence fails or another tab changes storage.

The complete suite also retains the earlier numerical, recipe-editor, journal,
calibration, accessibility-helper and offline-build tests.

## Production browser checks

The smoke, offline/update and accessibility scripts exercise the production app
in installed Chrome under a repository subpath. The shared setup exercise uses
two native-generated observations at 15 and 17 seconds and verifies:

1. All six connected equipment callouts render at visible size.
2. Dose 18 g, WDT, flat traditional burrs and 93°C inlet water remain locked while
   the grinder is searched over 185–195. Boiler/display metadata stays at 95°C.
3. Both observed shots can be recorded without a prior forecast.
4. Canceling retains observations; restarting returns verified candidates.
5. Keeping alternatives exports all source constraints and per-shot checks.
6. Explicit activation opens Dial in; an adjusted 19 g recipe produces a
   prediction for every retained compatible alternative.
7. Reload restores the active setup, alternatives and observations without the
   welcome popup. Setup and Lab never mount duplicate recipe-input IDs.
8. The 320 px layout has no document overflow and the equipment drawing stays
   visible. Desktop and phone screenshots are visually inspected.

The offline suite additionally starts a setup replay while browser transport is
blocked, using a synthetic observation from the actual current recipe. It keeps
and activates the verified result, reloads, exports the restored setup, and
checks that the original journal survives. Existing cache-only navigation,
previously unopened Explore, failed-update recovery and explicit multi-tab
release activation remain part of the same run.

Production accessibility checks cover the welcome dialog, equipment editor,
locks/ranges, observations, candidates, saved alternatives and prediction table,
alongside the existing expanded Lab, journal and Explore states. The production
audit exercises forty states and reports zero detected violations. A green
automated run means zero detected axe violations in the exercised states;
incomplete color-contrast/label checks around drawn content still require human
review. This is not a WCAG-conformance or assistive-technology certification.

Run the checks from `web/`:

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run licenses
node scripts/e2e.mjs
node scripts/offline-e2e.mjs
node scripts/accessibility-e2e.mjs
```

Browser reports and screenshots are written to the ignored `web/test-results/`
directory, including `accessibility-checks.json`, `offline-checks.json`,
`setup-equipment-drawing-desktop.png`, `setup-equipment-phone.png`, and the
`setup-inference-*` captures. They are generated evidence, not source assets.

## Unchanged numerical behavior and provenance

No Rust physics implementation, registry coefficient, preset or frozen model
weight changes in this release. Manifests, native bindings, WASM and the
version-bearing scientific artifacts are refreshed together. The
[machine-readable receipt](setup-inference-version-replay.json) records:

| Comparison | Values or cases | Changed values |
|---|---:|---:|
| Sphere golden fixture | 4,203 numeric values | 0 |
| Shot golden fixture | 214,018 numeric values | 0 |
| M3 scientific report, excluding version/identity/timing metadata | 58,804 numeric values | 0 |
| Full native builder and simulation across the frozen scalar dataset | 464 rows; 13,036,890 numeric values | 0 |

The M3 report's nineteen checks pass. The corresponding 217 Python tests for
versions, fixtures, M3 and surrogate tooling pass. The strict frozen surrogate
replay passes its consistency checks while `--require-qualified` still fails as
expected. Training coordinates, splits, weights, targets, error metrics and
`browser_approved: false` are preserved. A version change does not turn the
previously failed accuracy experiment into a qualified predictor.

## Remaining limits

- No new measured-shot accuracy results or prospective inferred-setup scorecard
  are established. The earlier V9 scorecard remains limited to older
  calibration-linked forecasts.
- Finite representative search can miss valid regions and cannot establish
  parameter identification. More unknown axes require stronger observations and
  may exceed a practical browser budget.
- Profile and geometry structure are configured before search. The optimizer
  varies supported active values, not every possible topology.
- Heater/PID dynamics and a mapping from display temperature to inlet water are
  deferred. Recorded-only fields remain recorded-only.
- Stored/imported evidence is checked for internal consistency, not authenticated
  or independently re-simulated during file import.
- Automated desktop viewport emulation is not physical-phone or screen-reader
  testing, and local timings do not close the target-device performance gates.
