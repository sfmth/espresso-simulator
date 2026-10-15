<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Input models (M1): from a recipe to a shot spec

*Puckworks M1 · workstream D · 2026-10-14 · code: `crates/puckmodel`.*

The input models turn a recipe (gear as a person describes it, [contract](m1-contract.md) §1) into a complete `ShotSpec` for the solver. They implement PLAN §7.3 modules **B** (bean), **G** (grinder → PSD), **P** (basket, bed, puck prep) and **M** (machine), on top of the parameter registry (module **R**, [ADR 0006](../decisions/0006-parameter-registry.md)) and the presets in `data/presets/`.

Read this with research notes [02](../research/02-chemistry-and-sensory.md) (§1, §4) and [03](../research/03-grinding-psd-and-data.md) (§1–§4, Implications A and B). Evidence grades A–D are those of the notes. **Most of the numbers that turn gear into physics are estimates (grade D)**; each says so here, in its registry record and in the notes the builder returns.

**Contents.** 1 Principles · 2 Grinder → PSD · 3 Bean · 4 Basket · 5 Bed and puck preparation · 6 Hydraulics closures · 7 Extraction parameters · 8 Machine · 9 Spec field map · 10 New registry records · 11 Presets and export · 12 Recipe fields added in M1 · 13 Limitations.

---

## 1. Principles

**Pipeline.** `builder::build` runs bean → machine → basket → grinder → bed → puck prep → hydraulics → solubles → thermal → stop. It then checks the spec with the solver's own validation (`puckcore::shot::validate_shot_spec`, also behind `validate::check_spec`), so it never emits a spec the solver rejects and never rejects one the solver accepts. The solver's warnings become notes.

**Precedence.** One rule for every registry-backed quantity, highest first:

| # | Source | Token |
|---|---|---|
| 1 | an explicit **recipe field** (e.g. `machine.temperature_c`) | `recipe:<field>` |
| 2 | a recipe **override** of the registry id (sandbox) | `override:<id>` |
| 3 | a **calibrated** value from `data/calibration/current.yaml` | `calibration:<id>` |
| 4 | a **preset** value (grinder, then its family; basket; machine) | `preset:<kind>/<id>` |
| 5 | a **model-derived** value (e.g. the bean model's intraparticle porosity) | the inputs' tokens |
| 6 | the **registry default**: the record's `value`, else the central value of its prior (uniform midpoint, normal mean, lognormal median, triangular mode) | `registry:<id>` |

- **Recipe over override.** What the user typed in the recipe is the most specific statement, so it beats a sandbox override of the same quantity; a note says so whenever both are given.
- **Calibration over presets.** A calibrated value replaces preset and model-derived values of the same id. Calibrate device-specific numbers (a dial mapping, a preset's pump) through the presets instead.
- **One deviation: the default ramp.** `model.machine.ramp_time` means "the ramp of a phase that states none", so an override changes the default only; phases with their own `ramp_s` (recipe or preset) keep it, with a note naming how many.
- Unknown override ids are errors naming the id, and so are values outside the record's `range`. Overrides the models do not use for this recipe get a note.

**Solver bounds.** Every registry range the models read lies inside what the solver accepts (shot-model.md §2.1): any value inside a record's range, with the rest at their defaults, gives a spec the solver accepts and a shot that runs (tested for every read id at both ends, on the generic and the owner recipe). Size classes are kept inside the solver's 0.1 µm–5 mm radii and the permeability spread at most 3 (with a note). No range of workstream C's records is wider than the models can use; the test would list any that became so (`crates/puckmodel/tests/review_checks.rs`, `C_RANGE_MISMATCHES`). The water-content check (v̄·max(c_sat, K·s₀) < 0.9) is the solver's; its error is mapped to every recipe field or override behind it.

**Plausibility bounds.** Every numeric recipe field is checked against plausible bounds (`crates/puckmodel/src/bounds.rs`, mirrored in the recipe schema), with an error naming the field: e.g. dose 1–60 g, burr gap ≤ 3000 µm, measured PSD diameters 0.2–5000 µm, basket diameters 20–120 mm and heights ≤ 100 mm, orifice 0.05–10 mm, brew temperature 20–100 °C, pressure targets ≤ 20 bar, flow targets ≤ 20 mL/s, pump limits ≤ 30 mL/s and 30 bar, phase times ≤ 600 s, stop time ≤ 600 s and beverage ≤ 500 g. Dial settings outside the preset's dial are clamped with a note. Registry values the models need inside tighter bounds than the record's range (e.g. a saturation > 0, a fines mode of 5–200 µm) are checked whenever they come from an override, a recipe field or a calibration, and derived quantities are checked too (κ₀, the extractable fraction, the initial bed temperature, the pore concentration against the solute volume). Every such error names the recipe fields, overrides or calibrated ids responsible; "internal error" is reserved for bugs.

**Registry ids read.** `crates/puckmodel/registry-reads.txt` lists every registry id the builder reads. Debug builds check each lookup against it, a test checks that the list is exact, and the export refuses a calibration of any other id (it would be silently ignored).

**Provenance.** `derived.provenance` maps each spec field path to comma-separated tokens of the sources it actually came from (table above, plus `model:<description>`). A test checks that every token resolves.

**Notes and flags.** `derived.notes` collects assumptions, clamped inputs, documented no-ops, solver warnings and every note of the presets used. `derived.flags` lists their flags: `estimated`, `unverified` (retail listings no manufacturer confirmed), `disputed` (sources conflict), `owner-gear`, `generic`.

**Strict inputs.** Unknown recipe fields are errors (serde `deny_unknown_fields`, mirrored by [`data/schema/recipe.schema.json`](../../data/schema/recipe.schema.json)).

**Determinism.** The models use only IEEE basic operations, `sqrt`, `puckcore::math::exp` and the deterministic `ln`, `pow` and `erfc` in `numeric.rs` (no platform maths library), so native and WebAssembly builds produce bit-identical specs. Unit conversions divide by exact powers of ten (5 mL → 5e-6 m³, not 4.9999999999999996e-6). serde_json's `float_roundtrip` feature makes specs survive JSON round trips bit for bit.

---

## 2. Grinder → PSD (module G)

Code: `models/grinder.rs`. Evidence: note 03 §1–§2, Implications A.

### 2.1 Setting → gap

g = g_ref + Δ (s − s_ref) from the preset's dial (`gap_at_ref_um`, `gap_per_unit_um`, `ref`). The recipe can replace g_ref and Δ (dial calibration, PLAN §7.3 K), give `gap_um` directly, or, with a family and no preset, give `setting` with `gap_at_ref_um` and `gap_per_unit_um` (reference setting 0). Settings outside the dial are clamped with a note; gaps below 5 µm are raised to 5 µm.

### 2.2 Median

X50 = κ_G · g · f_roast · f_T, with
- κ_G = `psd.x50_gap_ratio` = 1.4 (Bentwood V63, Camsizer x_area, A, derived), unless the preset, family or recipe gives one;
- f_roast = 1 − a_r (r − 0.5), a_r = `model.psd.roast_coefficient` = 0.15 per unit roast level (D);
- f_T = 1 − a_T · clamp((20 − T)/39, 0, 1), a_T = `model.psd.cold_size_reduction` = 0.10 (D): frozen beans (−19 °C or colder) grind 10% finer, warm beans get no correction.

κ_G was measured at X50 ≈ 220–350 µm only. Below X50 = 150 µm the builder notes that the median is extrapolated linearly in the gap (size and Sauter diameter uncertain by about ±30%), and a named grinder set outside the settings where its PSD was measured (`dial.anchored`) gets a note too. X50 is held at least 1.25 μ_f (50 µm), below which the median would sit inside the fines mode.

Note 03 writes the coarse mode as μ_c = κ_G g …. κ_G was measured as X50/gap, so the model applies it to the median and solves for μ_c (§2.4).

### 2.3 Fines

The weight of the fines component follows the coarse mode:

logit w_f = logit w_340 − γ ln(μ_c/μ_340), γ = `model.psd.fines_weight_slope` = 2.0 (C, fitted),

anchored at the mixture whose median is 340 µm and whose volume share below 100 µm is u_G (Gagné's "unimodality" metric, from the recipe, preset or family; 1–40%). As the gap closes, the coarse mode shrinks and the fines grow without bound or clamp, from filter grinds (a few % below 100 µm) to Turkish-like ones (X50 ≈ 60 µm with 65% below 100 µm). Q100, the volume share below 100 µm, is an output.

**Evidence** (measured PSDs only; no shot, flow or permeability data). Each measured (X50, Q100) was converted to the mixture's (μ_c, w_f), and logit w_f regressed on ln μ_c per grinder:

| Dataset | Grinder, method | X50 (µm) | γ | u_G at γ = 2 | Q100 residual at γ = 2 |
|---|---|---|---|---|---|
| Corrochano 2017 ΨA–ΨE | disc grinder, dry laser diffraction | 61–383 | 2.06 (rms 0.006 in logit) | 19.9% | ≤ 0.4 pt |
| Corrochano 2017 ΨF–ΨH | roller grinder, dry laser diffraction | 602–1297 | 2.35 | — | — |
| Smrke 2024 | Bentwood V63, Camsizer x_area | 232–352 | 2.01 (rms 0.013) | 15.7% | ≤ 0.3 pt |
| Cameron 2020 | EK43, laser diffraction (dispersion not stated) | 205–360 | 1.59 (rms 0.02) | 16.1% | ≤ 1.1 pt |
| Waszkiewicz 2026 | F64 EVO at 1.9, laser diffraction (not stated; no volume below 5 µm, so probably dry) | 61–64 | one setting | 18.4% | ≤ 0.1 pt |

**Basis.** Dry laser diffraction and dynamic image analysis, which agree at the level of X50 and Q100 for these grinders. Wet laser diffraction (Schmieder 2023; Corrochano's wet table) reports a 1–10 µm debris population, 2–4× smaller Sauter diameters and more fines; it is not used for the relation (the E65S dial fit below uses wet D43, which the debris barely moves). Cameron's EK43 disagrees most (γ 1.6): with γ = 2 its Q100 is within 1.1 points.

**Sauter diameter.** At the measured X50 and Q100 the mixture's D32 is within 12% of the measured dry D32 (Corrochano ΨA–ΨE, Cameron, Waszkiewicz): close at the fine (45 vs 47–50 µm) and coarse ends, 6–12% low in the espresso range (e.g. Cameron GS 1.0: 82 vs 94 µm), because the fines mode (μ_f 40 µm, σ_f 0.6) is narrower and finer than Cameron's drawn curves. A fines mode of 45 µm would remove most of that bias but worsens the fines relation for Corrochano's grinder (rms 2 points), so `psd.fines_mode` stays at 40 µm.

v1 used Q100 = u_G − β (X50 − 340 µm) with `psd.fines_slope` and clamps at 4% and 40%, measured for X50 ≈ 190–383 µm. It could not represent espresso-fine grinds: the Sauter diameter stopped near 70 µm.

### 2.4 Mixture

The volume-weighted PSD in ln d is
q₃(ln d) = Σ_k w_k φ((ln d − ln μ_k)/σ_k)/σ_k for k = fines, coarse, boulders.

| Component | Mode | Log-width | Weight |
|---|---|---|---|
| fines | μ_f = `psd.fines_mode` = 40 µm (C) | σ_f = `model.psd.fines_log_width` = 0.6 (D) | w_f, from the fines relation (§2.3) |
| coarse | μ_c, solved | σ_c = `model.psd.coarse_log_width` (D), from the recipe, preset or family | 1 − w_f − w_b |
| boulders | r_b μ_c, r_b = `psd.boulder_mode_ratio` = 1.75 (D) | σ_b = `model.psd.boulder_log_width` = 0.35 (D) | w_b = `model.psd.boulder_weight` (D), from the recipe, preset or family |

Two solves. (1) The anchor: at a 340 µm median with u_G below 100 µm, w_340 and μ_340 follow from the two conditions (for each trial μ_c, w_f follows linearly from the 100 µm condition; μ_c by bisection on the median). (2) At the recipe's X50, μ_c is found by bisection with w_f = W(μ_c) from §2.3; the median rises monotonically with μ_c, so the root is unique for any X50 above the 50 µm floor. Both solves are checked to 10⁻⁶; a failure (e.g. a u_G that no mixture with these widths can have at 340 µm) is an error naming the inputs.

### 2.5 Size classes and curve

- **Classes** (`bed.size_classes`): `numerics.size_classes` (default 30, 2–60) bins log-spaced between the 0.05% and 99.95% quantiles, tails folded into the end bins, each represented by its geometric midpoint; fractions sum to 1.
- **Curve** (`derived.psd_curve`): 200 log-spaced points of q₃(ln d), from min(5 µm, half the lower quantile) to max(1500 µm, 1.5× the upper quantile).
- **Summary** (`derived.psd`): X50, Q100 and D43 of the continuous mixture; D32 of the size classes (the one Sauter diameter reported, equal to `derived.bed.sauter_diameter_um`, which scales κ₀); the three components, gap, setting, burr size and rpm.
- Tier 0 gets the same classes; the solver coarsens them (contract §4).

### 2.6 Measured PSD

`grinder.psd` (diameters and volume fractions) overrides everything else. Diameters must lie in 0.2–5000 µm (the solver's particle radii are 0.1 µm–5 mm) and increase; at most 2000 bins. Fractions are normalised by their largest value before summing (so even 1e308 works), at least two bins must hold volume, and a distribution that never decreases and ends at 1 (or 100) is refused as cumulative. Bins are taken as contiguous in ln d, with edges at the geometric midpoints between neighbouring diameters (mirrored at the ends). Distributions with at most `size_classes` bins are used as given (empty bins dropped), which also serves the two-class literature mode (e.g. Grudeva 2026: 7.3 and 458 µm); longer ones are rebinned by overlap onto log-spaced classes. `method` (`dry_laser`, `wet_laser`, `image`, `sieve`, `other`) adds the matching caveat from note 03 §1.4; no measurement-model correction is applied in v1.

### 2.7 Families and named grinders

Families (`data/presets/grinders/families.yaml`, grade D, estimated from Gagné 2023's qualitative ranking and the measured grinders of §2.3):

| Family | u_G (%) | σ_c | w_b |
|---|---|---|---|
| `flat-unimodal` | 11 | 0.30 | 0.03 |
| `flat-traditional` | 16 | 0.35 | 0.05 |
| `conical` | 20 | 0.40 | 0.08 |

The measured flat grinders span u_G 15.7–19.9% (Bentwood, EK43, F64 EVO, Corrochano's disc grinder). The family's σ_c and w_b can be replaced from the recipe (`grinder.coarse_log_width`, `grinder.boulder_weight`) or by overriding or calibrating `model.psd.coarse_log_width` and `model.psd.boulder_weight`. A named grinder keeps its family's notes and `estimated` flag (its widths and weights are the family's grade-D estimates), and `derived.presets` lists both the grinder and its family. Burr diameter and rpm are recorded but have no effect: the evidence shows no systematic trend (03 §2.1).

| Preset | Family | Dial → gap | Measured settings | u_G | Grade, flags | Basis |
|---|---|---|---|---|---|---|
| `bentwood-v63` | flat-traditional | µm dial: g = setting | 160–250 | 15.7% | B, fitted | Smrke 2024 Fig. 2 (Camsizer) |
| `mahlkoenig-e65s` | flat-traditional | 195 µm at GL 1.4 + 25 µm per GL | 1.4–2.0 | 16% (family) | B, fitted; **disputed** | gap mapping fitted so the model gives Schmieder 2023's wet D43 at GL 1.4 and 2.0. The brochure's ≈5 µm per indicator is read as burr movement by note 03 but as a particle-size bandwidth by Schmieder; neither is used directly. GL 0 gives X50 224 µm: by this mapping the E65S cannot grind finer |
| `mahlkoenig-ek43` | flat-traditional | 72 µm + 71 µm per unit | 1.0–2.5 | 16.1% | B, fitted | Cameron 2020 Fig. 2B (laser diffraction): X50 within 6%. Setting 0 (burrs chirping) extrapolates to X50 ≈ 100 µm |
| `amzchef-single-dose` | conical | 50 µm + 15 µm per marked setting | — | 20% (family) | D; **owner-gear, unverified, estimated** | 40 mm conical, ~75 stepless marked settings, ~450 rpm from retail listings only (PLAN §15); the mapping is a wide prior (0–150 µm, 8–25 µm per setting) to calibrate from logged shots |
| `generic-flat-unimodal-64`, `generic-flat-traditional-64`, `generic-conical-50` | one each | setting = gap in µm | — | family | D, generic | for describing any grinder by its gap |

**Dial defaults** sit where published espresso grinds lie by particle size, not where a shot takes 30 s: Bentwood 190 µm (centre of Smrke's espresso study), E65S GL 1.7 (Schmieder), EK43 1.7 (Cameron's extraction peak), AMZCHEF 10 and the generic 170–190 µm (X50 ≈ 240–280 µm; grade-D dials, placed in the X50 ≈ 200–360 µm range of Smrke, Cameron and Corrochano ΨB–ΨE, as their notes say). The one published espresso grind with a full PSD and a ~30 s shot, Waszkiewicz 2026's, is much finer (X50 61–64 µm, D32 47–50 µm, nothing above 182 µm); the Bentwood, AMZCHEF and generic grinders reach it near the bottom of their dials.

### 2.8 Anchors reproduced

Bentwood V63 (κ_G 1.4, u_G 15.7) against Smrke 2024 (digitized ±3 µm, ±0.3 points):

| Spacing (µm) | X50 model | X50 data | Q100 model (%) | Q100 data (%) |
|---|---|---|---|---|
| 160 | 224 | 232 | 26.4 | 25.6 |
| 170 | 238 | 245 | 24.7 | 23.9 |
| 180 | 252 | 257 | 23.1 | 22.4 |
| 190 | 266 | 267 | 21.7 | 21.7 |
| 210 | 294 | 295 | 19.1 | 18.8 |
| 250 | 350 | 352 | 15.1 | 15.0 |

- Corrochano 2017 ΨA–ΨE (u_G 19.9, at the measured X50): Q100 within 0.4 points from X50 61 to 383 µm; D32 within 12%.
- Waszkiewicz 2026 (u_G 18.4, X50 62.5 µm): Q100 66.0% (measured 64.9–67.2), D32 46 µm (47–50).
- EK43 against Cameron 2020: X50 200 / 250 / 300 / 349 µm at 1.0 / 1.5 / 2.0 / 2.5 (measured 205 / 250 / 282 / 360); Q100 at the measured X50 within 1.1 points.
- E65S: model D43 274 / 285 / 296 µm at GL 1.4 / 1.7 / 2.0 vs measured 273 ± 8, 277 ± 17, 295 ± 18.
- EK43: light (0.25) at 2.0 → X50 311 µm; dark (0.85) at 2.3 → 312 µm, matching Méndez Harper's "light at 2.0 ≈ dark at 2.3".

Fine end (medium roast, 20 °C): the Bentwood at 50 µm gives X50 70 µm, 62.6% below 100 µm and D32 48 µm; the AMZCHEF at setting 0 and the generic grinders at a 50 µm gap give D32 47–49 µm; the EK43 at 0 gives X50 101 µm and D32 56 µm; the E65S at GL 0 gives D32 88 µm. v1 stopped at D32 ≈ 70–90 µm on every grinder.

The tests (`crates/puckmodel/tests/input_models.rs`) check all of these, and that every dial setting of every grinder builds with a Sauter diameter that rises monotonically with the setting.

### 2.9 Unverified or estimated

Family parameters, σ_f, σ_b, r_b, the roast and temperature factors, and the AMZCHEF dial mapping (grade D); the E65S dial scale (disputed); the X50/gap relation below X50 ≈ 220 µm (extrapolated: no grinder's gap was measured there). γ comes from three grinders and two methods; u_G of a grinder without PSD data is a family judgement.

---

## 3. Bean model v1 (module B)

Code: `models/bean.rs`. Evidence: note 02 §1, §4.

### 3.1 Inputs

Arabica share a (0–1), roast level r (0 very light … 1 very dark), days off roast, process, and bean temperature at grinding. Fields a recipe leaves out come from its preset, or from the default bean `medium-washed-arabica` (with a note). Blends mix Arabica and Robusta values linearly by mass.

**Roast index.** Internal roast level maps linearly to Colorette: Pt = 160 − 100 r (`model.bean.roast_index.colorette_light` 160, `…_dark` 60; D). The Smrke 2018 roasts (131, 101, 78 Pt) sit at r = 0.29, 0.59, 0.82. No validated conversion between colour scales exists (02 Conventions).

### 3.2 Tracked species (kg per kg dry dose)

| Species | Arabica | Robusta | Roast dependence | Kernel D at 80 °C | K | Surface scale |
|---|---|---|---|---|---|---|
| caffeine | `bean.composition.arabica.caffeine` 1.2% (C) | `….robusta.caffeine` 2.6% (C) | none (stable) | `extraction.diffusivity.caffeine.particle_80c` 1.9×10⁻¹⁰ (A) | `extraction.partition.caffeine` 1.0 (A) | `model.species.caffeine.surface_fraction_scale` 1 (D) |
| trigonelline | 1.2 → 0.2% light → dark (`model.bean.trigonelline.arabica_*`, C) | 0.7 → 0.3% (`….robusta_*`, C) | linear in r | `model.species.trigonelline.diffusivity_80c` 2.8×10⁻¹⁰ (C, low-MW class) | `….partition` 0.61 (D, lumped value) | 1 (D) |
| cqa5 (5-CQA) | `bean.composition.arabica.5cqa` 1.14% at medium (A) × (1 + 0.6 (1 − 2r)) (`model.bean.cqa5_roast_change`, D) | × 1.61 (`model.bean.cqa5_robusta_ratio`, C, from total CGA) | linear in r | `model.species.cqa5.diffusivity_80c` 1.55×10⁻¹⁰ (C, Stokes–Einstein from caffeine) | 0.61 (D) | 1 (D) |
| acids | aliphatic 1.6 + quinic 0.8% (C) | 1.6 + 1.0% (C) | none (documented no-op: individual acids move in opposite directions, 02 §4.3) | `model.species.acids.diffusivity_80c` 2.8×10⁻¹⁰ (C) | 0.61 (D) | 1 (D) |

Robusta's reported 2–5× higher formic and acetic acid (02 §4.1) is not in the compilation values used.

### 3.3 Extractable fraction

EY_max = `extraction.max_yield` (28%, prior 22–34%, B) + `model.bean.extractable_roast_slope` (2 points per unit roast level, D) × (r − 0.5) + `model.bean.extractable_robusta_increase` (2 points, D) × (1 − a). The registry value is treated as the medium-roast Arabica reference: an override of `extraction.max_yield` keeps the roast and species adjustments. The Robusta increase scales EY_max with the non-lipid matrix (lipids 11 vs 17% db).

### 3.4 Density and porosity

Skeletal density ρ_s = `bed.density.skeletal` (1352 kg/m³, C). Intraparticle porosity ε_p = `model.bean.intraparticle_porosity_medium` 0.55 (C, derived so that ε = 0.17 and ρ_s reproduce the measured ≈500 kg/m³ puck) + `model.bean.intraparticle_porosity_roast_slope` 0.1 (D) × (r − 0.5). This is a model-derived value: an override or a calibration of `bed.porosity.intraparticle` replaces it (§1). To calibrate the bean model itself, calibrate `model.bean.intraparticle_porosity_medium`.

### 3.5 CO₂ and the gas penalty

Whole-bean degassing (Smrke 2018, A): released M(t) = M∞[1 − exp(−(t/λ)^k)], so the remainder is a fraction exp(−(t/λ)^k). M∞, λ and k (`bean.co2.total.*`, `bean.co2.weibull_scale.*`, `bean.co2.weibull_shape.*`) are interpolated linearly in roast level between the light, medium and dark fits (k for medium interpolated between light and dark; constant beyond the end roasts, with a note).

The 400 h fits underestimate the total (02 §4.4: a light roast followed to 800 h gives M∞ 5.07 instead of 3.55 mg/g), so they set only the roast ratio and the time course. The level is anchored to the measured CO₂ of freshly ground coffee, `bean.co2.ground_residual` (4.5–12 mg/g, centre 8.25; C), taken as Smrke's medium roast:
- **CO₂ in the puck** c = c_residual × (M∞(r)/M∞,medium) × exp(−(t/λ)^k);
- **in the whole beans** (reported only): c/(1 − `model.bean.co2_grinding_loss` 50%) (D; "up to 75%" leaves within 90 s of grinding). Fresh medium beans then hold ≈ 14 mg/g, inside note 02's 1–2% by weight;
- **gas amplitude** A = `model.hydraulics.gas_amplitude_max` 0.5 × c/(c + c_half), c_half = `model.hydraulics.gas_half_content` 8.25 mg/g (the fresh-ground residual; D), with τ = `model.hydraulics.gas_relaxation_time` 5 s (D).

The amplitude mapping is an **estimate**: no measurement of CO₂'s hydraulic effect in espresso exists (01 §4.9). Typical values: medium roast fresh c = 7.1 mg/g, A = 0.23; after 10 days c = 2.9 mg/g, A = 0.13; after 30 days c = 0.5 mg/g, A = 0.03; dark roast after 7 days c = 6.0 mg/g, A = 0.21.

### 3.6 Process and age effects not modelled

Process (`washed`, `natural`, `honey`, `anaerobic`) is validated and recorded but is a **documented no-op** (dry processing raises untracked sugars; fermentation effects on roasted acids are unquantified, 02 §4.2). Staling after months and storage are not modelled; beans older than 120 days or younger than 2 days get a note.

### 3.7 Bean presets

| Preset | a | r | Days | Process | EY_max | Caffeine | CO₂ in puck (mg/g) | A_gas |
|---|---|---|---|---|---|---|---|---|
| `light-washed-arabica` | 1.0 | 0.25 | 14 | washed | 27.5% | 1.20% | 1.7 | 0.09 |
| `medium-washed-arabica` (default) | 1.0 | 0.5 | 10 | washed | 28.0% | 1.20% | 2.9 | 0.13 |
| `medium-natural-brazil` | 1.0 | 0.55 | 10 | natural | 28.1% | 1.20% | 2.9 | 0.13 |
| `medium-dark-90-10-blend` | 0.9 | 0.65 | 10 | — | 28.5% | 1.34% | 3.4 | 0.15 |
| `dark-80-20-blend` | 0.8 | 0.8 | 7 | — | 29.0% | 1.48% | 6.0 | 0.21 |
| `robusta-medium` | 0.0 | 0.6 | 10 | natural | 30.2% | 2.60% | 3.0 | 0.13 |

These are representative descriptions, not lots (grade C composition priors; Farah 2012 compilation).

---

## 4. Basket (module P)

Code: `models/basket.rs`.

**Any shape.** A custom basket is an inner wall profile of `[height above the floor, inner diameter]` points in mm (heights from 0, strictly increasing, at most 100 mm; diameters 20–120 mm; straight, tapered or stepped), the diameter of the perforated field (at least 5 mm, at most the floor diameter), an optional open-area fraction (0.001–1; default `model.basket.open_area_fraction` 0.03, D) and, for a pressurised (dual-wall) basket, the outlet orifice diameter (0.05–10 mm) with a discharge coefficient (0.1–1; default `model.basket.pressurised_discharge_coefficient` 0.7, D). The solver adds ΔP = ρQ²/(2C_d²A_o²) in series (contract §4). Presets use the same fields; the open area and C_d follow the precedence of §1 (a preset's value loses to an override). **A vertical step** needs a small height increment, because heights must strictly increase: write a 40 → 56 mm step at 6 mm as `[6, 40], [6.1, 56]`.

**Volumes.** The radius is linear between profile points, so volumes are sums of frusta. The bed height is the height at which the enclosed volume equals the bed volume (§5.1); a dose that does not fit is an error naming both volumes. A bed above 95% of the basket height gets a note. The machine's group headspace (§8.3) is passed as `extra_headspace_m3`; the solver adds the basket volume above the bed.

**Presets** (named by geometry; **all dimensions estimated**, grade D; nominal dose shown):

| Preset | Profile (height, diameter) mm | Perforated (mm) | Outlet | Dose (g) | Volume (mL) | Bed height at nominal dose* (mm) |
|---|---|---|---|---|---|---|
| `58-precision-15g` | (0, 54) (2, 57) (5, 58) (18, 58.5) | 50 | holes | 15 (13–16) | 47.3 | 11.4 |
| `58-precision-18g` | … (21, 58.5) | 50 | holes | 18 (16–19) | 55.3 | 13.7 |
| `58-precision-20g` | … (23, 58.5) | 50 | holes | 20 (18–21) | 60.6 | 15.2 |
| `58-precision-22g` | … (25, 58.5) | 50 | holes | 22 (20–23) | 65.9 | 16.7 |
| `58-stock-double` | (0, 46) (4, 50) (12, 55) (24, 58) | 40 | holes | 16 (14–18) | 54.7 | 15.0 |
| `58-stock-single` | (0, 30) (6, 40) (12, 50) (18, 57) | 26 | holes | 8 (7–10) | 28.9 | 12.2 |
| `54-double` | (0, 49) (3, 52.5) (22, 53.5) | 44 | holes | 18 (16–19) | 48.0 | 16.5 |
| `53-double` | (0, 48) (3, 51.5) (21, 52.5) | 43 | holes | 16 (14–18) | 44.1 | 15.2 |
| `51-double` | (0, 42) (5, 48) (20, 50.5) | 37 | holes | 14 (12–16) | 36.5 | 15.5 |
| `49-double` | (0, 40) (5, 46) (19, 48.5) | 35 | holes | 13 (11–14) | 31.8 | 15.7 |
| `58-pressurised-double` | as 58-stock-double | 40 | 0.4 mm orifice | 16 (14–18) | 54.7 | 15.0 |
| `51-pressurised-double` | as 51-double | 37 | 0.4 mm orifice | 14 (12–16) | 36.5 | 15.5 |

\*Medium-roast Arabica (bulk density 505 kg/m³). Measure your basket and describe it with `basket.custom` for better results. The owner's 58 mm basket type is unconfirmed (PLAN §15, open question 2); the AMZCHEF Ultra preset defaults to `58-stock-double` and says to pick `58-pressurised-double` for a dual-wall basket.

---

## 5. Bed and puck preparation (module P)

Code: `builder.rs` (bed, permeability), `models/prep.rs` (heterogeneity). Evidence: note 03 §4 and Implications B; note 01 §4.2–§4.4, §6.

### 5.1 Porosities and bulk density

Intergranular porosity ε = `bed.porosity.intergranular` (0.17, C). Bulk density ρ_bed = (1 − ε)(1 − ε_p) ρ_s; bed volume = dose/ρ_bed. With the defaults ρ_bed ≈ 505 kg/m³ for a medium roast, matching the measured ≈500 kg/m³ (`bed.density.bulk`). Tamping and the PSD do not change ε in v1.

### 5.2 Base permeability from the PSD

Permeability is calibrated, never predicted from the PSD; Kozeny–Carman is used only for relative changes (01 §4.3, Implications 2). The spec field `hydraulics.permeability_m2` is the solver's **bare** base permeability κ₀: the solver multiplies it by its compaction (poroelastic), swelling, gas, dissolution and viscosity factors (shot-model.md §4.2).

κ₀ = κ_ref · (D32/D32_ref)² · [KC(ε)/KC(ε_ref)]^α,  KC(ε) = ε³/(1−ε)²

- κ_ref = `hydraulics.permeability.reference`: the bare base permeability at D32_ref (2.4×10⁻¹⁴ m², fitted, grade D, workstream C; chosen so generic 18 → 36 g recipes at a flat 9 bar take about 30 s at tier 1, and replaced by the calibration);
- D32 = Sauter diameter of the size classes;
- D32_ref = `model.hydraulics.reference_sauter_diameter` = 165 µm (D): a convention, since D32_ref and κ_ref are not separately identifiable; a typical espresso grind has D32 ≈ 100 µm;
- ε_ref = the registry default of ε (calibrated if available, never the override);
- α = `hydraulics.kozeny_carman.density_exponent`: the density exponent of the relative closure, the same form as V6's case builder (`python/puckworks_tools/cases/corrochano2017.py`), which calibrates it against Corrochano 2017's permeability at three bed densities. The registry value 1 is plain relative Kozeny–Carman; V6 measures a much weaker response (κ(480)/κ(360) = 0.26–0.35 against ≈ 0.05 for α = 1). At ε = ε_ref the factor is 1 whatever α, so only porosity overrides and density effects feel it. α = 1 keeps v1's exact arithmetic (bit-identical results).

**Why not the in-shot permeability.** v1 used `hydraulics.permeability.in_shot`, an apparent κ = qμL/ΔP back-calculated from shots at 9 bar. That value already contains compaction (the poroelastic factor is 0.33 at 9 bar with P_c = 12 bar) and swelling, which the solver then applied again: a generic 9 bar shot took 96 s instead of about 30 s. κ₀ outside the solver's 10⁻¹⁸–10⁻¹⁰ m² is an error naming its sources.

Finer grinds resist more: on the Bentwood, κ₀ goes from 2.0×10⁻¹⁵ (50 µm spacing, D32 48 µm) and 7.0×10⁻¹⁵ (160 µm, D32 89 µm) to 1.7×10⁻¹⁴ m² (250 µm, D32 140 µm).

### 5.3 Heterogeneity

| Spec field | Model | Parameters (all D, wide priors) |
|---|---|---|
| `sigma_ln_permeability` | σ = max(σ_d/2, σ_d (1 + k (Q100 − 0.2))), at most the solver's 3 (with a note) | σ_d = `model.prep.sigma_ln_permeability.{none, tap, wdt}` 0.5 / 0.35 / 0.2 (distribution not given → `tap`, with a note); k = `model.prep.sigma_fines_sensitivity` 2. Anchor: Lee 2023's two-path offset is ±0.7 in ln κ |
| `edge_multiplier` | clamp(m_prep · ((min(1, r_perf/r_bed))/ρ_ref)^n, 0.05, 1), with r_bed = √(V_bed/(πL)) the bed's volume-equivalent radius | m_prep = `model.prep.edge_multiplier.base` 0.35, raised to `.paper` 0.75 with a bottom paper or `.screen` 0.7 with a puck screen (the larger applies); ρ_ref = `model.basket.edge_reference_ratio` 0.87 (the precision 18 g basket at 18 g); n = `model.basket.edge_ratio_exponent` 2. The base and paper values convert Ribes' edge/centre EY (13 vs 25%; 22 vs 25%) through a simple extraction curve. Using the bed's radius rather than the floor's makes tapered baskets funnel more (58 mm precision 0.35, stock double 0.27, single 0.19): an untested mechanism, grade D |
| `edge_area_fraction` | constant | `model.bed.edge_area_fraction` 0.25 (edge ≈ 25–30% of the dose) |
| `prewet_nonuniformity` | u_max · V_h/(V_h + V_½) · (1 − r_s if screen) · clamp(Q_jet/Q_fill, 0.5, 1) | u_max = `model.prep.prewet_max` 0.5; V_½ = `model.prep.prewet_half_headspace` 20 mL; r_s = `model.prep.prewet_screen_reduction` 0.5; Q_jet = `model.prep.prewet_jet_flow` 5 mL/s; V_h = headspace above the bed incl. group; Q_fill = first-phase fill flow (§8.1). Bounded by the +3.4-point headspace result |

The solver decides how these act (contract §4).

### 5.4 Inputs without a modelled effect

- **Tamp force:** no measurable effect above about 10 kgf (three datasets, 03 §4); below 5 kgf a "loose bed" note (community claim, unverified). Recorded with a note only.
- **Top paper:** no measurable effect (second-hand, 03 §4). Note only.

### 5.5 Evidence

Distribution, WDT, papers, screens and headspace rest on single-operator community data (grade D, 03 §4 and Open questions 4). Every build that uses the prep model says so in a note.

---

## 6. Hydraulics closures handed to the solver

| Spec field | Value | Source |
|---|---|---|
| `poroelastic_pc_pa` | 12 bar | `hydraulics.poroelastic.critical_pressure` (B, fitted) |
| `swelling` | A = 1 − KC(ε′)/KC(ε) with ε′ = ε − f (1 − ε)((1 + S)³ − 1); τ 26 s | S = `hydraulics.swelling.diameter_increase` 7.5% (prior 0–15%, disputed); f = `model.hydraulics.swelling_pore_closure` 0.1 (D); τ = `hydraulics.swelling.relaxation_time` (A, derived). With the defaults A = 0.347 (the solver's own default is 0: the confined-swelling closure f is a calibration parameter) |
| `gas` | §3.5 | estimated mapping (D) |
| `fines_layer` | amplitude 0 (off), τ 10 s | `model.hydraulics.fines_layer_amplitude`, `…_time` (D): off until calibrated |
| `axial_dispersion_m2_s` | 5×10⁻⁶ | `extraction.dispersion.axial_coefficient` (C, derived from Bo) |
| `viscosity` | a1 3.75, a2 14.1, γ 0.45 | `model.hydraulics.viscosity_ln_a1/a2`: exact solve through Moreno 2015's 20% and 35% w/w points at 4 °C (A, derived); `…_temperature_exponent` γ derived so 25% w/w extract is 2.25× water at brew temperature, the centre of `hydraulics.viscosity.extract_relative` (B) |
| `wetting_uptake` | 0.5 | `model.hydraulics.wetting_uptake` (D, 0–0.9): the mobile share of the particles' pore liquid, which mostly sets the wetting time (shot-model.md §5.1) |
| `dissolution_kozeny_carman` | true | solver default (contract §4) |
| `dissolution_porosity_share` | θ = 0 | `hydraulics.dissolution_porosity_share` (estimated, C; triangular 0/0/1, mode 0): the share of dissolved volume that becomes intergranular porosity (shot-model.md §5.5); an override sets it in the sandbox. Lee 2023's θ = 1 is the upper bound |

---

## 7. Extraction parameters

| Spec field | Value | Source |
|---|---|---|
| `extractable_fraction` | §3.3 | bean model |
| `cell_size_m` | 25 µm broken-cell shell | `model.extraction.broken_shell_thickness` (C: ½–1 cell of 25–40 µm) |
| `saturation_kg_m3` | 245 | `extraction.saturation.lumped` (B, prior 210–280) |
| `partition_coefficient` | 0.61 | `extraction.partition.lumped_80c` (A). K = C_b/C_s with C_s the solute per unit volume of the swollen particle envelope (Corrochano's basis, shot-model.md §5.3); the species' `model.species.*.partition` use the same basis |
| `kernel_diffusivity_m2_s` | 1.26×10⁻¹⁰ | `extraction.diffusivity.lumped.corrochano_80c` (A, fitted) |
| `surface_rate_m_s` | 1×10⁻³ | `extraction.surface_rate.grudeva2026` (B) |
| `reference_temp_c` | 80 °C | the temperature of every registry diffusivity used; the solver scales D with temperature |
| `solute_specific_volume_m3_kg` | 1/1570 = 6.37×10⁻⁴ | 1/`model.extraction.solute_apparent_density` (A, derived from extract density: 25% w/w ≈ 275 kg/m³ at 1.10 g/mL). The solver checks that the highest concentration, max(c_sat, K·s₀), still leaves the liquid water; the builder maps a failure to the extractable fraction, porosity, density, saturation, K and solute density behind it |
| `species[]` | §3.2 | bean model |
| `kernel_loading_cap` | true | solver default: kernels never take up more solute than they started with (shot-model.md §5.3) |

**Species groups.** The solver groups species with identical (D, K, surface scale), and its cost grows with the number of distinct groups. Species should therefore share one parameter set wherever the evidence does not distinguish them (for M2's larger species set); the four M1 species keep their own values.

---

## 8. Machine model (module M)

Code: `models/machine.rs`. No research note covers pump curves, drip or group thermal masses, so their defaults are estimates (D) whose registry records say so.

### 8.1 Programs

A program is a list of phases (recipe `machine.profile`, or the preset's `program`, same format):

| Phase field | Meaning | Spec (SI) |
|---|---|---|
| `control: pressure`, `target` bar | hold the pressure | `Pressure { target_pa = 10⁵ × bar }` |
| `control: flow`, `target` mL/s | hold the flow | `Flow { target_m3_s = mL/s ÷ 10⁶ }` |
| `control: pump` | full power on the pump curve | `PumpFull` (target and limit ignored, with a note) |
| `limit` | flow cap (mL/s) under pressure, pressure cap (bar) under flow | m³/s or Pa |
| `ramp_s` | linear ramp from the previous target | default `model.machine.ramp_time` 2 s (D); an override of it changes the default only (§1) |
| `until_time_s`, `until_beverage_g`, `until_pressure_bar` | first one met ends the phase | `exit` in s, kg, Pa |

Bounds: pressure targets 0–20 bar, flow targets 0–20 mL/s, caps ≤ 30 mL/s or 30 bar, ramps and `until_time_s` ≤ 600 s, `until_beverage_g` ≤ 500 g. Only the last phase may run without an exit condition; it runs until the stop rule, so its exits are dropped with a note. A pressure target above the pump's limit, and a flow target above its largest flow, get a note. The fill flow used by the prep model is the first phase's flow target, its flow cap, or the pump's largest flow.

### 8.2 Pumps

- **Ideal** (profiling machines, levers, rotary pumps with a bypass): `max_flow_ml_s`, `max_pressure_bar`; defaults `model.machine.ideal_max_flow` 8 mL/s and `…_max_pressure` 12 bar (D).
- **Vibratory**: Q = Q_free (1 − P/P_stall), optional OPV; defaults `model.machine.vibratory_free_flow` 9 mL/s and `…_stall_pressure` 16 bar (D). An OPV at or above the stall pressure gets a note (it never opens).

The pump comes from the recipe, then the preset; without either an ideal pump follows the program. Each of its numbers follows the precedence of §1 (recipe value > override > calibration > preset value > registry default): a recipe pump of the **same type** as the preset's keeps the preset's values for the fields it omits (with a note naming them); a recipe pump of **another type** takes the registry defaults for its omitted fields (with a note). The OPV has no registry default (recipe > preset > none). Flows and pressures are at most 30 mL/s and 30 bar.

### 8.3 Temperature, headspace, drip, preheat

All by the precedence of §1:
- Brew temperature `shot.temperature`: recipe `machine.temperature_c` (20–100 °C) > override > calibration > preset > registry (92 °C, B). A temperature outside the preset's `temperature_range_c` gets a note.
- Group headspace above the basket rim `model.machine.group_headspace`: recipe `headspace_ml` (0–200 mL) > override > calibration > preset > registry 5 mL (D).
- Post-stop drip τ `model.machine.drip_time_constant`: override > calibration > preset > registry 1.5 s (D; at most the solver's 60 s). The solver drains only the water left above the puck.
- Three-way valve `machine.stop.vent_headspace`: recipe `machine.vent_headspace` > preset `vent_headspace` > false. With it the group is vented at the stop and nothing drips into the cup. Presets: `e61-rotary` true (E61 groups have a three-way solenoid); `amzchef-ultra` false (UNVERIFIED: many budget vibratory machines lack one); `vibratory-pump` and `spring-lever` false (levers have none). Presets that do not say, and machines from scratch, get false with a note.
- Basket and portafilter temperature at the start `model.thermal.hardware_temperature`: override > calibration > preset > registry 85 °C (D).
- A preset's `default_basket` is used when the recipe has no basket (note); a basket whose rim differs from the preset's `basket_diameter_mm` by more than 2 mm gets a note.

### 8.4 Thermal node

C = 4.186 J/(g K) × (`model.thermal.hardware_water_equivalent` 30 g + dose × `model.thermal.coffee_heat_capacity_ratio` 0.35); initial bed temperature = heat-capacity-weighted mean of the hardware temperature and the bean temperature (an error naming its sources if it falls outside the solver's 0–150 °C); heat loss = C_hardware/`model.thermal.loss_time_constant` 300 s; ambient temperature `thermal.ambient_temp_c` = `model.thermal.room_temperature` 20 °C, the same room the beans come from. All D. (Stored as a water mass and a time constant because the unit vocabulary has no J/K or W/K.)

### 8.5 Stop rule

Beverage mass (≤ 500 g) and/or time (≤ 600 s) from the recipe; with neither, `model.stop.default_ratio` (2, C) × dose, with a note. The hard stop `numerics.max_duration_s` is the largest of 120 s, the stop time + 30 s and the program's timed phases and ramps + 60 s, capped at 1200 s (with a note). The beverage mass includes the post-stop drip of the headspace water, so without a three-way valve a shot stopped at 36 g ends about 2 g heavier (generic recipe: 38.3 g); with one it ends at 36 g.

### 8.6 Machine presets

| Preset | Pump | Program | T (°C) | Grade, flags |
|---|---|---|---|---|
| `flat-9-bar` | ideal (registry) | 9 bar, 2 s ramp | 93 | B, generic |
| `declining-9-6` | ideal | 9 bar for 8 s, then 9 → 6 bar over 15 s | 93 | D, estimated |
| `spring-lever` | ideal, 10 mL/s, 10 bar | 1.2 bar for 8 s (pre-infusion), 9 bar peak, then 9 → 4.5 bar over 22 s (time-based approximation of a volume-based decline) | 92 | D, estimated |
| `blooming` | ideal | 4 mL/s until 3.5 bar (≤ 12 s), 20 s with the pump off, then 9 bar capped at 3 mL/s | 93 | D, estimated |
| `turbo-6-bar` | ideal | 6 bar, flow cap 6 mL/s | 93 | D, estimated |
| `flow-2-ml-s` | ideal | 2 mL/s, pressure cap 10 bar | 93 | B, generic |
| `allonge` | ideal | 4.5 mL/s, pressure cap 6 bar | 93 | D, estimated |
| `vibratory-pump` | vibratory (registry curve), OPV 12 bar | pump at full power | 93 | D, estimated |
| `e61-rotary` | ideal, 6 mL/s (gicleur), 9.5 bar (bypass) | 9 bar with a 4 s ramp (pre-infusion chamber) | 93; preheat 88; drip 1 s | D, estimated |
| `amzchef-ultra` | vibratory, 8 mL/s free flow, 17 bar stall, **no OPV** | pump at full power | 93 (range 88–96); 58 mm; default basket `58-stock-double` | D; **owner-gear, unverified, estimated** |

**AMZCHEF Ultra.** Listing specifications (58 mm portafilter, "20 bar" pump, pressure gauge, PID 88–96 °C) are **unverified** (PLAN §15). The pump curve and whether there is an over-pressure valve are **unknown**; the values above are estimates for a cheap vibratory pump. The gauge may read pump pressure rather than pressure at the puck. A gauge reading during a choked shot gives the OPV, if any.

---

## 9. Spec field map

Every field the builder sets, and where it comes from (see `derived.provenance` for a given recipe):

| ShotSpec field | From |
|---|---|
| `basket.profile_m`, `perforated_radius_m` | basket preset or `basket.custom` (diameters halved, mm → m) |
| `basket.open_area_fraction` | `model.basket.open_area_fraction` by precedence (recipe basket > override > calibration > preset > registry) |
| `basket.outlet` | holes, or pressurised orifice and C_d (§4) |
| `basket.extra_headspace_m3` | machine group headspace (§8.3) |
| `bed.dose_kg` | `prep.dose_g` |
| `bed.intergranular_porosity` | `bed.porosity.intergranular` |
| `bed.intraparticle_porosity`, `skeletal_density_kg_m3` | bean model (§3.4); an override or calibration of `bed.porosity.intraparticle` beats the bean model |
| `bed.size_classes` | grinder model (§2) |
| `bed.heterogeneity.*` | prep model (§5.3); `columns` stays at the solver's 8 |
| `solubles.*` (incl. `solute_specific_volume_m3_kg`, `kernel_loading_cap`) | §7 |
| `hydraulics.permeability_m2` | §5.2 |
| other `hydraulics.*` (incl. `dissolution_porosity_share` from the registry) | §6 |
| `thermal.*` (incl. `ambient_temp_c`) | §8.3–§8.4 |
| `machine.phases`, `machine.pump` | §8.1–§8.2 |
| `machine.stop.*` (incl. `vent_headspace`) | §8.3, §8.5 |
| `numerics.tier`, `max_duration_s` | recipe tier (default 1); §8.5. Other numerics (`depth_cells`, `max_dt_s`, `output_interval_s`, `snapshot_count`, `kernel_shells`) stay at the solver's defaults, with provenance `model:solver default` |

The registry ids behind these fields are listed in [`crates/puckmodel/registry-reads.txt`](../../crates/puckmodel/registry-reads.txt) (§1).

---

## 10. New registry records (`data/params/model.yaml`)

72 records for what the registry lacked; it passes `puckworks-tools validate-registry`. Grades: most are **estimated, D** with wide priors; derived, fitted or class-assigned records are B–C (the fines-relation slope γ is a project fit, C), and the viscosity-fit coefficients A (an exact solve through A-grade data, whose transfer to brew temperature is the separate grade-B exponent).

| Group | Records |
|---|---|
| PSD (G) | `model.psd.fines_log_width`, `boulder_log_width`, `coarse_log_width`, `boulder_weight`, `fines_weight_slope`, `roast_coefficient`, `cold_size_reduction` |
| Bed, hydraulics (P, H) | `model.hydraulics.reference_sauter_diameter`, `swelling_pore_closure`, `gas_amplitude_max`, `gas_half_content`, `gas_relaxation_time`, `fines_layer_amplitude`, `fines_layer_time`, `viscosity_ln_a1`, `viscosity_ln_a2`, `viscosity_temperature_exponent`, `wetting_uptake` |
| Extraction (X) | `model.extraction.broken_shell_thickness`, `solute_apparent_density`; `model.species.{caffeine, trigonelline, cqa5, acids}.surface_fraction_scale`; `model.species.{trigonelline, cqa5, acids}.{diffusivity_80c, partition}` |
| Bean (B) | `model.bean.intraparticle_porosity_medium`, `intraparticle_porosity_roast_slope`, `extractable_roast_slope`, `extractable_robusta_increase`, `trigonelline.{arabica, robusta}_{light, dark}`, `cqa5_roast_change`, `cqa5_robusta_ratio`, `co2_grinding_loss`, `roast_index.colorette_{light, dark}` |
| Prep, basket (P) | `model.prep.sigma_ln_permeability.{none, tap, wdt}`, `sigma_fines_sensitivity`, `edge_multiplier.{base, paper, screen}`, `prewet_max`, `prewet_half_headspace`, `prewet_screen_reduction`, `prewet_jet_flow`; `model.bed.edge_area_fraction`; `model.basket.edge_reference_ratio`, `edge_ratio_exponent`, `open_area_fraction`, `pressurised_discharge_coefficient` |
| Machine, stop (M) | `model.machine.ideal_max_flow`, `ideal_max_pressure`, `vibratory_free_flow`, `vibratory_stall_pressure`, `ramp_time`, `group_headspace`, `drip_time_constant`; `model.stop.default_ratio` |
| Thermal (H) | `model.thermal.hardware_water_equivalent`, `coffee_heat_capacity_ratio`, `loss_time_constant`, `hardware_temperature`, `room_temperature` |

---

## 11. Presets and export

**Files.** `data/presets/<kind>/*.yaml`, each `schema: puckworks.preset-file/1` with one `kind` (`grinder_family`, `grinder`, `basket`, `machine`, `bean`) and a list of presets, validated against [`data/schema/preset.schema.json`](../../data/schema/preset.schema.json). Every preset carries `name`, `description`, `flags`, `notes` (shown to the user), `sources`, `evidence_grade`, `tag` and optional `registry_refs`. See [`data/presets/README.md`](../../data/presets/README.md).

**Export.** `python -m puckworks_tools.export` (later `puckworks-tools export`) validates the presets (schema, unique ids, family and default-basket references, registry ids, basket profiles, dose ranges, program rules, exactly one default bean) and the registry (as `validate-registry`), applies `data/calibration/current.yaml` if present (`schema: puckworks.calibration/1`, `parameters: {<registry id>: <value>}`; unknown ids, out-of-range values and non-finite metadata are errors, and so is calibrating an id the input models never read, which would be silently ignored, unless `--allow-unused-calibration` downgrades it to a warning and records it under `calibration.unused_by_builder`), checks that every id in `crates/puckmodel/registry-reads.txt` exists, and writes `crates/puckmodel/generated/presets.json` (`puckworks.presets/1`) and `registry.json` (`puckworks.registry/1`), one record per line. Registry records keep their provenance but drop `comment` and gain `default` and `default_from` (`value`, `prior`, `calibration`). `--check` fails if the committed files are stale. Sizes: registry 191 KB, presets 33 KB (about 29 KB and 8 KB gzipped).

---

## 12. Recipe fields added in M1

All optional (contract §6); listed in `recipe.rs` and the recipe schema.

| Field | Purpose |
|---|---|
| `bean.bean_temp_c` | bean temperature at grinding (f_T) and in the thermal node |
| `grinder.burr_diameter_mm`, `grinder.rpm` | recorded; no effect |
| `grinder.gap_at_ref_um`, `grinder.gap_per_unit_um` | dial calibration, or a dial from scratch with a family |
| `grinder.x50_gap_ratio`, `grinder.fines_at_340_pct` | κ_G and u_G (1–40%) for a specific grinder |
| `grinder.coarse_log_width`, `grinder.boulder_weight` | σ_c (0.1–1.0) and w_b (0–0.3) for a specific grinder |
| `grinder.psd.method` | measurement method of a measured PSD |
| `basket.custom.discharge_coefficient` | C_d of a pressurised orifice |
| `machine.pump` | a pump from scratch: `{"type": "ideal" \| "vibratory", …}` |
| `machine.headspace_ml` | group headspace above the basket rim |
| `machine.vent_headspace` | a three-way valve vents the group at the stop: no drip (default from the preset, else false) |
| `numerics.size_classes` | number of size classes (2–60, default 30) |

---

## 13. Limitations and open items

- **Calibration first.** The reference permeability, the gas and swelling mappings, the prep coefficients and the grinder dial mappings are placeholders for calibration (PLAN §7.3 K, §13 E1). The AMZCHEF presets in particular need the owner's shots.
- **Untested mechanisms.** The taper term of the edge multiplier, the CO₂ → permeability mapping and the confined-swelling closure have no direct data (grade D).
- **Drip.** The solver drains only the water above the puck after the stop (about 2 g for the generic recipe); a machine with a three-way valve (`machine.vent_headspace`) has none. Which presets have a valve is known only for E61 groups and levers.
- **PSD at the fine end and its basis.** Below X50 ≈ 220 µm no grinder's X50/gap relation was measured; the fines relation is supported down to X50 ≈ 60 µm. The model's Sauter diameter is 6–12% below measured dry laser values in the espresso range. The published espresso grinds (Smrke, Cameron, Corrochano ΨB–ΨE, Schmieder) have dry D32 ≈ 80–145 µm; Waszkiewicz 2026's 30 s grind has 47–50 µm and no particles above 182 µm. A reference permeability pooled from both kinds of evidence cannot make both give 30 s shots; which basis the permeability calibration should use is open (§5.2).
- **No measurement model** for PSD methods (wet vs dry laser, image, sieve): measured PSDs are used as given, with a caveat.
- **Not modelled in v1:** temperature narrowing of the PSD, static clumping and RDT (an in-puck aggregation state, 03 Implications A), process and staling effects, burr diameter and rpm, tamp force, a top paper, fines migration (switched off), PSD effects on ε.
- **Water** (module W) and the full species set are M2.
- **Solver interplay.** The builder emits full-resolution specs for tier 0 too; the solver coarsens. How the heterogeneity numbers act is the solver's (`docs/model/shot-model.md`).
