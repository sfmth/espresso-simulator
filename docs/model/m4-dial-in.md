# M4: experimental Dial-in contract

Version 0.8.0 · 2026-10-18. Implementation: `web/src/dialin/`.
The shared Rust physics, published calibration and original scientific targets
are unchanged. Personal measurements are optional; V9 remains open.

## Recipe and records

Dial-in uses the same recipe store as the Lab. Basic controls change bean,
grinder, dose, pump-stop beverage target and temperature; **Edit full recipe in
Lab** exposes custom equipment, water, profiles and overrides. A separate
explicit Tier 1 prediction calls the existing worker engine. It does not mount
a second live-preview controller.

The journal document is `puckworks.journal/1`, containing `entries` and
`calibrations`. Each entry has an ID, creation time, user bag/setup name, nominal
recipe and provenance. Its optional immutable prediction records time, core
version, executed recipe, summary, taste and calibration ID. Observations record
pump-on to pump-off seconds, final cup grams including drip, optional TDS in
percent, a 1–5 rating and notes. EY percentage points are
`TDS_percent * final_cup_g / dry_dose_g`.

An IndexedDB write resolves after transaction completion. Concurrent stale tabs
are rejected with a reload instruction. Failed writes do not appear as saved.
Unavailable/blocked storage falls back to a session journal with a visible
export reminder. Export/import uses JSON; duplicate identical records are
idempotent, conflicting IDs are rejected. External forecasts become imported
and cannot attest prospective order. Browser storage deletion is permanent
without an exported backup.

JSON is limited to 10 MB and 10,000 entries. Imports validate recipe schema,
finite numbers, observation ranges, IDs, dates and bounded structure before a
single commit. CSV/DE1 log files are limited to 2 MB.

## Shot-log imports

CSV requires `time_s,yield_g`; optional columns are `dose_g,setting,tds_percent,
rating,label,notes`. Quoted fields, doubled quotes and quoted newlines are
supported. The selected base recipe supplies other conditions, explicitly
labelled as assumptions. Import does not claim a forecast or independent
experimental provenance.

DE1 `.shot` input is parsed as inert literal key/value text. Only observed
elapsed and scale-weight channels supply the stored observation. Controller
goals and estimated inlet flow do not become measured yield. Raw elapsed end
is retained without alignment; negative/downward scale samples are reported.
Dose, grind and equipment remain selected-recipe assumptions. A log with an
unknown pump-off clock or final-weight boundary needs interpretation before
using it as calibration evidence. No Tcl, code or formula is executed.

## Local calibration

At least three completed shots in one exact bag/equipment/water/preparation
scope are required. Only the latest twelve matching records enter a fit. Dose,
grinder setting/gap, stop rule and numerical tier may vary. Changing bag
descriptors, water, preparation, machine program/temperature or overrides
requires a new fit; a core-version mismatch refuses application.

The first implementation fits existing model inputs: a multiplier of
`hydraulics.permeability.reference` and optionally grinder X50 scale. Existing
recipe/preset/family precedence resolves the reference X50/gap ratio; measured
PSDs instead scale particle diameters. Explicit gap and measured-PSD precedence
remain intact. Grinder zero, heterogeneity, startup and machine offsets are
fixed, not inferred.

The permeability grid has 17 logarithmic nodes over multipliers 0.25–4, clipped
to the registry's physical bounds; grinder scale has nine nodes over 0.8–1.25.
Independent Gaussian log-multiplier priors have SD ln(2) and ln(1.12), centred
on one. These are disclosed local algorithm assumptions, not measured closure
priors or a replacement for the published registry. This is finite-grid
quadrature, not MCMC or a Laplace approximation.

Every likelihood run uses Tier 0 with a time stop equal to the observed pump-off
time. It compares final cup yield, including drip. The yield standard deviation
is `timing_sigma_s * observed_yield_g / observed_time_s`, an approximate
average-flow conversion. Optional TDS residuals use absolute percentage-point
noise. User uncertainties are explicit inputs. A candidate that fails any
training shot has zero likelihood; it cannot benefit from dropping that shot.

Joint fitting requires opt-in and TDS at three distinct physical grind settings.
Otherwise grinder scale remains fixed. Marginal p05–p95 intervals are
conditional grid credible intervals; they can collapse to one grid node and
exclude structural model error. Prior dominance, grid-boundary MAP, posterior
correlation and a noise-scaled local sensitivity cosine warn of limited
identification. Narrow marginals do not establish a mechanism.

All retained training shots are rechecked with Tier 1. Time-at-final-yield
checks make at most three mass-stop/drip correction runs; remaining final-yield
error is disclosed. Tier 0/Tier 1 replay discrepancies remain visible in fit
notes. These are training residuals, not prospective scores.

## Inverse advice and personal ratings

Modes are recipe time/yield targets, cup TDS/EY or one relative taste-attribute
target, and next-shot advice from a completed observation. Search is bounded
and deterministic, quantizes grinder steps, intersects dose/machine limits with
presets and uses the builder for feasibility. Dose and temperature stay fixed
unless enabled. A measured PSD fixes grind. A temperature search with a local
fit is refused; the user can disable that fit for a separate model search.

The search uses Tier 0 multistart coordinate refinement with a finite call
budget. Finalists receive independent Tier 1 rechecks and are reranked. Failed,
choked or incomplete candidates are excluded. Final-cup-yield targets adjust
pump-stop mass with bounded drip corrections at each tier. Returned recipes
carry their verified pump-stop target; residual misses and legal bounds remain
visible. A returned candidate is a numerical result, not proof that the requested
target can be achieved on real equipment or that the search found a global best.

Candidate envelopes summarize nearby Tier 0 control perturbations. They are
neither posterior prediction intervals nor model-error confidence limits.
Absolute model-error coverage is unavailable.

Personal learning uses complete M3 acidity, bitterness, astringency and body
indices as centred features for a Bayesian linear 1–5 rating model. Coefficients
have independent N(0,1) priors, centred rating is `rating - 3`, and observation
noise is one rating point. Conditional 90% predictive ranges include that noise
and clip the displayed range to 1–5. Chemistry indices themselves never change
and are never summed into universal taste quality. Optional preference ranking
requires at least five varied compatible rated shots; sparse or out-of-domain
ratings remain uncertain.

## Prospective scorecard

Only app-created manual forecasts committed before observation and after their
matching saved calibration are eligible. Exact executed calibrated conditions,
engine version and setup must agree. Every saved profile's training IDs are
excluded; imported or backfilled forecasts are excluded. Timing-only scoring
accepts shots without TDS. Complete V9 scoring also requires measured TDS/EY.
The displayed target requires at least ten eligible shots, with every evaluated
time within ±3 s and, for complete V9, EY within ±1 percentage point. Failures
are retained in the denominator. Synthetic integration data never establish V9.
