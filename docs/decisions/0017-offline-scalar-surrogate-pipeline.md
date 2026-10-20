# ADR 0017: frozen offline scalar surrogate experiments

## Status

Accepted, 2026-10-19. Experimental M6 speed tooling in 0.11.0; browser integration
and the full surrogate targets remain open.

## Context

The live browser preview produces a complete shot result consumed by curves,
chemistry, taste and spatial views. A small scalar neural network cannot produce
those fields. M6 calls for surrogate speedups, held-out error measurements,
uncertainty assessment, versioned models and physics fallback outside the
training domain. Those requirements need reproducible training evidence first.

## Decision

- Begin with offline tools for one explicitly fixed recipe family and four
  continuous controls. Use the exact Tier 1 native core as the teacher. Keep the
  browser, inverse solver, journal forecasts and Explore on their existing APIs.
- Generate independent seeded scrambled Sobol streams for training, residual
  calibration and final testing. Reserve every domain corner for an additional
  boundary test. Retain failed/capped teacher runs and refuse to train over them.
- Fit three independently initialized 4 → 16 tanh → 3 networks using existing
  NumPy/SciPy dependencies and analytic gradients. Fit output scales only on
  training rows. Freeze architecture, seed and optimizer controls before reading
  the final evaluation; do not retry against test errors.
- Predict pump-stop time, actual final beverage mass and cup EY. Derive TDS from
  EY × dry dose / final beverage mass, including the teacher's post-stop drip.
  Never equate the requested beverage stop with the final cup mass.
- Record absolute-unit errors and maximum error divided by the training output
  range for both test and boundary sets. Apply the existing 1% range target
  without loosening it after observing results. Report optimizer limits and
  unsuccessful qualification as valid experimental results.
- Use a separate calibration split for absolute-residual approximation-error
  bands. Report observed simulator coverage without claiming physical,
  measurement or sensory uncertainty, or a formal Sobol coverage guarantee.
- Lock artifacts to core version, effective embedded registry/presets, source
  inputs and deterministic native behavior probes. Use bounded JSON with full
  SHA-256 identities, strict dimensions, finite values and explicit units.
- A separate offline scalar prediction API checks qualification, compatibility,
  the full fixed recipe template, feature supports and physical/algebraic bounds.
  Any failed guard selects an actual Tier 1 run of the supplied physical recipe.
  Results state their source and reasons; they never impersonate a full shot.
- Keep browser approval false and keep these artifacts outside production web
  assets. Refuse output overwrites by default to preserve frozen evaluations.

## Consequences

The first artifact is intentionally narrow. Equivalent-looking recipes with
extra fields can conservatively fall back to physics. Passing finite held-out
points does not prove uniform error everywhere in the support box. Compiled
behavior probes help detect stale extensions but are not exhaustive build
attestation. Compatibility checks have a cold-start cost; probe results are
cached only for an unchanged loaded teacher identity.

This supplies a replayable experimental baseline. It does not establish a
browser speedup, a 30–40-input emulator, curve emulation, calibrated real-shot
uncertainty or public-launch readiness. Existing scientific limitations remain.

## Alternatives considered

- Replace the full preview with guessed curves/species/spatial fields: violates
  the shared-state contract and creates information the scalar network lacks.
- Ship a model before measuring fixed test and boundary errors: no defensible
  compatibility or accuracy gate.
- Randomly discard failed or slow runs: hides difficult parts of the domain.
- Add a large ML runtime immediately: unnecessary for this small offline MLP;
  a browser evaluator belongs in a later shared-core integration step.
