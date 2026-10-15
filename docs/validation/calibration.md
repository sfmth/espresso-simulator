<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M1 calibration harness

*Puckworks M1 · workstream C · 2026-10-15.* `puckworks-tools calibrate` fits model parameters to the M1
calibration datasets ([PLAN §12 M1](../PLAN.md#m1-validated-core-and-lab-view)). The datasets are V1
Schmieder 2023, V2 Vaca Guerra 2024 (dispersion), V4 Waszkiewicz 2026 (long-time Q(P)) and V6 Corrochano
2017 (relative closure). The fit is written to `data/calibration/`, and the export
(`python/puckworks_tools/export.py`) embeds `current.yaml` into the app. The code is
`python/puckworks_tools/calibrate.py`; the configuration is
[data/calibration/config.yaml](../../data/calibration/config.yaml).

## Parameters, registry ids and spec fields

Every fitted parameter is a parameter-registry record. The record supplies:
- its units;
- its starting value: the record's value, or the prior's central value, as the export uses (the config's
  `start` can override it, for example for the nuisance permeabilities);
- its default bounds: the prior's support (uniform, triangular) or central 99.7% (normal, log-normal),
  clipped to the range. Without a prior, a factor of 10 around the value.

The config can narrow or widen the bounds; the M1 configuration keeps every shared model parameter inside its
prior. A parameter enters the cases in one of three ways:

| Mode | How it enters | Used for |
|---|---|---|
| `override` | as a recipe override; the builder maps the registry id to spec fields | shared model parameters; the calibrated value means exactly what the app's builder makes of it |
| `spec` | written into one spec field (`target`, a dotted path such as `solubles.species[id=caffeine].mass_fraction`) of the cases selected by `applies_to` (`dataset` or `dataset:group`), converted from the registry's units to the field's SI unit | setup-specific (nuisance) parameters |
| `case` | applied by a case builder (`CASE_PARAMETERS`) | the V6 closure exponent |

`calibrate` first checks every `override` parameter. Its id must be in the registry embedded in puckcore,
and the builder must use it, which shows as `override:<id>` in the provenance of some spec field. Otherwise
it warns, because the parameter could have no effect, and the export would embed a value nothing reads.

**Blocks.** Each parameter lists the residual blocks it affects, and its Jacobian column re-runs only those.
An override parameter is applied to every case, so it must list every block it changes: the dispersion
changes the V1 extraction curves as well as V2, and the critical pressure changes V1 and V6 as well as V4.
`calibrate --dry-run` perturbs each override parameter and warns when an unlisted block moves
(`check_blocks`).

**Fixed parameters.** The config's `fixed` section lists parameters that were reviewed for the calibration
and are held at their registry values (or, for a spec field without a registry id, at the solver's default),
each with its reason. They are recorded under `fit.fixed` in the calibration file.

## Identifiability

A parameter is fitted only if the calibration data constrain it. For each parameter the harness reports the
posterior SD (from the Jacobian, scaled by the reduced chi-square) over the SD of the registry prior, both in
the fit's coordinate (log10 for log-scaled parameters). At 0.5 or more the data add little to the prior
(`fit.weakly_identified`). Strong correlations inflate the marginal SDs, so the review is stepwise: fit,
fix the worst-identified interior shared parameter at its registry value, refit, and repeat until every
fitted shared parameter has a ratio below 0.5. A parameter that the fit holds at a bound of its prior is
constrained there, not unidentified; it is kept and reported as at its bound. Nuisance parameters are
always fitted. The calibration run applies the same rule to the shared parameters left in the config
(`calibrate --prune`); each parameter it fixes is recorded under `fit.fixed` with its SD ratio.

**Path independence.** Fixed parameters and the reference permeability (an output of the calibration, not a
fit parameter) are passed to every case at their registry values, and the fitted values explicitly, so a
calibration already embedded in puckcore cannot change any result: `validate` recomputes the calibration
blocks to the same RMS as the calibration file, and the report shows both. `fit.inputs` hashes the config and
every dataset folder used, and `fit.solver` identifies the build.

The review also checks parameters outside the fit (the dissolution share θ, the viscosity exponent γ, the
swelling and gas amplitudes, the critical pressure in V1) by adding each one alone at the V1 optimum:
its SD ratio, its correlation with the fitted set, and the shift the residuals ask for (a Wald z against the
registry value). Where a candidate is strongly collinear with the fitted set (more than 90% of its Jacobian
column explained by the others), the linearised ratio can mislead, and the review refits with the candidate
at two values instead (θ below).

### Review of 2026-10-14 (V1 trial fits)

The review ran on V1 alone, on the build of 2026-10-14 before the input-model fixes; the final fit's ratios
are in `fit.uncertainties` and the validation report.

| Parameter | SD ratio | Finding | Decision |
|---|---|---|---|
| species kernel diffusivities (caffeine, trigonelline, 5-CQA) | 2–12 | trade off with the contents (correlation −0.89 to −0.95); free fits drift 2–5× outside the literature priors (caffeine to 8×10⁻¹¹ m²/s, trigonelline to the 1×10⁻⁹ bound) | fixed |
| species surface-pool scales | 0.4–0.8 | the lever the species' λ need (their records name the Schmieder λ as the target); caffeine and trigonelline go to their prior bounds (0.5 and 2.0) | fitted, inside the priors |
| lumped kernel diffusivity | 1.15 | trades off with the extractable fraction; fixing it did not raise the cost | fixed |
| surface rate (Grudeva) | 44 | any value in its range keeps the surface flux fast | fixed |
| broken-shell thickness, saturation | 0.4–0.6 | both go to the top of their priors (40 µm, 280 kg/m³): the data want a larger fast pool | fitted, at their bounds |
| γ (viscosity exponent) | 0.13 | identified by the temperature dependence of the peak pressures; agrees with the registry value (0.445 ± 0.014 against 0.45) | fitted (shared with V4) |
| θ (dissolution share) | 0.12 (linearised) | collinear with the contents (correlation 0.95); refitting V1 at θ = 0 and at the proportional rule (≈0.27) gave the same cost (627.6 against 623.8) on this build, with the grinding-level permeabilities doubling at θ = 0 (on the final solver the θ = 0.27 recalibration fits worse: Results) | fixed at its mechanistic default, 0 (registry); θ = 0.27 reported as a structural sensitivity |
| swelling (pore-closure share) | 1.6 | not identified; the residuals lean towards less swelling (z 2.4) | fixed |
| gas amplitude | 0.4–0.7 | weakly identified, no evidence against the registry value (z 0.8) | fixed |
| critical pressure, from V1 alone | 0.7 | collinear with the grinding-level permeabilities (correlation −0.98); V1 leans to 15.6 bar (z 1.7) | fitted jointly with V4 and V6 |

With the species diffusivities fixed and the surface-pool scales fitted, λ still misses ±10% for
trigonelline (+9% on average) and caffeine (−11%), and TDS λ runs +12% with c₀ −10%: the model's λ spread
between species is narrower than the data's (15.4–22.2 g), even with the scales at their prior bounds. The
priors were not widened to force agreement. On the final M1 solver the calibration brings λ within ±10% for
50 of the 60 experiment–analyte pairs, with the scales inside their priors (Results).

## Prior provenance

Held-out facts must not shape the priors or model choices that their checks test. The review of 2026-10-15
traced every builder-read record that cites a held-out dataset:

| Record | Held-out fact behind it | Effect | Status |
|---|---|---|---|
| `extraction.saturation.lumped`, prior bounds | the upper bound, 280 kg/m³, came from Waszkiewicz's first-drop TDS (V4 TDS, held out) | the V1 fit sat on that bound, and the V4 first-fraction TDS check was not independent | re-derived without V4: 210–350 kg/m³, from Cameron's and Grudeva's model values and the highest Schmieder c₀ (V1, calibration data); the V4 TDS check is independent again |
| `model.prep.sigma_fines_sensitivity` (input models, model.yaml) | a judgement motivated by Cameron 2020's fine-grind behaviour (EY spread rising below GS 1.7), the V3 phenomenon | sets the permeability spread at fine grinds, which shapes V3's EY peak | V3's two EY-peak checks are marked "not independent" in the report |
| `hydraulics.poroelastic.critical_pressure`, prior | Waszkiewicz's fitted P_c (V4 Q(P), calibration data) | prior and fit share data | not a held-out leak; stated |
| `hydraulics.permeability.reference`, pre-calibration value | typical shot times (`shot.time.observed`, which cites Cameron and Smrke) | the registry default only; the calibration replaces it | no effect on the held-out checks |
| `psd.*`, `model.psd.fines_weight_slope` | Cameron, Smrke and Waszkiewicz PSDs (inputs, not outcomes) | the grinder presets; the V3 and V5 cases use their measured PSDs | no effect on the held-out checks |

## Results of the M1 calibration (v1, 2026-10-15)

`python/scripts/m1-pipeline.sh 8` on puckcore 0.2.0, sources `crates/puckcore/src` 164c715d8321929e and
`crates/puckmodel/src` b1bb6c6ab6559863 (`fit.solver`; config and datasets hashed in `fit.inputs`), θ = 0,
the density exponent α app-facing. The fit converged (ftol) at cost 683 after 24 evaluations (9,274
simulations including the prune refit); reduced chi-square 4.23, χ²/n by block V1 3.6, V2 14.1, V4 13.0,
V6 2.9, so every SD below is a lower bound. `--prune` fixed the broken-shell thickness at 25 µm (posterior SD
0.90× the prior's; 34.6 µm before pruning). In the superseded run on the previous solver it pruned the
critical pressure instead (0.51): both ratios sat near the 0.5 threshold, so prune decisions near it are
fragile.

| Parameter | Value | SD | SD/prior | Note |
|---|---|---|---|---|
| `extraction.saturation.lumped` | 342 kg/m³ | 14 | 0.35 | prior 210–350 without held-out data (Prior provenance) |
| `model.species.caffeine.surface_fraction_scale` | 0.510 | 0.056 | 0.19 | at the bottom of its prior (0.5) |
| `model.species.trigonelline.surface_fraction_scale` | 1.301 | 0.048 | 0.11 | |
| `model.species.cqa5.surface_fraction_scale` | 0.742 | 0.039 | 0.14 | |
| `model.hydraulics.viscosity_temperature_exponent` (γ) | 0.302 | 0.032 | 0.29 | |
| `hydraulics.poroelastic.critical_pressure` | 12.46 bar | 1.27 | 0.42 | |
| `extraction.dispersion.axial_coefficient` | 3.87×10⁻⁶ m²/s | 0.29×10⁻⁶ | 0.13 | model Bo above the data in 5 of 5 |
| `hydraulics.kozeny_carman.density_exponent` (α) | 0.244 | 0.039 | 0.04 | app-facing: the builder's κ₀ closure |
| `hydraulics.permeability.reference` | 1.24×10⁻¹³ m² | | | pooled (below) |

Nuisance values: extractable fraction 28.3 ± 0.3%; caffeine 1.261 ± 0.013%, trigonelline 0.670 ± 0.008%,
5-CQA 0.875 ± 0.010%; bare κ₀ 2.77, 3.05 and 3.97×10⁻¹⁴ m² at GL 1.4, 1.7, 2.0 (±10%) and 1.88×10⁻¹⁴ m² for
Waszkiewicz (±9%). Held at registry values with reasons (`fit.fixed`): the species and lumped diffusivities, the
surface rate, swelling (V1's residuals lean towards less swelling, Wald z 2.4 against its fixed value in the
review), gas amplitude, θ = 0 and the pruned shell thickness. Leave one condition out: λ 59/60 and cup masses
179/180 within ±15% (mildly optimistic: shared parameters stay at their full-fit values).

**Pump saturation.** At these values every V1 shot spends 1.5–3.7 s at the pump's 12 bar limit during the
preinfusion-to-pour switch, and experiment 12's pour sits at it for 4.7 s. Its residual is kept and flagged;
leaving it out changes no κ_ref estimate (sensitivity below).

**Reference permeability.** The structural spread dominates the statistical one:
- between datasets: Schmieder through the E65S preset (scaling 0.41–0.48, D32 106–115 µm), 6.70, 6.82 and
  8.25×10⁻¹⁴, so 7.22×10⁻¹⁴ m²; Waszkiewicz through its measured PSD (scaling 0.088, D32 49 µm),
  2.14×10⁻¹³ m². Pooled 1.24×10⁻¹³ m² (log-SD 0.55; the datasets differ ×3.0, the four estimates ×3.2), against
  fit uncertainties of about 10%;
- ×2.9 for the Schmieder estimate between the whole-shot and pour-phase pressure comparisons;
- ×2.2 for the pooled value between θ = 0 and θ = 0.27.

At the pooled value the held-out Cameron and Smrke shots run at ×0.43 and ×0.44 of their measured times, but
the V4 9-bar calibration case, whose long-time flow matches (1.87 against 1.82 g/s), reaches 36 g at ×0.47
too: the shortfall is mostly the start-up transient the model misses (its first drops come 1.8 s after full
pressure against 12.8 s measured), not κ_ref. Generic 18 → 36 g, 9 bar recipes take 10.5–13.2 s (fail).

**Sensitivity** (`fit.sensitivity`; V1 refits with other parameters held, unless stated):

| Variant | V1 cost | Schmieder κ_ref (m²) | Pooled κ_ref (m²) | Peak-pressure RMS | λ within ±10% |
|---|---|---|---|---|---|
| as calibrated (4 s ramp, pour-phase peak) | 565 | 7.22×10⁻¹⁴ | 1.24×10⁻¹³ | 1.55 | 57/60 |
| transition ramp 1 s | 776 | 7.25×10⁻¹⁴ | 1.25×10⁻¹³ | 1.46 | 49/60 |
| transition ramp 0.3 s | 839 | 7.28×10⁻¹⁴ | 1.25×10⁻¹³ | 1.17 | 49/60 |
| upstream pressure loss 0.4 bar | 547 | 7.77×10⁻¹⁴ | 1.29×10⁻¹³ | 1.35 | 57/60 |
| pressure classification margin 1 bar | 547 | 7.60×10⁻¹⁴ | 1.28×10⁻¹³ | 1.13 | 57/60 |
| pump-capped pour pressure (exp. 12) excluded | 562 | 7.22×10⁻¹⁴ | 1.24×10⁻¹³ | 1.40 | 57/60 |
| whole-shot peak pressure | 491 | 2.06×10⁻¹³ | 2.10×10⁻¹³ | 2.00 | 58/60 |
| θ = 0.27, every block recalibrated | 692 (total 822 against 683) | 3.87×10⁻¹⁴ | 5.55×10⁻¹⁴ | 2.35 | 54/60 |

- The article's 4 s ramp fits V1 better than 1 s or 0.3 s only while the pump saturates; with 0.3 s the
  model's 1 mL/s maxima match the measured 2.6–2.9 bar, at a higher V1 cost. κ₀ barely moves with the ramp.
- A 0.4 bar upstream loss and a 1 bar classification margin each move the Schmieder estimate by 5–8%.
- The whole-shot comparison matches the model's transition peaks against the low-flow maxima and misses the
  high-flow ones (pressure RMS 2.0 against 1.55): its lower cost comes from the extraction side, and its κ₀
  rise ×2.9.
  The pour-phase comparison is the one that tests the bed.
- θ = 0.27 converged, with three pours briefly at the pump limit (0.5–1.5 s); the bare κ₀ fall 1.8–2.7×. A
  within-model cost difference is not evidence for θ, which stays at its mechanistic default.

## Residuals

Residuals are normalised by the data's uncertainty, with floors so that no single point dominates. Each block
is weighted.

| Block | Residuals | Normalisation |
|---|---|---|
| V1 | per experiment and analyte: ln(λ_model/λ_data), ln(c₀,model/c₀,data); ln of the cup masses at 20/40/60 g (Eq. 3 on both sides by default); peak pressure (below) | fit standard error (floor 3%); replicate RSD (floor 2%); pressure RSD (floor 0.3 bar) |
| V2 | Bo_model − Bo_data for A–D after 30 g and B after 60 g | the printed SD (floor 1) |
| V4 | long-time flow, model − data, at 11 pressures | √(SEM² + (0.05 g/s)²) |
| V6 | ln of κ(ρ)/κ(360) model minus data, for 4 grinds × 2 densities | the two points' relative ± in quadrature (floor 0.1) |

A shot that fails, or an observable the model cannot produce, gets a residual of 10.

**V1 peak pressure.** Schmieder's Table 2 pressure is the mean of the per-shot maxima, measured by the DE1
between boiler and portafilter. The maximum is the larger of two things: the peak at the switch from the
7 mL/s preinfusion to the experiment's flow, and the highest pressure of the pour phase. The model's
transition is not compared, because its early hydraulics cannot pass the article's transition flow: with the
article's 4 s ramp (Fig. A2) the model's pump sits at its 12 bar limit for seconds during the switch in every
V1 shot at the calibrated values (the calibration file's `fit.blocks.V1.pump_limited` and the report list the
seconds), whereas the measured maxima are 2.5–9.3 bar. The model lacks the DE1's preinfusion control and the
dry bed's water uptake and headspace filling. The sensitivity variant "whole-shot peak pressure" shows what
comparing the whole-shot maximum would do. The residual uses the model's pour-phase maximum, which starts at
the end of the ramp:
- where the measured maximum exceeds the 2.5 bar exit pressure by more than 0.5 bar (`exit_margin_bar`), the
  pour phase sets it, and the residual is two-sided;
- otherwise the measured maximum is the transition peak, and it only bounds the pour phase from above. The
  residual is one-sided: zero unless the model's pour phase exceeds the measured maximum.

A pour that reaches the pump limit is flagged (`pour_capped`). Its residual is kept: the model cannot pass the
programmed flow below 12 bar where the real machine did, so the capped residual, if anything, understates the
misfit. The variant "pump-capped pour pressures excluded" refits without those residuals (the experiments
capped in the main fit), and "pressure classification margin 1 bar" moves the two-sided/one-sided boundary.

The block options `pressure_scale` and `pressure_offset_bar` shift the targets for sensitivity runs (the
basket pressure is below the DE1's reading by the group's loss), and `pressure: max` restores the
whole-shot maximum.

## Sensitivity runs

`calibrate --sensitivity` refits after the main fit under changed assumptions and records the results under
`fit.sensitivity`. Each variant changes the options of some blocks and refits the parameters the config lists
for those blocks alone; parameters shared with other blocks stay at their fitted values, and datasets not
refitted keep their κ_ref estimates in the pooled value.

| Variant | Blocks | Change |
|---|---|---|
| transition ramp 1 s, 0.3 s | V1 | the Schmieder preinfusion-to-pour ramp, instead of the article's 4 s |
| upstream pressure loss 0.4 bar | V1 | peak-pressure targets lowered by Waszkiewicz's measured group loss at about 2 g/s |
| whole-shot peak pressure | V1 | compare the model's whole-shot maximum instead of the pour phase |
| pressure classification margin 1 bar | V1 | maxima within 1 bar of the exit (instead of 0.5 bar) only bound the pour from above |
| pump-capped pour pressures excluded | V1 | peak-pressure residuals of the experiments whose pour reached the pump limit in the main fit are left out |
| dissolution share θ = 0.27 (structural) | V1, V2, V4, V6 | the solver's old proportional rule instead of the mechanistic default θ = 0, set in every spec (block option `spec_fields`): a full recalibration, nothing held |

The structural variant is not a candidate for the calibration: θ is fixed by its mechanism, because V1 cannot
identify it. `validate` repeats the held-out predictions (V3, V5) with the variant's refitted values and
pooled κ_ref, so the report shows what the assumption does to them.

## Solver and uncertainties

- **Optimiser.** `scipy.optimize.least_squares`: trust-region reflective, box bounds, `x_scale="jac"`.
  The optimisation variable is log10 of a log-scaled parameter and the value itself otherwise.
- **Jacobian.** Forward differences, with steps of 0.01 in log10 or 1% of the bounds (`--fd-step`). Only the
  blocks a parameter lists are re-run. Results are cached by spec, and `--jobs N` simulates in N processes.
- **Uncertainties.** From the Jacobian at the solution: cov = s²·(JᵀJ)⁻¹, with s² = Σr²/(m − n) the reduced
  chi-square, computed by SVD pseudo-inverse. They are lower bounds: a reduced chi-square well above 1, and
  χ²/n differing between blocks (both in `fit.blocks`), mean the residual model is incomplete; V1 holds most
  residuals, and its cup masses share information with c₀, λ and the first fraction (Eq. 3). The blocks are
  weighted equally: no external standard sets other weights, and the structural spreads (Results) dwarf the
  statistical ones.
  - Each parameter gets an SD, a 68% interval (asymmetric for log-scaled parameters) and its SD ratio to
    the prior.
  - Parameters whose Jacobian column vanishes, or that lie in an unresolved direction, are marked
    `identified: false`.
  - A parameter within 1% of its bounds' span of a bound is marked `at_bound` (the solver stays strictly
    inside the box).

## Reference permeability

The app's builder sets the bare base permeability of a recipe from one registry value,
`hydraulics.permeability.reference` (κ_ref, the bare κ₀ at `model.hydraulics.reference_sauter_diameter`),
scaled by the recipe's Sauter diameter and porosity: κ₀ = κ_ref·(D32/D32_ref)²·KC(ε)/KC(ε_ref) (ADR 0009).
The calibration fits a bare κ₀ per setup instead (the nuisance permeabilities: one per Schmieder grinding
level, one for Waszkiewicz) and maps each back to κ_ref:

- **Estimate.** κ_ref,i = κ₀,i ÷ s_i, where s_i is the builder's scaling for the app's representation of
  that grind (its *scaling basis*). For Schmieder it is the E65S grinder preset at the article's grinding
  level, so that the app's E65S at that level gets the fitted bed permeability; the case itself simulates
  the PSD reconstructed from the article's D[4,3]. For Waszkiewicz it is the case's own measured PSD, as
  entered in the app's manual PSD input. `builder_scaling` measures s_i by building the recipe with two
  values of the base id; nothing else is needed from the builder, as long as it scales the reference id
  proportionally.
- **Pooling.** Geometric mean within a dataset (over its grinding levels), then across datasets with equal
  weight. The report gives each dataset's value next to the pooled one, and the spread (log-SD over all
  estimates, max/min). Datasets that disagree by more than their fit uncertainties are reported as such, not
  averaged into agreement.
- **Re-pooling.** `calibrate --pool-only` recomputes κ_ref of `data/calibration/<label>.yaml` with the
  current builder, without refitting, and rewrites it and `current.yaml`. The fitted κ₀ do not depend on
  the grinder models (the cases simulate their own PSDs), but the Schmieder scaling does: re-pool after any
  change to the grinder→PSD models, then re-run the export.
- **Caveats.** D32 values from different bases are not strictly comparable. Waszkiewicz's PSD is laser
  diffraction (Malvern Mastersizer 2000; the article does not say whether the dispersion was wet or dry,
  and the fines share depends on it). The grinder presets' D32 comes from the input models, anchored on other
  measurements: the E65S on Schmieder's wet laser-diffraction D[4,3]. The Schmieder estimate also depends on
  the case's pressure comparison (above): the DE1 reads upstream of the puck, and the target is a mean of
  per-shot maxima. The report gives the sensitivity to a 0.4 bar upstream loss (Waszkiewicz's measured group
  loss at about 2 g/s).

## Output: `data/calibration/<label>.yaml` and `current.yaml`

```yaml
schema: puckworks.calibration/1
label: v1
created: 2026-10-14
core_version: 0.1.0
tools_version: 0.1.0
parameters: {<registry id>: <value in the registry's units>}   # only what the app's builder reads
fit:
  datasets: [dataset folders used]
  config: data/calibration/config.yaml
  solver: {puckcore_version, extension_sha256, extension_built, sources_sha256: {tree: hash}}
  optimizer: {method, success, message, evaluations, simulations, start_cost, cost}
  nuisance: {<calibration.* id>: value}          # setup-specific values (spec mode)
  case_parameters: {<id>: value}                 # values applied by case builders (case mode)
  reference_permeability: {id, value_m2, pooling, datasets, estimates, log_sd, max_over_min, repooled?}
  fixed: {<id>: {value, units, reason}}          # reviewed and held at their registry values
  weakly_identified: [ids]                       # posterior SD ≥ 0.5 × prior SD
  start: {id: value}
  bounds: {id: [lower, upper]}
  modes: {id: override | spec | case}
  blocks: {V1: {dataset, datasets, cases, residuals, rms, chi2, weight, failures}, ...}
  uncertainties: {id: {scale, identified, sd, interval_68, prior_sd_ratio, at_bound}}
  reduced_chi2: ...
  correlation: {ids: [...], matrix: [[...]]}
  residuals: {"V1/exp07/lambda/caffeine": <normalised residual>, ...}
  solver_warnings: [...]
  robustness: {simulations, failed, worst: {mass_balance_error, outflow_integral_error, max_regime_solves, ...}}
  loo: {...}                                     # with --loo
  sensitivity: {reference_datasets, variants: {name: {blocks, options, structural, cost, nuisance, shared,
                kappa_ref_by_dataset, pooled_kappa_ref_m2, v1_cost, pressure_rms, lambda_within, ...}}}
```

`parameters` holds the override parameters and the pooled reference permeability: the values the app's
builder reads. The export reads only `schema` and `parameters`, plus scalar top-level keys as metadata. It
checks that each id exists and that each value lies inside the record's range. A test checks that the
harness's output passes the export's loader. `validate` and `load_calibration` read all fitted values
(`parameters`, `fit.nuisance` and `fit.case_parameters`).

**Safety.** `calibrate` refuses to write into `data/calibration/` while the solver reports itself as a
placeholder, because `current.yaml` changes the app's defaults. Use `--out-dir` for trials, or
`--allow-placeholder`.

## Running it

The whole pipeline (rebuild, calibrate, export, rebuild, validate, shot fixture, checks) is one command:

```sh
python/scripts/m1-pipeline.sh 8      # 8 parallel simulation processes
```

The calibration file and the validation report record the solver build they ran on (`fit.solver` and
`solver`: the extension's hash and build time, and hashes of `crates/puckcore/src`, `crates/puckmodel/src`
and `crates/puckmodel/generated`), so runs on different builds can be told apart. `validate --from-json`
re-renders the report and its figures from `m1-validation.json` without simulating. The steps one by one:

```sh
.venv/bin/puckworks-tools calibrate --dry-run                   # cases, residual counts, start cost, block check
.venv/bin/puckworks-tools calibrate --tier 0 --out-dir /tmp/cal  # fast trial at tier 0
.venv/bin/puckworks-tools calibrate --jobs 8 --prune --loo --sensitivity  # tier 1; writes v1.yaml, current.yaml
.venv/bin/puckworks-tools calibrate --pool-only                 # re-pool κ_ref after a builder change
.venv/bin/puckworks-tools calibrate --sensitivity-only --variant θ  # re-run sensitivity variants only
.venv/bin/puckworks-tools export                                # embed current.yaml (then rebuild puckcore)
.venv/bin/puckworks-tools validate --jobs 8                      # docs/validation/m1-validation.md
```

## Leave one condition out (V1)

`calibrate --loo` adds the V1 leave-one-condition-out check (PLAN §10: λ and cup masses within ±15% when
left out). It refits the parameters that the config lists for V1 alone 15 times, each time without one
experiment, starting from the full fit. The refit includes that grinding level's permeability and the bean's
contents; parameters shared with other blocks (the dispersion, the critical pressure, γ) stay at their
full-fit values, so the check is mildly optimistic. It then predicts the left-out experiment and records the
relative errors of λ and of the Eq. 3 cup masses under `fit.loo`. `validate` reports the check from there, or
"not run" if the file has none.
