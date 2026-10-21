# ADR 0019: infer equipment before dialing in a shot

## Status

Accepted, 2026-10-21, following the owner's planning answers and explicit request
to implement the new tabs, optional first-visit setup, and illustrated controls.
This supersedes the mandatory-wizard portion of
[ADR 0018](0018-visual-equipment-and-first-visit-setup.md). Its diagram, local-data
and fixed-cookie requirements continue to apply.

## Context

The earlier Dial in page mixes equipment calibration, future predictions and
recipe search. It requires a saved prediction before recording a calibration
shot and fits a narrow model. The owner instead wants to describe known facts
about a real shot, let an inverse solver find possible unknown settings, retain
several explanations, and then predict future shots after choosing a setup.

The approved example includes known WDT, flat burrs, a displayed machine setting
of 95°C, and 35 g in 36 seconds. Display temperature must not silently become
inlet-water temperature. New boiler, thermoblock and PID physics are explicitly
deferred until after the setup-inference workflow.

## Decision

Use four tabs in this order: **Set up equipment**, **Dial in**, **Lab**,
**Explore**. Replace the first-visit wizard with a dialog offering equipment setup
or native-validated defaults. Setup reuses the complete illustrated Lab editor
and the shared recipe store. Users may also save specified settings without
fitting observations.

Add exact, ranged and unknown knowledge states around supported physical inputs
and registry coefficients. Unmarked values are fixed assumptions. Record one
real shot directly, then allow more observations to constrain the same setup.
An explicit list of known per-shot changes handles varied dose/grind/temperature
without treating every snapshot field as known.

Run bounded seeded search with inexpensive exploration and full Tier 1 replay
of every returned candidate against every observation. Match mass and optional
TDS using the observed timing convention and measurement tolerances. Observed
time is a replay condition; it is not independent evidence of prediction accuracy.
Keep distinct matching alternatives with their evidence and make activation an
explicit action. Scope and limitations are detailed in the
[equipment-inference contract](../model/setup-inference.md).

Use selected equipment for future Dial in predictions and comparison across
alternatives. Preserve the old journal/calibration data, but do not apply the
older calibration overlay on top of an active inferred setup. Keep the older
prospective scorecard explicitly associated with earlier local calibration.

Persist an independently versioned local setup document and provide bounded JSON
backup/restore. Validate before writes and imports, reject stale results and
profile-version mismatches, support cancellation, and retain session-only work
when browser persistence fails. Continue the fixed setup-completion cookie;
entered values remain in local storage.

## Consequences

Users can work in the order they described: establish possible equipment,
choose an active setup, then dial in a future shot. Multiple explanations remain
visible instead of implying that one shot uniquely identifies a machine.
Detailed images have a direct role in selecting and constraining settings.

The optimizer searches supported values inside the chosen recipe structure. It
does not vary every possible profile/geometry topology, invent a physical effect
for recorded-only fields, or prove complete coverage of a continuous domain.
Bounds, tolerances and fixed assumptions materially affect the answers. Inferred
values remain conditional on the simulator's existing physics.

This increases local state and verification responsibilities. Tests must cover
categorical replacements preserving constraints, per-shot overrides preserving
shared inferred values, compatible grinder dial semantics, native failures,
timing/drip conventions, stale activation, local-storage failure, import
consistency and cross-tab edits. Production browser checks cover the complete
workflow, including cancellation, persistence, alternative predictions and
keyboard/narrow-screen behavior.

## Alternatives considered

Keeping a single best fit would hide non-identifiability. Treating all current
fields as known would constrain guesses as facts. Automatically searching all
unmarked fields would make routine setup expensive and unclear. A mandatory
wizard would conflict with the owner's explicit option to skip using defaults.
Adding heater/PID equations now would combine two separately staged changes.
