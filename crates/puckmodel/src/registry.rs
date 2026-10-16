// SPDX-License-Identifier: GPL-2.0-or-later
//! The parameter registry (PLAN §7.3 R), embedded from
//! `generated/registry.json` (a `puckworks.registry/1` document written by
//! `python -m puckworks_tools.export` from `data/params/*.yaml` and, when it
//! exists, `data/calibration/current.yaml`).
//!
//! Each record's `default` is the number the input models use: the record's
//! value, the central value of its prior, or a calibrated value. The model
//! code always asks for a parameter together with the units it expects, so a
//! unit change in the YAML is caught instead of silently mis-scaling.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::api::ApiError;

/// Schema id of the embedded registry document.
pub const REGISTRY_SCHEMA: &str = "puckworks.registry/1";

pub(crate) const REGISTRY_JSON: &str = include_str!("../generated/registry.json");

/// Admissible bounds of a parameter, in its units.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Range {
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

impl Range {
    /// Whether `x` lies inside the (inclusive) bounds.
    pub fn contains(&self, x: f64) -> bool {
        self.min.is_none_or(|lo| x >= lo) && self.max.is_none_or(|hi| x <= hi)
    }
}

/// The fields of a registry record that the input models need. The embedded
/// document carries the full provenance (sources, conditions, relation, …)
/// for the user interface; serde skips what is not listed here.
#[derive(Clone, Debug, Deserialize)]
pub struct Parameter {
    pub id: String,
    pub name: String,
    pub units: String,
    /// The number the models use.
    pub default: f64,
    /// `"value"`, `"prior"` (the prior's central value) or `"calibration"`.
    pub default_from: String,
    pub range: Range,
    pub tag: String,
    pub evidence_grade: String,
}

#[derive(Deserialize)]
struct Document {
    schema: String,
    parameters: Vec<Parameter>,
}

/// The parsed registry.
#[derive(Debug)]
pub struct Registry {
    params: BTreeMap<String, Parameter>,
}

impl Registry {
    /// Parses a `puckworks.registry/1` document.
    pub fn parse(text: &str) -> Result<Self, String> {
        let doc: Document =
            serde_json::from_str(text).map_err(|e| format!("invalid registry document: {e}"))?;
        if doc.schema != REGISTRY_SCHEMA {
            return Err(format!("registry document has schema {:?}", doc.schema));
        }
        let mut params = BTreeMap::new();
        for p in doc.parameters {
            if !p.default.is_finite() {
                return Err(format!(
                    "registry parameter {} has a non-finite default",
                    p.id
                ));
            }
            if !["value", "prior", "calibration"].contains(&p.default_from.as_str()) {
                return Err(format!(
                    "registry parameter {}: unknown default_from {:?}",
                    p.id, p.default_from
                ));
            }
            if let Some(old) = params.insert(p.id.clone(), p) {
                return Err(format!("duplicate registry id {}", old.id));
            }
        }
        Ok(Self { params })
    }

    /// The record with this id.
    pub fn get(&self, id: &str) -> Option<&Parameter> {
        self.params.get(id)
    }

    /// All ids, sorted.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.params.keys().map(String::as_str)
    }

    /// Number of records.
    pub fn len(&self) -> usize {
        self.params.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.params.is_empty()
    }
}

/// The embedded registry, parsed on first use.
pub fn registry() -> Result<&'static Registry, ApiError> {
    static REGISTRY: OnceLock<Result<Registry, String>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Registry::parse(REGISTRY_JSON))
        .as_ref()
        .map_err(|e| ApiError(format!("internal error: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_registry_parses() {
        let reg = registry().unwrap();
        assert!(reg.len() > 150);
        let k = reg.get("psd.x50_gap_ratio").unwrap();
        assert_eq!(k.units, "1");
        assert_eq!(k.default, 1.4);
        assert!(k.range.contains(1.4) && !k.range.contains(-1.0));
    }

    #[test]
    fn rejects_bad_documents() {
        assert!(Registry::parse("{}").is_err());
        assert!(Registry::parse(r#"{"schema":"x","parameters":[]}"#).is_err());
        let dup = r#"{"schema":"puckworks.registry/1","parameters":[
            {"id":"a.b","name":"n","units":"1","default":1,"default_from":"value","range":{},"tag":"measured","evidence_grade":"A"},
            {"id":"a.b","name":"n","units":"1","default":1,"default_from":"value","range":{},"tag":"measured","evidence_grade":"A"}]}"#;
        assert!(Registry::parse(dup).unwrap_err().contains("duplicate"));
    }
}
