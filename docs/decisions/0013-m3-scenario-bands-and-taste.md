# 0013: Scenario uncertainty and explainable taste

**Status:** Accepted, experimental · 2026-10-18

## Context

M2 supplies compound transport and cup chemistry, with sparse measured anchors and
substantial estimated composition. Input descriptions often stand in for unknown
particle sizes, roast age, lot composition and water analysis. A precise central
simulation cannot express those unknowns. Neither the existing calibration nor the
available sensory evidence establishes a calibrated espresso taste predictor.

## Decision

Use a separate, explicitly requested, deterministic ensemble in the shared Rust
model. Evaluate inexpensive Tier 0 scenarios while preserving the normal Tier 1
result. Configure each uncertain input group as unknown, measured or fixed, with
registry-backed estimated scenario widths. Preserve correlations inside PSD and
water scenarios and respect recipe overrides.

Report empirical scenario quantiles, sample counts, assumptions and missing error
sources. A 5th–95th percentile scenario range is not a 90% predictive or confidence
interval. Compare the central Tier 0 preview with Tier 1 explicitly; do not hide
solver discrepancy inside an arbitrary band inflation. Align trajectories by
fractional shot duration, with that coordinate visible wherever they are shown.

Compute taste indices from chemistry in Rust. Show the drivers and coefficients,
their evidence, and the omitted interactions. All absolute indices have low trust;
they are relative explanatory scales rather than panel scores, liking or quality.
Propagate the input scenarios through the taste mapping without claiming to cover
sensory model error or differences among tasters.

Keep calculations local to browser workers. Cancellation terminates the worker as
for existing simulations; no telemetry, remote inference or shared-memory headers
are required.

## Consequences

Users can inspect how uncertain inputs affect predicted outcomes and see why a
taste estimate changes. Reproducible seeds support comparisons and bug reports.
Setting all groups fixed can collapse the input bands, while the omitted model
errors remain. No M1 or M2 scientific gate is closed by adding these features.

The detailed contracts are [uncertainty](../model/m3-uncertainty.md) and
[taste](../model/m3-taste.md). Verification and scientific validation remain
separate in the release report.

## Alternatives considered

- **Full Tier 1 ensembles by default:** too costly for interactive use before
  broader performance work; Tier 1 remains available as the central reference.
- **Treating grade-based widths as calibrated posteriors:** no data establish
  coverage, and this would overstate certainty.
- **An independent JavaScript taste model:** would break the shared-engine rule
  and permit the Python and browser results to disagree.
- **Learning from personal ratings now:** belongs to the local journal and
  personalization milestone, M4.
