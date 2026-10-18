// SPDX-License-Identifier: GPL-2.0-or-later
//! Python bindings for `puckcore` (`import puckcore`).
//!
//! The Python-facing API is a frozen contract. New functions may be added;
//! existing names and signatures must not change.
//!
//! - `puckcore.__version__`
//! - `puckcore.simulate_sphere_release(radius_m, diffusivity_m2_s, n_shells, t_end_s, n_steps,
//!   grid="equal_volume", scheme="bdf2") -> dict` with keys `t_s`, `released_fraction`,
//!   `analytic_fraction`, `shell_outer_radii_m`, `final_profile` (lists of float),
//!   `max_abs_error`, `mass_balance_error` (float).
//!   - Valid ranges: `radius_m`, `diffusivity_m2_s` and `t_end_s` finite and > 0, with
//!     D·t_end/radius² ≤ 1e200; 2 ≤ `n_shells` ≤ 100 000; 1 ≤ `n_steps` ≤ 10 000 000;
//!     `grid` `"uniform_radius"` or `"equal_volume"`; `scheme` `"backward_euler"`, `"bdf2"`
//!     or `"crank_nicolson"`.
//!   - Errors: `ValueError` for a value out of range or an unknown `grid` or `scheme`
//!     (the message names the parameter); `TypeError` for an argument of the wrong type,
//!     such as a float or str for `n_shells` or a non-str `grid`; `OverflowError` for an
//!     `n_shells` or `n_steps` that is negative or too large for an unsigned machine integer.
//! - `puckcore.crank_sphere_release_fraction(t_s, radius_m, diffusivity_m2_s) -> float`
//!   (0 for `t_s <= 0`)
//!
//! Shot simulation (M1; documents specified in `docs/model/m1-contract.md`).
//! Inputs may be a dict or a JSON string; outputs are dicts. Invalid input
//! raises `ValueError` with a readable message.
//! - `puckcore.presets() -> dict` (a `puckworks.presets/1` document)
//! - `puckcore.registry() -> dict` (a `puckworks.registry/1` document)
//! - `puckcore.build_shot_spec(recipe) -> dict` (`{"spec", "derived"}`)
//! - `puckcore.simulate_shot(spec) -> dict` (a `puckworks.shot-result/1` document)
//! - `puckcore.simulate_recipe(recipe) -> dict` (`{"build", "result"}`)

use puckcore::{Grid, KernelError, Scheme, SphereReleaseParams};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

fn value_error(e: KernelError) -> PyErr {
    PyValueError::new_err(e.to_string())
}

/// Simulates diffusion out of a sphere into a perfect sink.
///
/// Valid ranges: radius_m, diffusivity_m2_s and t_end_s finite and > 0, with
/// D·t_end/radius² ≤ 1e200; 2 ≤ n_shells ≤ 100 000; 1 ≤ n_steps ≤ 10 000 000;
/// grid "uniform_radius" or "equal_volume"; scheme "backward_euler", "bdf2" or
/// "crank_nicolson".
///
/// Raises ValueError for a value out of range or an unknown grid or scheme,
/// TypeError for an argument of the wrong type (e.g. a float for n_shells),
/// and OverflowError for a negative or oversized n_shells or n_steps.
#[pyfunction]
#[pyo3(signature = (radius_m, diffusivity_m2_s, n_shells, t_end_s, n_steps, grid = "equal_volume", scheme = "bdf2"))]
#[allow(clippy::too_many_arguments)]
fn simulate_sphere_release<'py>(
    py: Python<'py>,
    radius_m: f64,
    diffusivity_m2_s: f64,
    n_shells: usize,
    t_end_s: f64,
    n_steps: usize,
    grid: &str,
    scheme: &str,
) -> PyResult<Bound<'py, PyDict>> {
    let params = SphereReleaseParams {
        radius_m,
        diffusivity_m2_s,
        n_shells,
        t_end_s,
        n_steps,
        grid: Grid::parse(grid).map_err(value_error)?,
        scheme: Scheme::parse(scheme).map_err(value_error)?,
    };
    let r = puckcore::simulate_sphere_release(&params).map_err(value_error)?;
    let out = PyDict::new(py);
    out.set_item("t_s", r.t_s)?;
    out.set_item("released_fraction", r.released_fraction)?;
    out.set_item("analytic_fraction", r.analytic_fraction)?;
    out.set_item("shell_outer_radii_m", r.shell_outer_radii_m)?;
    out.set_item("final_profile", r.final_profile)?;
    out.set_item("max_abs_error", r.max_abs_error)?;
    out.set_item("mass_balance_error", r.mass_balance_error)?;
    Ok(out)
}

/// Analytic released fraction for the perfect-sink sphere (Crank 1975).
#[pyfunction]
fn crank_sphere_release_fraction(t_s: f64, radius_m: f64, diffusivity_m2_s: f64) -> f64 {
    puckcore::crank_sphere_release_fraction(t_s, radius_m, diffusivity_m2_s)
}

/// Python bindings for the Puckworks numerical core.
#[pymodule]
#[pyo3(name = "puckcore")]
fn puckcore_py(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", puckcore::VERSION)?;
    m.add_function(wrap_pyfunction!(simulate_sphere_release, m)?)?;
    m.add_function(wrap_pyfunction!(crank_sphere_release_fraction, m)?)?;
    m.add_function(wrap_pyfunction!(presets, m)?)?;
    m.add_function(wrap_pyfunction!(registry, m)?)?;
    m.add_function(wrap_pyfunction!(build_shot_spec, m)?)?;
    m.add_function(wrap_pyfunction!(simulate_shot, m)?)?;
    m.add_function(wrap_pyfunction!(simulate_recipe, m)?)?;
    m.add_function(wrap_pyfunction!(simulate_uncertainty, m)?)?;
    m.add_function(wrap_pyfunction!(estimate_taste, m)?)?;
    m.add_function(wrap_pyfunction!(analyze_taste, m)?)?;
    Ok(())
}

/// Accepts a dict (or other JSON-serialisable object) or a JSON string.
fn json_text(py: Python<'_>, obj: &Bound<'_, PyAny>) -> PyResult<String> {
    if let Ok(text) = obj.extract::<String>() {
        return Ok(text);
    }
    py.import("json")?.call_method1("dumps", (obj,))?.extract()
}

fn json_value<'py>(py: Python<'py>, text: &str) -> PyResult<Bound<'py, PyAny>> {
    py.import("json")?.call_method1("loads", (text,))
}

fn api_error(e: puckmodel::api::ApiError) -> PyErr {
    PyValueError::new_err(e.to_string())
}

/// All presets (a `puckworks.presets/1` document).
#[pyfunction]
fn presets(py: Python<'_>) -> PyResult<Bound<'_, PyAny>> {
    json_value(py, &puckmodel::api::presets_json())
}

/// The parameter registry with provenance (a `puckworks.registry/1` document).
#[pyfunction]
fn registry(py: Python<'_>) -> PyResult<Bound<'_, PyAny>> {
    json_value(py, &puckmodel::api::registry_json())
}

/// Builds the physical spec for a recipe: `{"spec", "derived"}`.
#[pyfunction]
fn build_shot_spec<'py>(
    py: Python<'py>,
    recipe: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyAny>> {
    let out = puckmodel::api::build_shot_spec_json(&json_text(py, recipe)?).map_err(api_error)?;
    json_value(py, &out)
}

/// Simulates a physical spec (a `puckworks.shot-result/1` document).
#[pyfunction]
fn simulate_shot<'py>(py: Python<'py>, spec: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyAny>> {
    let out = puckmodel::api::simulate_shot_json(&json_text(py, spec)?).map_err(api_error)?;
    json_value(py, &out)
}

/// Builds and simulates a recipe: `{"build", "result"}`.
#[pyfunction]
fn simulate_recipe<'py>(
    py: Python<'py>,
    recipe: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyAny>> {
    let out = puckmodel::api::simulate_recipe_json(&json_text(py, recipe)?).map_err(api_error)?;
    json_value(py, &out)
}

/// Seeded Tier 0 input scenarios. Inputs are dictionaries or JSON strings.
#[pyfunction]
#[pyo3(signature = (recipe, options = None))]
fn simulate_uncertainty<'py>(
    py: Python<'py>,
    recipe: &Bound<'py, PyAny>,
    options: Option<&Bound<'py, PyAny>>,
) -> PyResult<Bound<'py, PyAny>> {
    let options_json = options
        .map(|v| json_text(py, v))
        .transpose()?
        .unwrap_or_else(|| "{}".into());
    let out = puckmodel::api::simulate_uncertainty_json(&json_text(py, recipe)?, &options_json)
        .map_err(api_error)?;
    json_value(py, &out)
}

/// Explain taste proxies from an existing simulated result.
#[pyfunction]
#[pyo3(signature = (recipe, result, conditions = None))]
fn estimate_taste<'py>(
    py: Python<'py>,
    recipe: &Bound<'py, PyAny>,
    result: &Bound<'py, PyAny>,
    conditions: Option<&Bound<'py, PyAny>>,
) -> PyResult<Bound<'py, PyAny>> {
    let conditions_json = conditions
        .map(|v| json_text(py, v))
        .transpose()?
        .unwrap_or_else(|| "{}".into());
    let out = puckmodel::api::estimate_taste_json(
        &json_text(py, recipe)?,
        &json_text(py, result)?,
        &conditions_json,
    )
    .map_err(api_error)?;
    json_value(py, &out)
}

/// Build, simulate and explain taste proxies for a recipe.
#[pyfunction]
#[pyo3(signature = (recipe, conditions = None))]
fn analyze_taste<'py>(
    py: Python<'py>,
    recipe: &Bound<'py, PyAny>,
    conditions: Option<&Bound<'py, PyAny>>,
) -> PyResult<Bound<'py, PyAny>> {
    let conditions_json = conditions
        .map(|v| json_text(py, v))
        .transpose()?
        .unwrap_or_else(|| "{}".into());
    let out = puckmodel::api::analyze_taste_json(&json_text(py, recipe)?, &conditions_json)
        .map_err(api_error)?;
    json_value(py, &out)
}
