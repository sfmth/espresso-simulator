// SPDX-License-Identifier: GPL-2.0-or-later
//! Build context: registry lookups with one precedence rule, provenance and
//! notes (docs/model/input-models.md §1).
//!
//! Precedence for a registry-backed quantity, highest first:
//! 1. an explicit **recipe** field (`recipe:<path>`): what the user typed wins,
//!    even over a sandbox override of the same quantity (with a note);
//! 2. a recipe **override** of the registry id (`override:<id>`);
//! 3. a **calibrated** value from data/calibration/current.yaml
//!    (`calibration:<id>`);
//! 4. a **preset** value (`preset:<kind>/<id>`);
//! 5. a **model-derived** value (e.g. the bean model's porosity);
//! 6. the **registry default** (`registry:<id>`).
//!
//! Every value keeps the token of its actual source, and every value a model
//! needs inside tighter bounds than the registry's range is checked here, so
//! an error names the override, recipe field or calibration responsible.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use crate::api::ApiError;
use crate::bounds::num;
use crate::registry::Registry;

/// A number with the provenance tokens it came from, joined by ", ".
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Val {
    pub v: f64,
    pub src: String,
}

impl Val {
    pub fn new(v: f64, src: impl Into<String>) -> Self {
        Self { v, src: src.into() }
    }
}

/// Provenance of one field of a gear block: `recipe:<path>.<name>` for the
/// recipe, the bare `preset:<kind>/<id>` token for a preset.
pub(crate) fn field_src(src: &str, name: &str) -> String {
    if src.starts_with("recipe:") {
        format!("{src}.{name}")
    } else {
        src.to_string()
    }
}

/// Joins provenance tokens, dropping empty and repeated ones.
pub(crate) fn join(parts: &[&str]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for part in parts {
        for token in part.split(", ") {
            if !token.is_empty() && !seen.contains(&token) {
                seen.push(token);
            }
        }
    }
    seen.join(", ")
}

/// Describes provenance tokens for an error message: the user-controlled ones
/// (recipe fields, overrides, calibration) when there are any, else all.
pub(crate) fn describe(src: &str) -> String {
    let tokens: Vec<&str> = src.split(", ").filter(|t| !t.is_empty()).collect();
    let user: Vec<&str> = tokens
        .iter()
        .copied()
        .filter(|t| {
            t.starts_with("recipe:") || t.starts_with("override:") || t.starts_with("calibration:")
        })
        .collect();
    let shown = if user.is_empty() { &tokens } else { &user };
    shown
        .iter()
        .map(|t| match t.split_once(':') {
            Some(("recipe", path)) => format!("recipe field {path}"),
            Some(("override", id)) => format!("the override of {id}"),
            Some(("calibration", id)) => {
                format!("the calibrated {id} (data/calibration/current.yaml)")
            }
            Some(("registry", id)) => format!("registry parameter {id}"),
            Some(("preset", p)) => format!("preset {p}"),
            Some(("model", m)) => format!("the model ({m})"),
            _ => t.to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Whether provenance tokens include a user-controlled source.
pub(crate) fn user_controlled(src: &str) -> bool {
    src.split(", ").any(|t| {
        t.starts_with("recipe:") || t.starts_with("override:") || t.starts_with("calibration:")
    })
}

/// Bounds the models need, tighter than some registry ranges (which describe
/// what the literature allows, often "≥ 0"): (id, lowest, highest, lowest
/// excluded). Checked whenever the value comes from an override, a recipe
/// field or a calibration.
const MODEL_BOUNDS: &[(&str, f64, f64, bool)] = &[
    ("psd.x50_gap_ratio", 0.3, 5.0, false),
    ("psd.fines_mode", 5.0, 200.0, false),
    ("psd.boulder_mode_ratio", 1.0, 5.0, false),
    ("bed.porosity.intergranular", 0.01, 0.95, false),
    ("bed.porosity.intraparticle", 0.01, 0.95, false),
    ("bed.density.skeletal", 500.0, 3000.0, false),
    ("hydraulics.permeability.reference", 1e-18, 1e-10, false),
    ("hydraulics.kozeny_carman.density_exponent", 0.0, 3.0, false),
    (
        "hydraulics.poroelastic.critical_pressure",
        0.5,
        100.0,
        false,
    ),
    ("hydraulics.swelling.diameter_increase", 0.0, 50.0, false),
    ("hydraulics.swelling.relaxation_time", 0.0, 600.0, false),
    ("extraction.saturation.lumped", 1.0, 2000.0, false),
    ("extraction.partition.lumped_80c", 0.01, 100.0, false),
    ("extraction.partition.caffeine", 0.01, 100.0, false),
    (
        "extraction.diffusivity.lumped.corrochano_80c",
        1e-16,
        1e-7,
        false,
    ),
    (
        "extraction.diffusivity.caffeine.particle_80c",
        1e-16,
        1e-7,
        false,
    ),
    ("extraction.max_yield", 1.0, 60.0, false),
    ("extraction.dispersion.axial_coefficient", 0.0, 1e-3, false),
    ("extraction.surface_rate.grudeva2026", 0.0, 1.0, false),
    ("shot.temperature", 20.0, 100.0, false),
    ("bean.composition.arabica.caffeine", 0.0, 20.0, false),
    ("bean.composition.robusta.caffeine", 0.0, 20.0, false),
    ("bean.composition.arabica.5cqa", 0.0, 20.0, false),
    ("bean.composition.arabica.aliphatic_acids", 0.0, 20.0, false),
    ("bean.composition.robusta.aliphatic_acids", 0.0, 20.0, false),
    ("bean.composition.arabica.quinic_acid", 0.0, 20.0, false),
    ("bean.composition.robusta.quinic_acid", 0.0, 20.0, false),
    ("bean.co2.ground_residual", 0.0, 100.0, false),
    ("bean.co2.total.light", 0.01, 100.0, false),
    ("bean.co2.total.medium", 0.01, 100.0, false),
    ("bean.co2.total.dark", 0.01, 100.0, false),
    ("bean.co2.weibull_scale.light", 1.0, 1e5, false),
    ("bean.co2.weibull_scale.medium", 1.0, 1e5, false),
    ("bean.co2.weibull_scale.dark", 1.0, 1e5, false),
    ("bean.co2.weibull_shape.light", 0.05, 10.0, false),
    ("bean.co2.weibull_shape.dark", 0.05, 10.0, false),
];

fn model_bounds(id: &str) -> Option<(f64, f64, bool)> {
    MODEL_BOUNDS
        .iter()
        .find(|b| b.0 == id)
        .map(|b| (b.1, b.2, b.3))
}

/// The registry ids the builder reads (crates/puckmodel/registry-reads.txt):
/// the export refuses calibrations of other ids, and a test checks the list.
pub fn registry_reads() -> &'static BTreeSet<String> {
    static READS: OnceLock<BTreeSet<String>> = OnceLock::new();
    READS.get_or_init(|| {
        include_str!("../registry-reads.txt")
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect()
    })
}

pub(crate) struct Ctx<'a> {
    reg: &'a Registry,
    overrides: &'a BTreeMap<String, f64>,
    used: BTreeSet<String>,
    pub notes: Vec<String>,
    pub provenance: BTreeMap<String, String>,
    pub flags: BTreeSet<String>,
}

impl<'a> Ctx<'a> {
    /// Checks the overrides: every id must exist and every value must be
    /// finite and inside the parameter's range.
    pub fn new(reg: &'a Registry, overrides: &'a BTreeMap<String, f64>) -> Result<Self, ApiError> {
        for (id, &value) in overrides {
            let p = reg.get(id).ok_or_else(|| {
                ApiError(format!("overrides: unknown parameter-registry id {id:?}"))
            })?;
            if !value.is_finite() {
                return Err(ApiError(format!("overrides: {id} must be a finite number")));
            }
            if !p.range.contains(value) {
                let lo = p.range.min.map_or("−∞".to_string(), num);
                let hi = p.range.max.map_or("∞".to_string(), num);
                return Err(ApiError(format!(
                    "overrides: {id} = {} is outside its range [{lo}, {hi}] ({})",
                    num(value),
                    p.units
                )));
            }
        }
        Ok(Self {
            reg,
            overrides,
            used: BTreeSet::new(),
            notes: Vec::new(),
            provenance: BTreeMap::new(),
            flags: BTreeSet::new(),
        })
    }

    fn record(&self, id: &str, units: &str) -> Result<&'a crate::registry::Parameter, ApiError> {
        debug_assert!(
            registry_reads().contains(id),
            "{id} is read by the builder but missing from registry-reads.txt"
        );
        let p = self.reg.get(id).ok_or_else(|| {
            ApiError(format!(
                "internal error: the model needs registry parameter {id}, which is missing"
            ))
        })?;
        if p.units != units {
            return Err(ApiError(format!(
                "internal error: registry parameter {id} is in {:?}, the model expects {units:?}",
                p.units
            )));
        }
        Ok(p)
    }

    /// Checks a value against the bounds the models need for this id.
    fn check_bounds(&self, id: &str, units: &str, v: &Val) -> Result<(), ApiError> {
        let Some((lo, hi, lo_open)) = model_bounds(id) else {
            return Ok(());
        };
        let ok = v.v.is_finite() && if lo_open { v.v > lo } else { v.v >= lo } && v.v <= hi;
        if ok {
            return Ok(());
        }
        let what = if user_controlled(&v.src) {
            ""
        } else {
            "internal error: "
        };
        Err(ApiError(format!(
            "{what}{} gives {id} = {}, but the models need {}{} to {} ({units})",
            describe(&v.src),
            num(v.v),
            num(lo),
            if lo_open { " (excluded)" } else { "" },
            num(hi)
        )))
    }

    /// A registry parameter in its units, by the precedence of this module:
    /// recipe field > override > calibration > preset > model-derived >
    /// registry default.
    pub fn resolve(
        &mut self,
        id: &str,
        units: &str,
        recipe: Option<Val>,
        preset: Option<Val>,
        derived: Option<Val>,
    ) -> Result<Val, ApiError> {
        let p = self.record(id, units)?;
        self.used.insert(id.to_string());
        let overridden = self.overrides.get(id).copied();
        let v = if let Some(r) = recipe {
            if overridden.is_some() {
                self.note(format!(
                    "{} beats the override of {id}: an explicit recipe value wins over a sandbox override of the same quantity.",
                    describe(&r.src)
                ));
            }
            r
        } else if let Some(o) = overridden {
            Val::new(o, format!("override:{id}"))
        } else if p.default_from == "calibration" {
            Val::new(p.default, format!("calibration:{id}"))
        } else if let Some(pv) = preset {
            pv
        } else if let Some(d) = derived {
            d
        } else {
            Val::new(p.default, format!("registry:{id}"))
        };
        self.check_bounds(id, units, &v)?;
        Ok(v)
    }

    /// A registry parameter with no gear-specific candidates.
    pub fn param(&mut self, id: &str, units: &str) -> Result<Val, ApiError> {
        self.resolve(id, units, None, None, None)
    }

    /// The registry default (calibrated if available), ignoring overrides:
    /// for reference states such as the porosity at which κ₀ applies.
    pub fn default_of(&mut self, id: &str, units: &str) -> Result<Val, ApiError> {
        let p = self.record(id, units)?;
        self.used.insert(id.to_string());
        let token = if p.default_from == "calibration" {
            format!("calibration:{id}")
        } else {
            format!("registry:{id}")
        };
        Ok(Val::new(p.default, token))
    }

    /// Whether the recipe overrides this id.
    pub fn is_overridden(&self, id: &str) -> bool {
        self.overrides.contains_key(id)
    }

    /// Adds a note for the user, once.
    pub fn note(&mut self, text: impl Into<String>) {
        let text = text.into();
        if !self.notes.contains(&text) {
            self.notes.push(text);
        }
    }

    /// Records where a spec field came from.
    pub fn prov(&mut self, path: &str, src: &str) {
        self.provenance.insert(path.to_string(), join(&[src]));
    }

    /// The provenance recorded for a spec field path, or for its closest
    /// recorded parent (`machine.phases[0].limit` → `machine.phases`).
    pub fn provenance_of(&self, field: &str) -> Option<&String> {
        let mut path = field.to_string();
        loop {
            if let Some(src) = self.provenance.get(&path) {
                return Some(src);
            }
            let cut = path.rfind(['.', '['])?;
            path.truncate(cut);
        }
    }

    /// Overrides that no model consulted.
    pub fn unused_overrides(&self) -> Vec<String> {
        self.overrides
            .keys()
            .filter(|id| !self.used.contains(*id))
            .cloned()
            .collect()
    }

    /// The registry ids consulted so far.
    pub fn used(&self) -> &BTreeSet<String> {
        &self.used
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::registry;

    #[test]
    fn precedence_and_unknown_overrides() {
        let reg = registry().unwrap();
        let mut ov = BTreeMap::new();
        ov.insert("psd.fines_mode".to_string(), 35.0);
        ov.insert("hydraulics.permeability.in_shot".to_string(), 4e-15);
        let mut ctx = Ctx::new(reg, &ov).unwrap();
        let v = ctx.param("psd.fines_mode", "um").unwrap();
        assert_eq!(v, Val::new(35.0, "override:psd.fines_mode"));
        // An override beats a preset; a recipe field beats an override (with a note).
        let v = ctx
            .resolve(
                "psd.fines_mode",
                "um",
                None,
                Some(Val::new(41.0, "preset:x/y")),
                None,
            )
            .unwrap();
        assert_eq!(v.v, 35.0);
        let v = ctx
            .resolve(
                "psd.fines_mode",
                "um",
                Some(Val::new(45.0, "recipe:grinder.z")),
                None,
                None,
            )
            .unwrap();
        assert_eq!(v, Val::new(45.0, "recipe:grinder.z"));
        assert!(
            ctx.notes
                .iter()
                .any(|n| n.contains("beats the override of psd.fines_mode"))
        );
        // A preset beats a derived value, which beats the registry default.
        let v = ctx
            .resolve(
                "bed.porosity.intraparticle",
                "1",
                None,
                Some(Val::new(0.5, "preset:x/y")),
                Some(Val::new(0.6, "model:m")),
            )
            .unwrap();
        assert_eq!(v.src, "preset:x/y");
        let v = ctx
            .resolve(
                "bed.porosity.intraparticle",
                "1",
                None,
                None,
                Some(Val::new(0.6, "model:m")),
            )
            .unwrap();
        assert_eq!(v.src, "model:m");
        assert!(
            ctx.param("psd.fines_mode", "1")
                .unwrap_err()
                .0
                .contains("expects")
        );
        assert_eq!(
            ctx.unused_overrides(),
            vec!["hydraulics.permeability.in_shot".to_string()]
        );

        let mut bad = BTreeMap::new();
        bad.insert("no.such.id".to_string(), 1.0);
        assert!(
            Ctx::new(reg, &bad)
                .err()
                .unwrap()
                .0
                .contains("\"no.such.id\"")
        );
        let mut out = BTreeMap::new();
        out.insert("psd.sphericity".to_string(), 2.0);
        assert!(
            Ctx::new(reg, &out)
                .err()
                .unwrap()
                .0
                .contains("outside its range")
        );
    }

    #[test]
    fn model_bounds_name_the_source() {
        let reg = registry().unwrap();
        // An override outside the record's range (now equal to the bounds the models
        // need) is refused up front, naming the id ...
        let mut ov = BTreeMap::new();
        ov.insert("extraction.saturation.lumped".to_string(), 0.0);
        let err = Ctx::new(reg, &ov).err().unwrap().0;
        assert!(
            err.contains("overrides: extraction.saturation.lumped = 0 is outside its range"),
            "{err}"
        );
        // ... and a recipe value outside the bounds the models need names its field.
        let ov = BTreeMap::new();
        let mut ctx = Ctx::new(reg, &ov).unwrap();
        let err = ctx
            .resolve(
                "psd.x50_gap_ratio",
                "1",
                Some(Val::new(10.0, "recipe:grinder.x50_gap_ratio")),
                None,
                None,
            )
            .unwrap_err()
            .0;
        assert!(
            err.contains("grinder.x50_gap_ratio")
                && err.contains("0.3 to 5")
                && !err.contains("internal"),
            "{err}"
        );
    }

    #[test]
    fn calibrated_defaults_beat_presets() {
        let doc = r#"{"schema":"puckworks.registry/1","calibration":{"source":"data/calibration/current.yaml"},
            "parameters":[
              {"id":"psd.fines_mode","name":"n","units":"um","default":42.0,"default_from":"calibration","range":{"min":0},"tag":"fitted","evidence_grade":"B"},
              {"id":"model.psd.fines_log_width","name":"n","units":"1","default":0.6,"default_from":"prior","range":{},"tag":"estimated","evidence_grade":"D"}]}"#;
        let reg = Registry::parse(doc).unwrap();
        let ov = BTreeMap::new();
        let mut ctx = Ctx::new(&reg, &ov).unwrap();
        let v = ctx
            .resolve(
                "psd.fines_mode",
                "um",
                None,
                Some(Val::new(30.0, "preset:x/y")),
                None,
            )
            .unwrap();
        assert_eq!(v, Val::new(42.0, "calibration:psd.fines_mode"));
        assert_eq!(
            ctx.param("model.psd.fines_log_width", "1").unwrap(),
            Val::new(0.6, "registry:model.psd.fines_log_width")
        );
        assert_eq!(ctx.default_of("psd.fines_mode", "um").unwrap().v, 42.0);
    }

    #[test]
    fn helpers() {
        assert_eq!(join(&["a, b", "b", "", "c"]), "a, b, c");
        assert_eq!(
            describe("registry:a.b, recipe:prep.dose_g, override:c.d"),
            "recipe field prep.dose_g, the override of c.d"
        );
        assert_eq!(describe("registry:a.b"), "registry parameter a.b");
        assert!(registry_reads().contains("psd.x50_gap_ratio"));
    }
}
