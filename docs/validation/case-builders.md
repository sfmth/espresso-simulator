<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M1 case builders: datasets as shot specs

*Puckworks M1 · workstream C · 2026-10-15.* The case builders (`python/puckworks_tools/cases/`) turn the
experimental conditions of each validation dataset into ShotSpecs ([M1 contract](../model/m1-contract.md))
and read the results back as the dataset's observables. The calibration harness
([calibration.md](calibration.md)) and the validation report ([m1-validation.md](m1-validation.md)) both use
them. The datasets and their licences are listed in [data/datasets/README.md](../../data/datasets/README.md).

## How a case is built

Each case is one experimental condition. It is built in two steps:

1. **The builder's spec.** A recipe without presets goes through `puckcore.build_shot_spec`. The recipe
   carries the paper's PSD (`grinder.psd`), basket (`basket.custom`), dose, program (`machine.profile`) and
   temperature. The builder's closures therefore see the paper's gear: permeability from the Sauter
   diameter, headspace, prewetting, heterogeneity, thermal masses. Registry defaults fill everything else.
   Calibrated parameters enter here, as recipe `overrides`.
2. **The paper's conditions.** `finalize` then sets the fields the paper reports, exactly:
   - basket geometry and dose;
   - size classes (equal widths in log diameter, each with its Sauter radius);
   - porosity, where a bed height or bulk density is reported;
   - water temperature, machine phases, pump and stop rule;
   - numerics tier.

`Case.build(values)` repeats both steps for any parameter values, so the calibration can vary registry
parameters through the builder. Each module also provides `observe(case, result)`, which maps a ShotResult
onto the dataset's observables.

### Shared conventions

| Item | Convention |
|---|---|
| 58 mm IMS precision basket (Schmieder BT702Th26.5M; Waszkiewicz B682TCH26.5E) | straight wall, 58.0 mm inner diameter, 26.5 mm deep; holes over a 54 mm floor. The papers give 58 mm and 26.5 mm; the slight taper near the floor is ignored. |
| VST 20 g basket (Cameron "20 g ridgeless"; Smrke) | straight wall, 58.5 mm, 25 mm deep (assumed; neither paper gives dimensions) |
| Pump | ideal (profiling) pump for every machine. The DE1, San Remo Opera, Sanremo Zoe (with regulator) and Black Eagle all hold a set pressure or flow. |
| Ramps | 1 s to the target pressure or flow. Schmieder's preinfusion starts at once, and its switch to the pour flow takes 4 s (the article's Fig. A2). |
| PSD from summary statistics | fines + boulders log-normal mixture. The fines mode is fixed at 40 µm (`psd.fines_mode`); the widths are the input models' σ = 0.6 (fines) and 0.35 (boulders). The fines weight and boulder median are solved to match the two statistics a paper reports (`common.bimodal_psd`). |
| Size classes | 16 classes at tier 1 (8 for the closure cases), between the 0.05% and 99.95% volume quantiles |
| Temperatures not reported | 93 °C (Waszkiewicz, Smrke) |

### Concentrations from a shot result

- **Fractions.** The mean concentration of a species in a beverage-mass window [m₀, m₁] is
  (S(m₁) − S(m₀))/(m₁ − m₀). Here S is the species' cumulative cup mass, interpolated in the beverage mass.
  For TDS, S = `tds_cup × beverage_mass`. This avoids differentiating noisy outlet series.
- **Flows.** Mass flows are the time derivative of the cup mass on a uniform grid.

## Calibration datasets

### V1 Schmieder 2023: `cases/schmieder2023.py`

Data: [schmieder2023-design](../../data/datasets/schmieder2023-design/), [-fractions](../../data/datasets/schmieder2023-fractions/),
[-kinetics](../../data/datasets/schmieder2023-kinetics/), [-replicates](../../data/datasets/schmieder2023-replicates/).

**Cases.** There are 15, one per experiment (nuisance group = grinding level `gl1_4`, `gl1_7` or `gl2_0`).

| Field | Value |
|---|---|
| dose | 20 g |
| basket | IMS 58 mm |
| PSD | fines + boulders mixture, D[4,3] equal to the wet value for the grinding level (273, 277, 295 µm), fines weight fixed at 25% |
| program | flow 7 mL/s until the pressure reaches 2.5 bar, then a 4 s linear ramp to the experiment's *measured* mean flow (Table 2) |
| pump | ideal, 8 mL/s, 12 bar |
| temperature | the measured brew temperature (Table 2) |
| stop | the end of the experiment's last fraction plus 3% (at least 62 g) |

**Observables.**
- The concentration of each analyte (trigonelline, caffeine, 5-CQA, TDS) in each analysed fraction of every
  replicate, over that fraction's own mass window. The window is mid-mass ± fraction mass/2, from Table S1.
- λ and c₀ fitted to those model fractions exactly as the authors fitted the data: unweighted c = c₀·exp(−m/λ)
  at the fractions' accumulated mid-masses.
- Cup masses at 20, 40 and 60 g, both directly from the cumulative series and by the authors' Eq. 3 (first
  fraction's mass × concentration, plus the integral of the fit). By default the calibration compares Eq. 3
  with Eq. 3, so model and data are processed identically.
- The peak inlet pressure over the whole shot, and over the pour phase (from the end of the transition ramp).

**Assumptions.**
- The article reports only D[4,3] and D[3,2] of its PSDs (wet). Its Fig. A1(a) shows the dry distributions
  but was not digitised (future work: it would replace the fines-weight judgement), so the fines weight is a
  judgement inside the 15–36% dry range of `psd.fines_fraction.dry`. The wet D[3,2] of about 27 µm reflects
  1–10 µm debris that a 40 µm fines mode cannot represent.
- The DE1 measures pressure between boiler and portafilter. Table 2's pressure is the mean of the per-shot
  *maxima*; this was checked against Table S3. So the model's peak inlet pressure is the comparable quantity.
  It is fitted with one permeability per grinding level, the V1 nuisance parameters.
- The switch from preinfusion to the pour flow follows the article's Fig. A2 (set flow 2 mL/s): the DE1's
  flow falls from 7 to 2 mL/s over about 4 s after the basket fills. The case ramps linearly over 4 s. The
  model cannot pass that flow: at the calibrated values its pump sits at the 12 bar limit for seconds during
  the switch in every experiment, and in some the pour reaches the limit too (the report lists the seconds),
  whereas the measured maxima are 2.5–9.3 bar (2.6–2.9 bar at 1 mL/s, just above the 2.5 bar exit). The
  model lacks the DE1's preinfusion control and the dry bed's water uptake and headspace filling. So the
  calibration compares only the pour-phase maximum, and flags pump-capped pours (calibration.md, "V1 peak
  pressure"). The 4 s ramp fits V1 better than a 1 s or 0.3 s ramp only while the pump saturates: with a
  0.3 s ramp the model's 1 mL/s maxima match the data, but the V1 cost is higher (the sensitivity table).
- Each case runs at its experiment's mean measured flow (Table 2). For experiment 15 the replicates differ
  (2.47, 2.85 and 3.01 mL/s; RSD 8%, the largest of the design), so its single mean-flow shot represents
  them less well than elsewhere.
- The coffee's extractable solids and its contents of caffeine, trigonelline and 5-CQA belong to this bean.
  They are nuisance parameters too. Only the kinetics are shared with the other datasets.

### V2 Vaca Guerra 2024: `cases/vacaguerra2024.py`

Data: [vacaguerra2024-rtd](../../data/datasets/vacaguerra2024-rtd/) (cited facts; the article is CC BY-NC-ND).

**Cases.** There are 5: distributions A–D after 30 g, and B after 60 g. The dry initial bed (Bo = 16.8) is
left out, because the model's single dispersion coefficient describes the wetted bed.

| Field | Value |
|---|---|
| bed | 59 mm cylinder, porosity set so the bed is 13.4 mm long, as in the authors' model |
| dose | from Table 1 |
| PSD | mixture matching the reported D[3,2] and coarse D[3,2] |
| program | flow control at the experiment's flow |
| temperature | 88 °C |
| tier | 0 |

**Observable.** The model's Bodenstein number Bo = v·L/D_ax:
- L is the model's bed height;
- v = Q/(A·ε) uses the experiment's flow and the model's porosity;
- D_ax is the spec's `hydraulics.axial_dispersion_m2_s`.

**Assumptions.**
- The 22 °C tracer dispersion is taken to hold for hot beds (research note 01 §4.8).
- The reconstructed PSD under-predicts the reported D[4,3]. It does not enter the observable.

### V4 Waszkiewicz 2026 Q(P): `cases/waszkiewicz2026.py`

Data: [waszkiewicz2026-flow-pressure](../../data/datasets/waszkiewicz2026-flow-pressure/), [-flow-transient](../../data/datasets/waszkiewicz2026-flow-transient/),
[-tds](../../data/datasets/waszkiewicz2026-tds/), [-psd](../../data/datasets/waszkiewicz2026-psd/).

**Cases.** There are 11, one per pressure group.

| Field | Value |
|---|---|
| dose | 18.5 g |
| basket | IMS 58 mm, porosity set so the dry bed is 14 mm high (as measured) |
| PSD | the measured Mastersizer distribution (mean of three samples) |
| program | pressure control at the group's long-time *basket* pressure (pump pressure minus the group's measured loss aQ² + bQ + c), 1 s ramp |
| temperature | 93 °C (assumed) |
| stop | 130 s, enough for the 100 s data window after the pressure rise |

**Observables.**
- The cup mass flow, smoothed like the authors' (Savitzky–Golay, order 1, 3 s).
- The long-time flow, at t = 100 s on the data clock. The data clock starts when the pressure rise ends;
  the model's clock is shifted by the time its inlet pressure first reaches 95% of the target.
- The transient on the data grid.
- The TDS of consecutive 5 s fractions counted from the model's first drops. The authors put the TDS clock
  8 s after the flow clock's zero, near the first drops at 9 bar.

**Assumptions.**
- The basket pressure varies by about 0.14 bar within a shot as the flow changes. The model holds it at
  its long-time value.
- The temperature is not reported.

### V6 Corrochano 2017: `cases/corrochano2017.py`

Data: [corrochano2017-permeability](../../data/datasets/corrochano2017-permeability/), [-psd](../../data/datasets/corrochano2017-psd/),
[-properties](../../data/datasets/corrochano2017-properties/) (cited facts from the thesis).

**Cases.** There are 12: grinds ΨB–ΨE at 360, 400 and 480 kg/m³.

| Field | Value |
|---|---|
| cell | 37.4 mm cylinder (1.1×10⁻³ m²); the bed fills 20 cm³, so the dose (7.2, 8.0, 9.5 g) fixes the bulk density |
| bed | skeletal density 1337 kg/m³ and particle porosity 0.57 (Blend 1), intergranular porosity from the bulk density |
| PSD | mixture matching the dry fines share and X50 (Table 4.1) |
| permeability | the builder's κ₀ × [KC(ε)/KC(ε_builder)]^α, with KC(ε) = ε³/(1 − ε)² and α the closure exponent `hydraulics.kozeny_carman.density_exponent` (a case parameter) |
| program | pressure control at 3 bar for 600 s |
| temperature | 80 °C |
| tier | 0 |

**Observable.** The effective permeability κ = Q·μ·L/(A·ΔP) at 600 s. Q is the outflow, ΔP the inlet
pressure, L the model's bed height and μ = 0.355 mPa·s (water at 80 °C). V6 compares κ(ρ)/κ(360 kg/m³)
within each grind.

**Assumptions.**
- The beds were fully extracted (10 min at 80 °C). The 600 s run is meant to reproduce that state through
  the solver's dissolution and compaction closures.
- The thesis derived κ from Darcy fits over 0.5–4.5 bar using the consolidated bed length. The model uses
  one pressure and its own bed height.
- Plain relative Kozeny–Carman with the measured initial densities predicts κ(480)/κ(360) ≈ 0.05 against the
  measured 0.26–0.35. Loose beds consolidate more (up to 31%), so α < 1 is expected.

## Held-out datasets

### V3 Cameron 2020: `cases/cameron2020.py`

Data: [cameron2020-ey-grind](../../data/datasets/cameron2020-ey-grind/), [-psd](../../data/datasets/cameron2020-psd/),
[-two-class](../../data/datasets/cameron2020-two-class/) (cited facts; figures read from the PDF's vector graphics).

**Cases.** There are 7, at grind settings 1.1–2.3.

| Field | Value |
|---|---|
| dose | 20 g |
| basket | VST 20 g |
| PSD | the Fig. 2B curves (GS 1.0, 1.5, 2.0, 2.5), interpolated linearly in grind setting (the authors interpolated their table the same way); `psd="two_class"` uses the supplement's two classes as printed instead |
| program | 6 bar pressure control |
| temperature | 92 °C |
| stop | 40 g |

**Observables.** EY and shot time at the stop.

**Held out.** Only the shared calibrated parameters enter, as recipe overrides. Permeability and
heterogeneity come from the builder's closures for the paper's PSD.

### V4 transient: `cases/waszkiewicz2026.py`

The 9-bar case of the V4 block, with the calibrated poroelastic scale and Waszkiewicz permeability. The
flow transient and the TDS fractions are not fitted.

### V5 Smrke 2024: `cases/smrke2024.py`

Data: [smrke2024-psd](../../data/datasets/smrke2024-psd/), [smrke2024-shots](../../data/datasets/smrke2024-shots/)
(digitised from the CC BY figures).

**Cases.** There are 15 ground samples: six burr gaps, plus 1, 2 or 4 g of sieved fines at 190, 210 and 250 µm.

| Field | Value |
|---|---|
| dose | 20 g in every case (added fines replace coffee) |
| basket | VST 20 g |
| PSD | mixture matching the measured X50 and share below 100 µm (Camsizer, Fig. 2) |
| program | 9 bar pressure control |
| temperature | 93 °C (assumed) |
| stop | 40 g |

**Observables.** Shot time and EY.

**Assumption.** Camsizer sizes are projected-area equivalent diameters. They are used as given.

## Validity

`common.spec_problems` checks each spec:
- against `data/schema/shot-spec.schema.json` once workstream A publishes it;
- for unknown fields against the builder's own output;
- for non-finite numbers;
- optionally, for acceptance by the core's strict parser.

`python/tests/test_cases.py` builds every case, checks it and simulates it on the current build.
