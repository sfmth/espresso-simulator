# 0014: Local journal, calibration and constrained advice

**Status:** Accepted, experimental · 2026-10-18

## Context

M4 needs private shot records, explainable local adaptation and inverse advice.
The published physics has substantial structural errors. Time alone cannot
separate grinder scale, permeability and startup mechanisms. Browser-only
personalization must not change the published fit or count training results as
prospective validation.

## Decision

- Keep the journal in IndexedDB; acknowledge a write only after its transaction
  commits. Reject stale-tab writes. A clearly labelled memory fallback supports
  browsers without storage. Export is the user's backup.
- Save an immutable recipe, executed calibrated recipe, engine version, summary
  and optional taste estimate before accepting an observation. Imported
  predictions carry imported provenance and cannot establish V9.
- Orchestrate existing engine worker calls from TypeScript. All forward physics
  and chemistry remain in the shared Rust implementation; no simulator is
  duplicated in the interface. Local learning/search are browser services,
  with no new native API in this release.
- Use finite-grid Bayesian quadrature over a permeability multiplier and,
  optionally, grinder particle-size scale. Require three measured settings with
  TDS before attempting the joint fit. Report marginal intervals, posterior
  correlation and local sensitivity confounding. Other mechanisms stay fixed.
- Search on bounded equipment lattices with deterministic multistart coordinate
  refinement. Rank only candidates that complete Tier 1 rechecks. Final cup
  targets include drip; pump-stop corrections are bounded and disclosed.
- Keep a Bayesian personal rating model separate from M3's taste indices.
  Personal ranking is optional and requires varied ratings; its conditional
  uncertainty does not establish sensory accuracy.
- Keep prospective timing and complete time/EY scorecards separate. Require ten
  eligible post-calibration forecasts, excluding every saved fit's training IDs.

## Consequences

Everything stays on the device; users can lose journals when browser data is
cleared. Imports validate before committing and never execute Tcl or formulas.
Grid resolution, prior assumptions, Tier 0 approximation and structural physics
error limit calibration. Bounds and finite search budgets do not guarantee a
global optimum. Fits bind to the bag/equipment scope and engine version and do
not transfer across temperature changes. V9 remains an empirical future target.

## Alternatives considered

The plan's MCMC/Laplace methods and continuous Nelder–Mead/CMA-ES remain useful
future options. A small explicit grid and equipment lattice are inspectable,
deterministic and bounded in this initial browser implementation. Fitting all
listed setup mechanisms together would overstate what a few local observations
identify. A server journal would violate D9.
