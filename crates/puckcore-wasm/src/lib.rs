// SPDX-License-Identifier: GPL-2.0-or-later
//! WebAssembly bindings for `puckcore`, used by the browser app and by Node tests.
//!
//! The JavaScript-facing API is a frozen contract. New functions may be added;
//! existing names and signatures must not change.
//!
//! - `coreVersion(): string`
//! - `simulateSphereRelease(radiusM, diffusivityM2S, nShells, tEndS, nSteps, grid, scheme): SphereRelease`.
//!   It throws an `Error` naming the parameter when an input is invalid. Valid ranges:
//!   - `radiusM`, `diffusivityM2S` and `tEndS`: finite and > 0, with D·tEnd/radius² ≤ 1e200;
//!   - `nShells`: 2 to 100 000; `nSteps`: 1 to 10 000 000;
//!   - `grid`: `"uniform_radius"` or `"equal_volume"`;
//!   - `scheme`: `"backward_euler"`, `"bdf2"` or `"crank_nicolson"`.
//!
//!   `nShells` and `nSteps` are converted with WebAssembly's ToInt32 rule and read as
//!   unsigned: fractions are truncated and values wrap modulo 2^32, so `64.9` and
//!   `2 ** 32 + 64` both mean 64. Pass integers.
//! - `crankSphereReleaseFraction(tS, radiusM, diffusivityM2S): number` (0 for `tS <= 0`)
//!
//! Shot simulation (M1; JSON documents specified in `docs/model/m1-contract.md`).
//! Each function takes and returns JSON text, and throws an `Error` with a
//! readable message on invalid input:
//! - `presets(): string`: a `puckworks.presets/1` document.
//! - `registry(): string`: a `puckworks.registry/1` document.
//! - `buildShotSpec(recipeJson): string`: `{ spec, derived }`.
//! - `simulateShot(specJson): string`: a `puckworks.shot-result/1` document.
//! - `simulateRecipe(recipeJson): string`: `{ build: { spec, derived }, result }`.
//!
//! Diagnostics:
//! - `lastPanic(): string`: the message of the most recent Rust panic, or `""`.
//!   A panic surfaces in JavaScript only as a `RuntimeError: unreachable` trap.
//!   Call this right after catching one, then discard the instance: its state is
//!   undefined after a trap.
//!
//! `SphereRelease` getters: `times`, `releasedFraction`, `analyticFraction`,
//! `shellOuterRadii`, `finalProfile` (all `Float64Array`), `maxAbsError`,
//! `massBalanceError` (numbers). Call `free()` when done with it.

use puckcore::{Grid, Scheme, SphereReleaseParams, SphereReleaseResult};
use wasm_bindgen::prelude::*;

use std::sync::{Mutex, Once};

/// The message of the most recent panic, recorded by the hook installed in [`start`].
static LAST_PANIC: Mutex<String> = Mutex::new(String::new());

/// Runs when the module is instantiated: installs the panic hook.
#[wasm_bindgen(start)]
pub fn start() {
    install_panic_hook();
}

/// Records every panic message in [`LAST_PANIC`], then calls the previous hook.
/// Idempotent. Dependency-free, and silent: it writes nothing to the console.
fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Ok(mut last) = LAST_PANIC.lock() {
                *last = info.to_string();
            }
            previous(info);
        }));
    });
}

/// The message of the most recent Rust panic, or an empty string.
#[wasm_bindgen(js_name = lastPanic)]
pub fn last_panic() -> String {
    LAST_PANIC
        .lock()
        .map(|last| last.clone())
        .unwrap_or_default()
}

/// Version of the core (same as the crate version).
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    puckcore::VERSION.to_string()
}

/// Result of [`simulate_sphere_release`].
#[wasm_bindgen]
pub struct SphereRelease {
    inner: SphereReleaseResult,
}

#[wasm_bindgen]
impl SphereRelease {
    /// Output times, s.
    #[wasm_bindgen(getter)]
    pub fn times(&self) -> Vec<f64> {
        self.inner.t_s.clone()
    }

    /// Numerical released fraction at each output time.
    #[wasm_bindgen(getter, js_name = releasedFraction)]
    pub fn released_fraction(&self) -> Vec<f64> {
        self.inner.released_fraction.clone()
    }

    /// Analytic (Crank) released fraction at each output time.
    #[wasm_bindgen(getter, js_name = analyticFraction)]
    pub fn analytic_fraction(&self) -> Vec<f64> {
        self.inner.analytic_fraction.clone()
    }

    /// Outer radius of each shell, m.
    #[wasm_bindgen(getter, js_name = shellOuterRadii)]
    pub fn shell_outer_radii(&self) -> Vec<f64> {
        self.inner.shell_outer_radii_m.clone()
    }

    /// c/c0 in each shell at the end time.
    #[wasm_bindgen(getter, js_name = finalProfile)]
    pub fn final_profile(&self) -> Vec<f64> {
        self.inner.final_profile.clone()
    }

    /// Largest |numerical − analytic| released fraction.
    #[wasm_bindgen(getter, js_name = maxAbsError)]
    pub fn max_abs_error(&self) -> f64 {
        self.inner.max_abs_error
    }

    /// Discrete mass-conservation error, as a fraction of the initial mass.
    #[wasm_bindgen(getter, js_name = massBalanceError)]
    pub fn mass_balance_error(&self) -> f64 {
        self.inner.mass_balance_error
    }
}

/// Simulates diffusion out of a sphere into a perfect sink.
///
/// `grid` is `"uniform_radius"` or `"equal_volume"`; `scheme` is
/// `"backward_euler"`, `"bdf2"` or `"crank_nicolson"`.
///
/// Throws an `Error` naming the parameter when an input is out of range.
/// Valid ranges: radius, diffusivity and end time finite and > 0, with
/// D·tEnd/radius² ≤ 1e200; 2 ≤ `nShells` ≤ 100 000; 1 ≤ `nSteps` ≤
/// 10 000 000. `nShells` and `nSteps` are truncated and wrapped modulo 2^32
/// (WebAssembly ToInt32), so pass integers.
#[wasm_bindgen(js_name = simulateSphereRelease)]
pub fn simulate_sphere_release(
    radius_m: f64,
    diffusivity_m2_s: f64,
    n_shells: usize,
    t_end_s: f64,
    n_steps: usize,
    grid: &str,
    scheme: &str,
) -> Result<SphereRelease, JsError> {
    let params = SphereReleaseParams {
        radius_m,
        diffusivity_m2_s,
        n_shells,
        t_end_s,
        n_steps,
        grid: Grid::parse(grid)?,
        scheme: Scheme::parse(scheme)?,
    };
    let inner = puckcore::simulate_sphere_release(&params)?;
    Ok(SphereRelease { inner })
}

/// Analytic released fraction for the perfect-sink sphere (Crank 1975).
#[wasm_bindgen(js_name = crankSphereReleaseFraction)]
pub fn crank_sphere_release_fraction(t_s: f64, radius_m: f64, diffusivity_m2_s: f64) -> f64 {
    puckcore::crank_sphere_release_fraction(t_s, radius_m, diffusivity_m2_s)
}

/// All presets: a `puckworks.presets/1` JSON document.
#[wasm_bindgen]
pub fn presets() -> String {
    puckmodel::api::presets_json()
}

/// The parameter registry with provenance: a `puckworks.registry/1` JSON document.
#[wasm_bindgen]
pub fn registry() -> String {
    puckmodel::api::registry_json()
}

/// Builds the physical spec for a recipe; returns `{ spec, derived }` as JSON.
#[wasm_bindgen(js_name = buildShotSpec)]
pub fn build_shot_spec(recipe_json: &str) -> Result<String, JsError> {
    Ok(puckmodel::api::build_shot_spec_json(recipe_json)?)
}

/// Simulates a physical spec; returns a `puckworks.shot-result/1` JSON document.
#[wasm_bindgen(js_name = simulateShot)]
pub fn simulate_shot(spec_json: &str) -> Result<String, JsError> {
    Ok(puckmodel::api::simulate_shot_json(spec_json)?)
}

/// Builds and simulates a recipe; returns `{ build, result }` as JSON.
#[wasm_bindgen(js_name = simulateRecipe)]
pub fn simulate_recipe(recipe_json: &str) -> Result<String, JsError> {
    Ok(puckmodel::api::simulate_recipe_json(recipe_json)?)
}

/// Seeded Tier 0 input scenarios; returns `puckworks.uncertainty/1` JSON.
#[wasm_bindgen(js_name = simulateUncertainty)]
pub fn simulate_uncertainty(recipe_json: &str, options_json: &str) -> Result<String, JsError> {
    Ok(puckmodel::api::simulate_uncertainty_json(
        recipe_json,
        options_json,
    )?)
}

/// Explain taste from an existing result, without running the shot again.
#[wasm_bindgen(js_name = estimateTaste)]
pub fn estimate_taste(
    recipe_json: &str,
    result_json: &str,
    conditions_json: &str,
) -> Result<String, JsError> {
    Ok(puckmodel::api::estimate_taste_json(
        recipe_json,
        result_json,
        conditions_json,
    )?)
}

/// Build and simulate a recipe, returning explainable taste proxies.
#[wasm_bindgen(js_name = analyzeTaste)]
pub fn analyze_taste(recipe_json: &str, conditions_json: &str) -> Result<String, JsError> {
    Ok(puckmodel::api::analyze_taste_json(
        recipe_json,
        conditions_json,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_panic_hook_records_the_message() {
        install_panic_hook();
        install_panic_hook(); // idempotent
        let caught = std::panic::catch_unwind(|| panic!("boom in the solver"));
        assert!(caught.is_err());
        let message = last_panic();
        assert!(message.contains("boom in the solver"), "{message}");
        assert!(
            message.contains("lib.rs"),
            "the location is included: {message}"
        );
    }
}
