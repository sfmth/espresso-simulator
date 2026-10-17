<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M1 calibration harness

*Puckworks M1 · workstream C · 2026-10-16.* `puckworks-tools calibrate` fits model parameters to the M1
calibration datasets ([PLAN §12 M1](../PLAN.md#m1-validated-core-and-lab-view)). The datasets are V1
Schmieder 2023, V2 Vaca Guerra 2024 (dispersion), V4 Waszkiewicz 2026 (long-time Q(P)) and V6 Corrochano
2017 (relative closure). The fit is written to `data/calibration/`, and the export
(`python/puckworks_tools/export.py`) embeds `current.yaml` into the app. The code is
`python/puckworks_tools/calibrate.py`; the configuration is
[data/calibration/config.yaml](../../data/calibration/config.yaml).

Calibration **v4** retains the total-particle inventory correction and qualified wet CDF from v3.
The transport review reopens lumped diffusivity, trigonelline and 5-CQA partitioning, and effective
intraparticle water within their existing priors. Two preparation nuisances describe the Schmieder
setup's column spread and edge flow; they do not change the application's preparation presets.
Their bounds are transformed from the existing preparation priors. See the
[transport identification review](../research/06-transport-identification.md).
The preserved `data/calibration/v3.yaml`, [0.6.0 validation](baseline-v0.6.0/), earlier fits and
[particle audit](m11-particle-inputs.md) remain historical artifacts.
The [0.6.2 startup review](m11-startup-identification.md) subsequently checks local sensitivity,
training-cost grids and bounded connectivity refits while preserving v4. Its pressure-resolution
probe cautions against reading a local Jacobian SD as independent identification of a wetting law.
The original V1, V2-dispersion, V4-long-time-flow and V6 residuals, weights and holdouts remain
unchanged. V3, V4 transient and V5 are never used to choose the PSD, caps, priors or fitted parameters.
First-drop and flow-rise targets remain within ×1.5 of measured times, with the same no-overshoot
check at 15 s after first drops. Coverage checks prevent invented clock origins or endpoints.

The wet input uses Fig. A1b and the published D32 to constrain an unresolved fine tail. Its unfitted
D43 remains a cross-check. Wet-dispersed fines are not independent measurements of dry-puck
geometry or moisture diffusion length. In addition to the seven existing sensitivity variants, v4
refits D32 at its reported ±1 SD; these are source-input sensitivities, not a confidence interval or
extra observations. The existing E65S preset remains the reference basis for pooling V1 nuisance
permeabilities into the application's reference permeability; v4 does not re-fit that mapping.

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
| `case` | applied by a case builder (`CASE_PARAMETERS`) | available for case-specific coefficients; unused in v4 (the V6 closure exponent uses `override`) |

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
Validation and startup ablations use those recorded fixed values before configured starting
values. Fitted values take precedence; a fixed coefficient is not labeled as fitted.

## Identifiability

For each parameter the harness reports a local marginal SD from the Jacobian, scaled by the reduced
chi-square, divided by the registry prior's SD in the fit's coordinate (log10 for log-scaled parameters).
A ratio of 0.5 or more flags a candidate for review (`fit.weakly_identified`). This is a local linear
diagnostic, not a Bayesian posterior or proof of non-identifiability. The covariance allows movement
in every fitted direction, including directions whose compensating changes would cross other
parameters' bounds. A large marginal SD therefore does not establish that the registry value can
replace the fitted coefficient without affecting the fit.

In v4, `calibrate --prune` reviews the eligible interior shared parameter with the largest ratio first.
It fixes that coefficient at its registry value and refits every selected training block. Removal is
accepted only when the refit succeeds, its final predictions and cost are finite and failure-free,
and its cost is no more than **1% above both the preceding accepted fit and the initial pre-prune fit**.
The second ceiling prevents successive small losses from accumulating. This 1% is an explicit
operational tolerance for a negligible fit loss, not a statistical significance threshold or a new
scientific validation gate. Rejected candidates remain fitted, are recorded as weak under the local
diagnostic, and are not attempted again in the same run. Their retention can depend on bounds and
model assumptions; it does not establish independent measurement of those coefficients.

Parameters within 1% of a prior-bound span are retained and reported as bound-limited. Nuisance and
case parameters are always retained. `fit.pruning_review` records every accepted or rejected trial,
including the local SD ratio, costs and optimizer result; `fit.fixed` records accepted removals.
Historical v1–v3 used the marginal-SD rule without this fit-loss safeguard and retain their original
results. The distinction between local covariance approximations and bounded fitting follows the
[SciPy covariance documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html).

**Path independence.** Fixed parameters and the reference permeability (an output of the calibration, not a
fit parameter) are passed to every case at their registry values, and the fitted values explicitly, so a
calibration already embedded in puckcore cannot change any result: `validate` recomputes the calibration
blocks to the same RMS as the calibration file, and the report shows both. `fit.inputs` hashes the config,
every dataset folder used, the numeric registry inputs (units, values, priors and ranges, excluding prose
and the calibration overlay), the preset inputs, and the Python calibration/case sources; `fit.solver` identifies the build.
Validation rejects cached leave-one-out scores when those inputs or the solver/model sources change.
The expected post-fit registry export does not by itself invalidate the cached refits.

The review also checks parameters outside the fit (the dissolution share θ, the viscosity exponent γ, the
swelling and gas amplitudes, the critical pressure in V1) by adding each one alone at the V1 optimum:
its SD ratio, its correlation with the fitted set, and the shift the residuals ask for (a Wald z against the
registry value). Where a candidate is strongly collinear with the fitted set (more than 90% of its Jacobian
column explained by the others), the linearised ratio can mislead, and the review refits with the candidate
at two values instead (θ below).

### Review of 2026-10-14 (V1 trial fits)

The review ran on V1 alone, on the build of 2026-10-14 before the input-model fixes; the final fit's ratios
are in `fit.uncertainties` and the validation report. These trial-fit decisions predate M1.1's startup
model; the fixed startup assumptions have their own reasons in the current config.

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
priors were not widened to force agreement. The final v1 calibration brought λ within ±10% for
57 of the 60 experiment–analyte pairs, with the scales inside their priors (Results).

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

## Transport initialization review (v4, 2026-10-16)

Two all-block fits use the same 23 candidates and 339 residuals. One starts from v3 with the new
candidate defaults; the other starts from the bounded preparation diagnostic. The
[recorded comparison](m11-transport-multistart.json) preserves both initial/final value sets,
solver and input identities, uncertainties and optimizer diagnostics. No held-out observations
enter either fit or the choice between them.

| Initialization | Training cost | V1 λ within 10% | V1 cups within 10% | First-order optimality |
|---|---:|---:|---:|---:|
| Preserved v3 plus new candidate defaults | 609.304 | 50/60 | 172/180 | 18.38 |
| Bounded preparation diagnostic | 568.902 | 51/60 | 174/180 | 582.98 |

Both stop at `xtol` with no failed simulations. The lower-cost result supplies
[the recorded v4 initialization](../../data/calibration/starts/v4.yaml), followed by the declared
pruning rule and complete refit workflow. The nonzero optimality and differing solutions prevent
a claim of stationarity or global optimality. These are initialization-review scores, not the
final pruned calibration or its cross-validation results.

## Results of the bounded transport calibration (v4, 2026-10-16)

### Main fit and pruning

The 23-parameter warm-started fit has cost **568.901** on the unchanged **339 residuals**.
Guarded pruning leaves **22 fitted parameters**, with final cost **570.686** and reduced
chi-square **3.60054**, compared with v3's 2,496.80 and 15.412. The main fit and three
registry-value trials use **14,974 simulations**, with no failed simulation. That count
includes rejected pruning trials and excludes subsequent cross-validation and sensitivity refits.
The retained optimizer terminates by `xtol` after 20 evaluations and 10 Jacobian evaluations;
its first-order optimality is **58.9927**. This is a completed local fit, not evidence of
stationarity or a global minimum.

| Registry-value trial | Local SD/prior before trial | Trial cost | Change from preceding accepted fit | Decision |
|---|---|---|---|---|
| 5-CQA partition coefficient → 0.61 | 0.979 | 570.686 | +0.314% | fix at registry value |
| lumped diffusivity → 1.26×10⁻¹⁰ m²/s | 0.796 | 696.599 | +22.063% | retain fitted coefficient |
| 5-CQA surface-pool scale → 1 | 0.746 | 576.835 | +1.078% | retain fitted coefficient |

All three trials terminate successfully with finite, available final predictions. The two rejected
trials exceed both cost ceilings; they never replace the retained fit. Their complete decisions,
trial values and optimizer diagnostics are recorded in `fit.pruning_review`. The diffusivity
example shows why a broad unconstrained marginal SD is insufficient to justify removal: its
compensating direction is coupled to bound-limited surface and inventory coefficients. Retention
does not independently identify diffusivity, prove that it is necessary, or establish a unique
physical interpretation.

| Block | v3 normalised RMS | v4 normalised RMS |
|---|---:|---:|
| V1 kinetics and pressure | 3.91344 | 1.74617 |
| V2 dispersion | 1.41101 | 2.26337 |
| V4 long-time flow | 3.52659 | 3.47065 |
| V6 density/permeability | 1.68119 | 1.68781 |

The aggregate improvement is concentrated in V1; V2 and V6 fit slightly or substantially worse.
The original residual weights remain unchanged. With the saved coefficients, **51/60 V1 rates**
and **174/180 cup masses** are within ±10%, compared with v3's 25/60 and 158/180.

| Shared parameter | v4 value | Local SD/prior | Constraint or review |
|---|---:|---:|---|
| broken-shell thickness | 40 µm | 0.932 | upper bound |
| lumped saturation | 349.852 kg/m³ | 0.422 | near upper bound |
| lumped diffusivity at 80 °C | 3.524×10⁻¹¹ m²/s | 0.796 | retained after bounded trial |
| trigonelline partition coefficient | 0.999936 | 1.538 | near upper bound |
| caffeine surface-pool scale | 0.5 | 0.692 | lower bound |
| trigonelline surface-pool scale | 2 | 1.276 | upper bound |
| 5-CQA surface-pool scale | 0.842542 | 0.746 | retained after bounded trial |
| viscosity temperature exponent | 0.278611 | 0.445 | interior |
| critical pressure | 11.8057 bar | 0.387 | interior |
| axial dispersion | 4.5687×10⁻⁶ m²/s | 0.149 | interior |
| effective intraparticle water admission | 0.5 | 0.493 | lower bound |
| density exponent | 0.242921 | 0.0414 | interior |

The setup's extractable fraction also reaches its 34% upper bound. Seven coefficients are at
or within 1% of a bound's span; no prior was widened. The fitted water fraction is conditional
on instantaneous front filling and the other inventory assumptions, not a measured uptake rate.
The Schmieder preparation nuisances are inner permeability spread **0.457708** and edge
multiplier **0.260366** (local SD/prior 0.199 and 0.107). They remain specific to that setup,
with prewetting spread and edge area fixed, and are not exported as generic preparation defaults.

The pooled reference permeability is **1.51908×10⁻¹³ m²**. The Schmieder and Waszkiewicz
estimates are 1.02811×10⁻¹³ and 2.24452×10⁻¹³ m², a factor **2.18** apart; the four individual
estimates span a factor 2.33. Pooling carries this disagreement rather than resolving it.
The existing grinder-preset scaling basis is unchanged.

### Leave-one-condition-out prediction

All **15 folds** terminate successfully, using **236 optimizer evaluations**, with every
left-out prediction available. Each fold refits all 22 retained coefficients against V1, V2,
V4 and V6, excluding only its own V1 experiment. The retained case counts are 14, 5, 11 and
12 respectively; V6 contributes eight relative-permeability residuals from its 12 cases.
All optimizer stops are `xtol`; first-order optimality ranges from 12.26 to 183.73.

At the unchanged ±15% threshold, **57/60 λ values and 180/180 cup masses pass**. The three
misses are experiment 8 trigonelline (+15.58%), experiment 8 TDS (+21.13%) and experiment 9
caffeine (−17.28%). Here λ is the characteristic beverage mass in grams. Recounting the
60 saved rate errors and 180 saved cup errors reproduces those totals. The gate requires
every target to pass, so the combined V1 criterion remains failed.

The folds are conditional on the full-data parameter/pruning structure and warm start;
pruning and initialization selection are not repeated inside them. They assess refitted
predictions under that structure, not nested model selection. V3's 29/60 and 174/180 counts
used frozen shared coefficients and are therefore not a method-matched cross-validation
comparison.

### Sensitivity refits

All **nine sensitivity optimizers** terminate successfully after **157 evaluations** in
total, without unavailable final predictions. Eight V1-only variants refit 15 coefficients
while holding lumped diffusivity, viscosity exponent, critical pressure, axial dispersion
and water admission at their full-fit values. The structural θ = 0.27 variant refits all
22 coefficients against all four training blocks. Pruning is not repeated.

| Variant | V1 cost | λ within 10% | Cups within 10% | Pooled κ_ref (m²) |
|---|---:|---:|---:|---:|
| Main fit | 480.234 | 51/60 | 174/180 | 1.51908×10⁻¹³ |
| Transition ramp 1 s | 566.491 | 50/60 | 174/180 | 1.53196×10⁻¹³ |
| Transition ramp 0.3 s | 571.138 | 50/60 | 174/180 | 1.52818×10⁻¹³ |
| Upstream pressure loss 0.4 bar | 471.638 | 51/60 | 174/180 | 1.53957×10⁻¹³ |
| Whole-shot peak pressure | 440.761 | 55/60 | 174/180 | 3.35418×10⁻¹³ |
| Pressure classification margin 1 bar | 469.750 | 51/60 | 174/180 | 1.52979×10⁻¹³ |
| Pump-capped pour pressures excluded | 476.941 | 51/60 | 174/180 | 1.51908×10⁻¹³ |
| Wet D32 minus 1 SD | 488.677 | 49/60 | 173/180 | 1.51431×10⁻¹³ |
| Wet D32 plus 1 SD | 502.792 | 51/60 | 174/180 | 1.53144×10⁻¹³ |
| Dissolution share θ = 0.27 | 548.984 | 49/60 | 173/180 | 8.39208×10⁻¹⁴ |

The structural variant has total four-block cost 642.561. Whole-shot pressure changes the
observable being fitted and more than doubles pooled permeability; its smaller cost is
not evidence for replacing the established pour-pressure target. These are conditional
input and structural sensitivities, not a predictive confidence interval. The saved
sensitivity artifact records aggregate score counts rather than individual extraction
errors; its counts cannot be independently recounted from that artifact alone. Every
variant stops at `xtol`, with first-order optimality as high as 759.37 for D32 minus 1 SD.

### Held-out results and remaining limitations

The held-out evaluation follows the completed parameter selection and does not change
the fit. V2 dispersion remains within the 8–17 Bodenstein gate, although its weighted
fit worsens. V6 still fails one relative-permeability target. Held-out improvements and
regressions are reported together:

| Observable | v3 | v4 | Existing target or interpretation |
|---|---:|---:|---|
| Cameron model/data shot-time ratio, geometric mean | 0.946 | 0.805 | time RMS worsens from 3.49 to 7.06 s |
| Cameron peak EY | 20.12% | 19.62% | 22–24%; both peak at the wrong setting, GS 1.1 |
| Smrke model/data shot-time ratio, geometric mean | 0.913 | 0.776 | time RMS worsens from 20.26 to 22.93 s |
| Smrke EY/time Spearman correlation | 0.829 | 0.868 | both pass ≥0.8 |
| V4 first drops after full pressure | 7.03 s | 6.07 s | 12.76 s measured; outside ×1.5 |
| V4 flow-rise time after first drops | 13.91 s | 12.45 s | 25.48 s measured; outside ×1.5 |
| V4 first 5 s fraction TDS | 21.83% | 24.29% | v4 passes 22–28% |
| V4 time to 36 g | 31.33 s | 30.13 s | 47.69 s measured; reported diagnostic |
| Generic 18 → 36 g pump-stop range | 24.70–27.45 s | 21.05–23.24 s | every v4 preset misses 25–35 s |

V4 also fails the original no-overshoot endpoint check: flow 15 s after first drops is
1.880 g/s, above 1.856 g/s at 100 s. Added fines still lengthen Smrke shots much less than
observed. The condition measured at 12 s and 17.51% EY gives 22.0 s and 16.59% in v4.
Cameron's peak checks retain their disclosed dependence on the earlier preparation
mapping. **No complete M1 scientific exit criterion passes; M2 remains deferred.**

Four [fixed-parameter startup scenarios](m11-startup-sensitivity-v4.json), eight simulations
across V4 and the generic recipe, reproduce the final baseline. Disabling pore-air mobility
moves first drops to 1.81 s, flow rise to 7.01 s and the generic pump stop to 10.19 s.
Setting water admission to 0.5 reproduces the baseline exactly because v4 already fits
that value. These closure responses do not identify separate uptake and air mechanisms.

### Fixed-parameter numerical check

All 15 V1 conditions were repeated with the maximum timestep halved from 0.05 to 0.025 s,
holding the saved coefficients, output interval and every physical input fixed. All **30 simulations**
complete without failure. The [numerical evidence](m11-transport-resolution.json) records all
480 observable comparisons and the solver/input identities.

| Observable | Largest absolute relative change |
|---|---:|
| λ | 0.3843% |
| c₀ | 0.2936% |
| Eq. 3 cup masses | 0.1417% |
| directly integrated cup masses | 0.1325% |

Both resolutions retain 51/60 rates and 174/180 Eq. 3 cups within ±10%. V1 cost changes from
480.251 to 482.548; these re-evaluations use the saved, six-significant-digit coefficients.
Worst relative soluble-mass and hydraulic carrier-volume residuals are 2.81×10⁻¹⁴ and
6.62×10⁻¹⁴, and minimum concentration is zero. This is local timestep sensitivity at one
output interval; it establishes neither an asymptotic convergence order nor physical validity.

All **117 final validation simulations** succeed. The candidate and rebuilt v4 engine
agree exactly on **4,698 compared prediction values**; recorded fitted and fixed values,
cached-refit identities and the 13 exported defaults pass the promotion checks. The
setup nuisances remain outside the application defaults. Worst relative soluble-mass
and hydraulic carrier-volume balance errors across validation are 7.28×10⁻¹⁴ and
7.83×10⁻¹⁴; minimum concentration is zero. The separate output-flow quadrature discrepancy
is 0.00787 and is not a conservation residual. All 44 protected historical files retain
their original hashes.

Release verification passes **224 Rust tests** (one existing exhaustive test ignored),
**518 Python tests**, **448 web tests** and **55 browser checks**. The seven native/WASM
shot fixtures match exactly over 85,307 spec/result values through both the recipe and
direct-spec paths (170,614 comparisons). The sphere check matches 4,203 output values;
all 4,218 numeric entries in that fixture remain unchanged from v3. The independent
sphere-series calculation differs by at most 5.47×10⁻¹⁶. Formatting, lint, licence,
registry, export, fixture, release-version and report-freshness checks pass.

The final browser run measures **702 ms** for the default tier-1 shot (22 s of simulated
time), **32.1 ms** for the first preview and **14.2 ms** after an edit. The warm preview
still misses the 10 ms tier-0 target. These are observations on this machine and recipe,
not a performance guarantee across devices or inputs.

## Results of the inventory-corrected calibration (v3, 2026-10-16)

The 0.6.0 run starts from preserved v2 values, uses the qualified V1 wet CDF, and retains the original
339 residuals, their weights, all prior bounds and the held-out split. The main fit reduces cost from
8,356.87 to 2,486.43. Two identifiability-pruning passes leave **15 fitted parameters** and a final cost
of **2,496.80**, with **8,669 simulations** across the main and pruning fits. The final optimizer stops
on `xtol` after 18 evaluations. Solver source hashes are `707212539ef8979a` for `crates/puckcore/src`
and `1ca89ad808e6f2f7` for `crates/puckmodel/src`.

Pruning fixes the caffeine surface-fraction scale at **1.0** (previous fitted value 0.9394; SD/prior
1.02) and critical pressure at **12 bar** (previous fitted value 9.834 bar; SD/prior 0.67). The unchanged
rule keeps parameters at prior bounds, including four whose local SD is still more than half the
prior's SD. These bounds were not widened. Reduced chi-square is **15.412**, compared with 6.116 in v2;
the local covariance estimates do not describe predictive uncertainty or establish a global optimum.

| Calibration block | v2 normalized RMS | v3 normalized RMS |
|---|---:|---:|
| V1 extraction and pressure | 2.284 | 3.913 |
| V2 dispersion | 5.823 | 1.411 |
| V4 long-time flow | 3.571 | 3.527 |
| V6 relative permeability | 1.679 | 1.681 |

| Shared parameter | v3 value | SD/prior | Constraint |
|---|---:|---:|---|
| broken-shell thickness | 40 µm | 0.458 | upper bound |
| lumped saturation | 350 kg/m³ | 1.054 | upper bound |
| trigonelline surface-fraction scale | 2.0 | 1.313 | upper bound |
| 5-CQA surface-fraction scale | 1.5 | 0.871 | upper bound |
| viscosity temperature exponent | 0.22 | 0.658 | lower bound |
| axial dispersion coefficient | 5.32893×10⁻⁶ m²/s | 0.268 | interior |
| density exponent | 0.246074 | 0.086 | interior |

The pooled reference permeability is **1.23789×10⁻¹³ m²**, from Schmieder **6.91723×10⁻¹⁴** and
Waszkiewicz **2.21530×10⁻¹³ m²**, a factor of 3.20 between datasets. Individual estimates span a
factor of 3.75. This pooling retains the existing E65S reference mapping; the wet-PSD change does not
independently validate that mapping. The residuals and dataset disagreement remain model limitations.

| Check or observable | Preserved v2 | v3 | Target or interpretation |
|---|---:|---:|---|
| V1 λ within ±10%, fit | 48/60 | 25/60 | all 60; regressed |
| V1 cup masses within ±10%, fit | 163/180 | 158/180 | all 180; regressed |
| V1 λ within ±15%, leave one out | 54/60 | 29/60 | all 60; regressed |
| V1 cup masses within ±15%, leave one out | 178/180 | 174/180 | all 180; regressed |
| V2 Bodenstein numbers within 8–17 | 3/5 | 5/5 | pass |
| V3 model/data shot-time ratio, geometric mean | 0.600 | 0.946 | reported; RMS time error 3.49 s |
| V5 model/data shot-time ratio, geometric mean | 0.577 | 0.913 | reported; RMS time error remains 20.3 s |
| V5 EY/time rank correlation, Spearman ρ | 0.543 | 0.829 | at least 0.8; pass |
| V3 peak EY | 22.09% | 20.12% | 22–24%; fail |
| V3 peak grind setting | 1.1 | 1.1 | 1.5–1.9; edge of range, fail |
| V4 first drops after pressure rise | 6.83 s | 7.03 s | 12.76 s measured, within ×1.5; fail |
| V4 flow rise after first drops | 12.08 s | 13.91 s | 25.48 s measured, within ×1.5; fail |
| V4 first-fraction TDS | 21.37% | 21.83% | 22–28%; fail |
| V4 time to 36 g after pressure rise | 30.47 s | 31.33 s | 47.69 s measured; reported |
| Generic 18 g → 36 g, 9 bar pump-stop times | 15.61–17.04 s | 24.70–27.45 s | all six within 25–35 s; E65S still fails |

All **15 leave-one-condition-out optimizers converge**, using 188 evaluations in total, and every
refit and withheld prediction is available. The original method retains the full fit's shared-block
parameters and pruning choices; this is not nested cross-validation of all model choices. The
29/60 λ and 174/180 cup counts retain the complete scoring denominators.

All **nine sensitivity optimizers converge**, using 125 evaluations in total, with every final
prediction available. The first eight variants refit V1 with the shared V2/V4 parameters held at
the main fit; the dissolution variant refits all four calibration blocks. Counts below use the
unchanged ±10% fit gates. Costs use the variant's residual definition and are not interchangeable
with the full main-fit cost of 2,496.80 (whose V1 contribution is 2,412.12).

| Sensitivity | Cost | Pooled κ_ref (m²) | λ within gate | Cups within gate |
|---|---:|---:|---:|---:|
| transition ramp 1 s | 2,456.98 (V1) | 1.24426×10⁻¹³ | 25/60 | 158/180 |
| transition ramp 0.3 s | 2,445.75 (V1) | 1.24769×10⁻¹³ | 25/60 | 158/180 |
| upstream pressure loss 0.4 bar | 2,427.22 (V1) | 1.27272×10⁻¹³ | 25/60 | 158/180 |
| whole-shot peak pressure | 6,973.38 (V1) | 7.70577×10⁻¹⁴ | 25/60 | 159/180 |
| pressure classification margin 1 bar | 2,403.45 (V1) | 1.23789×10⁻¹³ | 25/60 | 158/180 |
| pump-capped pour pressures excluded | 2,383.04 (V1) | 1.23789×10⁻¹³ | 25/60 | 158/180 |
| wet PSD D32 −1 SD | 2,293.29 (V1) | 1.22893×10⁻¹³ | 25/60 | 158/180 |
| wet PSD D32 +1 SD | 2,555.40 (V1) | 1.26163×10⁻¹³ | 24/60 | 157/180 |
| dissolution share θ = 0.27 | 3,696.62 (all blocks) | 6.85300×10⁻¹⁴ | 12/60 | 137/180 |

The D32 variants reconstruct the unresolved fine tail within the published moment uncertainty;
resolved CDF readings and priors stay fixed. Their pore-air relaxation times change with the
particle sizes, so they are not sensitivities of extraction alone or complete uncertainty bands.
Neither changes the main conclusion about V1 rates. Whole-shot pressure and dissolution assumptions
shift the pooled permeability substantially and fit worse; the calibration is not robust to every
structural assumption. The main θ = 0 choice retains its pre-existing mechanistic basis rather than
being selected against held-out outcomes.

The θ = 0.27 refit's held-out V4 delays improve to 11.94 s for first drops and 29.45 s for flow rise,
with 27.59% first-fraction TDS and 42.70 s to 36 g. Its V3/V5 time ratios are 1.014/0.982, but V5's
EY/time rank correlation falls to 0.257. These outcomes remain sensitivity results; they neither
replace the main calibration nor justify selecting θ from the held-out observations.

V1's λ counts are trigonelline 0/15, caffeine 14/15, 5-CQA 11/15 and TDS 0/15. The fitted wet-PSD
model does not recover the species-rate spread. Trigonelline and TDS λ are too large in all 15
experiments, including the 12 uncapped pours, so pump capping alone cannot explain the overprediction of λ.
Its preinfusion-to-pour transitions spend 1.9–3.9 s
at the pump limit; pours in experiments 2, 12 and 13 also remain capped for 28.86, 32.61 and 5.70 s.
Those cases and pressure residuals remain in the main fit and are flagged in the report.

The two V3 peak checks remain marked as not independent because of the existing preparation prior's
use of Cameron's fine-grind behaviour. The V5 EY check at conditions measured to last 10–15 s passes
at 17.94%, but the corresponding model shot lasts 25.7 s. Added fines still lengthen V5 shots much less
than measured. Better aggregate timing therefore does not establish accurate individual predictions.

V4 passes only the 15 s overshoot component of its transient check: flow is 1.710 g/s there versus
1.859 g/s at 100 s. It later peaks at 2.020 g/s, so the whole transient is not monotonic. The first-drop
and flow-rise targets still fail. **No complete M1 scientific exit criterion passes; M2 remains deferred.**
Correcting the inventory removes a physical inconsistency, while the refit exposes remaining model
error. This release comparison combines the inventory correction, wet input and refit; it does not
isolate any one change. Generic shot times end at the pump-stop mass; reported final EY includes drip.

The rebuilt native engine reproduces the candidate's **6,034 validation numbers exactly**. All
**117 validation simulations succeed**, and calibration-statistics reuse checks report no changed
inputs or model sources. Recomputed block RMS values agree with the fit within 3.1×10⁻⁶ relative,
consistent with the calibration file's six-significant-digit serialization. Worst relative soluble
mass error is **7.40×10⁻¹⁴**, and hydraulic carrier-volume error is **1.24×10⁻¹³**. Concentrations remain
nonnegative; the most difficult run rejects one step before succeeding. The separate sampled-outflow
quadrature discrepancy reaches 0.00783 and is not a bed mass-conservation error.

The [v3 startup ablations](m11-startup-sensitivity-v3.json) hold every fitted coefficient fixed and
record all eight simulation specs. They expose the response to the existing water-volume and
pore-air assumptions without fitting those assumptions to the held-out transients. Every run uses
the corrected 0.6.0 inventories and uncapped kernel partitioning; disabling both assumptions does
not restore an archived model.

| Fixed-v3 variant | V4 first-drop delay | V4 rise time | V4 time to 36 g | Generic EK43 pump-stop time |
|---|---:|---:|---:|---:|
| v3 baseline | 7.03 s | 13.91 s | 31.33 s | 25.54 s |
| pore-air closure disabled | 2.25 s | 7.32 s | 23.29 s | 12.20 s |
| half intraparticle water inventory | 5.59 s | 11.02 s | 28.71 s | 23.73 s |
| half inventory and pore-air disabled | 1.63 s | 5.88 s | 21.56 s | 11.32 s |

These responses show that the existing pore-air closure contributes substantially to the generic
shot time. They do not identify an air-clearance law from measurements or explain the remaining
V4 delay. The original fixed-v2 ablations and all v1/v2 calibration files remain byte-for-byte intact.

## Results of the M1.1 calibration (v2, 2026-10-15)

The complete tier-1 run used the same fitted-parameter candidates, residual definitions, weights and
calibration/held-out split as v1, with the five fixed startup/loading assumptions recorded in the config.
It ran the main fit, identifiability pruning, all 15 leave-one-condition-out refits and all seven sensitivity
variants. The final prune refit converged by `xtol` at cost **987.704** after 23 evaluations; the main/prune
runner simulated 7,991 shots. All seven sensitivity optimizers also converged. Solver sources were
`crates/puckcore/src` `2bc3b20936480bae` and `crates/puckmodel/src` `6d9ebc09c7f9b2d2` on puckcore 0.3.0.

The reduced chi-square is **6.116**, up from 4.23 in v1. Normalised RMS by block is V1 2.284, V2 5.823,
V4 3.571 and V6 1.679. Recomputing the exported values reproduces those RMS values within 1.5×10⁻⁶
relative; the remaining difference is the calibration file's six-significant-digit serialization.
The numerical run is reproducible, but the larger residuals limit what its parameter uncertainties mean.

The pruning rule fixed the critical pressure at its registry value, **12 bar** (13.46 bar before pruning;
posterior SD 0.59× the prior's). The broken-shell thickness reached its 40 µm upper bound and remains
weakly identified (SD/prior 0.56); the rule keeps parameters at bounds. Saturation reached its 350 kg/m³
upper bound, and the viscosity exponent reached its 0.22 lower bound. Those bounds were not widened.
The reference permeability is **2.78039×10⁻¹³ m²**: Schmieder 3.49157×10⁻¹³ and Waszkiewicz
2.21406×10⁻¹³ m², a factor of 1.58 between datasets. This is a fit to the original calibration observables,
not to the held-out shot times.

| Check or observable | Archived v1 / 0.2.0 | v2 / 0.3.0 | Target or interpretation |
|---|---:|---:|---|
| V1 λ within ±10%, fit | 57/60 | 48/60 | all 60; regressed |
| V1 cup masses within ±10%, fit | 167/180 | 163/180 | all 180; regressed |
| V1 λ within ±15%, leave one out | 59/60 | 54/60 | all 60; regressed |
| V1 cup masses within ±15%, leave one out | 179/180 | 178/180 | all 180; regressed |
| V2 Bodenstein numbers within 8–17 | 5/5 | 3/5 | all 5; pass → fail |
| V3 model/data shot-time ratio, geometric mean | 0.429 | 0.600 | reported; still too fast |
| V5 model/data shot-time ratio, geometric mean | 0.437 | 0.577 | reported; still too fast |
| V5 EY/time rank correlation, Spearman ρ | 0.836 | 0.543 | at least 0.8; pass → fail |
| V4 first drops after the pressure rise | 1.80 s | 6.83 s | 12.76 s measured, within ×1.5; fail |
| V4 time from first drops to 90% of the 100 s flow | 6.70 s | 12.08 s | 25.48 s measured, within ×1.5; fail |
| V4 flow at 15 s after first drops / flow at 100 s | 2.100 / 1.865 g/s | 1.839 / 1.858 g/s | no overshoot at 15 s; now passes this component |
| V4 time to 36 g after the pressure rise | 22.24 s | 30.47 s | 47.69 s measured; reported |
| Generic 18 g → 36 g, 9 bar shot times | 10.49–13.21 s | 15.61–17.04 s | 25–35 s sanity range; fail |

This is a comparison of two calibrated releases, not an isolation of any one model change. The archived
v1 report used its original observer: its sampled data flow-rise time was 25.78 s; interpolation of the
same 90% crossing now gives 25.48 s. First-drop thresholds, scoring factors and overshoot targets are
unchanged. V4 headspace filling before the pressure-clock origin does not contribute to its reported
post-pressure delay.

The overshoot criterion compares the established 15 s and 100 s endpoints only. The model's flow
later peaks above its 100 s value, so passing this component does not mean the entire transient is
monotonic or free of overshoot.

The generic shot times end at the 36 g pump-stop target. Their reported EY includes subsequent drip,
so it describes a larger cup: the default EK43 ablation ends at 56.89 g after 20.89 g of drip. The
drainage model remains an approximation; these EY values are not extraction yields for a 36 g beverage.

V3's maximum EY is now 22.09%, inside its 22–24% target, but it is still at the edge of the tested grind
range (GS 1.1), so the required peak location is absent. The two V3 peak checks remain marked as not
independent because an existing grind-spread prior used Cameron's fine-grind behaviour. The validation
exit criteria are therefore **V1 fail, V3 partial, V4 fail**. V4 first-fraction TDS is 21.37%, below 22–28%.
The startup closure improves timing while extraction fit quality worsens; it has not validated the full
single-liquid water-inventory approximation or the estimated pore-air law. V2 dispersion and V5's
EY/time rank correlation also regress from passing to failing their existing checks.

The [0.5.1 particle-input audit](m11-particle-inputs.md) keeps every v2 shared and nuisance value
fixed while substituting the source-constrained wet PSD, varying its reported D32 by one SD,
holding the original pore-air timescale fixed, and refining the particle classes. It is an input
sensitivity study, not a new calibration or a replacement for these gates. The
[partition-source review](../research/05-water-and-particle-inventory.md) identifies a solute-capacity
overlap in the 0.5.1 full-water approximation. Version 0.6.0 corrects that inventory; its refit still
does not identify particle-water exchange kinetics.

The sensitivity runs retain the same seven variants as v1. The pooled permeability ranges from
2.23×10⁻¹³ to 4.83×10⁻¹³ m² across the six V1 case variants; the whole-shot pressure variant gives the
upper end and V1 cost 572.5 versus 821.5 in the main fit. The full structural refit at θ = 0.27 gives
1.71×10⁻¹³ m² and total cost 1153. The main fit retains v1's pour-phase pressure comparison. Its
preinfusion-to-pour transitions still spend 0.7–3.4 s at the pump limit, although none of its pours is
capped. These controller and structural sensitivities remain material.

The additional [startup ablations](m11-startup-sensitivity.json), reproduced by
`python/scripts/m11-startup-sensitivity.py`, hold every fitted v2 coefficient fixed while disabling pore
air, halving the intraparticle water inventory, or doing both. They show the response to those assumptions;
they do not identify their values from measurements, and the combined variant is not the historical v1
solver. Its default V4 metrics match the final report; the default generic time agrees to floating-point
roundoff. All 117 final validation simulations succeeded, with worst relative hydraulic volume-balance
error 1.06×10⁻¹³. That diagnostic was collected by validation and the ablations; it was not retrospectively
added to the calibration run's robustness statistics.

The first v2 document's two fixed-assumption descriptions were clarified after fitting: pore-air amplitude
is an effective connectivity deficit, not a measured gas-volume fraction. `fit.provenance_refresh` records
the exact prose changes and confirms that no numeric values, solver identity, LOO or sensitivity results
changed. All input fingerprints were already current; no hashes were added or replaced in that refresh.

## Results of the M1 calibration (v1, 2026-10-15)

This section preserves the 0.2.0 results. Its fitted values, uncertainty review and controller behaviour
belong to that solver; they are not the M1.1 calibration.

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

At the pooled value the held-out Cameron and Smrke shots ran at ×0.43 and ×0.44 of their measured times.
The V4 9-bar case matched its separately calibrated long-time flow (1.87 against 1.82 g/s), but reached
36 g at ×0.47 of the measured time and first drops at 1.8 s after full pressure against 12.8 s measured.
These results motivated the M1.1 startup work. They do not isolate how much of the total-time error came
from permeability versus each startup mechanism. Generic 18 → 36 g, 9 bar recipes took 10.5–13.2 s (fail).

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

V1's λ, c₀ and Eq. 3 cup targets derive from the same fraction measurements and are correlated.
The existing diagonal weighting is retained for comparison; its reduced chi-square and local
Jacobian SDs are descriptive diagnostics, not calibrated probability intervals.

**V1 peak pressure.** Schmieder's Table 2 pressure is the mean of the per-shot maxima, measured by the DE1
between boiler and portafilter. The maximum is the larger of two things: the peak at the switch from the
7 mL/s preinfusion to the experiment's flow, and the highest pressure of the pour phase. The model's
transition is not compared: the original M1 hydraulics could not pass the article's transition flow, and
M1.1 retains an idealised DE1 controller. With the article's 4 s ramp (Fig. A2), the M1 pump sat at its 12 bar
limit during the switch in every V1 shot, whereas the measured maxima are 2.5–9.3 bar. The current
calibration file's `fit.blocks.V1.pump_limited` and the report record any remaining saturation after the
startup corrections. The sensitivity variant "whole-shot peak pressure" shows what
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
  chi-square, computed by SVD pseudo-inverse. These local linear summaries do not account for truncation
  by bounds and are not calibrated probability intervals or guaranteed lower bounds. A reduced chi-square
  well above 1, and χ²/n differing between blocks (both in `fit.blocks`), mean the residual model is incomplete; V1 holds most
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
label: v4
created: 2026-10-16
core_version: 0.6.1
tools_version: 0.6.1
parameters: {<registry id>: <value in the registry's units>}   # only what the app's builder reads
fit:
  datasets: [dataset folders used]
  config: data/calibration/config.yaml
  solver: {puckcore_version, extension_sha256, extension_built, sources_sha256: {tree: hash}}
  inputs: {config_sha256, datasets_sha256, registry_inputs_sha256, presets_sha256, calibration_sources_sha256}
  optimizer: {method, success, status, message, evaluations, jacobian_evaluations, optimality,
              simulations, start_cost, cost}
  nuisance: {<calibration.* id>: value}          # setup-specific values (spec mode)
  case_parameters: {<id>: value}                 # values applied by case builders (case mode)
  reference_permeability: {id, value_m2, pooling, datasets, estimates, log_sd, max_over_min, repooled?}
  fixed: {<id>: {value, units, reason}}          # reviewed and held at their registry values
  weakly_identified: [ids]                       # local marginal SD ≥ 0.5 × prior SD
  pruning_review: {...}                         # bounded registry-value trials and decisions
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

The whole pipeline rebuilds the native engine, starts from the recorded training-selected
`data/calibration/starts/v4.yaml`, stages v4 under `.local/calibration-v4`, runs the
main/pruned fit, all 15 leave-one-condition-out refits and nine sensitivities, validates the candidate,
then promotes a numerically complete result. It exports/rebuilds the application calibration,
regenerates validation, calibration-labelled startup ablations and kernel verification, and checks
fixtures, report freshness and Python tests. Run the Rust and browser release checks from
[CONTRIBUTING.md](../../CONTRIBUTING.md) after rebuilding WebAssembly with the exported calibration:

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
.venv/bin/puckworks-tools calibrate --label v4 --jobs 8 --prune --loo --loo-jobs 2 --sensitivity \
  --start-from data/calibration/starts/v4.yaml --out-dir .local/calibration-v4 --no-current \
  --checkpoint-dir .local/calibration-v4/checkpoints
.venv/bin/puckworks-tools calibrate --pool-only                 # re-pool κ_ref after a builder change
.venv/bin/puckworks-tools calibrate --sensitivity-only --variant θ  # re-run sensitivity variants only
.venv/bin/puckworks-tools export                                # embed current.yaml (then rebuild puckcore)
.venv/bin/puckworks-tools validate --jobs 8                      # docs/validation/m1-validation.md
.venv/bin/puckworks-tools validate --check                       # report rendering and calibrated values agree
.venv/bin/python python/scripts/m11-startup-sensitivity.py        # labelled output; historical JSON preserved
```

Warm starts must lie inside the unchanged bounds; substantive clipping is rejected. Atomic
checkpoints retain the initial main fit, each pruning refit, each LOO condition and each sensitivity.
The document records optimizer success, status, message and first-order optimality for the main fit
and each refit. `xtol` termination is not evidence of a stationary or global optimum. Numerical completion requires the expected
refits and available finite final predictions; optimizer termination on a failed constant residual
is insufficient. Scientific failures are reported separately and never converted to optimizer success
or used to relax gates. Input and solver identities are captured before fitting and checked again
before publication; changing them during a run requires a new run.

## Leave one condition out (V1)

`calibrate --loo` adds the V1 leave-one-condition-out check (PLAN §10: λ and cup masses within ±15% when
left out). In v4 it refits every fitted parameter across all selected calibration blocks 15 times,
each time removing one V1 experiment and retaining every observation in the other blocks. Shared
transport and hydraulic parameters are re-estimated along with that grinding level's permeability,
the bean's contents and the preparation nuisances. `--blocks` limits this scope explicitly.
It predicts only the omitted experiment and records relative errors of λ and Eq. 3 cup masses,
per-fold starting/fitted values, optimizer diagnostics, retained case counts and excluded cases.
`--loo-jobs N` runs up to N independent folds concurrently; each owns its inputs, caches and
`--jobs` simulation processes. The default is one fold. Checkpoints are written by the coordinator
and list experiments in their original order. The selected loss is used in every refit.

This is conditional cross-validation: the parameter/fixed structure selected on the full training
data is retained, pruning is not repeated within each fold, and the optimizer starts from the full
fit. It does not validate the model-selection procedure itself. Historical v1–v3 refits held shared
parameters at their full-fit values; reports preserve that distinction. `validate` reads `fit.loo`,
or reports "not run" if the calibration has none.
