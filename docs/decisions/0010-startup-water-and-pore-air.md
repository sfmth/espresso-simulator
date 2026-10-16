<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 0010 — Startup water inventory and an effective pore-air closure

**Status:** Accepted, 2026-10-15. Extends ADR 0009; no validation threshold changes.

## Context

M1's held-out shot timings and transient flow fail their targets. The core charged the pump for intergranular water and a fraction of intraparticle water, while its documentation described the remaining particle pore volume as already liquid-filled. Filling that missing water requires a consistent transport holdup; slowing only the front would cause solute to concentrate into too little liquid. Roast-dependent CO₂ alone also does not represent initially dry pore air.

[Foster et al. (2025)](https://doi.org/10.1063/5.0245167) demonstrate the importance of infiltration, pump behavior and headspace dynamics, while identifying the lack of measured saturation–permeability relations for coffee. That supports investigating startup physics; it does not supply a calibrated relative-permeability law. [Mateus et al. (2007)](https://doi.org/10.1021/jf062841g) infer moisture diffusivities around 2–3 × 10⁻¹¹ m²/s from swelling. Applying that scale to hydraulic connectivity is an additional assumption.

## Decision

Add three backward-compatible spec fields, disabled by default in raw shot specs:

- `intraparticle_water_fraction`: explicit water-filled share of intraparticle porosity, or null for the legacy `wetting_uptake` share. The front, liquid holdup and thermal capacity use the same value.
- `pore_air`: amplitude and relaxation time for a local dry-pore connectivity penalty. A cell's clock starts when it wets; an initial dry pause cannot relax it.
- `pore_air_permeability_exponent`: power n in the relative permeability `(1 − A exp(−wet_age/τ))^n`.

Recipe construction selects full initial pore capacity, A = 0.5 and n = 3, and estimates τ = (D32/2)²/(π² D_water), capped at the solver's existing 600 s relaxation bound with a visible note. These are fixed, grade-D assumptions in `data/params/startup.yaml`, with sources and sensitivity ranges. They were not fitted to held-out startup times. The closure represents effective liquid connectivity, not literal gas saturation, so it does not change the volume inventory or prescribe a delay in seconds.

With explicit water capacity, the particle pool and kernel states are effective soluble loadings, expressed using their existing capacity normalisation. They are not another water inventory. This is a single-liquid approximation: the added pore water participates in local transport holdup. It does not resolve finite-rate uptake into a separate immobile liquid, internal saturation, or gas mass transfer.

Headspace fill remains sequential and vented. Integrate the capped fill program exactly and land on its fill event; bound final drip delivery by the water actually left. Report `hydraulic_volume_balance_error` independently of the soluble mass balance. The former uses the solver's incompressible carrier-volume convention and must not be presented as a solvent-mass balance including dissolved-solids displacement.

## Consequences

Existing raw JSON remains accepted and can reproduce the legacy closure. Recipe-built shots account for more startup water and can recover permeability over a longer period without changing the late-time bare permeability. Quantitative predictions remain conditional on uncertain assumptions; the validation report must continue reporting failed targets and distinguish numerical verification from experimental validation.

Verification covers an independent analytical full-pore filling time, a capped ramp, pump-off and dry-wait behavior, partial wetting, drip/vent conservation, disabled limits, late-flow recovery, solute positivity and timestep convergence. Browser/native determinism still uses the same Rust arithmetic, including the deterministic logarithm/exponential for non-integer powers.

### Outcome of the v2 calibration and validation

The startup change improves the held-out V4 timing estimates but does not meet their targets: first drops are 6.83 s after full pressure against 12.76 s observed; the flow-rise time is 12.08 s against 25.48 s; 36 g arrives at 30.47 s against 47.69 s. Generic recipes reach the 36 g pump-stop target in 15.6–17.0 s, still below the 25–35 s sanity range. Their reported final extraction includes post-stop drip.

The refitted extraction model regresses: V1 rates within ±10% fall from 57/60 to 48/60, and cup masses from 167/180 to 163/180. Leave-one-condition-out rates within ±15% fall from 59/60 to 54/60, and cup masses from 179/180 to 178/180. Enlarging the effective liquid holdup changes dilution and residence time; the present fit does not preserve M1's extraction accuracy. All three M1 scientific exit criteria remain unmet. This decision records an experimental model increment, not a validated resolution of startup physics. The [validation report](../validation/m1-validation.md) and [fixed-parameter ablations](../validation/m11-startup-sensitivity.json) retain the failures; the latter hold the v2 fit fixed and are not reproductions of the archived v1 model.

## Alternatives considered

- A fitted fixed startup delay would not respond to water capacity, pump delivery or local wetting and would not explain a rising flow. It was rejected.
- Increasing the front's uptake without increasing holdup would break the water/transport relationship. It was rejected.
- An explicit dual-porosity/two-phase model and simultaneous compressible headspace dynamics would provide a more detailed model, but need additional state, transport closures and independent parameter evidence. They remain follow-on work.
