# M5: experimental Explore contract

Version 0.9.0 · 2026-10-18. Browser implementation: `web/src/explore/`.
Explore displays the shared shot model's state. It does not add a second
extraction model, infer a scanned puck, or change the published calibration.
Numerical consistency and actual device performance are separate checks.
**G5 remains open pending measured laptop and phone validation.**

## Shared recipe and run ownership

Lab, Dial-in and Explore use the same recipe store. `ShotRunProvider` owns one
catalog loader and one automatic/full shot controller. Lab and Explore consume
those controls; mounting Explore does not start a second live-preview channel.
A scenario load replaces the shared form with an Undo action. Normal Tier 0
preview behavior continues, but detailed particle export requires the explicit
**Run Explore** action.

An Explore request uses the existing full-run owner. It cancels pending previews
and previous full runs, forces Tier 1 and forwards the requested column, depth
cell and resolution. Cancelled or superseded calls cannot publish late results,
even if an engine ignores abort. Retrying an engine failure retains the Explore
selection and resolution. The result enters the same `ShotOutcome` slot as a Lab
run; earlier recipe results remain identifiable by their stored physical key.

The timeline indexes the result's **stored spatial snapshots**, not rounded
seconds or time-series sample numbers. One selected snapshot drives the
cross-section, particle extraction colours, local metrics and shell inspector.
Changing results initializes selection from the returned micro metadata and
starts paused at the last stored snapshot. Playback stops while Explore is
hidden. Scrubbing does not run new physics.

## Opt-in coupled state

The JavaScript worker API is
`simulateExplore(recipe, {column, cell, resolution?})`. The Rust JSON entrypoint
is `simulate_explore_json(recipe_json, request_json)`; bindings expose the same
shared implementation. `resolution` is `standard` by default or `high`.
Column and cell are zero-based indices on the **actual resolved grid**.
Selections and an export memory budget are checked before solving.

The additive fields are optional in ordinary shot results:

| Location | Meaning and units |
|---|---|
| `spatial.micro` | Exported column/cell, resolution, actual depth-cell count and size-class metadata |
| `spatial.micro.classes[]` | Full particle radius, intact-kernel radius and shell outer faces in metres; normalized volume/dry-mass share; surface-pool fraction; initial concentration-equivalent kernel loading in kg/m³ |
| `spatial.snapshots[].micro.class_ey[]` | Each size class's local extraction fraction in the selected cell |
| `spatial.snapshots[].micro.kernel_conc_kg_m3[][]` | Actual shell-average concentration-equivalent soluble loading, indexed by class and kernel shell |
| `spatial.snapshots[].micro.surface_remaining_fraction[]` | Remaining surface-pool fraction; null when there was no initial surface content |
| `spatial.snapshots[].column_flow_m3_s[]` | Resolved flow by continuum column, m³/s |
| `spatial.snapshots[].bed_temperature_c` | The model's single bed-temperature node, °C |

Shell values are read-only copies of the coupled solver's state at the snapshot
clock. The inspector plots each shell average at its outer face, normalized by
the **intact-kernel radius**, which excludes the broken-cell surface layer. A
class with no intact kernel has an empty radial profile; a class without an
initial surface pool has no invented remaining fraction. These are lumped
solubles, not separate radial profiles for all catalogue compounds. As in the
[shot model](shot-model.md#51-inventories), kernel values are effective loadings
normalized by the reference capacity ε_c, not free-liquid concentrations or a
separate physical water inventory. The exported field name retains `conc_kg_m3`
for the core's concentration-equivalent state.

Only one cell's particle state is exported per run. Other cells retain their
continuum heatmap values. Selecting a different cell requires another Explore
run to obtain its shells. An ordinary preview, absent metadata, a selected-cell
mismatch or inconsistent class data produces an unavailable indication rather
than a reconstructed radial profile or fabricated extraction colour.

## Standard and high resolution

Both choices use the existing **Tier 1 parallel 1D-in-depth equations**:

| Choice | Depth grid | Display presets |
|---|---|---|
| Standard | Default 30 cells | 5,000 particles on mobile; 30,000 on desktop |
| High | Five times the built depth grid, normally 150 cells | 25,000 particles on mobile; 150,000 on desktop |

High resolution refines depth only. It does not introduce lateral exchange,
resolved basket holes, shower-screen jets or headspace geometry. The future
2D axisymmetric Tier 2 model remains deferred. The returned spec and metadata
record the actual grid; a selected physical depth is mapped to that grid by the
interface. A refined result can differ numerically from the standard result and
can take longer to compute.

The displayed particle-count control is independent of extraction resolution.
Increasing it changes rendering and representative packing, not the continuum
PSD, kernel equations or number of extraction states. Standard and high display
counts are budgets, not promises that a particular device reaches G5.

## Representative particles and consistency

A separate module worker builds the representative volume deterministically
with seed **20261018**. Particle radii come from the resolved PSD. Number
sampling reserves a marker for every class, and statistical dry-mass weights
preserve each class's normalized volume share exactly. Particles below the
75 µm diameter display cutoff are marked as fines. Their physical radii and
class weights remain available; the display does not drop their soluble mass.

All displayed particles in a size class share the selected continuum cell's
actual class state. Positions add no extra extraction differences. Consequently

`sum(particle_weight × class_EY) = selected_cell_local_EY`

up to numerical representation error. The interface reports the weighted mean,
continuum value and difference in **EY percentage points**. It refuses coupled
colours when the consistency difference exceeds the G4 tolerance of 0.5 point.
Local extraction counts material leaving particles and is distinct from cup EY.
The cube's size follows sampled particle volume and the source intergranular
porosity; it is not a fixed-size scan of the puck.

Packing uses seeded placement and a bounded soft-sphere relaxation in the
worker. It is approximate. Diagnostics report iterations, residual overlapping
pairs and the largest relative overlap, including whether the final overlap
audit was complete. A bounded incomplete audit reports a lower bound on overlap
counts. The view does not claim a mechanically equilibrated or overlap-free bed.

## Illustrative pore network

A small clearance-based void lattice is constructed from the displayed packing.
A conjugate-gradient solve supplies dimensionless inlet-one/outlet-zero
potentials and edge fluxes normalized by inlet flux. Diagnostics expose solver
residual, convergence and whether a through path exists. A disconnected network
does not receive an invented through flow.

The network is an illustration. It is not the shot pressure field, a calibrated
permeability estimate, a resolved hydraulic solution of the real puck, or a source
of continuum extraction updates. Particle positions, lattice potential and its
edge fluxes never feed back into the shot solver. Reported column flow, liquid
concentration, wetting and bed temperature instead come from the coupled result;
missing physical fields stay unavailable.

## Rendering and fallbacks

The 3D renderer uses Three.js with **WebGL2 instanced sphere impostors**. Each
particle uses a small billboard with spherical shading rather than a separate
high-detail sphere mesh. Orbit/zoom, particle picking, a cutaway and optional
network edges support inspection. The cutaway hides particle centres beyond
the chosen plane; it does not compute sliced particle interiors.

WebGPU is not required. If 3D initialization fails or a WebGL context is lost,
a bounded SVG front projection accompanies the continuum cross-section,
timeline and particle/profile tables. Selection also has a numeric control;
inspection does not require pointer picking. Packing runs outside the UI thread,
and hidden Explore views stop their playback/render work.

The optional **Measure frame rate** action measures a brief rotating view on
that device at the current count and viewport. It is not a benchmark of all
recipes, hardware, thermal conditions or interaction patterns. G5 still requires
measured evidence for the plan's mid-range laptop target (60 fps around 30,000
particles) and recent-phone target (30 fps at 5,000–10,000 particles). The
150,000/25,000 display options do not relax those gates or establish them.

## Guided scenarios and verification

Seven fixed, complete recipes provide a reference, finer/coarser grind, uneven
preparation, bottom paper, a bloom pause and a coarse 6 bar shot with a longer
pump-stop target. The metadata lists changed inputs and what to inspect. It does
not promise a measured direction of EY change. Preparation effects retain their
grade-D assumptions; the turbo example changes three controls and does not
isolate a single cause. Pump-stop targets are distinguished from final cup mass
including drip.

Evidence is kept in the implementation tests and the [M5 verification
report](../validation/m5-validation.md):

- [Core export tests](../../crates/puckcore/src/shot/m5_explore_tests.rs) verify
  unchanged existing outputs for read-only export, exact selected-cell shell
  copies, weighted class/cell consistency, honest dry/all-surface cases,
  selection/memory bounds and deterministic refined-grid cases.
- [API tests](../../crates/puckmodel/tests/m5_explore.rs) cover the shared boundary.
- [Microstructure tests](../../web/src/explore/microstructure.test.ts) cover
  seeded repeatability, exact class weights, bounded packing/network diagnostics,
  weighted EY and refusal of missing or inconsistent coupled state.
- [Scenario tests](../../web/src/explore/scenarios.test.ts) build all seven
  recipes in the actual WASM core and verify the declared changes affect the
  resolved PSD, preparation, edge closure and machine program.
- [Controller tests](../../web/src/shot/useShotRunExplore.test.tsx) and
  [playback tests](../../web/src/explore/useExploreState.test.tsx) cover shared
  ownership, cancellation/supersession, retry and actual snapshot/cell selection.
- [Packing-worker lifecycle tests](../../web/src/explore/useMicrostructure.test.tsx)
  cover stale responses, hidden-view cancellation, reuse and unavailable/blocked
  worker fallbacks. [Inspector tests](../../web/src/explore/ParticleInspector.test.tsx)
  cover exact shell tables and honest all-surface, no-pool and unavailable states.

These verify representation and orchestration. They do not validate an observed
particle geometry, a pore-scale mechanism or empirical espresso accuracy. The
existing scientific gates, calibration/source splits and hardware G5 requirements
remain unchanged.
