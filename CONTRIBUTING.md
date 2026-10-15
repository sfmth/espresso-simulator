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
7. **Version control.** Automated assistants working in this repository never run git commands; the maintainer handles version control.

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
| Check that all versions agree | `.venv/bin/puckworks-tools check-versions` |
| Run the Python tests | `.venv/bin/pytest python/tests` |
| Start the web dev server | `cd web && npm run dev` |
| Run the web checks | `cd web && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run licenses` |
| Run the browser end-to-end test (uses the installed Google Chrome) | `cd web && npm run e2e` |

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
