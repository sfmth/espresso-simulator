# 0015: Coupled Explore state and explicit depth refinement

**Status:** Accepted, experimental · 2026-10-18

## Context

M5 needs a particle view that agrees with the shot's continuum state and remains
usable without WebGPU. A separately rerun sphere diffusion model would lose the
actual wetting, liquid concentration and flow history. A visually plausible
packing or pore network could also be mistaken for a resolved physical field.
The requested high-resolution option must be explicit about which equations and
numerical grid change. Laptop/phone frame-rate gates need actual device evidence.

## Decision

- Add an opt-in selected-cell export to the existing shared Rust shot solver.
  Export actual kernel-shell and surface-pool state at the same snapshot clock,
  plus class metadata, column flow and the single-node bed temperature. Ordinary
  results omit these additive fields. Validate selection and bound export size.
- Keep one recipe store, one catalog loader and one automatic/full controller
  above Lab and Explore. Detailed Explore runs force Tier 1 on the existing
  full-run channel; cancellation and supersession protect the shared result.
  One stored-snapshot index drives the cross-section and inspector.
- Name the choices standard and high-resolution **parallel 1D Tier 1**. High
  multiplies the built depth grid by five, normally 30 → 150 cells, and records
  the actual grid in the result. It does not introduce a new global fidelity
  tier. The future 2D axisymmetric Tier 2 model remains deferred.
- Generate the representative packing in a module worker with seed 20261018.
  Preserve PSD-class volume/dry-mass shares through statistical weights so the
  displayed class extraction reproduces the selected continuum cell. Refuse
  missing/mismatched state rather than reconstructing it from an unrelated run.
- Use bounded soft-sphere relaxation with visible residual-overlap diagnostics.
  Solve a small clearance-based pore lattice with conjugate gradients for an
  optional illustration. Its dimensionless potentials and normalized edge flows
  do not update the physical shot model or become shot pressure/permeability.
- Render Three.js WebGL2 instanced sphere impostors, with 5,000/25,000 mobile and
  30,000/150,000 desktop display budgets. Display count is independent of the
  extraction grid. Require no WebGPU and retain SVG/cross-section/table fallbacks.
- Provide explicit guided recipe loads with Undo and evidence labels. Loading may
  trigger the usual cheap preview; detailed particle export waits for Run Explore.
- Keep G5 open until the specified laptop and phone frame rates are measured.
  A current-device measurement tool and software-rendered smoke tests cannot
  establish those hardware gates.

## Consequences

The inspector follows the actual coupled history, and numerical tests can check
class-weighted local EY against the continuum without fitting a visual result.
Only one cell's detailed state is exported per run; inspecting another cell needs
another explicit run. High resolution costs additional solver time and can
produce different discretization results. Large display budgets cost packing,
picking and rendering time without adding extraction physics.

A statistical representative volume is not a scanned microstructure. Approximate
packing can retain overlaps, and the small lattice may be disconnected or fail
to converge. Those diagnostics stay visible. Its geometry and flow remain
illustrative even when a numerical residual is small. Existing scientific
accuracy targets and calibration/source splits are unchanged. G4 representation
checks do not establish empirical validity, and G5 is not claimed passed.

## Alternatives considered

- **Independent browser sphere runs:** rejected because they would not retain the
  selected cell's coupled liquid and wetting history.
- **WebGPU-only packing/rendering:** deferred because platform support and device
  measurements do not justify making it a requirement. The worker/WebGL2 path
  and fallbacks support the initial implementation.
- **A new 2D Tier 2 solver:** remains research work. Refining the existing depth
  grid is a bounded numerical option and must not be presented as lateral physics.
- **Feeding the displayed pore network back into extraction:** deferred until its
  geometry, closure and validation support a physical coupling. A CG residual
  alone does not establish that coupling.
