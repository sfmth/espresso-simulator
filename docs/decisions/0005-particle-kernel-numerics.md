# 0005: Particle-kernel numerics

- **Status:** Accepted
- **Date:** 2026-10-14
- **Details and measurements:** [docs/model/particle-kernel.md](../model/particle-kernel.md)

## Context

Every particle in the extraction model is a diffusing sphere ([PLAN.md §7.3](../PLAN.md#73-modules), module X). M0 verifies the kernel on the perfect-sink sphere, which has an exact solution (Crank 1975). M1 couples the same kernel to the bed liquid. The kernel must be:

- conservative and second order;
- robust for stiff steps;
- bit-identical between the native and WebAssembly builds ([ADR 0002](0002-rust-core-shared-by-browser-and-python.md));
- cheap enough for the Tier-1 budget of 1 s per shot.

## Decision

- **Space.** Finite volumes on spherical shells, with shell averages as unknowns.
  - Face conductances are exact for every profile c = A + Br², and are written without cancellation.
  - Two grids are available: equal-volume shells (the default) and equal-thickness shells.
- **Time.** Three schemes:
  - BDF2, the default;
  - backward Euler, which stays non-negative in floating point;
  - Crank–Nicolson with four backward-Euler half-steps at the start (Rannacher start-up).
- **Start-up refinement.** The first 4 output intervals run on 8 sub-steps each, for every scheme; `SolverOptions` can change both numbers. The release grows like √t at the start, and without refinement that error dominates.
- **Mass accounting.** The released mass is accumulated with each scheme's own time discretisation, and summed with compensated (Neumaier) summation.
- **Linear algebra.** The systems are solved for the new concentrations, not for increments, which keeps positivity and relative accuracy under stiff steps. The tridiagonal matrices are M-matrices, so each is LU-factorised once per run, without pivoting.
- **Determinism.** `puckcore::math` implements `exp` and `cbrt` from basic IEEE-754 operations, so no platform maths library affects results.

## Consequences

**Measured on the reference case** (a = 150 µm, D = 1e-10 m²/s, 60 s, 64 equal-volume shells, 2000 BDF2 steps):

| quantity | value |
|---|---|
| max error vs the analytic solution | 5.14e-4 (target < 1e-3; the placeholder gave 1.03e-2) |
| error at τ = 0.1 | −4.99e-6 |
| mass balance | 5.4e-14 |
| runtime | 0.63 ms native; 0.72 ms in WebAssembly |

**Observed orders.** Space: 1.98 on the equal-volume grid, 2.00 on the uniform grid. Time: 1.00 for backward Euler, 2.00 for BDF2 and Crank–Nicolson. At equal N, the equal-volume grid is about 7× more accurate at τ = 0.1.

**Determinism.** All 255,640 values compared were bit-identical between native and WebAssembly.

**Where the max error sits.** It occurs at the first output and scales as C/(N²√Δτ), so at fixed N it does not shrink as Δt shrinks. The model document gives the rule for choosing N.

**Positivity.** Backward Euler never goes negative. BDF2 and Crank–Nicolson can, for steps that don't resolve the slowest decay (Δτ > 0.04). Crank–Nicolson also undershoots late in depletion (τ > 1), because it is A-stable but not L-stable. BDF2 with Δτ ≤ 0.01 stays positive out to at least τ = 20.

**M1 follow-up.** Fine particles (radius 3–25 µm) stepped at bed time steps of about 0.05–0.2 s have very large Δτ. The core review measured the options on 16 equal-volume shells, and they are not interchangeable:

| option | at Δτ = 0.2 / 1 |
|---|---|
| BDF2 | minimum c/c0 −3.1e-2 / −3.8e-2; with the default start-up the released fraction even decreases for Δτ ≥ 0.2 (solute flows back in) |
| Crank–Nicolson | minimum c/c0 −5.6e-4 / −9.0e-4 |
| TR-BDF2 | minimum c/c0 −0.10 / −0.27, and an overshoot to 0.38 against a bed concentration of 0.3 |
| linear driving force | 17% / 11% low after one step at Δτ = 0.01 / 0.04 |
| backward Euler | positive and monotone, 1–2% off at Δτ = 0.04–0.2 |

Default plan for M1, to be confirmed in its own ADR:
- **Δτ > 0.04:** backward Euler for any size class above that step. Its M-matrix keeps the condensed bed system an M-matrix.
- **Below 0.04:** BDF2.
- **Tier 0:** keep the linear driving force there only.
- **TR-BDF2:** drop it.
- **The more accurate option for fines:** precompute the exact propagator exp(−Δτ·V⁻¹K) once per size class and step size. It is non-negative and exact in time: error 8e-5 at Δτ = 0.2 and 6e-7 at Δτ = 1, measured. It costs N² flops per step.

**Mass balance at very large N.** The error grows with the number of shells times the stiffness of the step: about 1e-8 at 100,000 shells. That is still far inside the PLAN §10 target of 0.1% per run.

## Alternatives considered

| alternative | why rejected |
|---|---|
| Volume coordinate u = (r/a)³ with face coefficients u^(4/3) | order ≈ 1.6, because c is not smooth in u at the centre |
| Steady spherical conductances between centroid radii | order ≈ 1.6 |
| Solving for increments | better round-off, but loses relative accuracy under stiff steps: 59% release instead of 100% at τ = 1e6 with 100,000 shells |
| No start-up refinement | max error 5.3e-3 with BDF2, ten times larger |
| Platform `exp` and `cbrt` | glibc and the WebAssembly maths library can differ in the last bit, which breaks bit-identical results |
