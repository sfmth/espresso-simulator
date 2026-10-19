# M5 rendering performance

Version 0.9.1 · 2026-10-19. This report supersedes the preliminary callback counts
in [M5 verification](m5-validation.md) for rendering comparisons. The final renderer
retains exact analytic spheres and adds tighter projected bounds and conservative
hidden-sphere culling. **The midrange laptop and physical phone G5 gates remain
open.** The available hardware is a high end RTX 4080 Laptop GPU, and the recorded
frame cadence is a scheduling measurement, not a count of presented frames.

Repeated hardware and software trials are archived below. The available GPU
shows similar cadence before and after; backend-specific software results do
not establish a general rendering speedup.

## Fixed measurement protocol

The [benchmark accumulator](../../web/src/explore/benchmark.ts) is shared by the
production view and the separately instrumented frozen baseline. Measurements use
the same deterministic reference scenario and packing seed, `20261018`, with
network arrows off, cut fraction 1 and particle 0 selected. The full requested
population remains in the model. Particle radii, source PSD weights, extraction
values, physics and depth refinement do not change for the benchmark.

| Setting | Protocol |
|---|---|
| Desktop display counts | 30,000 and 150,000; 1280×900 viewport |
| Mobile layout display counts | 5,000 and 25,000; 390×844 viewport on the desktop browser |
| Device scale factor | DPR 1 for the archived comparisons; actual screen and renderer DPR recorded separately |
| Warmup | Fixed canonical camera pose, at least 1,500 ms **and** 30 successful CPU render submissions |
| Clock origin | First RAF callback; setup-task `performance.now()` is not mixed into the frame clock |
| Sample | At least 5,000 ms between first and last sampled RAF timestamps; actual elapsed time and interval count retained |
| Camera | 40° vertical FOV; fixed initial position/target; wall-clock orbit at 0.36 rad/s, reset to zero at the sample transition |
| Target budget | 60 fps desktop; 30 fps for viewport widths at most 700 px; 0.5 ms timestamp tolerance |
| Optional GPU timer | `EXT_disjoint_timer_query_webgl2`, every fourth sampled submission, asynchronous availability checks |
| Cancellation | Hidden tab, lost context, changed rendering configuration, clock discontinuity, interruption or disposal |

The 30-submission requirement matters on slow backends: baseline SwiftShader
warmup took roughly 42–45 seconds at 150,000 particles. The sampled orbit still
starts at the same angle after that warmup. Camera speed depends on elapsed time,
so a slower device does not sample a shorter orbit through an increment per frame.

For `N` sampled callback timestamps, reported mean FPS is
`1000 × (N − 1) / (lastTimestamp − firstTimestamp)`. There are `N − 1` measured
intervals, rather than `N` completed or presented frames. For a sorted array of
`m` intervals, median and p95 use linear interpolation at `(m − 1) × percentile`
(the archived `linear_interpolation_n_minus_1` quantile method). CPU durations are
measured immediately around the render submission. Missed-slot estimates count
target-budget intervals beyond the stated tolerance; they are not observed
display drops.

No per-frame `gl.finish`, synchronous framebuffer readback or reduced-pixel
benchmark mode is used. GPU query results are read only when available. A disjoint
event invalidates the query sample set; unresolved query counts remain explicit.
Query durations measure sampled render commands, excluding compositor presentation
and other unqueried browser work. A complete five-second cadence sample can still
have pending GPU queries when it ends.

## Rendering quality and comparison boundaries

Both baseline and final paths report `renderPath: analytic-exact` and
`sphereQuality: exact sphere silhouette and surface depth`. Analytic ray/sphere
intersection and fragment depth remain the surface model. The final vertex path
uses tangent bounds instead of a larger conservative projected rectangle and
culls fully clipped or cut spheres before fragment work.

The final containment index searches at most the 32 largest possible enclosing
spheres. A child is culled only with strict geometric containment and additional
view guards: its enclosing sphere must remain visible through the cut and near/far
planes, the camera must remain outside it, and the separation must exceed the
Float32/depth-buffer safety margin. Insufficient precision or uncertain visibility
keeps the child. All particle arrays, physical radii and extraction values remain
available to picking and inspection. This optimizes redundant opaque rendering
inside the illustrative packing; it does not change the coupled solver or make
the representative packing a measured puck geometry.

Every comparison must retain particle count, CSS and drawing-buffer dimensions,
DPR, camera path, cut, network visibility and sphere quality. The hardware trials
below use a 761×576 drawing buffer; software desktop trials use 771×576 because
their browser layout differs. The mobile layout buffer is 358×384. Compare builds
within the same backend/layout; these are not identical pixel workloads across
hardware and software environments.

The baseline and final 30,000-particle initial camera components differ by less
than `1e-15`, consistent with Float64 camera/control rounding, while their target,
FOV and timed trajectory agree. Legacy baseline metadata also retains zero mesh
counts and `meshMaxErrorPx: 0`; the final exact-only path omits those unused fields.
Those annotations do not introduce a visual quality difference. Implementation
descriptions and containment counts belong to `renderObservations`, separate from
the physical workload and sphere quality. No claim of bit-identical framebuffer
pixels is made.

## Frozen baseline and archived evidence

[Baseline provenance](rendering/baseline-provenance.json) records source files,
SHA-256 hashes, the emitted helper and the instrumentation contract. The original
renderer asset is `PuckView-BwAkJHbz.js`, SHA-256
`9765c4a206c46fe693e8929b8a81ab48720780fec34de6bc7ae74a82d565ab26`.
The [normalizer](../../web/scripts/normalize-render-baseline.mjs) accepts the pinned
production build and unique source anchors, fails closed for unknown builds, and
writes to a fresh output directory. It preserves renderer/shader code, geometry,
counts and DPR policy while replacing the old timing and per-frame camera motion
with the protocol above. Source files remain unchanged, and existing output is
never overwritten.

Archived standalone hardware baseline JSON omits the bulky raw `frameRecords`
array. Each file records the number removed as `archive.rawFrameRecordsOmitted`.
Aggregate interval/CPU/GPU statistics, sample counts, protocol and environment are
retained unchanged. The common metric definitions are covered by tests; the
archived aggregates cannot be independently reconstructed from those omitted raw
arrays. The software suite retains its captured result objects.

## Available high end GPU measurements

The in-app Chromium 155 browser reports the actual unmasked backend:

```text
ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4080 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0)
```

This is hardware acceleration on a high end laptop GPU, not the required midrange
laptop. All hardware trials below use DPR 1, the same 1280×900 viewport and
761×576 drawing buffer. Values are per-trial cadence rates; medians summarize
trials rather than pooling frames.

| Build/count | Three trials: mean RAF cadence (fps) | Median cadence | Per-trial interval p95 (ms) | Evidence |
|---|---|---|---|---|
| Frozen baseline, 30,000 | 239.442 / 239.637 / 239.637 | 239.637 | 4.30 / 4.20 / 4.20 | [1](rendering/baseline-hardware-30000-1.json), [2](rendering/baseline-hardware-30000-2.json), [3](rendering/baseline-hardware-30000-3.json) |
| Final exact renderer, 30,000 | 239.842 / 239.832 / 239.242 | 239.832 | 4.20 / 4.20 / 4.22 | [1](rendering/optimized-hardware-30000-1.json), [2](rendering/optimized-hardware-30000-2.json), [3](rendering/optimized-hardware-30000-3.json) |
| Frozen baseline, 150,000 | 239.442 / 239.637 / 239.042 | 239.442 | 4.30 / 4.30 / 4.20 | [1](rendering/baseline-hardware-150000-1.json), [2](rendering/baseline-hardware-150000-2.json), [3](rendering/baseline-hardware-150000-3.json) |
| Final exact renderer, 150,000 | 239.837 / 239.637 / 239.437 | 239.637 | 4.20 / 4.21 / 4.20 | [1](rendering/optimized-hardware-150000-1.json), [2](rendering/optimized-hardware-150000-2.json), [3](rendering/optimized-hardware-150000-3.json) |

The approximately 239 fps cadence and 4.2 ms median intervals describe the browser's
scheduling behavior; they do not establish 239 presentations per second. At
30,000 particles the baseline and final cadence overlap across trials. The median
of per-trial mean GPU query durations is 0.337 ms baseline and 0.351 ms final, with
299–300 valid query samples per trial and zero or one unresolved query at finish.
The median of per-trial mean CPU submission durations is 0.0286 ms baseline and
0.0296 ms final. CPU samples are visibly quantized, including zero durations.
These results do not demonstrate a meaningful hardware speedup at 30,000 particles.

## Software rendering measurements

The [baseline software suite](rendering/baseline-software.json) contains three
trials at all four populations, with no recorded suite failures. Its actual
backend is ANGLE Vulkan SwiftShader (Subzero), running on Linux x86_64 with an
AMD Ryzen 9 7945HX host CPU. The recorded browser version is 131.0.6778.139; it is
different from the hardware browser. Software and hardware numbers are separate
backend experiments, not a hardware speed ratio.

| Particles | Viewport | Baseline fps (3 trials) | Final fps (3 trials) | Median change | Median of per-trial p95, baseline → final (ms) |
|---|---|---|---|---|---|
| 30,000 | 1280×900 | 3.451 / 3.366 / 3.293 | 3.588 / 3.588 / 3.775 | +6.6% | 370.0 → 551.7 |
| 150,000 | 1280×900 | 0.688 / 0.706 / 0.833 | 0.738 / 0.719 / 0.714 | +1.9% | 1559.9 → 2460.7 |
| 5,000 | 390×844 | 20.991 / 20.793 / 19.272 | 19.934 / 19.868 / 20.396 | -4.1% | 66.7 → 67.6 |
| 25,000 | 390×844 | 4.065 / 4.186 / 4.013 | 4.300 / 4.423 / 4.481 | +8.8% | 266.7 → 415.9 |

The [final software suite](rendering/optimized-software.json) also has no recorded
failures. The 30,000 and 25,000 populations improve median cadence modestly, but
frame-time tails worsen. The 5,000 case regresses slightly; 150,000 remains slow
and has only a few sampled intervals per five-second orbit. Three sequential
trials do not control thermal/power state or scheduling noise, so these are
observed local differences, not a statistically established cross-device gain.
Neither build meets the display targets in software. A narrow
viewport still uses the desktop CPU/software backend and supplies no physical
phone evidence. Five-times display populations remain optional workloads; they
do not relax the original 30,000-particle laptop and 5,000–10,000-particle phone gates.

## Discarded adaptive prototype

A preliminary prototype mixed analytic spheres with tessellated native meshes
using a projected error bound. It is **not present in the final renderer**.
The [single adaptive GPU trial](rendering/discarded-adaptive-hardware-30000.json)
recorded 239.447 fps and 0.1789 ms mean CPU submission time, compared with
239.842 fps and 0.0426 ms in the
[single tight-bounds exact trial](rendering/optimized-tight-bounds-hardware-30000.json).
GPU query means were 0.399 ms adaptive and 0.343 ms exact. The experiment showed
no cadence win and substantially more CPU work in those individual runs.

The [preliminary single software trial](rendering/discarded-adaptive-software.json)
also failed to justify that extra work.
These exploratory captures motivated removing the mesh path and its quality
selector; they are not repeated final-build evidence or an equal-quality
comparison, because the prototype approximated sphere surfaces. The final report
uses the repeated exact-only captures for release conclusions.

## Reproduction

From the repository root, build the production web app and run the suite:

```bash
cd web
npm run build
node scripts/render-benchmark.mjs --backend auto --quality exact --counts 30000,150000,5000,25000 --trials 3 --dpr 1 --output test-results/render-hardware.json
node scripts/render-benchmark.mjs --backend software --quality exact --counts 30000,150000,5000,25000 --trials 3 --dpr 1 --output test-results/render-software.json
```

`auto` records the backend actually available to installed Chrome; it does not
guarantee hardware acceleration. `CHROME_PATH` can select another installed Chrome
executable. `--dist PATH` measures a separate production directory, and `--url URL`
uses an existing local server. Use matching browser/backend, display counts and
pixel dimensions for before/after comparisons.

With a preserved copy of the pinned baseline build, create a fresh instrumented
copy and measure it separately:

```bash
node scripts/normalize-render-baseline.mjs --source /tmp/espresso-m5-baseline-dist --output /tmp/espresso-m5-baseline-bench-dist
node scripts/render-benchmark.mjs --dist /tmp/espresso-m5-baseline-bench-dist --backend software --quality current --counts 30000,150000,5000,25000 --trials 3 --dpr 1 --output test-results/render-baseline.json
```

The normalizer refuses an existing output directory. The baseline binaries are
not embedded in the report; the provenance hashes identify the required snapshot.
The UI's **Measure** action runs the same protocol and exposes JSON in
`.puck-view[data-render-benchmark]`, alongside **Download benchmark JSON** for a
local capture. Hardware UI runs must retain their browser/backend and viewport
metadata when archived. The production script records its actual backend, host,
viewport, quality and failures; review those fields before assigning a device class.

## Checks and remaining gates

The metric helper has 23 focused tests, including clock ordering, deferred first-RAF
startup, warmup exclusion, interval counting, quantiles, cancellation, metadata
immutability and nonblocking/disjoint GPU queries. Eight rendering-math checks
cover tangent bounds and conservative containment/visibility/precision guards.
The complete web suite passes 672 tests. These checks establish orchestration and
geometric safeguards, rather than device performance or empirical espresso accuracy.

A full-flow browser run exposed a clock-ordering exception that previously
left measurement active. First-frame startup now uses the RAF clock;
later duplicates/regressions cancel with `clock-discontinuity`, preserve only the
valid earlier intervals and expose numeric diagnostics in the local report. No
timestamps are clamped, synthesized or counted twice. The rejected-clock path is
covered separately from successful measurement, including an injected duplicate
callback followed by a successful native-clock retry in Chrome. The archived
valid captures precede the extra failure diagnostics/recovery and minor UI-copy
cleanup; shaders, accepted-clock statistics and camera protocol remain unchanged.

| Gate | Required evidence | Current status |
|---|---|---|
| G5 laptop rendering | At least 60 fps around 30,000 particles on a midrange laptop | Open; available GPU evidence is from an RTX 4080 Laptop GPU |
| G5 phone rendering | At least 30 fps at 5,000–10,000 particles on a recent physical phone | Open; desktop mobile viewport emulation does not qualify |
| Presentation/completion | Evidence of compositor presentation or completed frames if such claims are made | Not measured by RAF cadence; optional GPU queries cover sampled commands only |
| Cross-device rendering behavior | Matching recorded workload, dimensions, quality and actual backend | Limited to the archived configurations; thermals, power state and other devices remain unmeasured |

The [M5 representation contract](../model/m5-explore.md), existing coupled-state
checks and M1–M4 scientific limitations remain unchanged. No physics parameter,
calibration split, numerical tier or scientific accuracy target changes as a
result of these rendering measurements.
