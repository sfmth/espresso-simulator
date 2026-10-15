// SPDX-License-Identifier: GPL-2.0-or-later
//! The JSON API shared by the WebAssembly and Python bindings.
//!
//! Every function takes and returns JSON text. The documents are specified in
//! `docs/model/m1-contract.md`. Names and signatures are frozen; new
//! functions may be added.

use std::fmt;

use puckcore::shot::{ShotResult, ShotSpec, simulate_shot};
use serde::Serialize;

use crate::builder::{self, Built};
use crate::recipe::Recipe;

/// An API error, with a message suitable for the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError(pub String);

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ApiError {}

fn to_json<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value)
        .map_err(|e| ApiError(format!("could not serialise the result: {e}")))
}

fn parse_recipe(recipe_json: &str) -> Result<Recipe, ApiError> {
    serde_json::from_str(recipe_json).map_err(|e| ApiError(format!("invalid recipe: {e}")))
}

/// All presets (grinders and burr families, baskets, machines, beans): a
/// `puckworks.presets/1` document.
pub fn presets_json() -> String {
    crate::presets::PRESETS_JSON.to_string()
}

/// The parameter registry with provenance: a `puckworks.registry/1` document.
pub fn registry_json() -> String {
    crate::registry::REGISTRY_JSON.to_string()
}

/// Builds the physical spec for a recipe: `{ "spec": ShotSpec, "derived": {...} }`.
pub fn build_shot_spec_json(recipe_json: &str) -> Result<String, ApiError> {
    let built = builder::build(&parse_recipe(recipe_json)?)?;
    to_json(&built)
}

/// Simulates a physical spec: a `puckworks.shot-result/1` document.
pub fn simulate_shot_json(spec_json: &str) -> Result<String, ApiError> {
    let spec: ShotSpec =
        serde_json::from_str(spec_json).map_err(|e| ApiError(format!("invalid shot spec: {e}")))?;
    let result = simulate_shot(&spec).map_err(|e| ApiError(e.to_string()))?;
    to_json(&result)
}

/// Builds and simulates a recipe: `{ "build": {spec, derived}, "result": ShotResult }`.
pub fn simulate_recipe_json(recipe_json: &str) -> Result<String, ApiError> {
    #[derive(Serialize)]
    struct RecipeRun {
        build: Built,
        result: ShotResult,
    }
    let built = builder::build(&parse_recipe(recipe_json)?)?;
    let result = simulate_shot(&built.spec).map_err(|e| ApiError(e.to_string()))?;
    to_json(&RecipeRun {
        build: built,
        result,
    })
}
