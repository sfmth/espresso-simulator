// SPDX-License-Identifier: GPL-2.0-or-later
//! Presets (grinders and burr families, baskets, machines, beans), embedded
//! from `generated/presets.json`: a `puckworks.presets/1` document written by
//! `python -m puckworks_tools.export` from `data/presets/**/*.yaml`, which are
//! validated against `data/schema/preset.schema.json`.
//!
//! The structs mirror that schema exactly and reject unknown fields, so a
//! preset field the model would silently ignore fails the tests instead.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::api::ApiError;
use crate::recipe::{PhaseInput, PumpInput};

/// Schema id of the embedded presets document.
pub const PRESETS_SCHEMA: &str = "puckworks.presets/1";

pub(crate) const PRESETS_JSON: &str = include_str!("../generated/presets.json");

/// A citation.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub citation: String,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub locator: Option<String>,
}

/// Metadata every preset carries.
pub trait PresetMeta {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    /// `estimated`, `unverified`, `disputed`, `owner-gear`, `generic`.
    fn flags(&self) -> &[String];
    /// Notes for the user, copied into `derived.notes` when the preset is used.
    fn notes(&self) -> &[String];
    fn evidence_grade(&self) -> &str;
}

/// Defines a preset struct with the common metadata fields plus its own.
macro_rules! preset {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident: $ty:ty,)* }) => {
        $(#[$meta])*
        #[derive(Clone, Debug, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            pub id: String,
            pub name: String,
            pub description: String,
            pub flags: Vec<String>,
            pub notes: Vec<String>,
            pub sources: Vec<Source>,
            pub evidence_grade: String,
            pub tag: String,
            /// Registry records describing this preset's data.
            #[serde(default)]
            pub registry_refs: Vec<String>,
            $($(#[$fmeta])* pub $field: $ty,)*
        }

        impl PresetMeta for $name {
            fn id(&self) -> &str { &self.id }
            fn name(&self) -> &str { &self.name }
            fn flags(&self) -> &[String] { &self.flags }
            fn notes(&self) -> &[String] { &self.notes }
            fn evidence_grade(&self) -> &str { &self.evidence_grade }
        }
    };
}

/// Parameters of the three-component log-normal PSD model; omitted values
/// come from the family, then the registry.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PsdParameters {
    /// κ_G: volume median X50 / burr gap.
    #[serde(default)]
    pub x50_gap_ratio: Option<f64>,
    /// u_G: volume % below 100 µm when X50 = 340 µm.
    #[serde(default)]
    pub fines_at_340_pct: Option<f64>,
    /// σ_c: standard deviation of ln d of the coarse mode.
    #[serde(default)]
    pub coarse_log_width: Option<f64>,
    /// w_b: volume share of the boulder tail.
    #[serde(default)]
    pub boulder_weight: Option<f64>,
    /// μ_f: fines mode, µm.
    #[serde(default)]
    pub fines_mode_um: Option<f64>,
}

preset!(
    /// A generic burr family.
    GrinderFamilyPreset {
        /// `"flat"` or `"conical"`.
        burr: String,
        psd: PsdParameters,
    }
);

/// Setting → burr gap: gap = `gap_at_ref_um` + `gap_per_unit_um` × (setting − `reference`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dial {
    pub label: String,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    #[serde(rename = "ref")]
    pub reference: f64,
    pub gap_at_ref_um: f64,
    pub gap_per_unit_um: f64,
    /// Settings at which the grinder's PSD was measured; outside them the
    /// builder notes the extrapolation.
    #[serde(default)]
    pub anchored: Option<SettingRange>,
}

/// A closed range of dial settings.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingRange {
    pub min: f64,
    pub max: f64,
}

preset!(
    /// A grinder: a family, a burr size and a dial mapping.
    GrinderPreset {
        family: String,
        burr_diameter_mm: f64,
        #[serde(default)]
        rpm: Option<f64>,
        dial: Dial,
        #[serde(default)]
        psd: Option<PsdParameters>,
    }
);

preset!(
    /// A basket: the fields of a custom basket plus its dose range.
    BasketPreset {
        nominal_dose_g: f64,
        dose_range_g: [f64; 2],
        /// `[height above the floor, inner diameter]`, mm.
        profile_mm: Vec<[f64; 2]>,
        perforated_diameter_mm: f64,
        #[serde(default)]
        open_area_fraction: Option<f64>,
        #[serde(default)]
        pressurised_orifice_mm: Option<f64>,
        #[serde(default)]
        discharge_coefficient: Option<f64>,
    }
);

preset!(
    /// A machine: a pump, a program and thermal details.
    MachinePreset {
        #[serde(default)]
        pump: Option<PumpInput>,
        program: Vec<PhaseInput>,
        temperature_c: f64,
        #[serde(default)]
        temperature_range_c: Option<[f64; 2]>,
        #[serde(default)]
        group_headspace_ml: Option<f64>,
        #[serde(default)]
        drip_tau_s: Option<f64>,
        /// True if a three-way valve vents the group at the stop.
        #[serde(default)]
        vent_headspace: Option<bool>,
        #[serde(default)]
        preheat_temp_c: Option<f64>,
        #[serde(default)]
        basket_diameter_mm: Option<f64>,
        #[serde(default)]
        default_basket: Option<String>,
    }
);

preset!(
    /// A coffee described by species, roast, age and process.
    BeanPreset {
        arabica_fraction: f64,
        roast_level: f64,
        days_off_roast: f64,
        #[serde(default)]
        process: Option<String>,
        #[serde(default)]
        altitude_m: Option<f64>,
        #[serde(default)]
        variety_group: Option<String>,
        #[serde(default)]
        storage: Option<String>,
        /// The bean assumed for fields a recipe leaves out.
        #[serde(default)]
        default: bool,
    }
);

/// The embedded presets document.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Presets {
    pub schema: String,
    pub grinder_families: Vec<GrinderFamilyPreset>,
    pub grinders: Vec<GrinderPreset>,
    pub baskets: Vec<BasketPreset>,
    pub machines: Vec<MachinePreset>,
    pub beans: Vec<BeanPreset>,
}

fn find<'a, T: PresetMeta>(list: &'a [T], kind: &str, id: &str) -> Result<&'a T, ApiError> {
    list.iter().find(|p| p.id() == id).ok_or_else(|| {
        let known: Vec<&str> = list.iter().map(PresetMeta::id).collect();
        ApiError(format!(
            "unknown {kind} preset {id:?}; known: {}",
            known.join(", ")
        ))
    })
}

impl Presets {
    /// Parses a `puckworks.presets/1` document.
    pub fn parse(text: &str) -> Result<Self, String> {
        let doc: Self =
            serde_json::from_str(text).map_err(|e| format!("invalid presets document: {e}"))?;
        if doc.schema != PRESETS_SCHEMA {
            return Err(format!("presets document has schema {:?}", doc.schema));
        }
        if doc.beans.iter().filter(|b| b.default).count() != 1 {
            return Err("presets document needs exactly one default bean".into());
        }
        Ok(doc)
    }

    pub fn grinder_family(&self, id: &str) -> Result<&GrinderFamilyPreset, ApiError> {
        find(&self.grinder_families, "grinder family", id)
    }

    pub fn grinder(&self, id: &str) -> Result<&GrinderPreset, ApiError> {
        find(&self.grinders, "grinder", id)
    }

    pub fn basket(&self, id: &str) -> Result<&BasketPreset, ApiError> {
        find(&self.baskets, "basket", id)
    }

    pub fn machine(&self, id: &str) -> Result<&MachinePreset, ApiError> {
        find(&self.machines, "machine", id)
    }

    pub fn bean(&self, id: &str) -> Result<&BeanPreset, ApiError> {
        find(&self.beans, "bean", id)
    }

    /// The bean assumed for fields a recipe leaves out.
    pub fn default_bean(&self) -> &BeanPreset {
        // `parse` guarantees exactly one.
        self.beans
            .iter()
            .find(|b| b.default)
            .unwrap_or(&self.beans[0])
    }
}

/// The embedded presets, parsed on first use.
pub fn presets() -> Result<&'static Presets, ApiError> {
    static PRESETS: OnceLock<Result<Presets, String>> = OnceLock::new();
    PRESETS
        .get_or_init(|| Presets::parse(PRESETS_JSON))
        .as_ref()
        .map_err(|e| ApiError(format!("internal error: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_presets_parse_strictly() {
        let p = presets().unwrap();
        assert!(!p.grinder_families.is_empty() && !p.grinders.is_empty());
        assert!(!p.baskets.is_empty() && !p.machines.is_empty() && !p.beans.is_empty());
        for g in &p.grinders {
            p.grinder_family(&g.family).unwrap();
        }
        assert!(
            p.basket("no-such-basket")
                .unwrap_err()
                .0
                .contains("58-precision-18g")
        );
        assert!(p.default_bean().default);
    }
}
