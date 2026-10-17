<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 0012 — Mobile liquid and total particle solute inventories

**Status:** Accepted, 2026-10-16. Supersedes the solute-holdup interpretation of
[ADR 0010](0010-startup-water-and-pore-air.md); its hydraulic and thermal water
budgets and fixed pore-air closure remain applicable.

## Context

Corrochano's measured partition coefficient uses **total** solute per particle
envelope volume, including internal pore solution and matrix-attached solute.
The 0.3–0.5.1 equations also placed that pore water at the mobile concentration,
overlapping equilibrium capacities. The [source audit](../research/05-water-and-particle-inventory.md)
derives the discrepancy and explains why changing K alone omits transient terms.

## Decision

Keep mobile solute in intergranular liquid, with storage εwVc, and retain total
particle-loading states. The sharp front still consumes all selected pore water
and the thermal node still includes it. For each cell, newly filled particle
water is b = (1−ε₀)ε_p f_water V Δw. Allocate b by particle-envelope volume to
each size class and its broken-shell pool/kernel shares. It carries b c′ from
the mobile inventory into those reservoirs. This is a declared uniform-source
closure, not an experimentally identified internal-water exchange law.

Condense the source in the implicit particle solve and use the exact total
particle mass change as the mobile source. For backward Euler the kernel's
uniform-source response is z = (V+hK)⁻¹V1, algebraically 1 minus its unit boundary
response; solve it directly to retain positivity for very stiff kernels. The
surviving source contributes a nonnegative mobile diagonal. Surface pools use
the corresponding source-inclusive affine loss in each saturation regime.

Separate wet and dry populations exactly. The wet population starts from
[u−(1−w_end)u₀]/w_end, including the initial loading of newly wetted particles;
the dry remainder keeps u₀. Apply the same ownership to pools and species.
Use backward Euler throughout an advancing front step, including the step
that finishes wetting a cell. This also preserves a partial cell during a dwell.

Recipe builds use the uncapped, source-defined kernel partition relation.
Raw specs retain an optional excess-loading restriction, but its boundary is
now min(c/(Kε_c), u₀+βc/ε_c), β = ε_p f_water. The aqueous term is necessary:
a fixed u₀ ceiling expelled newly carried solute and concentrated the front.
The surface-pool deposition ceiling is initial content plus cumulative carried
solute. Commit its increments only after all lumped column solves converge.
Neither restriction is a measured adsorption capacity.

Species receive their own carried b c_s′. Separate front carriage from exchange
before deriving congruent dissolution factors; restore the untouched dry pool
after the step. Identical species must scale every cup value exactly up to
round-off, including when carriage and dissolution happen simultaneously.

## Consequences

For a closed, fully wetted, uncapped pure-kernel bed, the equilibrium capacity
is V[ε+(1−ε₀)/K]. Selected startup pore-water fraction and reference loading
normalization no longer add an extra equilibrium capacity. Local EY may be
negative when a particle receives solute carried from elsewhere; conservation
and positivity are the relevant invariants, rather than a blanket zero lower
bound on local EY.

The v3 calibration uses Schmieder's qualified wet CDF and published D32, preserves
v1/v2, and retains the original calibration blocks, holdouts, priors and scientific
gates. Wet dispersion fines are not independently established dry-puck geometry.
Their ±1 SD D32 variants are sensitivity refits, not extra observations or a
selection rule. Existing E65S preset geometry remains the basis for mapping the
V1 nuisance permeabilities to the application's reference permeability.

Independent tests cover source-defined equilibrium, an exactly partial wet bed,
negligible-diffusion front carriage, zero surface exchange, identical/zero species,
and refinement. Randomized tests retain conservation and positive-solvent checks.
These establish the numerical accounting, not experimental accuracy.

## Alternatives considered

- Subtract internal-water capacity from 1/K while leaving the transient equations
  unchanged: rejected because the transformed particle state gains time-derivative
  terms and need not remain nonnegative.
- Remove mobile pore-water storage without transferring its carried solute:
  rejected because the hydraulic front then consumes water without its solute.
- Add carried solute after a capped solve: rejected because subsequent steps can
  forcibly release it, and net pool loss hides simultaneous species carriage.
- Fit a new internal-water exchange rate: deferred because the reviewed sources
  do not identify it independently of storage, delivery and particle geometry.
