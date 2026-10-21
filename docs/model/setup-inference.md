# Equipment inference before dialing in

Version 0.12.0 implements the workflow approved on 2026-10-21. It replaces the
mandatory first-visit wizard and separates learning a possible equipment setup
from choosing the next shot. See [ADR 0019](../decisions/0019-equipment-inference-before-dial-in.md)
and the [validation record](../validation/setup-inference-validation.md).

## User flow

The tabs are **Set up equipment**, **Dial in**, **Lab**, and **Explore**, in that
order. On a first visit, a native dialog offers **Set up equipment** or
**Skip setup with defaults**. Opening setup preserves the current recipe; skipping
validates the default recipe with the native builder, remembers the choice, and
opens Dial in. Closing the dialog with Escape opens setup for the current session.

Set up equipment uses the same illustrated editor as Lab: the overview and its
connected callouts, machine cutaway, interchangeable empirical burr families,
basket/outlet drawings, quick controls, and advanced fields all edit one recipe.
Only the active tab mounts an editor, so form IDs and labels stay unique.

The setup workflow has three parts:

1. Describe equipment and mark which values are known. A user who already knows
   their settings can choose **Use these settings in Dial in** without fitting a
   shot. This produces a specified setup, with no claim of measurement validation.
2. Add an actual shot directly: time, cup weight, and optionally measured TDS.
   Add more shots when available. A prior simulator prediction is not required.
3. Search for matching setups, inspect the replay evidence, keep alternatives,
   and explicitly choose one for Dial in. Keeping a possibility does not activate it.

Dial in predicts the next shot with the selected setup and the desired recipe,
supports the existing journal and recipe search, and can compare predictions
across retained alternatives. Lab remains the general experiment workspace.

## Knowledge states and search scope

Each supported field can have an exact **lock**, an allowed **range** (or subset
of categorical choices), or be **unknown** inside finite physical bounds.
Unmarked values remain fixed assumptions. They are not converted into known facts
or silently added as optimization axes. Unknown numeric fields without finite
catalog bounds require an explicit finite range before a search can run. An
unmarked value inherited from a preset follows that preset if a preset search
axis changes it; lock the value explicitly when it must remain fixed.

The catalog includes active practical recipe inputs, supported preset/family
selectors, existing pressure/flow profile values, basket geometry and outlet
parameters, PSD-bin values, and internal physical registry coefficients. It
derives effective values from the current recipe and native catalog, respecting
preset precedence and recipe overrides. Duplicate aliases point to the practical
field instead of exposing two conflicting axes. Numerical fidelity settings,
such as solver tier and grid resolution, are not inferred physical parameters.

This release searches parameters within an existing recipe structure. Configure
phase count, pressure-versus-flow control type, newly introduced exit conditions,
basket outlet kind, PSD/bin or basket-point count, and chemistry enable/mineral
blank flags in the illustrated/full editor before searching. Changing those
structures is not part of the optimizer. Recorded-only inputs such as burr
diameter, RPM, top paper, variety, altitude, and tamp force cannot gain evidence
from a model that does not use them. The controls explain these limitations.

A categorical replacement cannot silently break another constrained value.
Grinder family selection is applied before dependent values, then all effective
constrained values are checked again. Changing between named grinder dial references is rejected when
it would reinterpret a constrained reference gap. Native builder failures,
clamped grinder settings/gaps, invalid diagnostics and nonfinite outputs cannot
be accepted as matches.

The metadata **Machine display / set temperature** means the value shown by the
machine. It is separate from modeled water temperature entering the puck. Heater
type and displayed temperature are saved with a setup, but do not establish a
boiler/thermoblock/PID transfer model. Those physics remain a later stage.

## Observations and shared equipment

A search accepts one to twelve observations. Each stores its recipe snapshot,
measurement conventions, tolerances, and the specific settings known to apply to
that shot. For example, two observations can explicitly use different grind
settings or doses while sharing inferred permeability, burr family and machine
parameters. Only the explicitly selected shot-specific paths override a shared
candidate. Shared locked and inferred values are rechecked after applying those
changes, except the exact paths intentionally overridden for that observation.

The shot editor distinguishes:

- time measured from pump start or first drip;
- mass measured at pump stop or after the final drip;
- measured TDS, when available, expressed in percent;
- separate time, mass and optional TDS tolerances.

The initial tolerances are 1 second, 0.5 gram and 0.2 percentage points of TDS.
They are editable measurement assumptions, not calibrated instrument accuracy.
The allowed observations are greater than zero and at most 600 seconds / 500
grams; measured TDS is greater than zero and at most 30 percent.

For a replay, observed time determines the stop boundary. The solver compares
mass and optional TDS after running to that time; it does not claim that matching
the supplied time is an independent prediction. A bounded timing adjustment may
use the stated time tolerance. First-drip observations first locate modeled
wetting delay, then replay for the observed duration after first drip. Pump-stop
mass excludes modeled drip, and pump-stop TDS comes from the corresponding trace
sample. The candidate itself retains the recipe's future-shot stop rule.
First-drip replay requires a successful pilot through the modeled wetting delay
(at least 60 seconds, or the observed duration when longer). The input limits do
not guarantee that every timing convention or proposed setup can be replayed
successfully; failed pilots are rejected.

Completed journal shots can be copied into setup for refinement. Dose, grind and
an explicit brew-temperature value are marked as known shot-specific settings.
Users can review that list and add other known changes before fitting. Existing
journal entries and older calibration records are preserved.

## Search and acceptance

The browser uses seeded bounded multistart search, differential mutation and
coordinate refinement. About 60 percent of the simulation-call budget is used
for Tier 0 exploration; remaining calls verify and refine candidates at Tier 1.
The UI offers 480 or 1,440 calls. The runtime accepts at most 10,000 calls and
requires at least eight calls per observation. Timing pilots and corrections
count against this budget.

Every returned match and near miss has been replayed at Tier 1 against every
observation. A match must satisfy all stated tolerances. The UI reports observed
and simulated values, residuals and tolerances for each shot. It retains up to
twelve distinct matching configurations and five near misses; only matching
configurations can be kept as inferred setups.

The search is finite and heuristic. It finds representative combinations; it
does not enumerate all continuous possibilities or guarantee a global optimum.
No match means none was found in this domain and budget, not proof that none
exists. Reported solution ranges describe the retained samples, not confidence
intervals or parameter identification. One shot can leave many parameters
unresolved. Additional varied shots and independent future predictions are
needed to distinguish alternatives and evaluate usefulness.

Searches are cancelable. Editing recipes, constraints or observations invalidates
old results and aborts active work. Stale or late worker responses cannot be saved
as a current fit. Activation checks the native builder, current engine version,
and the selected saved-profile contents before changing the active setup.

## Using alternatives for the next shot

Choosing an active setup loads its recipe into the shared editor with Undo.
Retained alternatives are independent snapshots: the user can rename, remove,
activate, or reopen one for refinement. Future-shot comparison runs each
alternative at Tier 1 and transfers the user's intentional dose, compatible
grind, brew-temperature and stop-rule changes. Other equipment/coffee/prep
changes require returning to setup. Incompatible grind representations are
rejected instead of silently ignoring a requested dial change.

Comparison results are invalidated by the current recipe, alternative contents
and engine version. They describe simulator predictions across plausible
setups, not empirical uncertainty coverage. An active equipment setup disables
the older automatic permeability-calibration overlay, avoiding double fitting.
The earlier local-calibration scorecard still applies only to its original
calibration-linked prospective records. New equipment predictions can be saved
and compared with measurements in the journal, but are not credited to that
older V9 scorecard.

## Local persistence and compatibility

The setup document is stored under an app-path-scoped local-storage key with
schema `puckworks.setup-inference/1`. It includes the working constraints,
observations, equipment facts, at most twelve alternatives and the active ID.
Each saved alternative retains its source request, native core version and, for
an inferred setup, its verification evidence. Export/import is a separate JSON
backup from the existing journal, with a 5 MB input limit. Import preserves the
alternatives but clears the active selection: the user must select an alternative
so the native engine validates and loads its recipe before it becomes active.
Ordinary reloads preserve the existing active selection.

Imports validate recipes, finite values, bounded collection sizes, unique IDs,
paths and verification consistency before replacing local state. A stored
inferred recipe must match the recipe verified by its candidate; observed
values, tolerances and residuals must agree with the saved source observations.
Imports are not an authentication or scientific-proof format: a user can edit a
file, and a self-consistent record is not independent replication. A profile from
another core version must be rechecked before activation.

Storage failures keep work available in the current session and show a notice.
Conflicting external writes require a reload rather than silently overwriting
another tab's data. The existing completion marker remains the fixed cookie
`puckworks_setup_v1=done`. No settings, observations, identifiers or inferred
values enter that cookie. There are no uploads, analytics, new runtime services
or external assets. All inference and predictions run locally, including offline.

## Validation boundary

The implementation tests constraint semantics, native replay behavior,
cancellation, persistence, keyboard and screen-size behavior. Synthetic
observations prove consistency with the same engine, not espresso accuracy.
There are no new real-shot accuracy measurements in this release. Heater/PID
physics, prospective setup-specific scoring, broad parameter-identification
studies and physical-device usability remain open. No Rust physics equations or
registry coefficients changed; the version-only replay receipt verifies that
the frozen native outputs and previous surrogate qualification are unchanged.
