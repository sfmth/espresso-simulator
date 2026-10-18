# Native solver performance and numerical regression

Version 0.7.0, 2026-10-18 (UTC).

The M3 preparation changes reuse hydraulic predictor, transport-input and
rollback buffers across time steps. Kernel matrices are reused only when the
dimensionless time step and the BDF2 step-ratio bits are identical. The
existing full-bed batched kernel solves and scalar fallback solves remain.
The floating-point operations, physical parameters, discretisation and
calibration are unchanged.

## Reproduction

```sh
cargo build --release -p puckmodel --example recipe_benchmark
target/release/examples/recipe_benchmark 11
```

The workload is the actual browser-default recipe: medium washed Arabica,
generic 64 mm flat grinder at setting 190, 58 mm precision basket, WDT,
18 g in and a 36 g stop at 9 bar. It contains 30 PSD classes and 51 dissolved
passengers. The catalogue's 57 metadata entries also include overlapping
aggregates and separately accounted phases; they are not 57 independent
dissolved passengers.

Timing includes spec validation, model construction and the complete physical
shot with time-series and spatial outputs. Recipe construction, serialization
and the UI are outside the timer. Each executable warms up with one shot;
repeated results must equal that complete result. The raw numerical-core
workloads can also be reproduced with:

```sh
cargo run --release -p puckcore --example shot_benchmark -- 11
```

## Measurements

The comparison uses the main-branch M2 solver (0.6.0) and this change (0.7.0),
with the same compiler and benchmark source. Environment: Intel Xeon Platinum
8573C, Linux 6.18.55 x86_64, Rust 1.99.0; release optimisation level 3, fat LTO,
one codegen unit, and no `target-cpu=native`. Both executables use logical CPU
8. Seven independent measurements per revision alternate their order. Other
validation work runs concurrently, so process CPU time is the primary
comparison; the recorded wall times are reported with their load caveat.

Process CPU time is the difference in `resource.getrusage(RUSAGE_CHILDREN)`
user plus system time around each complete `recipe_benchmark 1` subprocess.
Each invocation includes one warm-up and one measured shot at each tier, the
recipe builds, equality checks and fingerprint generation. It is therefore
an aggregate workload cost, not CPU time per shot. It must not be compared
directly with the plan's wall-time targets.

| Metric | M2 baseline median (range) | Optimized median (range) |
|---|---:|---:|
| Tier 1 wall time, ms/shot | 1,549.3 (1,516.9–2,212.8) | 1,535.1 (1,490.7–1,688.3) |
| Tier 0 wall time, ms/shot | 22.19 (19.86–26.88) | 20.11 (19.06–24.88) |
| Complete harness process CPU time, s/invocation | 3.166 (3.121–3.796) | 3.269 (3.083–3.399) |

The Tier 0 wall-time median is about 9% lower, with overlapping ranges. Tier 1
wall time is effectively unchanged, and aggregate CPU time did not improve.
These loaded measurements do not establish a reliable full-M2 speedup or the
plan's throughput targets. The demonstrated benefit is lower allocator traffic;
transport remains the main target for further speed work.

Allocation instrumentation around `simulate_shot` for the identical browser
default ShotSpec gave:

| Allocation metric | M2 baseline | Optimized |
|---|---:|---:|
| `alloc` + `realloc` calls | 18,044 | 7,797 |
| Cumulative requested bytes | 47,692,191 | 46,029,351 |

This is 56.8% fewer allocation/reallocation requests. The counter wraps
`std::alloc::System` and excludes input JSON parsing and output serialization.
Requested bytes are cumulative allocation traffic, not peak or retained memory.

## Numerical evidence

The benchmark's FNV-1a fingerprint covers the complete deterministic Rust
`Debug` output after clearing only `core_version`. These fingerprints match
between the M2 and optimized solver:

| Workload | Fingerprint |
|---|---|
| Browser default, Tier 1 | `b0658b6278cae8e5` |
| Browser default, Tier 0 | `a782f4b03fe03c79` |
| Raw default, Tier 1 | `f9ebfb7c921f6019` |
| Raw default, Tier 0 | `857e1f4f0edc63f5` |
| 30 classes, four passengers, Tier 1 | `cf5611e66678fae6` |
| 30 classes, four passengers, Tier 0 | `d4bdd0f3515d197d` |
| 30 classes, four passengers, isothermal | `75f49dcf8389ae7a` |

A separate replay of the identical Smrke `s210_f4` held-out ShotSpec compared
the two compiled solvers. All 14,867 numeric fields, including signed zeros,
and the entire 212,784-byte result JSON matched after clearing `core_version`.
Its SHA-256 was
`cf5f622506f6162b1c6f8c13995583b86d3250da6a3d6cb41063433f0aad2651`.
Historical validation reports may differ because their Python/NumPy/SciPy
environment and reconstructed case inputs differ; those reports are not a
substitute for replaying the same spec through both solvers.

Unit coverage compares mixed time schemes against independent scalar
cell solves, including dry and first-wet cells, loading caps, negative BDF2
right-hand-side and mass-loss fallbacks, and signed zeros. Matrix-cache tests
compare fresh factorisation after repeated steps, diffusivity changes, step
changes, forced backward-Euler retries and changed BDF2 ratios. All core tests
and strict core clippy checks pass.

These are native measurements on one host, not a browser or phone speed
guarantee. Existing scientific-validation limitations remain unchanged.
