<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Shot model: from first water to the cup

*puckcore 0.3.0 · Milestones M1 and M1.1 · Last updated 2026-10-15.*

This is the specification of `puckcore::shot::simulate_shot`, the M1 shot solver behind `simulateShot` (JavaScript) and `puckcore.simulate_shot` (Python). It implements §4 of the [M1 contract](m1-contract.md) for both fidelity tiers, as modules H and X of [PLAN §7.3](../PLAN.md#73-modules).

M1.1 adds an explicit dry-pore water budget and a locally timed pore-air permeability closure. These are an **effective single-liquid approximation**, with estimated startup parameters, not a resolved two-phase or kinetic dual-porosity model. Existing raw shot specs retain their legacy defaults; recipe-built specs enable the new closure through the registry. The [startup decision](../decisions/0010-startup-water-and-pore-air.md) records its assumptions. Validation thresholds remain unchanged; see the [validation report](../validation/m1-validation.md) for held-out results.

**Code** (all in `crates/puckcore/src/shot/`):

| file | contents |
|---|---|
| `spec.rs`, `result.rs` | the contract types (`ShotSpec`, `ShotResult`); their doc comments define every field |
| `validate.rs` | spec validation: a plausibility range for every number, bounded model size and step count; every error names the field by its dotted path |
| `geometry.rs` | exact volumes and Darcy integrals of a piecewise-linear wall profile; depth cells |
| `model.rs` | the discretised model: columns, cells, size classes, kernel grids, species, tier 0 |
| `props.rs` | water viscosity and density, extract density and viscosity, Kozeny–Carman, the poroelastic law, Stokes–Einstein, the Bernoulli function, the normal distribution and its quantiles |
| `hydraulics.rs` | the bed's flow law and the operating point of program, pump and bed |
| `transport.rs` | the coupled implicit step of bed liquid, surface pools and kernels |
| `sim.rs` | state, machine program, events, the time loop and the outputs |

Schemas: [`data/schema/shot-spec.schema.json`](../../data/schema/shot-spec.schema.json) and [`shot-result.schema.json`](../../data/schema/shot-result.schema.json). Measurements: `cargo test -p puckcore --release -- --nocapture` and `cargo run --release -p puckcore --example shot_report` (every table of §8–§9). The findings of the independent review are pinned by `tests/shot_regressions.rs`.

**Notation.** Depth z is measured down from the bed top (inlet, z = 0) to the floor (z = L); height h = L − z up from the basket floor. ε is the intergranular porosity, ε_p the intraparticle porosity, ρ_s the skeletal density. Concentrations are kg/m³. Columns are indexed i, depth cells j, size classes k, kernel shells l.

---

## 1. What happens in a shot

1. **Headspace fill.** The pump fills the headspace — the basket volume above the bed plus `basket.extra_headspace_m3` — at zero pressure (the air escapes through the dry puck).
2. **Wetting.** Water then infiltrates each column behind a sharp front. The wetted part resists flow; the dry part ahead of the front is at atmospheric pressure. Extraction starts in each cell as the front enters it.
3. **First drops.** A column drips once its front reaches the floor. `summary.first_drops_s` is the earliest such time, interpolated within the step.
4. **Extraction.** Every size class has a fast broken-cell surface pool and a slow intact kernel. They feed the bed liquid, which flows to the cup with axial dispersion. Viscosity, porosity, temperature, compaction, swelling, gas and fines change the flow as the shot goes on.
5. **Stop and drip.** The stop rule stops the pump. The water left in the headspace then drains through the puck under an inlet pressure that decays as P_stop·e^{−t/τ} (`machine.stop.drip_tau_s`), for 8τ or until that water is gone. A machine that vents the headspace (`machine.stop.vent_headspace`, a three-way solenoid valve) does not drip. The reported beverage mass includes the drip.

---

## 2. Parameters: equations, spec fields and registry ids

Defaults are the registry's central values where an entry exists (the centre of a uniform prior, the mode of a triangular one, or the recorded value). `puckmodel` supplies the real values for each recipe. Registry ids refer to `data/params/*.yaml`.

| symbol | meaning | spec field | default | registry id / basis |
|---|---|---|---|---|
| r(h) | basket wall profile | `basket.profile_m` | 29 mm radius, 25 mm deep | `bed.basket.area_58mm` (2.64e-3 m²) |
| r_perf, f_open | perforated radius, open fraction | `basket.perforated_radius_m`, `basket.open_area_fraction` | 27 mm, 1 | — |
| d_o, C_d | pressurised orifice | `basket.outlet` | holes | — |
| V_x | headspace above the rim | `basket.extra_headspace_m3` | 5 mL | — |
| M | dose | `bed.dose_kg` | 18 g | `shot.dose.double`, `shot.dose.cafe` |
| ε₀ | intergranular porosity | `bed.intergranular_porosity` | 0.17 | `bed.porosity.intergranular` (mode) |
| ε_p | intraparticle porosity | `bed.intraparticle_porosity` | 0.56 | from `bed.porosity.total` (0.635, "well constrained") and ε₀: (0.635 − 0.17)/0.83, i.e. from the dry bulk density; Corrochano, who measured K, takes the swollen envelope equal to the dry one |
| ρ_s | skeletal density | `bed.skeletal_density_kg_m3` | 1352 kg/m³ | `bed.density.skeletal` (centre of 1304–1400) |
| a_k, x_k | class radii and solid-volume shares | `bed.size_classes` | 20 µm (25.5%), 175 µm (74.5%) | `psd.fines_mode` (40 µm diameter), `psd.fines_fraction.dry` (centre of 15–36%), `psd.two_class.boulder_radius.espresso_range` (centre of 100–250 µm) |
| n_col | parallel columns | `bed.heterogeneity.columns` | 8 | PLAN §7.2 |
| σ | spread of ln κ over the inner columns (conditional-mean strata, §3) | `bed.heterogeneity.sigma_ln_permeability` | 0.2 | — (`bed.heterogeneity.two_path_delta_lee2023` implies ≈ 0.7 for a two-path model) |
| f_e, m_e | edge annulus share and multiplier | `bed.heterogeneity.edge_area_fraction`, `.edge_multiplier` | 0.25, 1 | — (`bed.heterogeneity.edge_centre_ey_ratio.*` are calibration targets) |
| σ_pw | pre-wetting non-uniformity | `bed.heterogeneity.prewet_nonuniformity` | 0 | — |
| E_max | extractable fraction | `solubles.extractable_fraction` | 0.28 | `extraction.max_yield` (centre of 22–34%) |
| δ | broken-cell shell thickness | `solubles.cell_size_m` | 30 µm | one cell (note 01 §5.1); `extraction.surface_pool_fraction.geometric` |
| c_sat | saturation | `solubles.saturation_kg_m3` | 245 kg/m³ | `extraction.saturation.lumped` (centre of 210–280) |
| K | partition coefficient, c_liquid/C_s with C_s per particle envelope volume (§5.3) | `solubles.partition_coefficient` | 0.61 | `extraction.partition.lumped_80c` (Corrochano 2017, eq. 3.15–3.17) |
| — | kernel loading cap (§5.3) | `solubles.kernel_loading_cap` | on | modelling assumption beyond the data |
| D_ref | kernel diffusivity at T_ref | `solubles.kernel_diffusivity_m2_s` | 1.26e-10 m²/s | `extraction.diffusivity.lumped.corrochano_80c` |
| T_ref | reference temperature of D | `solubles.reference_temp_c` | 80 °C | the condition of that entry |
| k_s | surface dissolution coefficient | `solubles.surface_rate_m_s` | 1e-3 m/s | `extraction.surface_rate.grudeva2026` |
| v̄ | apparent specific volume of solutes | `solubles.solute_specific_volume_m3_kg` | 6.4e-4 m³/kg | 25% w/w ≈ 275 kg/m³ at density 1.10 (note 01 §4.10; `hydraulics.extract_density.low_temperature`) |
| w_s, D_s, K_s, s_s | tracked species | `solubles.species[]` | none | `bean.composition.*`, `extraction.diffusivity.*`, `extraction.partition.caffeine` (set by `puckmodel`) |
| κ₀ | bare base permeability | `hydraulics.permeability_m2` | 2.4e-14 m² | `hydraulics.permeability.reference`: bare κ₀ at the reference Sauter diameter, to be calibrated (ADR 0009) |
| P_c | poroelastic saturation pressure | `hydraulics.poroelastic_pc_pa` | 12 bar | `hydraulics.poroelastic.critical_pressure` |
| — | dissolution Kozeny–Carman on/off | `hydraulics.dissolution_kozeny_carman` | on | note 01 §4.11 |
| A_sw, τ_sw | swelling | `hydraulics.swelling` | 0, 26 s | `hydraulics.swelling.relaxation_time` (centre of 19–33 s); amplitude off by default (§4.2) |
| A_g, τ_g | gas | `hydraulics.gas` | 0, 5 s | — (`hydraulics.gas.potential_volume_ratio` is a candidate scale for `puckmodel`) |
| A_air, τ_air, n_air | dry-pore connectivity penalty | `hydraulics.pore_air`, `.pore_air_permeability_exponent` | raw: off, n = 1; recipe: A = 0.5, n = 3, τ = (D32/2)²/(π² D_water), capped at 600 s | `model.hydraulics.pore_air_amplitude`, `.pore_air_permeability_exponent`, `.moisture_diffusivity`; grade D mapping |
| A_f, τ_f | fines layer | `hydraulics.fines_layer` | 0, 10 s | — |
| D_ax | axial dispersion | `hydraulics.axial_dispersion_m2_s` | 5e-6 m²/s | `extraction.dispersion.axial_coefficient` |
| a1, a2, γ | extract viscosity | `hydraulics.viscosity` | 4.2, 11.8, 0.45 | a1, a2 fit Moreno 2015 (4 °C); γ gives 2.24 at 25% w/w, the centre of `hydraulics.viscosity.extract_relative` (1.5–3) |
| u_w | legacy mobile share / particle-loading capacity normalisation, 0–0.9 (§5.1) | `hydraulics.wetting_uptake` | 0.5 | `model.hydraulics.wetting_uptake` (D) |
| f_water | water-filled share of intraparticle porosity | `hydraulics.intraparticle_water_fraction` | raw: null → u_w; recipe: 1 | `model.hydraulics.intraparticle_water_fraction`; when set, u_w normalises particle loading, not a second solvent inventory (§5.1) |
| θ | dissolved volume that becomes intergranular | `hydraulics.dissolution_porosity_share` | null = 0 (§5.5) | `hydraulics.dissolution_porosity_share` (triangular 0/0/1, mode 0); Lee 2023 (θ = 1, upper bound) |
| T_w | brew water temperature | `thermal.water_temp_c` | 92 °C | `shot.temperature` (centre of 88–96) |
| T₀ | initial bed temperature | `thermal.initial_bed_temp_c` | 70 °C | — |
| C | lumped heat capacity | `thermal.heat_capacity_j_k` | 150 J/K | — |
| h | heat loss | `thermal.heat_loss_w_k` | 0.5 W/K | — |
| T_a | ambient temperature | `thermal.ambient_temp_c` | 25 °C | — |
| — | program, pump, stop | `machine` | 9 bar, 2 s ramp, 8 mL/s limit; ideal pump 8 mL/s / 12 bar; stop at 36 g; drip τ = 1 s; no vent | `shot.pressure` (9 bar) |
| — | numerics | `numerics` | tier 1, 30 cells, Δt ≤ 0.05 s, 8 shells | §7 |

Fixed constants (not spec fields): water heat capacity c_w = 4200 J/(kg K) (within 0.3% of IAPWS-95 over 60–100 °C); hole discharge coefficient 0.61 (sharp-edged orifice); stall threshold 0.01 mL/s and a tenth of the demanded flow, for 5 s; mass-event tolerance 0.1 mg; drip length 8τ.

### 2.1 Plausibility bounds

Every number has a range (`validate.rs`; the same bounds are in the JSON Schema, and `tests/shot_schema.rs` pushes every bounded value just outside its bound and checks that validation rejects it, naming that field). The ranges are wide enough for any espresso equipment and recipe and narrow enough that the numerics hold: no overflow, no loss of the M-matrix structure, a bounded state and a bounded number of steps. The main ones:

| quantity | range |
|---|---|
| dose; porosities; skeletal density | 1 g–1 kg; 0.01–0.95; 500–3000 kg/m³ |
| particle radius; shell δ; extractable fraction | 0.1 µm–5 mm; 0–1 mm; 0–0.6 |
| c_sat; K; D; k_s | 1–2000 kg/m³; 0.01–100; 1e-16–1e-7 m²/s; 0–1 m/s |
| κ₀; P_c; D_ax; σ | 1e-18–1e-10 m²; 1e4–1e8 Pa; 0–1e-3 m²/s; 0–3 |
| fines amplitude; relaxation τ; drip τ | 0–100; 0–600 s; 0–60 s |
| pressures; flows; times; beverage targets | ≤ 200 bar; ≤ 100 mL/s; ≤ 3600 s; ≤ 10 kg |
| loading-capacity normalisation u_w | 0–0.9 (keeps the reference particle capacity ε_p(1 − u_w) positive) |
| intraparticle water fraction; pore-air amplitude; exponent | 0–1 or null; [0,1); 1–10 |
| max_dt; steps; output points | ≤ 0.5 s; (max_duration + 8τ_drip)/min(Δt_max, Δt_out) ≤ 2e6; output values ≤ 1e7 |
| model size | columns × cells × classes × (shells + 1) × (1 + species) ≤ 1e7; snapshots × columns × cells ≤ 1e6 |
| total work | steps (as above) × model size ≤ 1e10, about 30 s natively at the measured 1.5–6 ns per value and step; above 1e9 validation warns |
| liquid water content | v̄·max(c_sat, K·s₀) < 0.9: the liquid's bound (§5.4) must leave it water; K·s₀ > c_sat warns that the liquid can exceed saturation |

Beyond validation, a run fails with `ShotError::Numerical` instead of panicking when a factorisation meets a non-positive pivot or a non-finite value; when a step's regimes do not converge even after twelve halvings of the step (§7.2); when the soluble mass balance error exceeds 1e-6 (three orders above the warning threshold of 1e-9; within the bounds round-off stays near 1e-10, §7.3); when a concentration falls below −1e-3 of the concentration scale max(c_sat, u₀) (a broken solve; the warning threshold is −1e-9); or when the liquid reaches v̄·c ≥ 0.95, where it would hold almost no water (validation and the bound of §5.4 exclude this; the check makes sure the water content never clamps silently).

---

## 3. Geometry and the bed

**Bed.** The dose fills the basket from the floor until its volume is

$$V_\text{bed}=\frac{M}{(1-\varepsilon_0)(1-\varepsilon_p)\rho_s}.$$

The bed height L solves ∫₀^L π r(h)² dh = V_bed (bisection to the last bit). A dose that does not fit is rejected with an error naming `bed.dose_kg`. The headspace is V_hs = V_basket − V_bed + V_x (`summary.headspace_m3`).

**Exact integrals.** Between profile points r(h) is linear, so each piece is a frustum:

$$V=\frac{\pi\,\Delta h\,(r_a^2+r_ar_b+r_b^2)}{3},\qquad \int\frac{dh}{\pi r^2}=\frac{\Delta h}{\pi r_ar_b}.$$

Both are exact; the second also holds for r_a = r_b. Cells are equal in thickness Δz = L/J; their volumes and their ∫dz/A are summed over the profile pieces they cut. Straight, tapered and stepped baskets are all exact.

**Columns.** The columns are radial annuli of the real geometry. Column i takes a fixed share f_i of the cross-section at every height, so A_i(z) = f_i A(z) varies with depth in a tapered basket. Each annulus follows the wall like a stream tube, and the columns do not exchange liquid.
- **Edge annulus.** The outer annulus takes f_e = `edge_area_fraction` and the multiplier m_e = `edge_multiplier`. With f_e = 0 there is no edge column.
- **Inner annuli.** They share 1 − f_e equally and carry stratified log-normal multipliers. Each is an equal-probability stratum [z_k, z_{k+1}] of the standard normal, z_k = Φ⁻¹(k/n), represented by its conditional mean of the unit-mean multiplier e^{σ′Z − σ′²/2}:

  $$m_k=n\,\big[\Phi(z_{k+1}-\sigma')-\Phi(z_k-\sigma')\big],$$

  which telescope to a mean of exactly 1 and keep the distribution's tails (Φ: Abramowitz & Stegun 7.1.26; Φ⁻¹: Acklam). The midpoint quantiles used before represented the tails poorly: EY moved by 2.1% between 8 and 64 columns at σ = 0.7, now by 0.2% (§8). The strata are laid out from the centre outward in golden-ratio order, so permeability has no radial trend. Pre-wetting non-uniformity widens the spread: σ′ = √(σ² + σ_pw²).
- **One column, or one inner column.** A single column carries the area-weighted multiplier (1 − f_e) + f_e m_e; with two columns and an edge, the one inner column has multiplier 1. A spread then cannot be represented, and the solver warns (`bed.heterogeneity.columns` ≥ 3 with an edge).
- **Outputs.** `spatial.columns` reports each annulus's radii at the floor, its share and its multiplier. Column i spans radii r(h)√F_{i−1} to r(h)√F_i at height h, where F_i is the cumulative share, so A_i(z) = f_i·A(z).

**Particles.** Class k has radius a_k and solid-volume share x_k, renormalised to sum to 1. Its particle (envelope) volume per bed volume is φ_k = (1 − ε₀)x_k, and its outer surface per bed volume is b_k = 3φ_k/a_k.

---

## 4. Hydraulics

### 4.1 Darcy series resistance

The wetted part of column i has the resistance

$$R_i=\int_0^{z_f}\frac{\mu(z)\,dz}{\kappa_i(z)A_i(z)}=\sum_j\frac{\mu_j\,g_j}{f_i\,\kappa_{ij}},\qquad g_j=\int_\text{cell j}\frac{dz}{A}.$$

The front cell contributes its exact partial integral, from its top to the front. A column that drips adds the fines layer R_f (§4.3). The viscosity μ_j is the local one (§4.4), so the resistance varies along the column.

### 4.2 Permeability closure

$$\kappa_{ij}=\kappa_0\;m_i\;\frac{\mathrm{KC}(\varepsilon_{ij})}{\mathrm{KC}(\varepsilon_0)}\;f_\text{sw}(t-t_{w,ij})\;f_\text{gas}(t-t_{w,ij})\;f_\text{air}(t-t_{w,ij})\;f_\text{poro}(\Delta P_i),\qquad \mathrm{KC}(\varepsilon)=\frac{\varepsilon^3}{(1-\varepsilon)^2}.$$

- **κ₀** is calibrated, never predicted from the size distribution (PLAN §6 #2).
- **Kozeny–Carman** enters only as a relative factor, through the local porosity of §5.5. With the default θ = 0 the porosity does not change, so the factor stays 1; `dissolution_kozeny_carman = false` turns it off for any θ.
- **Swelling and gas** depend on the time since the cell wetted, t_w:
  - swelling: f_sw = 1 − A_sw(1 − e^{−t/τ_sw});
  - gas: f_gas = 1 − A_g e^{−t/τ_g}.

  Both amplitudes must be in [0, 1). τ = 0 makes the change immediate.
- **Dry-pore air** is separate from roast-dependent CO₂. The effective connectivity factor is

  $$f_\text{air}(a)=\left[1-A_\text{air} e^{-a/\tau_\text{air}}\right]^{n_\text{air}},\qquad a=\max(0,t-t_w).$$

  A_air ∈ [0,1), n_air ∈ [1,10]; A_air = 0 or τ_air = 0 disables the penalty. Dry cells do not age merely because the pump clock runs. Wet cells continue to relax during a soak. This factor describes hydraulic connectivity, **not a literal gas saturation**; it neither creates water nor subtracts pore volume. Its eventual value is 1, so it does not change the bare late-time permeability. Recipe defaults and their broad priors are in `data/params/startup.yaml`. The diffusion-time mapping from moisture diffusivity and a representative particle radius is an estimate; no startup coefficient was selected against the held-out flow curves.
- **Why swelling defaults to 0.** The registry's swelling is a diameter increase (`hydraulics.swelling.diameter_increase`, 0–15%), not a permeability factor. In a confined bed, Kozeny–Carman turns even a 2% diameter increase (ε 0.17 → 0.12) into a 70% permeability loss, so mapping one onto the other needs a confined-swelling closure that no data constrain. The amplitude is a calibration parameter.

**Poroelastic factor (Waszkiewicz et al. 2026).** The flow through a bed with pressure drop ΔP is Q = Φ(ΔP)/R, where R is the Darcy resistance without compaction and

$$\Phi(\Delta P)=\Delta P\,f(x),\quad x=\frac{\Delta P}{P_c},\qquad f(x)=\frac{1-(1-x)^4}{4x}=1-\tfrac32x+x^2-\tfrac14x^3\ (x<1),\qquad f(x)=\frac{1}{4x}\ (x\ge1).$$

**Verified** (unit test `poroelastic_law_reproduces_the_waszkiewicz_curve`): Q/Q_c = Φ(ΔP)/Φ(P_c) equals 1 − (1 − x)⁴ to 1e-14 for 0 ≤ x ≤ 1. Here Q_c = P_c/(4R), and the flow saturates beyond P_c.
- f(0) = 1, and f and f′ are continuous at x = 1.
- The polynomial form has no cancellation at small x.
- dΦ/dΔP = (1 − x)³ ≥ 0, so the flow law is monotone.

ΔP is the pressure drop across the column: P_in for a column still wetting, and P_in − P_floor for one that drips. The factor applies to the whole column, including the fines layer. `poroelastic_pc_pa = null` gives Φ(ΔP) = ΔP.

### 4.3 Fines layer and outlet

- **Fines.** A dripping column gains the outlet resistance R_f = A_f R_i⁰ (1 − e^{−t/τ_f}), with t counted from its first drops. R_i⁰ is its fully wetted resistance with water at T_w and the initial porosity.
- **Outlet.** All dripping columns drain through one outlet with ΔP = aQ_out². Each orifice adds ρ_w/(2C_d²A²):
  - the floor holes when f_open < 1: A = f_open π r_perf², C_d = 0.61;
  - a pressurised (dual-wall) orifice: A = πd_o²/4 with its own C_d.

### 4.4 Viscosity and densities

- **Water viscosity.** Kestin, Sokolov & Wakeham (1978), valid −8 to 150 °C:

  $$\log_{10}\frac{\mu_w(T)}{\mu_{20}}=\frac{(20-T)\,[1.2378-1.303\times10^{-3}(20-T)+3.06\times10^{-6}(20-T)^2+2.55\times10^{-8}(20-T)^3]}{96+T},\quad \mu_{20}=1.002\ \text{mPa s}.$$

  It gives 0.3551, 0.3151 and 0.2978 mPa s at 80, 90 and 95 °C. That is within 0.3% of the registry's CRC values (`hydraulics.viscosity.water_80c`/`_90c`/`_95c`: 0.354, 0.315, 0.298) and within 0.2% of IAPWS 2008.
- **Extract viscosity.** μ = μ_w(T)·exp(γ(a1 w + a2 w²)), where w = c/ρ(c) is the solute mass fraction.
- **Densities.**
  - Liquid: ρ(c) = ρ_w(1 − v̄c) + c.
  - Water: ρ_w is from Kell (1975) at T_w (965.3 kg/m³ at 90 °C).
  - Thermal expansion inside the bed is neglected. The liquid density only converts outflow volume into beverage mass, and concentration into TDS (w/w).

### 4.5 The bed's flow law

The columns share the inlet pressure. Wetting columns drain into the dry bed at atmospheric pressure; dripping columns share the floor pressure:

$$Q_\text{bed}(P)=G_w\,\Phi(P)+y(P),\qquad y=G_t\,\Phi(P-a\,y^2),\qquad G_{w,t}=\sum_{\text{wetting, dripping}}\frac1{R_i}.$$

- y is the outflow through the dripping columns. It is unique, because the left side increases and the right side decreases.
- Without compaction it has the closed form y = 2G_tP/(1 + √(1 + 4aG_t²P)). Otherwise it is found by a bracketed Illinois iteration.
- Q_bed increases monotonically in P. The column flows follow, and so does P_floor = a y².
- The instant a front enters the bed, its resistance is floored at that of a 1e-6·L layer, which keeps it finite.

### 4.6 Program, pump and operating point

The program and the pump deliver at most S(P), which never increases with P, below a pressure cap P_cap. The operating point is the intersection of Q_bed with S below the cap, or the cap itself. The flow is always the bed's flow at the chosen pressure.

| control | S(P) | P_cap |
|---|---|---|
| `pressure {target}` | min(limit, ideal max flow, pump curve) | min(ramped target, ideal max pressure or min(P_stall, OPV)) |
| `flow {target}` | min(ramped target, ideal max flow, pump curve) | min(limit, ideal max pressure or min(P_stall, OPV)) |
| `pump_full` | min(ideal max flow, pump curve) | ideal max pressure or min(P_stall, OPV) |
| drip | ∞ | P_stop e^{−(t − t_stop)/τ} while headspace water is left, else 0 |

- **Vibratory pump.** The curve is Q_free(1 − P/P_stall); an over-pressure valve caps P at `opv_pa`. An ideal pump has no curve.
- **Ramps.** The target moves linearly over `ramp_s`. It starts from the value of the controlled quantity when the phase starts: 0 for the first phase, then the achieved pressure or flow.
- **Headspace fill.** While the headspace fills, the pressure is 0. The pump then delivers S(0) if the instantaneous command permits positive pressure and flow. Its delivered volume is integrated exactly over a flow ramp, splitting at the ramp end and pump-flow cap. A scalar root lands on the full-headspace event; excess delivery is never discarded by clamping the volume. This remains a sequential, vented-headspace approximation. It does not yet resolve simultaneous ponding/infiltration or compressible headspace pressure.
- **Drip.** After the stop the bed flow drains the water held in the headspace (all of it when the headspace was full). The drip ends when that water is gone (steps land on the moment), after 8τ, or at once with `vent_headspace`. Its size is set by the headspace water and by the poroelastic law: as the pressure decays the bed decompresses, so the flow falls more slowly than the pressure (Q ∝ 1 − (1 − ΔP/P_c)⁴). The decompression shapes the drip; the headspace water is its source.

### 4.7 Wetting front

The front in column i advances as its wetted bed volume W_i grows:

$$\frac{dW_i}{dt}=\frac{Q_i}{\phi_T},\qquad \phi_T=\varepsilon_0+(1-\varepsilon_0)\,\varepsilon_p\,f_\text{water},$$

where f_water is `intraparticle_water_fraction`, or u_w when that option is null (§5.1). The same φ_T enters the liquid holdup and thermal capacity. With f_water = 1 the pump must supply all initial pore water; it is not enough to change only the front speed, which would concentrate solute into an under-counted holdup.

Tracking volume rather than position keeps tapered baskets exact. The front depth inside its cell comes from inverting the exact frustum volume.
- **First drops.** A column drips once W_i reaches its volume. Its outlet flow in that step is the share of the step after the crossing.
- **Wetting time.** Under constant flow Q with one column, the first drops come at (V_hs + φ_T V_bed)/Q exactly (verified to 2.8e-15, §8).

---

## 5. Extraction

### 5.1 Inventories

The solubles, E_max of the dry dose, are spread uniformly through the solid: s₀ = E_max ρ_s (1 − ε_p) per particle (envelope) volume.

**Liquid volume and particle loading.** The liquid holdup is H = ε + (1 − ε₀)ε_p f_water. Recipe-built M1.1 specs use f_water = 1, filling the total initial porosity ε_T = ε₀ + (1 − ε₀)ε_p. Particle states retain the reference capacity ε_c = ε_p(1 − u_w), but are interpreted as **effective soluble loadings**, not another physical water inventory. Water is counted only in H. This approximation makes the intraparticle water locally accessible to the liquid continuum while retaining diffusive particle loading; it does not resolve an immobile water reservoir, finite-rate water ingress, or a measured saturation field. Increasing H also changes dilution, residence time and extraction kinetics, so the extraction fit must be reassessed. Water-volume conservation does not establish the accuracy of this approximation.

**Legacy mode.** With `intraparticle_water_fraction = null`, f_water = u_w and the previous equations are recovered. M1 described ε_c as a fully filled second liquid without charging the pump for that water; that interpretation was not a complete startup water budget. The null option preserves numerical compatibility, not a claim that all dry pores have been filled.

Each particle of class k splits into two loading states:
- **Surface pool.** The broken-cell shell of thickness δ, a volume share f_s = 1 − ((a − δ)/a)³ (f_s = 1 when a ≤ δ). It holds S = f_s φ_k s₀ per bed volume with reference capacity V_p = ε_c f_s φ_k. Its concentration-equivalent loading is c_pool = S/V_p, initially s₀/ε_c.
- **Kernel.** The intact sphere of radius a_k = a − δ, with concentration-equivalent loading u(r), initially u₀ = s₀/ε_c. Its mass per bed volume is σ Σ_l Ṽ_l u_l, with σ = 3φ_k ε_c (a_k/a)³. Kernel release does not depend on the normalisation ε_c: σ u and the boundary value scale together.

**What u_w means.** u_w (`wetting_uptake`, 0–0.9) retains the M1 loading-capacity normalisation. In legacy mode it also sets water uptake, holdup and front speed. With an explicit f_water those water quantities are independent of u_w; its remaining influence is the effective surface-pool capacity. The cap at 0.9 keeps that capacity positive. The M1 sensitivity figures in §8–§9 refer to legacy mode, not a calibrated assessment of the new startup approximation.

### 5.2 Surface pool: saturating flux (Grudeva form)

$$\frac{dS}{dt}=-k_s\,b_k\,\big(\min(c_\text{pool},c_\text{sat})-c\big).$$

- **Initial state.** The pool starts above saturation (s₀/ε_c = 595 kg/m³ against c_sat = 245 with the defaults). It first dissolves at the saturated rate k_s b(c_sat − c), then decays exponentially once c_pool falls below c_sat.
- **Reverse flux, capped.** If the liquid exceeds the pool's level, solute returns to the pool, but never beyond the pool's initial content S₀: no additional solute is parked beyond the original loading. In backward Euler the cap is the loss max(L(c′), S − S₀), where L is the free (saturated or unsaturated) loss. With K s₀ ≤ c_sat, the liquid stays at or below saturation (§5.4), so the cap prevents excess re-uptake rather than modelling precipitation. An empty pool retains its effective exchange capacity; in M1.1 that capacity is not a separate water volume.
- **Rate.** k_s b/ε ≈ 10²–10³ s⁻¹ for fines (note 01 §2), so the pool is integrated implicitly (§7.3).

### 5.3 Kernel: diffusion in a sphere with a partition boundary

$$\frac{\partial u}{\partial t}=\frac{D(T)}{r^2}\frac{\partial}{\partial r}\Big(r^2\frac{\partial u}{\partial r}\Big),\qquad \partial_r u|_0=0,\qquad u(a_k,t)=u_s=\min\Big(\frac{c}{K\,\varepsilon_c},\,u_0\Big).$$

- **Spatial discretisation.** This is the M0 kernel ([particle-kernel.md](particle-kernel.md), ADR 0005) on equal-volume shells, with conductances exact for parabolic profiles. The perfect sink is replaced by the boundary value u_s: the broken shell's pores are taken to be in perfect contact with the bed liquid.
- **Partition basis.** Corrochano (2017, eq. 3.15–3.17) defines K = c_liquid/C_s at equilibrium, with C_s the soluble mass per particle envelope volume: pore solution and matrix-bound solute together. He takes the swollen envelope equal to the dry one (no swelling), and `bed.intraparticle_porosity` (0.56) likewise follows from the dry bulk density, so the bases agree. Here C_s = ε_c u with the reference capacity ε_c = ε_p(1 − u_w), so the boundary loading is c/(K ε_c). At equilibrium a kernel holds the liquid at K s₀, whatever ε_c. With explicit M1.1 water capacity, u is a concentration-equivalent loading, not a measured internal pore-liquid concentration. Treating it as literal pore-liquid concentration would additionally assume no matrix binding. (The first version used c/K, as if K were per pore volume.)
- **Loading cap** (`solubles.kernel_loading_cap`, default on). With the defaults K s₀ = 0.61 × 166.6 = 102 kg/m³, well below c_sat = 245: at equilibrium with saturated liquid a linear partition would load kernels to 2.4 times their initial content. On the default spec the coarse kernels then take up 0.59 g, 27% of their initial 2.14 g (gross, `the_loading_cap_bounds_reuptake` in `sim.rs`), and EY falls from 21.95% to 21.31% (§9); fines have no kernel. The partition coefficient was measured in dilute batch extraction, and nothing constrains a linear isotherm at near-saturated espresso concentrations. The default therefore caps the boundary value at u₀: a kernel takes back at most what it lost, and never ends above its initial content. Capped kernels always step by backward Euler, which keeps u ≤ u₀ exactly (the discrete maximum principle): a kernel capped at the previous step starts the step by backward Euler, and one that becomes capped within a BDF2 step is re-solved by backward Euler and its column solved again. With the cap, the default spec's coarse kernels take up nothing: the liquid that reaches them is already above K s₀, so they stay capped until it falls below. This is a modelling assumption beyond the data; `kernel_loading_cap = false` restores the linear partition, and validation then warns when K s₀ < c_sat. Conservation is exact either way: the cap changes only the boundary value, which the liquid sees through the same linear functions.
- **Kernels above saturation.** When K s₀ > c_sat (K > 1.47 with the defaults; allowed up to 100) the kernels hold the liquid above saturation, up to K s₀: nothing limits their release by solubility. Validation warns, and rejects a K at which the liquid would hold almost no water (v̄ K s₀ ≥ 0.9). Measured maxima of the liquid: 261 kg/m³ at K = 2 (outlet TDS 24.5%), 279 at K = 3 (395 before the front-cell scaling of §5.4), 295 at K = 5; K = 100 is rejected.
- **Temperature.** The diffusivity scales with temperature by Stokes–Einstein: D(T) = D_ref (T/T_ref)(μ_w(T_ref)/μ_w(T)), with absolute temperatures. This gives ×1.24 from 80 to 95 °C, matching `extraction.diffusivity.temperature_coefficient`.

### 5.4 Bed liquid: advection and axial dispersion

$$\frac{\partial(H c)}{\partial t}+\frac{\partial}{\partial z}\Big(\frac{Q_i}{A_i}c-\varepsilon D_\text{ax}\frac{\partial c}{\partial z}\Big)=\sum_k(\text{pool and kernel sources}),\qquad H=\varepsilon+(\phi_T-\varepsilon_0).$$

- **Fluxes.** The face fluxes are exponentially fitted (Scharfetter–Gummel / Il'in–Allen–Southwell): F = a c_up − b c_down with b = g B(Q/g) and a = Q + b. Here g = A_f ε_f D_ax/Δz and B(x) = x/(eˣ − 1).
  - Constants are advected exactly (a − b = Q).
  - The scheme is exact for steady 1D advection–dispersion.
  - Both coefficients are non-negative at every Péclet number: central differencing at low Péclet, upwinding at high.
- **Boundaries.**
  - Inlet: Danckwerts with fresh water, so no solute crosses the inlet face.
  - Outlet: zero dispersive flux; the outflow Q c_last goes to the cup.
  - Front: a face carries flow (and dispersion) only for the part of the step after the front crossed it, the share (w₁ − edge)/(w₁ − w₀) of the column's wetted volume w; the bottom face of the front cell carries nothing.
- **Holdup.** The liquid holdup is H = ε_ij(t) + (φ_T − ε₀): the intergranular liquid plus the selected water-filled intraparticle share (§5.1), which fills from the front and exchanges locally in this effective continuum. Solute therefore travels at the speed of the wetting front, Q/(A φ_T). The front cell holds only its wetted share of the holdup, H w V, and only its wetted share of particles exchanges: their pool lines, cap and kernel losses scale by w (the wetted part is a scaled copy of the cell), and the kernels become u + w(u_full − u), a convex combination stepped by backward Euler (positive, at or below u₀). Before, the whole front cell's particles released into its thin wetted sliver, which with a large K held the front cell far above saturation (7380 kg/m³ at K = 100).
- **Why.** The previous version held only εV and let the imbibed water (φ_T − ε₀ = 0.23 of the bed) carry no solute, while the front advanced at Q/φ_T. Solute then outran its water and piled up in the front cell, which exceeded saturation (270 kg/m³, 322 with 120 cells, against c_sat = 245); the pools re-precipitated the excess, parking up to 0.56 g, and local EY reached −18.6% (−33.5% with 120 cells), getting worse with the grid. Now every cell's holdup grows by exactly the water that enters it, so backward Euler gives each cell a weighted average of its old concentration, its inflow and the local equilibria: the liquid never exceeds max(c_sat, K s₀, inflow), with or without the loading cap. Measured (§8): the liquid stays at c_sat to 3e-9, local EY never falls below −2e-14, first-drop TDS is 23.161% (the saturation value) on every grid from 15 to 120 cells and at every u_w, and EY converges (21.88 → 21.98% from 15 to 120 cells).

### 5.5 Porosity growth with dissolution

Consider a cell whose particles have lost a share EY_loc of their dry mass. The dissolved solid volume is ΔV_s = EY_loc ρ_s(1 − ε_p)(1 − ε₀)V/ρ_s. If a share θ of it becomes intergranular pore space, the particles' envelope volume shrinks by θΔV_s/(1 − ε_p):

$$\varepsilon=\varepsilon_0+\theta\,\max(\mathrm{EY}_\text{loc},0)\,(1-\varepsilon_0)\qquad(\text{capped at }0.95,\ \text{never decreasing}).$$

- **Default: θ = 0** (`dissolution_porosity_share` = null or absent). Solubles leave from inside cells whose insoluble walls keep the particle envelope, so dissolution raises the intraparticle porosity, not ε. The transport follows effective soluble particle loadings; changes in the intraparticle share of the freed volume are not tracked. The registry record `hydraulics.dissolution_porosity_share` is triangular 0/0/1 with mode 0.
- **θ = 1.** Particles shrink at constant envelope density. This is the closure of Lee, Smith & Arshad (2023), EY = (ε − ε₀)/(1 − ε₀), and the upper bound: note 01 §4.11 gives ×4 at EY 10% and ×12 at 20%.
- **Change.** null used to mean the proportional rule θ = ε₀/(ε₀ + (1 − ε₀)ε_p) = 0.27. That rule had no mechanism in this model, and at ε₀ = 0.17 Kozeny–Carman makes it a strong lever (d ln KC/dε ≈ 20, ×2.8 permeability at 26% local EY). It is dropped; null now means 0, the same as an explicit 0 (bit-identical, `tests/shot_regressions.rs`). θ is not tuned to any flow data.

For θ > 0 the porosity updates once per step from the particles' loss and sets the holdup and Kozeny–Carman. It never decreases: solute taken back up refills the particles' pores, not the intergranular space. The liquid's volume flow is not changed by dissolution (∂Q/∂z = 0; §10).

### 5.6 Tracked species

Each species is a linear passenger on the lumped solution: same flows, porosity and temperature history. It has its own kernel diffusivity D_s(T) and partition coefficient K_s.
- **Initial split.** The species is spread like the lumped solubles, with a surface share of min(1, s_s f_s) per class (`surface_fraction_scale` = s_s). Classes without a kernel take all of it in the pool; without a pool, none.
- **Pools: congruent co-dissolution.** While the lumped pool of a cell and class dissolves, the species leaves in proportion to its share of the pool's mass. When the lumped flux reverses, solute returns in proportion to the liquid's composition. With backward Euler this is S′_s = (S_s + g c′_s)·κ, using two factors from the lumped step:
  - while dissolving: κ = S′/(S′ + loss), the factor that keeps the pool's composition exactly unchanged, and g = 0;
  - while solute returns: κ = 1 and g = −loss/c′.

  This is linear in the species state, positive, and conservative. It replaces a per-species saturation, which has no data (only lumped c_sat is known); the composition of the surface pool is what the species' own data constrain.
- **Kernels.** The species' kernel boundary is c′_s/(K_s ε_c), using the same reference loading capacity ε_c = ε_p(1 − u_w) as the lumped kernel. It is capped at its own initial content when the loading cap is on (a policy iteration over the kernel caps only; the species pools are linear).
- **Groups.** Species with identical (D_s, K_s, s_s) form a group, solved once for a unit mass fraction; each member is that solution times its mass fraction. The loading cap scales with the content, so the scaling is exact (a species alone and the same species in a group give bit-identical results).
- **Cost.** Each group costs about one lumped solve: 4.6 ms per group natively on the default bed, 55 ms on the 30-class bed, 0.47 ms in tier 0 (§8). Fifty-five species with distinct parameters cost 0.29 s natively on the default bed, but 3.1 s on the 30-class bed and 29 ms in tier 0, beyond the budgets; 55 species sharing one parameter set cost 19 ms. Builders should map species onto a few shared (D, K, surface-scale) sets.
- **Check.** A species identical to the lumped solubles reproduces their cup mass to 4.7e-15 (§8).

---

## 6. Thermal model

One lumped node for bed, basket and portafilter:

$$\big(C+\rho_wc_w\,\phi_T\textstyle\sum_iW_i\big)\frac{dT}{dt}=\rho_wc_wQ_\text{bed}(T_w-T)-h\,(T-T_a).$$

- The node starts at T₀ and is integrated by backward Euler, which keeps T between T_w, T_a and its old value.
- The water held in the wetted bed adds to the heat capacity.
- The extract leaves at the node temperature (`series.outlet_temp_c`).
- T sets μ_w (flow) and D (kernels).

---

## 7. Numerics

### 7.1 Discretisation

| tier | columns | depth cells | size classes | kernel |
|---|---|---|---|---|
| 1 | `heterogeneity.columns` (1–64) | `numerics.depth_cells` (2–1000) | as specified (≤ 200) | `numerics.kernel_shells` equal-volume shells (2–64) |
| 0 | 3 conditional-mean strata (1 without spread) plus the edge annulus | 8 | 2: fines (< 100 µm) and coarse, each at its Sauter radius | coarse: two equal-volume shells; fines: linear driving force (one shell) |

The original tier 0 used one column at the area-mean multiplier with linear-driving-force kernels. It ignored the spread (EY +24.9% against tier 1 at σ = 0.7) and its single-shell kernel missed −7.3% at coarse grind. With three strata and two-shell coarse kernels, the M1 legacy-closure verification found agreement within 2.9% on EY and TDS and 0.6% on shot time across twelve cases, within the 10 ms benchmark budget (§8). Those historical figures do not establish M1.1 recipe accuracy or runtime; the current validation report compares the tiers with the active closure.

### 7.2 Time steps and events

- **Step size.** Steps land on every output time with a uniform base step Δt = Δt_out/⌈Δt_out/Δt_max⌉ (0.05 s by default; Δt_max ≤ 0.5 s).
- **Events.** A step is shortened to land on:
  - the headspace filling;
  - each column's breakthrough (predicted from its flow), so outflow starts at a step boundary and the mass events below can be predicted from it;
  - phase exit times and the stop time;
  - `max_duration_s`, the end of the drip and the moment the headspace water runs out;
  - predicted mass events (phase exits and the stop by beverage mass, from the current mass flow). These fire within 0.1 mg, also at Δt_max = 0.5 s (`mass_events_land_with_the_largest_step`); pressure exits fire at the end of the step that reaches them.
- **Step guards.** Validation bounds (max_duration + 8τ_drip)/min(Δt_max, Δt_out) and the number of output points at 2e6, and the total work at 1e10 value-steps. Previously Δt_max had no cap: Δt_max = 100 s took 3 steps and stopped at 446 g instead of 36 g, and the 8τ drip was not counted (508 000 steps at Δt_max = 1 ms and τ = 60 s).
- **Rejected steps.** A step is never accepted with unconverged choices. If a column's policy iteration exceeds its solve limit (§7.3), the transport reports it before changing any state (all columns are solved before any is back-substituted), the hydraulic and front state is restored, and the step is retried at half its length, by backward Euler (the kernels' previous time level is gone). After twelve halvings the run fails with `ShotError::Numerical`, naming the time and step. A step that may reach a mass target (within four times the current mass flow over the step) keeps a full copy of the state; if it overshoots the target by more than 0.1 mg it is re-landed with a secant step on its own mass gain (at most eight times). `diagnostics.rejected_steps` counts both; none occurs on the default spec.
- **Within each step:**
  1. **Hydraulics.** Heun predictor–corrector: flows at the start, a predicted front, flows at the end (with the old concentrations), and their mean, which carries both the front and the transport. Headspace delivery uses the exact integral of the capped fill program. A final drip step is bounded by its actual remaining headspace volume.
  2. **Thermal node.** Backward Euler.
  3. **Extraction and transport.** Implicit (§7.3); the porosity then updates.
  4. **Bookkeeping.** Hydraulics are refreshed at the new state, then outputs and events are processed.
- **Choked.** A shot stalls when, for 5 s, the flow stays below 0.01 mL/s and below a tenth of the flow the program asks for (its flow target, or the supply's flow at zero pressure). It then stops with `stop_reason = "choked"`. A slow soak (0.005 mL/s) is no longer reported as choked.

### 7.3 The coupled implicit step (`transport.rs`)

The bed liquid and the pools use backward Euler. The kernels use BDF2 (variable step, ratio ω ≤ 2) for classes with Δτ = DΔt/a_k² ≤ 0.04, and backward Euler above, as ADR 0005 recommends. Five cases use backward Euler individually: the first step of the run, a cell's first wet step, a kernel at its loading cap, a BDF2 right-hand side that would turn negative, and a BDF2 step whose homogeneous loss α would be negative.

**Condensation.** Particle states are local to a depth cell, so they are eliminated cell by cell.
- **Kernels.** With the new liquid concentration c′ as a parameter, the new kernel is u′ = u_hom + u_s w. Here u_hom solves the step with a zero boundary value, and w is the response to a unit boundary value; w is the same for every cell of a class. The kernel's mass loss over the step is therefore α − β u_s, with α = σV Σ Ṽ(u − u_hom) and β = σV Σ Ṽ w, and u_s = c′/(K ε_c) (linear) or u₀ (capped). In a cell the front is inside, α and β (and the pool lines) carry the wetted share w.
- **Pools.** A free pool's loss is piecewise linear in c′. In the saturated regime it is k_sbΔt(c_sat − c′); in the unsaturated one, (γS − k_sbΔt c′)/(1 + γ) with γ = k_sbΔt/V_p. The two lines meet at c′* = c_sat + (V_pc_sat − S)/(k_sbΔt). The free loss is concave (the smaller line); the cap at the initial content makes the loss max(free, S − S₀).
- **The column system.** What remains is one tridiagonal system per column for c′, an M-matrix in every regime: positive diagonal, non-positive off-diagonals, column diagonally dominant.

**Regimes: nested policy iteration.** The free pool losses are concave in c′ and the caps convex, so the system is min–max piecewise linear. Plain Howard iteration can cycle on such systems. It is solved instead by nested policy iteration (Hoffman & Karp 1966): with the caps fixed, Howard's algorithm (Bokanowski, Maroso & Zidani 2009) picks a regime per free pool, solves, and re-picks until no regime changes, its iterates decreasing monotonically; then the caps are re-picked from that solution, and the outer iterates increase monotonically, bounded by the solution. Both loops terminate in exact arithmetic; the regimes and caps of the previous step are the starting guess.

A regime change can travel one cell per solve (with no dispersion, each cell's liquid depends on the one above), so the number of solves grows with the column: the limit per column and step is 100 + 4 n K for n active cells and K classes. The review's fixed limit of 100 made stiff pools on fine grids with coarse steps (1000 cells, k_s = 1 m/s, Δt = 0.5 s) accept unconverged choices, overdraw pools thousands of times their content and fail on a negative concentration; those specs now need up to 206 solves in their worst step and run cleanly. `diagnostics.max_regime_solves` reports the most any column needed in a step (4–9 on the default specs). The species iterate over kernel caps only, whose iterates increase monotonically, so 2 n K + 1 solves always suffice there.

In floating point a pool can sit exactly on its switch point, where both lines agree; without a band c′ can flip by one ulp each iteration forever. A choice is therefore kept while its candidates differ by less than 1e-10 of the pool's content (or the kernel's u₀), or by less than the round-off of evaluating them (16 ε k_sbΔt c_sat). The band used to be 1e-10 in c′, which allows a pool error of k_sbΔt × 1e-10 c_sat: with k_s = 1e6 m/s a pool ended at −82 kg/m³. The mass band bounds the pool error directly.

If the limit is reached the step is rejected and retried shorter (§7.2); unconverged choices are never used.

**Positivity.** At c′ = 0 every right-hand-side term of the final regimes is non-negative: the liquid mass, the free pool intercepts (k_sbΔt c_sat and γS/(1 + γ)) and the kernel loss α. (The caps apply only above their switch points, and the regimes are consistent with the solution.) An M-matrix has a non-negative inverse, so c′ ≥ 0, and then u′ = u_hom + u_s w ≥ 0. For backward Euler, α = Δτ G (u_hom)_N ≥ 0 and u_hom ≥ 0 hold by construction. BDF2 needs both checked: its right-hand side V[(1 + ω)u − ω²u_prev/(1 + ω)] can turn negative, and α can turn negative while a kernel loads (the extrapolation overshoots); either case falls back to backward Euler. The previous version checked only the right-hand side, and K = 1e-3 gave −1.18 kg/m³. All values are checked every step (`diagnostics.min_concentration_kg_m3`): the kernels with a vectorised sign test each step and their exact minimum at the check points. A value below −1e-9 of max(c_sat, u₀) warns, and below −1e-3 the run fails.

**Conservation.** The liquid receives exactly what the pools and kernels lose, as the same linear functions of c′. Interior face fluxes cancel, the inlet carries nothing, and the outlet flux goes to the cup. The soluble mass of particles + liquid + cup is therefore conserved to round-off for every scheme. The species obey the same identity.

**Hydraulic carrier volume.** `diagnostics.hydraulic_volume_balance_error` checks the final identity V_pump = V_outlet + φ_T ΣW_i + V_headspace,left + V_vented, using the accepted steps' actual volume transfers. The residual is divided by delivered volume, or zero with no delivery. Dripping subtracts the same water from the headspace that it supplies to the bed; venting has its own discharged volume. This is a check of the solver's incompressible carrier-volume convention, **not an exact solvent-mass balance** including dissolved-solids displacement or dissolution-created pore volume. Pure-water tests check the actual water budget at fill, partial wetting, breakthrough, drip and venting.

**M1.1 startup verification.** `tests/shot_startup.rs` verifies exact constant-flow full-pore breakthrough and a capped flow ramp across multiple steps, disabled-closure compatibility, dry waiting versus wet-age relaxation, pump-off phases, late-flow recovery and conservation. In a raw default spec with f_water = 1 and test air values A = 0.5, τ = 10 s, n = 3, reducing Δt from 0.05 to 0.025 s changes first drops by 0.0063 s, shot time by 0.0118 s and EY by 0.0099 percentage point. These are numerical checks, not observations used to calibrate startup.

**Conservation degrades with stiffness.** The balance is exact algebra, but its round-off grows with the size of the terms in a cell's equation: a pool line's terms are k_sbΔt c_sat, so a stiff pool (k_sbΔt ≫ V_p) loses digits. Measured: 2e-15 at the defaults, 2.0e-12 at k_s = 1 m/s (the bound), 8.9e-11 at k_s = 1 m/s with 0.1 µm fines (both bounds), 2.7e-13 at D_ax = 1e-3 m²/s. The review measured 3.7e-7 at k_s = 1e5 and 1.9 at D_ax = 1e10, now outside the bounds. A run warns above 1e-9 and fails above 1e-6.

**Outlet check.** `diagnostics.outflow_integral_error` compares the cup's solute (the implicit outflow of every step) with the trapezoidal integral of Σ q_i c_i at the step ends. Both integrate the same outlet q·c, so it is a quadrature-consistency check of the outlet bookkeeping, not an independent budget of the bed: it could not have seen the old front supersaturation. It converges at first order, 8.4e-3 at Δt = 0.1 s, 3.5e-3 at 0.05 s and 1.05e-3 at 0.0125 s. The bed's own budget (particles from local EY × dry mass, liquid c·H·w·V, cup) closes to ≤ 5e-15 every step in the independent verification.

`diagnostics.mass_balance_error` is the largest relative error, over the lumped solubles and each species, at every snapshot check point and at the end. All inventories use Neumaier summation.

### 7.4 Layout, cost and determinism

- **Layout.** Kernels are stored shell-major across all cells of the bed, so one shell of one class is a contiguous row of n_col × n_cells values.
- **Cost.** A step runs in three phases, for the lumped solubles and then each species group:
  1. the homogeneous kernel solves of every class over the whole bed in lockstep (`TridiagonalLu::solve_many_in_place`, which vectorises and gives exactly the bits of one-by-one solves);
  2. the liquid solve of each column, with its policy iteration;
  3. the kernel update over the whole bed.

  The homogeneous solution overwrites the previous level in place, and the buffers swap once per step. All columns are solved before any is back-substituted (the back-substitution recomputes the same linear functions), so a step can be rejected unchanged. Factorisations check their pivots (`TridiagonalLu::pivots_positive`) and fail with `ShotError::Numerical` instead of panicking.
- **Determinism.** The core uses only IEEE basic operations and `crate::math`, which gains `ln` and `expm1` (both within 1 ulp of correctly rounded references) and `fmin`/`fmax`, whose results do not depend on how a platform orders ±0. Two habits matter too:
  - sums that may be empty fold from +0, because Rust's float `sum()` starts at −0;
  - the WebAssembly module imports no maths functions.

---

## 8. Verification (M1 legacy-closure measurements)

These tables preserve the M1 0.2.0 verification record: raw defaults use the legacy water fraction and have no pore-air penalty. They are not measurements of recipe-built M1.1 shots. The new startup checks and their timestep results are described in §7.3; current fitted and held-out predictions are in the [validation report](../validation/m1-validation.md).

The M1 measurements used an AMD Ryzen 9 7945HX with Rust 1.99.0 (release build), with other work running (load ≈ 3). The corresponding checks remain in `cargo test` (`tests/shot_verification.rs`, `shot_regressions.rs`, `shot_validation.rs`, `shot_robustness.rs`, `shot_schema.rs`, plus unit tests).

| check | setup | result |
|---|---|---|
| Darcy, straight basket | insoluble bed, constant T, no compaction, 9 bar | Q = P κ₀/(μ_w L/πr²): rel. error **6.7e-16** |
| Darcy, frustum | r 25 → 30 mm over 25 mm; ∫dz/A = L/(π r₀ r_L) | rel. error **2.2e-16**; fill volume π L(r₀² + r₀r_L + r_L²)/3 to 1e-13 |
| Darcy, 8 columns | σ = 0.5, edge 25% × 0.6 | Q = P κ₀ Σf_im_i/(μ ∫dz/A): rel. error **2.2e-16** |
| Pressurised orifice | 0.4 mm, C_d 0.7, 9 bar | Q = 2P/(R + √(R² + 4aP)): rel. error **1.1e-15** (orifice drop 6.8 bar) |
| Vibratory pump | 6 mL/s free, 15 bar stall, pump_full | Q = Q_free/(1 + Q_free R/P_stall): rel. error **2.2e-16**; an OPV below the intersection caps P exactly |
| Wetting time | flow control 2 mL/s, one column | first drops = (V_hs + φ_T V)/Q: rel. error **2.8e-15** |
| Washburn wetting | 9 bar, flow-limited start, Δt 0.01 s | first drops vs t_fill + t₁ + μφ_T(L² − z*²)/(2κP): rel. error **6.6e-4** |
| Perfect sink (M0 kernel) | one class, no pool, 1 g bed flushed at 100 mL/s, K = 100 (boundary ≈ 0), 32 shells, Δt 0.05 s | released − Crank: **+3.7e-4** (τ = 0.01), +2.1e-4 (0.03), +7.1e-5 (0.1), +3.8e-5 (0.3), +5.2e-6 (0.6); the shells converge at second order (change 1.6e-4 from 16 to 32 shells, 4.0e-5 from 32 to 64) |
| Closed-system equilibrium | legacy mode: wet, then zero flow for 120 s; liquid holdup ε + mobile water and effective particle capacity ε_c, kernels at c/(K ε_c); reference capacities sum to ε_T | every cell at c_eq to **6e-13**: 155.67 kg/m³ (K = 1, uncapped), 148.53 (K = 0.61, kernels capped at u₀), 124.22 (K = 0.61, linear) |
| Mass conservation | default, tier 0, stepped taper, pressurised, vibratory, all effects (each with 3 species) | **2.5e-15 to 4.7e-15** |
| Species copy | a species with the lumped D, K and E_max | cup mass equals the lumped cup mass to **4.7e-15** |
| Species groups | a species alone and the same species in a group | bit-identical; members scale exactly with their mass fractions |
| Front (H1) | default, 15–120 cells, Δt 0.05 and 0.0125 s, 200 snapshots; u_w 0–0.9 | liquid ≤ c_sat (to 3e-9); local EY ≥ −2e-14; first-drop TDS **23.161%** on every grid and uptake (saturation 23.161%); EY 21.88 → 21.98% (15 → 120 cells) |
| Coarse steps | 4–19 cells, Δt 0.21–0.5 s, θ = 0.6: the front crosses faces and the floor within a step | liquid ≤ c_sat (to 1e-9) |
| Stiff, fine, coarse (H) | 576 combinations: 30–1000 cells × Δt 0.05–0.5 s × k_s 1e-3–1 m/s × K 0.61–1.471 × D_ax 0, 5e-6 × 1 or 8 columns | all run; worst mass balance **1.2e-11**; at most 370 regime solves in a step; no retry needed (the review saw 88 failures in 2112) |
| Retry path | the solve limit forced to 3 per step (unit test) | steps rejected and retried shorter; result conservative and within 2% of the unlimited run; with 1 solve the run fails with a clear reason |
| Tier 0 vs tier 1 | the review's twelve cases (table below) | EY and TDS within **2.9%**, shot time within 0.6%, beverage within 0.5% |
| Outlet check | default, Δt 0.1 / 0.05 / 0.0125 s | cup solute vs ∫ q c dt: 8.4e-3 / **3.5e-3** / 1.05e-3 (first order) |
| Stiff corners | k_s = 1 m/s with 0.1 µm fines; D_ax = 1e-3; D = 1e-7 with K = 0.01; a 1 g dose | mass balance ≤ **1e-10**, no negative value, no warning |
| Determinism | default + 3 species, twice | bit-identical (`Debug` text) |
| Validation | 76 invalid specs and the review's crash cases | each rejected with an error naming its field; 10 valid edge cases run |
| Robustness | 20 000 random valid specs over wide ranges of geometry, size distribution, kinetics (k_s up to 1 m/s), hydraulics, programs, pumps, loading cap, venting, tiers, grids (one in eight with 100–400 cells) and steps (up to 0.5 s) (`PUCKWORKS_SWEEP=20000`; 25 in CI) | all run; all outputs finite; no negative value; the liquid never exceeds max(c_sat, K s₀); with the cap no local EY below −1e-9; every mass stop within 0.2 mg; worst mass balance **5.1e-10** (stiff pools); at most 411 regime solves in a step; 360 steps rejected and retried in all |
| Schemas | defaults and variants covering every enum variant, plus results | all 100 spec keys and 61 result keys match in both directions; instance values lie within the schema bounds; **249** values just outside a schema bound are each rejected by validation, naming that field |

**Native vs WebAssembly.** Eight specs were run through `puckmodel::api::simulate_shot_json` natively and through `simulateShot` in Node 26 (`initSync`): default, default tier 0, 30 classes + 4 species (tier 1 and 0), pressurised + vibratory + species, tapered + flow control + all effects, cap off + venting + species groups, and θ = 0.2 with two columns, a 20 s drip and Δt = 0.5 s. The outputs are **byte-identical**: 70 914 numbers. The WebAssembly module imports no maths functions.

**Tier 0 against tier 1** (relative differences; `shot_report`):

| case | EY | TDS | shot time | beverage |
|---|---|---|---|---|
| default | −1.9% | −1.9% | +0.36% | −0.04% |
| 1 column (tier 1) | −2.9% | −2.9% | +0.32% | −0.06% |
| flow 2 mL/s | −1.3% | −1.3% | +0.03% | +0.01% |
| flow 1.2 mL/s | −0.8% | −0.8% | +0.01% | 0.00% |
| 3 bar | −1.6% | −1.6% | +0.35% | −0.02% |
| 6 bar | −1.9% | −1.9% | +0.36% | −0.04% |
| grind ×0.6 | −1.0% | −1.0% | +0.54% | −0.04% |
| grind ×0.75 | −1.4% | −1.3% | +0.46% | −0.05% |
| grind ×1.33 | −2.8% | −2.7% | +0.25% | −0.05% |
| σ = 0.7 | −0.3% | −0.3% | +0.43% | −0.04% |
| 30 classes | +1.0% | +1.1% | +0.60% | −0.08% |
| time stop 25 s | −1.0% | −0.5% | 0.00% | −0.47% |

The first tier 0 (one column, single-shell kernels) gave +24.9% at σ = 0.7 and −8.3% at grind ×1.33.

**Convergence** (default spec; change from the finest run):

| refinement | EY change at the default | shot-time change at the default |
|---|---|---|
| Δt_max 0.2 / 0.1 / **0.05** / 0.025 s vs 0.0125 s | −0.100 / −0.049 / **−0.021** / −0.007 points | +0.083 / +0.049 / **+0.024** / +0.009 s |
| depth cells 10 / 15 / **30** / 60 vs 120 | −0.204 / −0.093 / **−0.023** / −0.005 points | +0.075 / +0.042 / **+0.018** / +0.007 s |
| kernel shells 4 / **8** / 16 vs 32 | −0.042 / **−0.010** / −0.002 points | −0.008 / **−0.002** / 0.000 s |
| columns 3 / 4 / **8** / 16 vs 64, σ = 0.2 | +0.093 / +0.053 / **+0.016** / +0.005 points | first drops 7.26 / 7.11 / **6.89** / 6.73 vs 6.50 s |
| columns 3 / 4 / **8** / 16 vs 64, σ = 0.7 | +0.771 / +0.339 / **+0.023** / −0.019 points | first drops 6.62 / 6.28 / **5.82** / 5.55 vs 5.24 s |

At the defaults the discretisation contributes less than 0.03 EY points. Steps converge at first order (backward Euler for the liquid); depth cells at second order (successive EY changes 0.071, 0.018, 0.005 from 15 to 120 cells), although the front itself is smeared over one cell. Before the H1 fix the local-EY minimum diverged with the grid. The column count discretises the permeability distribution: EY converges (8 columns are within 0.03 points of 64 at σ = 0.7, against 2.1% with the old midpoint strata), but first drops keep moving earlier as the fastest stratum resolves the tail.

**Timings** (median wall time per shot, including the drip; measured under a machine load of about 8, so absolute values read high):

| case | native Rust | WebAssembly (Node 26, via JSON) |
|---|---|---|
| tier 1, default (2 classes, 8 × 30 cells) | 15.6 ms | 20.3 ms |
| tier 1, 30 classes + 4 species (8 × 30 cells, 8 shells) | **343 ms** | **471 ms** |
| tier 0, default | 2.6 ms | 3.2 ms |
| tier 0, 30 classes + 4 species | 5.2 ms | 7.2 ms |
| tier 1, default + 16 / 55 distinct species | 91 / 280 ms | — |
| tier 1, default + 55 species in one group | 18.7 ms | — |
| tier 0, default + 16 / 55 distinct species | 10.1 / 28.4 ms | — |

In the M1 measurement, interleaving the reviewed build with its predecessor under the same load showed 3–7% more runtime (the saved front state per step, wetted shares and full copy kept near mass targets). Both budgets (tier 0 ≤ 10 ms, tier 1 ≤ 1 s per 30 s shot) were met for those legacy standard specs. Species with distinct parameters scale linearly (§5.6).

---

## 9. Plausibility (historical M1 raw defaults, tier 1)

These uncalibrated M1 0.2.0 raw-spec results use the legacy water fraction and no pore-air penalty. They show directional responses and are retained as a numerical reference; they do not describe M1.1 recipe-built shots. The raw κ₀ is 2.4e-14 m², a bare reference permeability (ADR 0009). The separate calibration uses Schmieder 2023, Vaca Guerra 2024, Waszkiewicz 2026 long-time flow and Corrochano; Cameron 2020, Smrke 2024 and Waszkiewicz's startup transient are held out. See the current [calibration and validation report](../validation/m1-validation.md) for those results.

| case | shot time s | first drops s | beverage g (drip) | TDS % | EY % | max P bar | flow mL/s: drops + 2 s → mid → stop |
|---|---|---|---|---|---|---|---|
| default: 18 g, 9 bar, stop at 36 g | 18.2 | 6.9 | 42.9 (6.9) | 9.21 | 21.95 | 9.0 | 2.68 → 3.53 → 3.91 |
| finer (radii ×0.75, κ₀ ×0.56) | 29.5 | 8.7 | 39.8 (3.8) | 10.82 | 23.93 | 9.0 | 1.14 → 1.89 → 2.15 |
| coarser (radii ×1.33, κ₀ ×1.78) | 12.3 | 6.1 | 48.4 (12.4) | 7.12 | 19.15 | 9.0 | 5.86 → 6.51 → 7.05 |
| 6 bar | 19.1 | 7.0 | 41.4 (5.4) | 9.50 | 21.84 | 6.0 | 2.34 → 3.32 → 3.67 |
| flow control 2 mL/s (12 bar limit) | 43.5 | 24.6 | 38.2 (2.2) | 10.18 | 21.63 | 4.0 | 1.85 → 2.00 → 2.00 |
| tapered basket (r 25 → 29.5 mm) | 23.3 | 6.7 | 40.7 (4.7) | 9.88 | 22.36 | 9.0 | 1.59 → 2.41 → 2.69 |
| pressurised basket (0.4 mm orifice) | 20.6 | 6.9 | 40.5 (4.5) | 9.73 | 21.89 | 9.0 | 2.42 → 2.85 → 2.95 |
| vibratory pump (7 mL/s free, OPV 10 bar) | 19.3 | 7.8 | 41.9 (5.9) | 9.39 | 21.85 | 9.6 | 2.69 → 3.48 → 3.79 |
| 30 classes + 4 species | 18.2 | 6.9 | 42.9 (6.9) | 9.17 | 21.85 | 9.0 | 2.68 → 3.53 → 3.92 |

**Reading the table.**
- **First drops.** The first drops are saturated: 23.16% TDS, the saturation value at c_sat = 245 kg/m³ (the first version reported 23.47%, above saturation, because of the front supersaturation of §5.4).
- **Flow trend.** At 9 bar the outflow rises ×1.46 from first drops + 2 s to the stop. Measured decomposition (`shot_report`):

  | case | rise |
  |---|---|
  | default (θ = 0) | ×1.46 |
  | water viscosity (γ = 0) | ×1.08 |
  | isothermal (bed starts at 92 °C) | ×1.30 |
  | γ = 0 and isothermal | ×1.00 |
  | one column | ×1.39 |
  | θ = 0.1 / 0.27 (old proportional rule) | ×1.64 / ×1.57 |

  The rise is the extract's viscosity falling as the outlet dilutes (alone ×1.35) and the bed warming from 70 °C (alone ×1.12); with both removed the flow is flat. Staggered breakthrough of the columns adds about ×1.05 in this metric (×1.39 with one column). Dissolution porosity no longer contributes (θ = 0); with the old proportional rule it was the dominant term, and the review measured ×4.1 then. At θ = 0.27 the rise is capped by the program's 8 mL/s flow limit: the pump reaches it and the pressure falls to 4.7 bar by the stop. Waszkiewicz measure about ×2; θ and γ are not tuned to that, and κ₀, γ and σ remain calibration targets.
- **Pressure.** 6 bar and 9 bar differ by only 5% in time, because the poroelastic law saturates (Φ(6 bar) = 0.94 Q_c R, Φ(9 bar) = 0.996 Q_c R), as Waszkiewicz observe.
- **Flow control.** With κ₀ = 2.4e-14 the default bed takes 2 mL/s at 4.0 bar, well below the 12 bar limit.
- **Drip.** The drip drains the 34.6 mL headspace through the puck with τ = 1 s: 6.9 g, more than Q_stop τ because the bed decompresses as the pressure decays (§4.6). It can never exceed the headspace water: at τ = 10–60 s the whole headspace drains (33.6 g), where the previous version, with no water budget, gave 66.9 g at τ = 10 s and 219 g at τ = 30 s; a 1.06 mL headspace gives 1.03 g (was 5.96 g). Machines that vent the headspace (`vent_headspace`) do not drip. `drip_tau_s` and `vent_headspace` are machine properties for `puckmodel` to set.
- **Grind.** Grind changes time, EY and TDS in the expected directions. Reproducing the EY peak with grind (Cameron) is a calibration task (heterogeneity σ).

**κ₀ is a bare permeability.** The registry's `hydraulics.permeability.in_shot` (1.8e-15–1.5e-14 m²) was back-calculated as κ = qμL/ΔP, with water viscosity and no compaction: an effective, all-in value. This model applies its own factors on top of κ₀:
- the poroelastic factor (0.33 at 9 bar);
- the extract viscosity (up to 2× water);
- a bed cooler than the brew water (the water viscosity at 70 °C is 1.31× that at 92 °C; over a shot the bed warms, which changes the flow by ×1.12, above);
- swelling, gas and the column multipliers.

Using the back-calculated value as κ₀ counts these effects twice. κ₀ defaults to `hydraulics.permeability.reference` instead, the bare value at the reference Sauter diameter (ADR 0009), which `puckmodel` scales with the grind; it is to be calibrated within this model, for example against Waszkiewicz's Q_c = 1.90 g/s at P_c = 12 bar.

---

## 10. Limitations

- **Flow geometry.** The columns are 1D stream tubes without cross-flow. In a tapered basket each keeps its share of the cross-section; there is no radial redistribution or 2D flow (that is Tier 2). Edge and hole-pattern effects enter only through the edge multiplier and the outlet orifices.
- **Wetting.** The front is sharp, without capillary pressure or a resolved saturation field. M1.1 adds a time-dependent effective relative-permeability factor for pore-air connectivity, but its amplitude, power and moisture-to-mobility timescale mapping are estimated. It does not solve two-phase flow, gas transport or finite-rate particle hydration. The headspace still fills at zero pressure before infiltration and has no compliance: once full, pressure follows the bed instantly.
- **The front cell.** The front cell holds the wetted share of its liquid, its faces carry flow only after the front has passed them, and only its wetted share of particles exchanges, so solute and water stay in step. The wetted share is mixed into one cell average (newly wetted and earlier wetted particles are not told apart), and a cell activated part-way through a step exchanges from the step's start. This smears particle exchange over one cell and one step (resistance and front position stay exact).
- **Liquid volume.** The explicit intraparticle water fraction sets both front uptake and continuum holdup. Full pore capacity is an upper-envelope single-liquid approximation: the added water mixes locally and changes dilution and residence time, whereas real intraparticle water can exchange slowly. u_w retains its effective loading-capacity role; it sets water uptake only in legacy mode (§5.1). M1.1 budgets pump delivery, initial pore fill, headspace storage, outlet flow, drip and venting. The reported hydraulic residual excludes dissolved-solids displacement, thermal expansion and the additional holdup created by nonzero dissolution porosity (§5.5); it is not an exact solvent-mass balance.
- **Particle geometry.** Particles do not change size: swelling acts through permeability only, and porosity growth (§5.5, off by default) through holdup and Kozeny–Carman only.
- **Exchange closures.**
  - Kernels are in perfect contact with the bed liquid (no film resistance). Their partition is linear in c up to the loading cap at u₀ (§5.3, an assumption beyond the data), with the per-envelope coefficient K converted to concentration-equivalent loading by ε_c. This conversion does not measure internal pore-liquid concentration or resolve matrix binding. Nothing limits their release by solubility: with K s₀ > c_sat they can hold the liquid above saturation (warned).
  - Pools take back at most their initial content.
  - k_s, K, c_sat and D_ax do not depend on temperature.
  - The viscosity's temperature dependence beyond water is a constant exponent γ.
- **Thermal.** One node: no axial temperature profile; the outlet temperature is the node temperature.
- **Fines.** Fines migration is a relaxing outlet resistance, without particle transport or erosion.
- **Species.** Species are linear passengers. Their pools dissolve congruently with the lumped pool, and they have no saturation of their own. Each group of distinct transport parameters costs about one lumped solve (§5.6), so tens of distinct species exceed the budgets.
- **Tier 0.** The historical M1 comparison over twelve legacy-closure cases gave differences within 2.9% on EY/TDS and 0.6% on shot time (§8). That is not an accuracy bound for M1.1 recipes; consult the current validation report's tier comparison. First drops depend on the fastest stratum and so on the strata count. Tier 0's `class_ey` lists the two merged classes.
- **Outputs.**
  - `shot_time_s` ends at pump stop. Beverage mass, TDS and EY include the subsequent modeled drip. A 36 g mass stop therefore does not guarantee a final 36 g cup; subtract `drip_mass_kg` from the final mass to recover the mass at stop, and use the series at `shot_time_s` for extraction at that point.
  - Snapshots are the stored candidates nearest k·t_end/n. Very coarse output intervals can repeat one.
  - Mass events land within 0.1 mg.
  - Pressure exits fire at the end of the step that reaches them.
- **Speed.** The historical tier-1 timings are from a fast desktop CPU and the legacy closure. Longer startup trajectories require more steps; M1.1 performance must be measured for the actual recipe. A slower laptop may need Δt_max = 0.1 s for heavy specs (30 classes + 4 species).
- **Conservation at the bounds.** Round-off grows with stiffness: up to about 1e-10 at the most extreme bounds (§7.3).
- **Defaults.** Raw `ShotSpec` defaults preserve the legacy closure and are not the fitted recipe defaults. Recipe construction combines registry values with the current calibration; startup capacity and pore-air parameters remain fixed grade-D assumptions rather than experimentally identified coefficients. θ is a mechanistic 0, not fitted. Current failures and uncertainties belong in the calibration/validation report, not in the historical raw-spec tables above.

## References

- Abramowitz M, Stegun IA (1964) *Handbook of Mathematical Functions*, formula 7.1.26. National Bureau of Standards.
- Bokanowski O, Maroso S, Zidani H (2009) Some convergence results for Howard's algorithm. *SIAM J Numer Anal* 47:3001–3026. doi:10.1137/08073041X
- Roman Corrochano B (2017) *Advancing the engineering understanding of coffee extraction*. EngD thesis, University of Birmingham (eq. 3.15–3.17: the partition coefficient per swollen particle envelope volume).
- Foster J et al. (2025) Dynamics of liquid infiltration into an espresso bed using time-resolved micro-computed tomography: Insights from experiment and modeling. *Phys Fluids* 37:013383. [doi:10.1063/5.0245167](https://doi.org/10.1063/5.0245167)
- Glueckauf E (1955) Formulae for diffusion into spheres and their application to chromatography. *Trans Faraday Soc* 51:1540–1551. doi:10.1039/TF9555101540
- Hoffman AJ, Karp RM (1966) On nonterminating stochastic games. *Management Science* 12:359–370. doi:10.1287/mnsc.12.5.359
- Grudeva Y, Moroney KM, Foster JM (2026) A multiscale model for espresso brewing: asymptotic analysis and numerical simulation. *Eur J Appl Math* 37:496–519. doi:10.1017/S095679252500018X
- Kell GS (1975) Density, thermal expansivity, and compressibility of liquid water from 0° to 150 °C. *J Chem Eng Data* 20:97–105. doi:10.1021/je60064a005
- Kestin J, Sokolov M, Wakeham WA (1978) Viscosity of liquid water in the range −8 °C to 150 °C. *J Phys Chem Ref Data* 7:941–948. doi:10.1063/1.555581
- Lee WT, Smith A, Arshad A (2023) Uneven extraction in coffee brewing. *Phys Fluids* 35:054110. doi:10.1063/5.0138998
- Mateus M-L et al. (2007) Interactions of water with roasted and ground coffee in the wetting process investigated by a combination of physical determinations. *J Agric Food Chem* 55:2979–2984. [doi:10.1021/jf062841g](https://doi.org/10.1021/jf062841g)
- Moreno FL et al. (2015) Rheological behaviour, freezing curve, and density of coffee solutions near freezing. *Int J Food Prop* 18:426–438. doi:10.1080/10942912.2013.833221
- Scharfetter DL, Gummel HK (1969) Large-signal analysis of a silicon Read diode oscillator. *IEEE Trans Electron Devices* 16:64–77. doi:10.1109/T-ED.1969.16566
- Waszkiewicz R et al. (2026) Under pressure: poroelastic regulation of flow in espresso brewing. *Phys Fluids* 38:063113. doi:10.1063/5.0319611
- Research note 01 ([extraction and flow physics](../research/01-extraction-and-flow-physics.md)) §3–§6, §8, §10; [particle-kernel.md](particle-kernel.md); ADRs 0002, 0005 and 0008.

The DOIs of Bokanowski 2009, Hoffman & Karp 1966, Kell 1975, Kestin 1978 and Scharfetter & Gummel 1969, and the Abramowitz & Stegun citation, are given from the publications' records and were not re-checked against Crossref here (Corrochano 2017 is as cited in `data/params/extraction.yaml`). For M1.1 the Foster paper and Mateus abstract were read from primary publication records; the remaining references follow research note 01.
