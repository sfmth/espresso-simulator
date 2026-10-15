# 0009: Shot solver numerics and the bare base permeability

- **Status:** Accepted
- **Date:** 2026-10-14
- **Specification:** [docs/model/shot-model.md](../model/shot-model.md)

## Context

The M1 shot solver (`puckcore::shot::simulate_shot`) has to:
- couple flow, wetting, dissolution and diffusion in up to 64 columns × 1000 depth cells × 200 size classes;
- stay within 1 s per Tier 1 shot and 10 ms per Tier 0 shot, natively and in WebAssembly;
- conserve soluble mass to round-off;
- give bit-identical results on every target (ADR 0002).

The parameter registry's in-shot permeability (1.8e-15–1.5e-14 m²) was back-calculated from published shots as κ = QμL/(AΔP), using water viscosity and no compaction.

## Decision

- **Columns are stream tubes.** Each heterogeneity column is a radial annulus of the real basket geometry. It keeps its share of the cross-section at every depth, with no cross-flow. Flow is Darcy series resistance along each column, and the columns share the inlet pressure.
- **Hydraulics use a Heun predictor–corrector per step.** The wetting front is tracked as a wetted volume. Events are hit exactly: headspace full, phase exits, stop, mass targets within 0.1 mg.
- **Transport is one implicit step per column.**
  - Bed liquid and surface pools use backward Euler.
  - Kernels use BDF2 or backward Euler, per ADR 0005.
  - Kernels and pools are eliminated cell by cell. This leaves one tridiagonal M-matrix per column, for the new liquid concentration.
  - Saturated and unsaturated pool regimes are resolved by policy iteration (Howard's algorithm), keeping a regime within a 1e-10 band of its switch point.
  - Conservation and positivity hold by construction and are checked every step.
- **Tier 0 is the same model, coarsened:** 3 permeability strata plus the edge column, 8 cells, 2 classes, and 2-shell kernels for coarse classes. The first version had 1 column and linear-driving-force kernels; an independent review found it 25% off for uneven beds.
- **Heterogeneity strata are equal-probability, with conditional means** of the log-normal permeability distribution.
- **Wetting.** The liquid holdup includes imbibed water, so solute carried into particle pores is conserved and never precipitated. The first version let the liquid supersaturate at the front.
- **Partition.** K is Corrochano's coefficient, per swollen-particle envelope volume, and the kernel boundary value is c/(K·ε_p). Kernel re-uptake is capped at the initial content by default (`solubles.kernel_loading_cap`). Linear partition is measured only at dilute concentrations, whereas espresso liquid is near saturation.
- **θ = 0 by default.** Insoluble cell walls (about 70% of the dry mass) hold the particle envelope, so dissolution raises intraparticle porosity, not ε. The calibration data cannot identify θ. Because θ is collinear with κ₀, it is fixed by this mechanism, and the validation report shows the sensitivity.
- **The drip drains only the headspace water,** or nothing when a 3-way valve vents the group.
- **Unconverged steps are rejected.** If the pool regimes do not converge within the solve limit (100 + 4 × cells × classes per column), the step is retried at Δt/2 by backward Euler. Unconverged choices are never accepted.
- **Liquid volume equals total porosity.** Pools and kernels hold the pore liquid ε_p(1 − u_w); the mobile holdup is ε plus the imbibed share.
- **Determinism.** Only IEEE basic operations and `crate::math` are used; `crate::math` now has `ln` and `expm1` too. The WebAssembly module imports no maths functions.
- **κ₀ is a bare permeability, calibrated within this model.** The solver multiplies κ₀ by its own compaction, swelling, gas, dissolution and viscosity factors. A back-calculated in-shot value therefore cannot serve as κ₀ without counting those effects twice. The input models read κ₀ from a calibrated registry parameter, `hydraulics.permeability.reference`; the in-shot record remains a validation target and a prior for effective permeability.

## Consequences

- **Measured performance,** final (native / WebAssembly, on a loaded machine): tier 1 takes 16 / 20 ms for the default spec and 343 / 471 ms with 30 classes + 4 species; tier 0 takes 2.6 / 3.2 ms. Species with identical parameters share one solve; 55 distinct species cost 280 ms on the default spec.
- **Verification:**
  - conservation within 1e-14 at default stiffness (8.9e-11 at the parameter bounds), with an independent outflow-integral check;
  - 20,000 random specs without failure;
  - native and WebAssembly bit-identical on every replayed number;
  - analytic checks listed in shot-model.md §8.
- **Tier 0 against tier 1** (EY, relative): within 2.9% in every tested regime after the final fixes. Shot time agrees within 0.6%.
- **Physics without radial redistribution.** Effects that need it, such as 2D flow in tapered baskets or hole patterns, enter only through the edge multiplier until Tier 2.
- **Calibration owns κ₀.** The M1 calibration gives 1.24e-13 m² at the reference Sauter diameter, but the two datasets behind it disagree about 3×. γ and P_c are calibrated too; θ is fixed by mechanism; swelling stays at its registry value. With these values, held-out shots run at 0.43–0.47× the measured times. The missing slow start-up transient, not κ₀, explains most of that (`docs/validation/m1-validation.md`).
- **Debug builds optimise `puckcore` at `opt-level = 3`**, because unoptimised solver tests took minutes. Results do not change, because Rust neither contracts nor reorders floating-point operations.

## Alternatives considered

| alternative | why rejected |
|---|---|
| Explicit or operator-split transport | step limits from fast pools and fines; splitting errors in the mass balance |
| A generic Newton solver for the pool regimes | heavier, needs damping, and gives no exact termination; policy iteration solves 96% of steps in one solve |
| 2D axisymmetric flow in M1 | out of the Tier 1 budget; planned as Tier 2 |
| Use the back-calculated in-shot κ as κ₀ | counts compaction, viscosity, swelling and warming twice; preset shots took 78–101 s |
