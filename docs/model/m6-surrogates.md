# M6 scalar surrogate tools

Version 0.11.0 adds a reproducible **offline experiment** for learning a small
scalar approximation to Tier 1. Generated samples are simulator outputs, not
measured shots. The browser continues to use physics; the model is not a source
of curves, chemistry, taste, particles or spatial state.

The committed first baseline **fails** the declared accuracy gate and therefore
uses physics fallback. Maximum test/boundary final-mass errors are 1.287/3.837 g.
All three fits reached their fixed iteration limit; no tuning followed the final
evaluation. Full errors, coverage and optimizer outcomes are in the
[measured report](../validation/m6-surrogate-validation.md).

## Supported recipe family

The canonical template uses medium-washed-arabica, generic-flat-traditional-64,
the 58-precision-18g basket, WDT and flat-9-bar. The time limit is 60 seconds and
the teacher uses standard Tier 1 numerics. Other fields retain the template's
embedded defaults, including the current unvented post-stop drip behavior.

| Control | Support | Unit |
|---|---:|---|
| Generic grinder setting | 170–230 | µm-equivalent preset dial |
| Dry dose | 16–20 | g |
| Requested beverage stop / dry dose | 1.5–2.5 | g/g |
| Machine temperature | 90–96 | °C |

`recipe_for_features` creates the exact supported representation. The guard
rejects extra fields, overrides, alternate gear, profiles, custom PSDs and a
different tier. Conservatively rejected representations go to the actual
builder/solver; their extra physical inputs are preserved.

Outputs are pump-stop `shot_time_s`, final `beverage_mass_kg`, cup `ey` and `tds`
as fractions. The first three are learned. TDS is derived from the reported
mean EY, dry dose and final cup mass so that these four values are consistent.
Final mass includes post-stop drip and can exceed the requested stop mass.

## Generate, train and inspect

After building the native extension and installing the tools:

```bash
.venv/bin/puckworks-tools surrogate-generate \
  --output .local/surrogates/dataset.json \
  --train 256 --calibration 64 --test 128 --jobs 4 --seed 20261020
.venv/bin/puckworks-tools surrogate-train \
  --dataset .local/surrogates/dataset.json \
  --model .local/surrogates/model.json \
  --report-dir .local/surrogates/report --seed 20261020 --max-iter 2000
.venv/bin/puckworks-tools surrogate-check \
  --model .local/surrogates/model.json --dataset .local/surrogates/dataset.json
```

The 464 rows comprise 256 training, 64 calibration, 128 final test and 16
boundary corners. Distinct feature hashes prohibit leakage across splits.
Failures and capped shots remain accounted for and block training; they are not
replaced by easier samples. One to four native processes are supported because
the binding holds the GIL. Counts must be powers of two within the documented
CLI limits. Generation needs no observations or external downloads.

With `--dataset`, the check replays Sobol coordinates, training-only scales,
actual saved-weight predictions, physical checks, error metrics and calibration
radii/coverage without fitting. It rejects a rehashed model with stale claimed
metrics. The committed artifact can be checked with
`--model models/scalar-v1.json --dataset data/surrogates/scalar-v1.json`.

Each of three 4 → 16 tanh → 3 networks fits only training rows. Input scaling
uses declared support; output scaling uses training rows. Optimizer limits and
convergence are recorded. Test and boundary labels determine only final
evaluation and qualification, never fitting or residual calibration.

The declared accuracy gate is maximum absolute error ≤1% of each training
output's range, separately on test and boundary, including derived TDS. Zero
training range has an explicit unavailable normalized error and requires zero
absolute error. The report also retains MAE, RMSE and p95 error in native units.
Passing these finite samples is not a uniform bound over every possible input.

The calibration split determines separate 90% absolute-residual radii for
simulator approximation error. Observed coverage on untouched test and boundary
rows is reported. These are not measurement uncertainty, empirical espresso
coverage, sensory accuracy or a formal exchangeability guarantee for Sobol
points. Raw ensemble spread is not interpreted as confidence.

## Guarded scalar predictions

```bash
.venv/bin/puckworks-tools surrogate-predict \
  --model models/scalar-v1.json --recipe models/scalar-v1-recipe.json
```

The result has schema `puckworks.scalar-prediction/1`, `mode` (`surrogate` or
`physics`), four `scalars`, model/core identity and explicit fallback reasons.
It has no full-shot schema or invented solver diagnostics. Invalid physical
recipes still produce the builder's error. Fallback forces Tier 1 while retaining
the supplied physical settings, including overrides.

The example uses the committed baseline and template recipe. To inspect a newly
generated local model, substitute `.local/surrogates/model.json` for the model
path. The committed baseline returns `mode: physics` with its qualification
failure visible in `fallback_reasons`.

A model is usable by this experimental offline API only if its artifact is
intact, small-scope qualification passes, current teacher identity matches,
the exact template/features are supported and its output is physical. Mass must
be positive and at least the requested stop mass, EY/TDS must lie in [0,1], time
in (0,60], and the TDS identity must hold. Invalid outputs are rejected rather
than clipped. Optional cancellation is checked before work and before fallback;
it cannot interrupt a synchronous native solve already in progress.

`surrogate-check --require-qualified` exits 1 for an intact but unqualified
artifact. Generation exits 1 for retained teacher failures, and setup/format
errors exit 2. Training can complete successfully with failed accuracy gates:
that measured failure belongs in the report. Outputs refuse replacement unless
`--force` is explicitly supplied. JSON is size-bounded; no executable model
formats are read.

Input/output aliases are rejected even with `--force`. Each file publishes
atomically, but model and report files publish sequentially: an I/O failure can
leave an incomplete bundle. Check identities and replay the complete bundle
before committing it.

## Identity and release scope

Dataset and model identities use full canonical SHA-256. Compatibility includes
core version, effective embedded registry and presets (including fitted values),
behavior source inputs and three fixed native behavior probes. The pre-calibration
registry hash alone is insufficient. Platform binaries, timestamps and Python
versions do not enter compatibility. Current identity inputs are checked afresh;
costly probe results are reused only within an unchanged loaded teacher.

Hashes check integrity, not authorship or the truth of an independently supplied
model's claimed errors. Use the committed or locally trained artifacts; replay
an artifact against its source dataset before relying on its qualification.

Cold identity validation includes three real solves and must not be confused
with pure neural forward-pass latency. Report performance phases separately.
Behavior probes are an additional stale-build check, not proof of every compiled
branch. Rebuild the extension before generating a release dataset.

The committed dataset, model and evaluation establish a reproducible baseline.
Model and dataset files live outside `web/` and are not bundled or cached by the
production app. `browser_approved` is always false in this slice. Browser/shared
core integration, broader inputs, curve emulators and uncertainty qualification
remain future work. See [ADR 0017](../decisions/0017-offline-scalar-surrogate-pipeline.md)
and [the measured evaluation](../validation/m6-surrogate-validation.md).
