# Contributing to Puckworks

This page covers the project rules, one-time setup and everyday commands.

## Ground rules

1. **Read the plan first.** [docs/PLAN.md §2](docs/PLAN.md#2-locked-decisions-2026-10-13) lists the locked product decisions; don't change them without the maintainer's agreement. Implementation decisions are recorded as [ADRs](docs/decisions/README.md).
2. **Licence.** Contributions are licensed GPL-2.0-or-later. Every source file starts with `SPDX-License-Identifier: GPL-2.0-or-later`. Dependencies must follow [ADR 0007](docs/decisions/0007-licensing-and-dependency-policy.md).
3. **Keep the docs current.** Every change does all of the following:
   - updates the README and the relevant docs;
   - adds a CHANGELOG entry citing the measurement behind the change, where there is one;
   - bumps the version. All manifests share one version, and `puckworks-tools check-versions` verifies they agree.
4. **Physical parameters go through the registry** (`data/params/`), each with a source, an evidence grade and a tag. From M1 on, physics code refers to registry entries, not bare numbers.
5. **Privacy.** The site never collects user data: no network requests, analytics or cookies, and user data stays in the browser ([PLAN §7.7](docs/PLAN.md#77-privacy-by-construction-d9)).
6. **Data licences.** Datasets follow [PLAN §11](docs/PLAN.md#11-data-and-licensing-rules) and carry a metadata sidecar.
7. **Version control.** The maintainer authorized assistants to use git, create commits and push changes on 2026-10-15. Preserve existing work, run the relevant checks, and use a feature branch for development.

## One-time setup

You need rustup, Node 22 or later (LTS), and Python 3.10 or later.

```bash
# Rust. rust-toolchain.toml pins 1.99.0 with the WebAssembly target; rustup installs it on first use.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"
cargo install wasm-bindgen-cli --version 0.2.129 --locked   # must match the crate pin in Cargo.toml

# Python: a virtual environment with the core extension and the project tools.
python3 -m venv .venv
.venv/bin/pip install maturin
VIRTUAL_ENV="$PWD/.venv" .venv/bin/maturin develop --release -m crates/puckcore-py/Cargo.toml
.venv/bin/pip install -e "./python[dev]"

# Web.
scripts/build_wasm.sh
(cd web && npm ci)
```

Shell sessions that haven't run the `export` line need `$HOME/.cargo/bin` on `PATH`. To make that permanent, add `. "$HOME/.cargo/env"` to your shell profile.

## Everyday commands

| Task | Command |
|---|---|
| Format, lint and test the Rust code | `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test` |
| Rebuild the WebAssembly engine | `scripts/build_wasm.sh` |
| Rebuild the Python extension | `VIRTUAL_ENV="$PWD/.venv" .venv/bin/maturin develop --release -m crates/puckcore-py/Cargo.toml` |
| Validate the parameter registry | `.venv/bin/puckworks-tools validate-registry` |
| Check the golden fixture | `.venv/bin/puckworks-tools fixtures --check` |
| Regenerate the kernel verification report | `.venv/bin/puckworks-tools verify` |
| Regenerate the M3 scenario and taste checks | `.venv/bin/puckworks-tools m3-validate` |
| Benchmark repeated simulations (release build) | `cargo run --release -p puckcore --example shot_benchmark -- 11` |
| Check that all versions agree | `.venv/bin/puckworks-tools check-versions` |
| Run the Python tests | `.venv/bin/pytest python/tests` |
| Compare the original community shots locally | `.venv/bin/puckworks-tools community --archive /path/to/shotfiles_Mar2_2021.zip --log /path/to/measurement-log.csv` ([source downloads and assumptions](python/README.md#reproduce-the-community-comparison)) |
| Start the web dev server | `cd web && npm run dev` |
| Run the web checks | `cd web && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run licenses` |
| Run the browser end-to-end test (uses the installed Google Chrome) | `cd web && npm run e2e` |
| Measure production Explore rendering (build first) | `cd web && node scripts/render-benchmark.mjs --backend auto --quality exact --counts 30000,150000,5000,25000 --trials 3 --dpr 1` |

## Rendering performance measurements

Version 0.9.1 provides a repeatable production-view benchmark. From `web/`, build once, then run:

```bash
npm run build
node scripts/render-benchmark.mjs --backend auto --quality exact --counts 30000,150000,5000,25000 --trials 3 --dpr 1 --output test-results/render-exact.json
```

The script uses installed Chrome, or the executable specified by `CHROME_PATH`. `--backend auto` uses the browser's available backend and records its actual WebGL strings; `--backend software` explicitly selects SwiftShader. `--quality exact` requires analytic sphere silhouettes and surface depth; `--quality current` accepts the build's recorded rendering path, including the frozen reference. Physical radii and the full requested particle population are preserved. The recorded environment identifies the rendering implementation and exact sphere quality.

Each count uses a fixed viewport: 1280×900 for 30,000/150,000 particles and 390×844 for 5,000/25,000 particles. `--dpr` defaults to 1; the renderer's existing DPR cap is recorded separately. The benchmark does not reduce counts or DPR to improve results. Compare matching populations, viewport and drawing-buffer dimensions, DPR, camera path, cut, network visibility and sphere quality. `--trials 3` repeats from fresh browser contexts. An alternate production directory can be selected with `--dist PATH`, or a running local server with `--url URL`.

The browser warms up at a fixed camera pose for at least 1.5 seconds **and** 30 successful render submissions, then resets the orbit to zero and samples a deterministic five-second trajectory. Reports retain actual warmup/sample durations, interval counts, median/p95 frame intervals, CPU submission durations, target-budget missed-slot estimates and any available non-disjoint asynchronous GPU timer results. Hidden tabs, lost contexts and changed configurations cancel the measurement. Frame intervals describe RAF scheduling around CPU submissions; they do not count GPU-completed or compositor-presented frames. GPU queries measure selected render commands, report unresolved queries, and never force a per-frame `gl.finish` or readback. The UI exposes the same structured JSON and a local **Download benchmark JSON** button.

For the original frozen M5 baseline, `scripts/normalize-render-baseline.mjs` accepts only the pinned build hashes and writes a separate instrumented directory. It preserves the renderer, shaders, geometry, counts and DPR policy while applying the same camera and timing protocol. It records a provenance sidecar, leaves the source untouched and refuses to replace an existing output. Run that instrumented directory with `--quality current`; a generic or unknown baseline build is rejected.

The RTX 4080 Laptop GPU identified in the in-app browser is high end hardware. Desktop viewport emulation is not physical phone evidence, and software rendering is not a hardware G5 result. The midrange laptop and physical phone gates remain open. Record results and limitations in [M5 rendering performance](docs/validation/m5-rendering-performance.md); the broader [M5 verification report](docs/validation/m5-validation.md) tracks the remaining gates.

## When the core numerics change

`data/fixtures/sphere_cases.json` is a golden file that pins the core's output. Both the Python and the web test suites compare against it. After an intentional numerical change:

1. Rebuild the WebAssembly engine and the Python extension.
2. Run `puckworks-tools fixtures` to regenerate the golden file.
3. Run `puckworks-tools verify` to refresh the verification report.
4. Record the change in the CHANGELOG, with the new error figures.

## Continuous integration

Four GitHub Actions workflows run in `.github/workflows/`:

| Workflow | Runs |
|---|---|
| `rust.yml` | rustfmt, clippy, tests, the WebAssembly build check and the cargo-deny licence check |
| `python.yml` | builds the extension, then validates the registry, checks versions and the golden fixture, and runs pytest |
| `web.yml` | builds the engine, then lints, type-checks, tests and builds the app, checks licences and runs the browser test; on pull requests, and as the first stage of `pages.yml` |
| `pages.yml` | on every push to `main`: runs `web.yml`, then deploys that exact build to GitHub Pages; set **Settings → Pages → Source** to **GitHub Actions** |

## The source link in the deployed site

GPL-2.0-or-later requires the site to point at its source. The build takes the URL from `PUCKWORKS_SOURCE_URL`, or in GitHub Actions from GitHub's own repository variables. A CI build without one fails. A local build falls back to a clearly marked placeholder.

## Repository layout

See [PLAN §7.6](docs/PLAN.md#76-repository-layout-target).
