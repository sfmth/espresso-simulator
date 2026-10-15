<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M1 contract: recipes, shot specs and shot results

*Puckworks M1 · 2026-10-14.* This contract lets the solver, the input models, the tools and the web app evolve independently. It is binding for every M1 workstream.

## 1. Layers

```
Recipe ──puckmodel::builder──▶ ShotSpec ──puckcore::shot::simulate_shot──▶ ShotResult
(gear as a person describes it)    (complete physics, SI)                 (what the shot produces)
```

| Layer | Rust type (source of truth) | JSON schema id |
|---|---|---|
| Recipe | `crates/puckmodel/src/recipe.rs` → `Recipe` | `puckworks.recipe/1` |
| Physical spec | `crates/puckcore/src/shot/spec.rs` → `ShotSpec` | `puckworks.shot-spec/1` |
| Result | `crates/puckcore/src/shot/result.rs` → `ShotResult` | `puckworks.shot-result/1` |
| Presets | `crates/puckmodel/generated/presets.json` | `puckworks.presets/1` |
| Registry export | `crates/puckmodel/generated/registry.json` | `puckworks.registry/1` |

**Field definitions.** The Rust doc comments on each field are the field definitions. JSON uses the Rust field names (snake_case). Enums are internally tagged with `"type"` in snake_case, e.g. `{"type": "pressurised", "orifice_diameter_m": 0.0004, "discharge_coefficient": 0.7}`.

## 2. Conventions

- **Units.** ShotSpec and ShotResult use SI, with the unit in every field name (`_m`, `_kg`, `_s`, `_pa`, `_m3_s`, `_kg_m3`, `_m2_s`). Temperatures are °C (`_c`). TDS, EY, porosities and fractions are plain fractions (0.095, not 9.5).
- **Recipes** use practical units (g, mm, µm, bar, mL/s, °C). Diameters, not radii.
- **Strictness.**
  - Input documents (Recipe, ShotSpec) reject unknown fields. Missing fields take defaults: `Default` in Rust, and optional fields in recipes.
  - Output documents tolerate unknown fields, for forward compatibility.
- **Numbers.** Every number must be finite; JSON cannot carry NaN or infinity. Solvers must never emit them.
- **Determinism.** Native and WebAssembly builds must give bit-identical results for the same JSON input (ADR 0002, ADR 0005).

## 3. API (frozen names and signatures; new functions may be added)

| Rust (`puckmodel::api`) | JavaScript (`web/src/engine/pkg`) | Python (`import puckcore`) | Returns |
|---|---|---|---|
| `presets_json()` | `presets()` | `presets()` | presets document |
| `registry_json()` | `registry()` | `registry()` | registry document |
| `build_shot_spec_json(recipe)` | `buildShotSpec(recipeJson)` | `build_shot_spec(recipe)` | `{spec, derived}` |
| `simulate_shot_json(spec)` | `simulateShot(specJson)` | `simulate_shot(spec)` | ShotResult |
| `simulate_recipe_json(recipe)` | `simulateRecipe(recipeJson)` | `simulate_recipe(recipe)` | `{build: {spec, derived}, result}` |

**Calling conventions.**
- JavaScript functions take and return JSON strings, and throw `Error` with a readable message.
- Python functions accept a dict or a JSON string, return dicts, and raise `ValueError`.

**`derived` fields.** `Derived` in `crates/puckmodel/src/builder.rs` is the definition.
- `psd_curve`: `{diameter_um[], volume_density[]}` for plotting; the density is per unit ln(diameter).
- `notes[]`: assumptions, clamped inputs and flagged presets, written for the user.
- `provenance`: maps a spec field's dotted path to comma-separated tokens: `registry:<id>`, `calibration:<id>`, `override:<id>`, `preset:<kind>/<id>`, `recipe:<field>` or `model:<description>`.
- Added in M1 (workstream D):
  - `psd`: source, X50, fines fraction, D[3,2], D[4,3], the log-normal mixture and the class count;
  - `bean`: the bean as modelled;
  - `bed`: the bed in the basket;
  - `presets`: the presets used, by kind;
  - `flags`: the flags of the presets used (`estimated`, `unverified`, `disputed`, `owner-gear`, `generic`).

New `derived` fields may be added.

**Exact numbers.** `puckmodel` enables serde_json's `float_roundtrip` feature, so every number survives a JSON round trip exactly in all three languages.

## 4. Model requirements behind the types (M1)

These are the minimum the M1 solver honours. The full specification lives in `docs/model/shot-model.md`, written by workstream A.

- **Geometry.**
  - `basket.profile_m` is any axisymmetric wall profile. The bed fills from the floor until its volume equals dose / ((1−ε)(1−ε_p)ρ_s).
  - Columns are radial annuli of the actual geometry. The cross-section A(z) varies with depth in tapered baskets.
  - The headspace is the basket volume above the bed plus `extra_headspace_m3`.
  - A pressurised outlet adds an orifice resistance in series.
- **Flow.**
  - Darcy series resistance per column, with viscosity varying along the column.
  - Columns share the inlet pressure, or the total flow under flow control.
  - κ_eff = κ₀ · column multiplier · relative Kozeny–Carman(ε(t)) · poroelastic factor(P) · swelling · gas, plus an outlet fines resistance.
  - A wetting front, with the headspace filling first.
  - Pump: an ideal profiling pump, or a vibratory pump curve with an optional over-pressure valve. `PumpFull` phases take their pressure from the pump curve.
- **Extraction.**
  - Each size class has a broken-cell surface pool, of thickness `cell_size_m`, capped by saturation, and an intact kernel diffusing as spheres (M0 kernel numerics, ADR 0005).
  - Bed-liquid advection with axial dispersion; partition coefficients.
  - Lumped solubles are non-linear (saturation, viscosity, porosity). Tracked species are linear passengers on the same flow and temperature history.
- **Thermal.** A lumped ODE; viscosity and diffusivities depend on temperature.
- **Tiers.**
  - `numerics.tier = 0`: the same physics, coarsened to 1 column, about 8 depth cells, 2 size classes and linear driving force kernels. Budget ≤ 10 ms per shot.
  - `tier = 1`: as specified. Budget ≤ 1 s per 30 s shot, native and WebAssembly.
- **Stop and drip.** The shot stops when the stop rule fires, then the extract drips with time constant `drip_tau_s`. The reported beverage mass includes the drip.
- **Conservation.** The soluble mass balance (particles + liquid + cup) is reported in `diagnostics.mass_balance_error`.

## 5. Ownership during M1

| Path | Owner |
|---|---|
| `crates/puckcore/**` (solver, `shot` types and their JSON schemas), `docs/model/shot-model.md`, `data/schema/shot-*.schema.json` | **A** (solver) |
| `crates/puckmodel/**` (recipe types, input models, builder, presets and registry embedding, JSON API bodies), `data/presets/**`, `data/schema/recipe.schema.json`, `data/schema/preset*.schema.json`, `data/params/model.yaml`, `python/puckworks_tools/export.py` and its test | **D** (input models) |
| `data/datasets/**`, `data/params/**` except `model.yaml`, `data/calibration/**`, the rest of `python/**`, `docs/validation/**`, `.github/workflows/python.yml` | **C** (data and validation) |
| `web/**`, `.github/workflows/web.yml` and `pages.yml` | **B** (web), starting later |
| `Cargo.toml` (workspace), the binding crates, `scripts/`, `docs/PLAN.md`, `docs/decisions/**`, `docs/model/m1-contract.md`, README, CHANGELOG, CONTRIBUTING, `deny.toml` | lead |

## 6. Change rules

1. **Never rename or remove a field, enum variant or API function.** Additions are fine if they have defaults (ShotSpec, ShotResult) or are optional (Recipe).
2. **Keep `Default` complete.** Every new ShotSpec field must appear in its struct's `Default` impl, so struct literals with `..Default::default()` in other crates keep compiling.
3. **Keep the JSON schema in step.** Whoever owns a type updates its JSON schema in the same change, and reports the addition in their final report. The lead then updates this document.
4. **Never leave shared crates broken.** The solver workstream develops in an isolated copy and copies back only once `cargo build`, `clippy` and `test` pass in the main tree.

## 7. Golden shot fixtures

`data/fixtures/shot_cases.json` is generated from the native core by `puckworks-tools shot-fixtures [--check]` (workstream C). The web test suite replays it through WebAssembly and requires every number to be bit-identical (`Object.is`), as `sphere_cases.json` does for the particle kernel.

```
{"schema": "puckworks.shot-cases/1", "core_version": "…", "generator": "…",
 "cases": [{"name": "…", "recipe": {…}, "spec": {…}, "result": {…}}]}
```

- `spec` is the built ShotSpec (`build.spec` from `simulate_recipe`); `result` is the native ShotResult.
- **The web replay** (`web/test/crosslang-shot.test.ts`) requires, for every case:
  - `buildShotSpec(recipe).spec` equals `spec`;
  - `simulateRecipe(recipe)` and `simulateShot(spec)` both equal `result`.
  Every number is compared with `Object.is`, and the key sets must match. `result.core_version` is skipped, but the file-level `core_version` must equal the engine's.
- Any change to the builder, the solver or the calibration changes these numbers. Regenerate with `puckworks-tools shot-fixtures` afterwards.
- The file carries no wall-clock timing fields.

## 8. Additions during M1

Recorded here by the lead as workstreams report them (rule 3).

**Recipe** (workstream D; all optional; meanings in `docs/model/input-models.md` §12):

| Field | Purpose |
|---|---|
| `bean.bean_temp_c` | bean temperature at grinding |
| `grinder.burr_diameter_mm`, `grinder.rpm` | recorded, no effect in v1 |
| `grinder.gap_at_ref_um`, `grinder.gap_per_unit_um` | dial calibration |
| `grinder.x50_gap_ratio`, `grinder.fines_at_340_pct` | grinder-specific PSD shape |
| `grinder.psd.method` | measurement method of a measured PSD |
| `basket.custom.discharge_coefficient` | C_d of a pressurised orifice |
| `machine.pump` | `{"type": "ideal", max_flow_ml_s, max_pressure_bar}` or `{"type": "vibratory", free_flow_ml_s, stall_pressure_bar, opv_bar}` |
| `machine.headspace_ml` | group headspace above the basket rim |
| `numerics.size_classes` | number of size classes, 2–60 (default 30) |

| `grinder.coarse_log_width`, `grinder.boulder_weight` | σ_c and w_b for a grinder described from scratch (second round) |
| `machine.vent_headspace` | third round: a 3-way valve vents the group at the stop, so there is no drip. Precedence: recipe, then preset, then `false` |

`grinder.fines_at_340_pct` is narrowed to 1–40 (second round, with plausibility bounds on every recipe field: `crates/puckmodel/src/bounds.rs`, mirrored in the recipe schema).

**`derived`:** `psd`, `bean`, `bed`, `presets`, `flags` (§3). Second round: `presets.grinder_family`; `psd.d32_um` is now the size classes' D[3,2], the value κ₀ uses.

**Presets document** (second round): `dial.anchored` gives the measured range of a grinder dial; outside it, a note is shown. Third round: machines may carry `vent_headspace`, and `drip_tau_s` is at most 60 s. `psd.fines_slope_pct_per_um` is removed. It never appeared in a release, and readers tolerate its absence.

**Registry** (second round):
- added `hydraulics.permeability.reference` (C), `model.psd.coarse_log_width`, `model.psd.boulder_weight`, `model.psd.fines_weight_slope` and `model.extraction.solute_apparent_density`;
- removed `model.psd.fines_floor` and `model.psd.fines_ceiling`;
- the builder's reads are listed in `crates/puckmodel/registry-reads.txt`, and `export` refuses calibrations of ids that are never read.

**Rust API** (D): `puckmodel::build_traced` and `puckmodel::registry_reads`.

**Builder semantics** (third round):
- `hydraulics.dissolution_porosity_share` is set from the registry (θ = 0), with provenance, and can be overridden.
- A recipe pump of the preset pump's type fills the fields it omits from the preset; a pump of another type uses registry defaults. Each field's provenance names its source.
- Every registry-read id at either end of its range builds a valid spec that runs (tested).
- Base permeability: κ₀ = κ_ref · (D32/D32_ref)² · [KC(ε)/KC(ε_ref)]^α, with KC(ε) = ε³/(1−ε)² and α = `hydraulics.kozeny_carman.density_exponent`, the closure calibrated on V6 (fourth round). At the default porosity the bracket is 1.
- **Known limitation:** an explicit `opv_bar: null` means "inherit", just like leaving it out. To state "no valve" while the preset's pump of the same type has one, set `opv_bar` at or above the stall pressure; the valve then never opens.

**ShotSpec** (workstream A; all with defaults, which are the registry's central values):

| Field | Meaning |
|---|---|
| `solubles.solute_specific_volume_m3_kg` | specific volume of dissolved solids in the liquid, used for the extract's density and the TDS conversion |
| `hydraulics.dissolution_porosity_share` | θ, the share of dissolved solid volume that becomes intergranular porosity, in [0, 1]. Absent or `null` means θ = 0, bit-identical to an explicit 0 (second round; the proportional rule is removed) |
| `thermal.ambient_temp_c` | ambient temperature for heat loss |
| `numerics.kernel_shells` | equal-volume shells per kernel (2–64) |
| `solubles.kernel_loading_cap` | second round, default `true`: caps kernel re-uptake at the initial pore content u₀ |
| `machine.stop.vent_headspace` | second round, default `false`: a 3-way valve vents the group at the stop, so there is no drip |

**ShotResult** (workstream A):

| Field | Meaning |
|---|---|
| `summary.drip_mass_kg` | beverage mass that dripped after the stop (included in `beverage_mass_kg`) |
| `summary.uniformity.ey_mean` | mean local EY across the bed |
| `series.wetted_fraction` | wetted fraction of the bed against time |
| `diagnostics.min_concentration_kg_m3` | smallest concentration seen (positivity check) |
| `diagnostics.tier` | the tier that ran |
| `spatial.depth_edges_m` | second round: the depth-cell edges (cells + 1 values) |
| `spatial.snapshots[].wetted_fraction` | second round: the wetted share of each [column][depth] cell, 0–1 |
| `diagnostics.outflow_integral_error` | second round: cup solute against ∫q·c dt, as a relative difference. This is a quadrature-consistency check; it cannot detect errors inside the bed (third round wording) |
| `diagnostics.max_regime_solves`, `diagnostics.rejected_steps` | third round: the most policy-iteration solves in one step, and how many steps were rejected and retried at Δt/2 |

**Solver semantics** (second round, after the independent review):
- Every spec number is bounded (`docs/model/shot-model.md` §2.1, mirrored in the schema), and the model size is capped.
- Mass balance above 1e-9 warns, and above 1e-6 fails with `Numerical`. Negative concentrations warn or fail likewise.
- Partition coefficients are Corrochano's K, per swollen-particle envelope volume. The kernel boundary value is c/(K·ε_p).
- `spatial.snapshots[].liquid_conc_kg_m3` is per liquid holdup. Local EY is never negative while the loading cap is on.
- The drip drains only the headspace water.
- Tier 0 reports 4 columns (3 strata plus the edge), 2 without spread, or 1 without spread or edge.
- **Third round** (after a verification review):
  - A step whose pool regimes do not converge is rejected and retried at Δt/2, never accepted; after 12 halvings the run fails with `Numerical`.
  - Pools and kernels hold the pore liquid ε_p(1 − u_w), and the mobile holdup is ε + (1−ε₀)·ε_p·u_w, so liquid volume always equals total porosity.
  - `hydraulics.wetting_uptake` (u_w ≤ 0.9) is the mobile share of the particles' pore liquid; it mostly sets the wetting time.
  - Validation rejects v̄·max(c_sat, K·s₀) ≥ 0.9, with s₀ = E_max·ρ_s·(1−ε_p), and warns when K·s₀ > c_sat.
  - Total work is bounded: steps × model values ≤ 1e10.
  - Mass stops land within 0.2 mg.

**Rust API** (lead): `puckcore::shot::validate_shot_spec(&ShotSpec)` runs the solver's own spec check without simulating. It returns the warnings, or `InvalidSpec` naming the field. The builder uses it, so the builder never emits a spec the solver rejects.

**JavaScript diagnostics** (lead): `lastPanic()` returns the message of the most recent Rust panic, or `""`. A panic reaches JavaScript only as a `RuntimeError: unreachable` trap. Read `lastPanic()` right after catching one, then discard the worker; the instance's state is undefined after a trap.
