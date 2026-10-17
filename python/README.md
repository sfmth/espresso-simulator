<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# puckworks-tools

Offline Python tools for Puckworks. They check the parameter registry and the datasets, write the
golden fixtures shared with the web tests, produce the kernel verification report, calibrate the M1
model against the literature datasets and write the M1 validation report, export presets and registry
for the model crate, compare community shot logs under explicit assumptions, and check that versions agree across the repository. Version 0.5.0,
GPL-2.0-or-later.

## Install

The tools use the native core through the `puckcore` Python extension (`crates/puckcore-py`). It is
not on PyPI, so install it first (this compiles the Rust core with maturin), then the tools:

```sh
python -m venv .venv
.venv/bin/pip install ./crates/puckcore-py
.venv/bin/pip install -e "./python[dev]"
```

Python 3.10 or newer. Runtime dependencies: PyYAML, jsonschema, NumPy, SciPy (and tomli on Python
3.10); pytest for the `dev` extra. Optional extras: `report` (matplotlib, for the validation report's
figures; the report is written without them otherwise) and `sources` (Pillow, for the importers that
digitise raster figures). All are MIT, BSD, PSF-style or HPND licensed. `validate-registry` and
`export` work without `puckcore`; the other commands need it.

## Commands

Run from anywhere inside the repository (or pass `--root PATH`). Exit status: 0 success, 1 a check
failed, 2 a setup problem (for example, `puckcore` is not installed).

| Command | What it does |
|---|---|
| `puckworks-tools validate-registry` | Validates `data/params/*.yaml` against `data/schema/parameter.schema.json`, the unit vocabulary `data/schema/units.yaml`, and every dataset sidecar in `data/datasets/` (see below) |
| `puckworks-tools fixtures` | Writes `data/fixtures/sphere_cases.json` from the installed `puckcore` |
| `puckworks-tools fixtures --check` | Regenerates the fixture in memory and fails if the committed file differs, printing the largest difference and where it is. `--tolerance ATOL` allows small absolute differences in results (default 0, exact) |
| `puckworks-tools shot-fixtures [--check]` | Writes, or checks, `data/fixtures/shot_cases.json`: recipes with the spec and result the native core gives (below). `--tolerance ATOL` as for `fixtures` |
| `puckworks-tools verify` | Writes `docs/validation/m0-kernel-verification.md` and `.json`. `--quick` runs small series (smoke test); `--output-dir` writes elsewhere |
| `puckworks-tools calibrate` | Fits the M1 calibration (`data/calibration/config.yaml`; [docs/validation/calibration.md](../docs/validation/calibration.md)) and writes `data/calibration/<label>.yaml` and `current.yaml`. Options: `--dry-run` (with a check that each override parameter lists every block it changes), `--blocks V1,V4`, `--tier`, `--jobs N`, `--max-nfev`, `--loo` (V1 leave-one-out), `--prune` (fix weakly identified shared parameters and refit), `--sensitivity` (V1 refits under changed case assumptions), `--pool-only` (re-pool `hydraulics.permeability.reference` with the current builder, no refit), `--out-dir`, `--no-current`, `--start-from FILE` (bounded warm start), `--checkpoint-dir DIR` (atomic main/prune/refit snapshots). Defaults to v3 and protects historical v1/v2 output paths. Refuses to write `data/calibration` while the solver is a placeholder |
| `puckworks-tools validate` | Writes the M1 validation report `docs/validation/m1-validation.md` (figures in `docs/validation/m1/`, numbers in `.json`): calibration fit quality and the held-out checks of PLAN §10. `--quick` (tier 0), `--jobs N`, `--calibration FILE`, `--output-dir`, `--from-json FILE` (re-render without simulating). `python/scripts/m1-pipeline.sh [JOBS]` runs the whole M1 pipeline (rebuild, calibrate, export, rebuild, validate, shot fixture, checks) |
| `puckworks-tools community --archive ZIP --log CSV` | Imports the pinned original Gagné experiment and runs exploratory model comparisons with fixed assumptions. No download, fitting or admission to the calibration inventory. `--tier 0` is a coarse smoke run; the default is tier 1. Detailed output goes to `.local/community/gagne2021`; `--output-dir` must be outside a Git worktree or ignored |
| `puckworks-tools export [--check]` | Forwards to `puckworks_tools.export.main` (workstream D): writes, or checks, `crates/puckmodel/generated/presets.json` and `registry.json` from `data/presets`, `data/params` and `data/calibration/current.yaml`. Run it after any change to those |
| `puckworks-tools check-versions` | Checks that `Cargo.toml` (`[workspace.package]`), `web/package.json` (if present), `python/pyproject.toml` and `puckcore.__version__` agree. `--release` also requires a `## [<version>]` heading in `CHANGELOG.md` |

`python -m puckworks_tools …` works too.

## Reproduce the community comparison

Obtain the author's [original shot ZIP](https://www.dropbox.com/s/l0v4a5d3h98kasn/shotfiles_Mar2_2021.zip?raw=1)
and [measurement-log CSV export](https://docs.google.com/spreadsheets/d/1r33CI6lczJhuYcNjy8z3jABagZoxO8Z0kkd6h5Ppos0/export?format=csv),
identified by hashes in the [source audit](../docs/research/04-community-shot-data.md). Store them outside
tracked data, for example under `.local/sources/`, then run:

```sh
.venv/bin/puckworks-tools community \
  --archive .local/sources/shotfiles_Mar2_2021.zip \
  --log .local/sources/gagne2021-log.csv
```

The command reads local files only. Source checksums must match the inspected downloads; a changed
spreadsheet needs a new provenance review, not silent reuse of the old experiment identity. The parser
does not execute Tcl or export account/device fields. It preserves measurement noise, separates
observed and target channels, and reports an unreached mass threshold as missing.

The command uses the calibration selected by `data/calibration/current.yaml`. That document must match
`data/calibration/<label>.yaml`, and the installed extension must embed the same calibration label,
parameter keys and values. After changing the selection, run `puckworks-tools export` and rebuild the
native extension before comparing shots. The report records the selected label, coefficient values,
both calibration-file hashes and the current solver identity; it does not refit them to these shots.
Choose a fresh `--output-dir` when changing the calibration or core version to preserve earlier reports.
Saved reports keep their recorded calibration identity when rendered again. The published comparison
uses v2 with core 0.5.0; running the current model produces a new comparison, not a reproduction of those
historical numerical results.

The [comparison report](../docs/validation/community-shot-comparison.md) records the assumptions and
observations used. Pressure-driven comparisons condition on the measured pressure and therefore cannot
validate pressure prediction. Missing particle-size and machine inputs prevent matched calibration;
these runs are exploratory and do not replace the existing held-out tests. Raw sources and detailed
reports remain local; only the cited aggregate report is committed.

Command probes use the fixed 0/0.5/2 mL/bar compliance grid; pressure-conditioned runs
retain zero compliance. The report includes bloom pressure decline, charged storage,
cumulative inlet/outlet volumes and interval conservation, plus time-step refinement
for a fixed nonzero-compliance case. It does not choose a best-fit storage value.
For your own experiments, use recipe override `model.machine.hydraulic_compliance`
in mL/bar or raw-spec `machine.hydraulic_compliance_m3_pa` in SI (×10⁻¹¹).
The default remains zero. [ADR 0011](../docs/decisions/0011-upstream-pressure-storage.md)
defines the boundary and post-stop behavior.

## Tests

```sh
.venv/bin/python -m pytest python/tests
```

The suite covers registry validation (the real registry passes; about 40 crafted bad records each
fail with the expected message; linked parameters such as D_ax and Bo agree), the unit vocabulary, dataset sidecars, the fixture format and
`--check`, the version check, the independent analytic solution, and a quick run of the
verification report. For M1 it adds: every dataset sidecar validates with its licence and size; every
case builder produces specs that pass the checks and simulate on the current build; the calibration
plumbing recovers known parameters (a synthetic problem, and a permeability recovered through the
solver), flags unidentified parameters and writes documents the export accepts; the validation report
runs end to end; the shot fixture's format, coverage and `--check`; the importers' helpers; and the CLI
wiring (export delegation). Tests that need `puckcore` are skipped when it is not installed.

`test_committed_fixture_matches_the_current_build` fails whenever the core's numbers change: after
an intended solver change, regenerate the fixture with `puckworks-tools fixtures` and re-run
`puckworks-tools verify`.

## Layout

```
python/
├── pyproject.toml
├── puckworks_tools/
│   ├── cli.py         command line
│   ├── registry.py    parameter registry validation
│   ├── datasets.py    dataset sidecar validation
│   ├── units.py       unit vocabulary: parsing, checks, conversion
│   ├── notes.py       research-note section index ("01 §4.3")
│   ├── analytic.py    independent NumPy implementation of Crank's sphere solution
│   ├── fixtures.py    golden sphere fixture for the cross-language check
│   ├── shotfixtures.py golden shot fixture (recipes → spec and result)
│   ├── verify.py      kernel verification report
│   ├── cases/         case builders: each validation dataset as ShotSpecs, and its observables
│   ├── calibrate.py   M1 calibration harness (scipy least squares)
│   ├── validate.py    M1 validation report
│   ├── community.py   exploratory comparisons with locally supplied community logs
│   ├── sources/       importers that regenerate dataset CSVs from the original downloads
│   ├── export.py      presets and registry JSON for the model crate (workstream D)
│   ├── versions.py    version consistency
│   ├── paths.py       repository paths
│   └── yamlio.py      YAML loading (YAML 1.2 floats, no duplicate keys)
└── tests/
```

## The parameter registry

Every model parameter enters through `data/params/*.yaml` with a source, an evidence grade and a tag
(docs/PLAN.md §7.3 R and §16). A file looks like this:

```yaml
schema: puckworks.parameters/1
description: Bed geometry, densities and porosity.
parameters:
  - id: bed.porosity.intergranular        # dotted, lower case; ids form a tree
    name: Intergranular (bed) porosity
    symbol: ε
    description: Pore volume between particles per bed volume.
    units: "1"                            # from data/schema/units.yaml
    value: 0.17                           # value and/or prior
    prior: {distribution: triangular, min: 0.10, mode: 0.17, max: 0.29}
    range: {min: 0, max: 1}               # physical limits or plan scope
    relation:                             # required when tag is derived
      derived_from: [bed.porosity.total, bed.porosity.intraparticle]
      formula: "ε = (ε_total − ε_p)/(1 − ε_p)"
    conditions: ...
    tag: estimated                        # measured | derived | estimated | fitted
    evidence_grade: C                     # A | B | C | D
    sources:
      - citation: "Cameron M.I. et al. (2020) ... Matter 2:631–648."
        doi: "10.1016/j.matt.2019.12.019"  # bare DOI
        locator: "Table 1"                 # optional
    research_note_ref: "01 §4.4"          # or a list of references
    used_by: [P, H, X]                    # module letters of PLAN §7.3
    licence_note: ...                     # optional (PLAN §11)
    comment: ...                          # caveats, other values, [unverified]/[derived]
    status: draft                         # draft | accepted
```

Conventions used for the first entries (all transcribed from the research notes in `docs/research`):

- **Values are transcribed exactly** as the notes state them, and no number is invented. Where a
  note rounds a value from the primary source and the source was checked, the comment gives the
  source's printed precision.
- **Priors encode the stated evidence.** A range "a–b" becomes `uniform(a, b)`, or, when a > 0 and
  b/a > 10, `lognormal` with `lower: a, upper: b, coverage: 0.95`. "x ± s" becomes `normal(x, s)`
  (± read as one standard deviation unless the source says otherwise). A range with a typical value
  becomes `triangular`. A lone value has no prior. Uncertainty is widened by grade later, in module
  U, not here.
- **A prior covers every value its record cites**, unless the comment says why a value is left out
  (another weighting, method or definition).
- **Per-grinder parameters.** When a note says a parameter must be fitted per grinder or setup and
  the evidence comes from one or two of them (e.g. `psd.x50_gap_ratio`, `psd.fines_slope`), the prior
  is a lognormal whose 95% interval extends the evidence by a factor √2 on each side. The factor is
  a judgement, and the comment says so.
- **`range`** holds physical limits (0–1 for fractions, 0–100 for percentages, ≥ 0 for positive
  quantities) or the scope the plan supports (PLAN §4, e.g. doses of 7–25 g), never invented numbers.
  The validator requires the value and the prior's support inside it; an unbounded prior must have
  its centre inside and at least 95% of its probability inside.
- **`relation`** records how a parameter follows from, or is linked to, others: a `formula` (with the
  numbers a note used) and the registry ids it can be computed from (`derived_from`). It is required
  for derived records and also documents linked quantities, e.g. bulk density, skeletal density and
  the two porosities, or D_ax = vL/Bo. Linked quantities must not all be sampled independently.
- **Tags:** `measured` (measured directly in the cited source); `derived` (calculated from measured or
  tabulated inputs without fitting, by the source or in a note); `estimated` (judgement,
  extrapolation, analogy, class assignment, or a model's assumed parameter); `fitted` (obtained by
  fitting a model to data).
- **Evidence grade** (A peer-reviewed measurement, B peer-reviewed model/fit/inference,
  C thesis/book/review, D community or grey literature), in this order: the grade the note gives the
  row or statement, taking the weaker where it is combined ("A/B") or where the cited sources are
  graded differently; otherwise, for derived values, the weakest input; otherwise the grade of the
  source type. A prior that needs several sources takes the weakest of them.
- **Markers** such as [unverified], [derived], "abstract read" and secondary citations are copied into
  `comment`.
- **Status** stays `draft` until the maintainer reviews a record.

`validate-registry` checks: schema validity (including a `relation` on every derived record); unique
ids and the id tree (no id is a dotted prefix of another); known units; value and prior against the
range and against each other; that every `relation.derived_from` id exists; DOI syntax; and that
every `research_note_ref` names an existing note (`docs/research/NN-*.md`) and heading:
`"NN §X.Y"` for a numbered heading, `"NN Implications"` or `"NN Implications A"`, and
`"NN Open questions"`. YAML files are read with YAML 1.2 float rules (`1e-10` is a number, not a
string) and duplicate keys are errors.

### Units

`data/schema/units.yaml` lists every unit string with its SI dimension exponents and scale factor.
Spelling is ASCII: products with `*`, at most one `/`, exponents with `^` (`kg/m^3`,
`m^7*kg^-2*s^-1`, `mPa*s`, `um` for micrometres, `degC`). The validator re-derives each listed
unit from its spelling and the `atoms` and `prefixes` tables, so a wrong scale or dimension in the
vocabulary is an error. To add a unit, add a line to `units`; add an atom only for a new symbol.

## Datasets

Dataset sidecars (`data/datasets/<id>/dataset.yaml`) follow `data/schema/dataset.schema.json`. The
validator also enforces the licensing rules of PLAN §11 (no non-commercial data bundled;
`facts-cited` data are `cite-only`) and checks each CSV file against the declared columns, types and
units. See [data/datasets/README.md](../data/datasets/README.md) for the rules and how to add a dataset.

## Golden shot fixture

`data/fixtures/shot_cases.json` holds seven recipes with the spec the native builder makes of each and
the result the native solver returns for that spec. The web tests feed each recipe to the WebAssembly
build and compare:

```json
{"schema": "puckworks.shot-cases/1", "core_version": "0.1.0", "generator": "puckworks-tools shot-fixtures",
 "cases": [{"name": "...", "recipe": {...}, "spec": {...}, "result": {...}}]}
```

`spec` is `build.spec` of `simulate_recipe(recipe)` and `result` its `result`. The cases cover tiers 0
and 1, a vibratory pump, a pressurised basket, flow-controlled programs, a custom tapered basket and a
measured PSD, plus pressure-storage pause/resume cases with a stored-water tail or a stop vent.
The file has no wall-clock fields and stays under 3 MB. Floats round-trip exactly.
`shot-fixtures --check` compares recipes, keys and strings exactly and the numbers of `spec` and
`result` to `--tolerance`. Regenerate it whenever the builder or the solver changes on purpose.

## Golden fixture

`data/fixtures/sphere_cases.json` holds three sphere-release runs of the native core
(`boulder_bdf2`, `fines_cn`, `uniform_be`), with their parameters and full results:

```json
{"schema": "puckworks.sphere-cases/1", "core_version": "0.1.0", "generator": "puckworks-tools fixtures",
 "cases": [{"name": "...", "params": {"radius_m": ..., "diffusivity_m2_s": ..., "n_shells": ..., "t_end_s": ...,
            "n_steps": ..., "grid": "...", "scheme": "..."},
            "result": {"t_s": [...], "released_fraction": [...], "analytic_fraction": [...],
                       "shell_outer_radii_m": [...], "final_profile": [...],
                       "max_abs_error": ..., "mass_balance_error": ...}}]}
```

Floats use Python's shortest round-trip representation, so parsing gives back exactly the doubles
the core produced. The web tests compare the WebAssembly build against this file (PLAN §10:
browser and native agree). `fixtures --check` compares parameters and metadata exactly and results
to `--tolerance`.

## Calibration and validation (M1)

- **Datasets** (`data/datasets/`): 19 folders from Schmieder 2023, Waszkiewicz 2026, Cameron 2020, Vaca
  Guerra 2024, Corrochano 2017 and Smrke 2024 (licences and gaps in
  [data/datasets/README.md](../data/datasets/README.md)). `sources/` regenerates their CSV files from the
  downloads (xlsx tables, the authors' Zenodo archive, PDF vector graphics, raster figures).
- **Case builders** (`cases/`): one ShotSpec per experimental condition, starting from the builder's spec
  for a minimal recipe and setting the paper's physical conditions; `observe` maps a ShotResult onto the
  dataset's observables. Documented in [docs/validation/case-builders.md](../docs/validation/case-builders.md).
- **Calibration** (`calibrate.py`): registry ids ↔ recipe overrides, spec fields or case parameters, with
  bounds from the registry priors; per-dataset normalised residuals; `scipy.optimize.least_squares` with a
  block-sparse finite-difference Jacobian; uncertainties and posterior/prior SD ratios from the Jacobian;
  the reference permeability pooled from the fitted nuisance permeabilities. Documented in
  [docs/validation/calibration.md](../docs/validation/calibration.md).
- **Validation** (`validate.py`): fit quality of the calibration blocks and the held-out checks V3 (Cameron),
  V4 transient (Waszkiewicz) and V5 (Smrke), with pass or fail against PLAN §10; tier 0 against tier 1 on
  the held-out cases; generic app shots; the validation part of the M1 exit criteria.

### Particle-size input audit (0.5.1)

The historical v1/v2 Schmieder input reconstructed the wet volume mean with an assumed 25% fines
mode; it did not reproduce the published surface-area mean. Calibration v3 explicitly selects the
qualified wet CDF after correcting the mobile/particle solute inventories. The explicit `wet_cdf` case input
combines the resolved wet cumulative curve with a D[3,2]-constrained unresolved head. The
[report](../docs/validation/m11-particle-inputs.md) compares fixed input scenarios with the v2
coefficients unchanged, including source-moment, pore-air-time and numerical sensitivities:

```bash
.venv/bin/python -m puckworks_tools.particle_inputs --jobs 3 --output-dir .local/particle-inputs
```

Reproducing the published 0.5.1 audit requires its original source/build (`7b1d3a0`). On a newer
engine this command evaluates fixed v2 coefficients on that engine and records its identity; it
is not a reproduction of the historical numbers. The committed audit is preserved.

The PSD affects both the derived pore-air timescale and preparation heterogeneity. The
fixed-air-time probe isolates the former; the 32-class refinement holds every non-class field
at its nominal wet value. The JSON retains final specs, observations, failures and input hashes.

To regenerate the new dataset, download the [published article PDF](https://www.mdpi.com/2304-8158/12/15/2871/pdf)
as `schmieder2023.pdf` into a local directory. The importer checks the edition's hash and requires
`pdftoppm` and the `sources` extra; `--review-dir` additionally uses matplotlib:

```bash
.venv/bin/python -m puckworks_tools.sources.schmieder2023_psd .local/sources \
  --out .local/imported-datasets --review-dir .local/particle-inputs/source-review
```

The [sidecar](../data/datasets/schmieder2023-psd/dataset.yaml) records source attribution,
digitisation, omitted/occluded points, monotonic correction, and support assumptions. D[3,2]
matching is imposed by the reconstruction; D[4,3] remains an unfitted check. The ±1 SD probes
are source-moment sensitivities, not a complete uncertainty interval or a calibrated improvement.
Wet particle sizes do not independently identify dry pore geometry or a water-exchange time.

## Verification report

`puckworks-tools verify` checks the sphere-diffusion kernel against Crank's analytic solution
(a = 100 µm, D = 10⁻¹⁰ m²/s, t_end = 20 s, so τ = D t/a² runs to 0.2) for every grid × scheme:

- a space-refinement series, N = 16, 32, 64, 128 shells at 10⁵ steps (10⁶ for backward Euler);
- a time-refinement series, 100, 200, 400, 800 steps at N = 65 536;
- per run: the maximum error over all output times, the error at τ = 0.1, the mass-balance error and
  the runtime; observed orders log2(e_coarse/e_fine);
- an independent NumPy implementation of Crank's series (`analytic.py`, written from the formula and
  not calling `puckcore`) compared with `puckcore.crank_sphere_release_fraction` at about 2000 values
  of τ from 10⁻⁸ to 10.

It writes the Markdown report and a JSON file with the raw numbers to `docs/validation/`, and flags a
solver that ignores `grid` or `scheme`. Regenerate it for every release (PLAN §16).
