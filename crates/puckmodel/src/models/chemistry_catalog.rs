// SPDX-License-Identifier: GPL-2.0-or-later
//! M2 compound catalogue, broad composition priors and shared transport bases.
//! The catalogue describes all 55 Appendix A compounds. K5 and K6 are separate
//! phase inventories, not fictitious dissolved passengers. Named inventories
//! are never rescaled to match lumped TDS; an explicit unresolved remainder
//! closes the initial available-solids inventory only.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::context::{Ctx, Val, join};
use puckcore::math::exp;

use super::bean::{BeanState, Species};

/// Public metadata serialized with a built recipe; no duplicate UI label list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SpeciesMeta {
    pub id: String,
    pub name: String,
    pub family: String,
    pub kinetic_class: String,
    pub phase: String,
    pub counts_toward_tds: bool,
    pub transport_evidence: String,
    pub composition_evidence: String,
    pub registry_refs: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Deserialize)]
struct CatalogFile {
    species: Vec<SpeciesMeta>,
}

pub(crate) fn catalog() -> &'static [SpeciesMeta] {
    static CATALOG: OnceLock<Vec<SpeciesMeta>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str::<CatalogFile>(include_str!("../../../../data/chemistry/species.json"))
            .expect("the checked-in chemistry catalogue is valid JSON")
            .species
    })
}

pub(crate) fn species(id: &str) -> Option<&'static SpeciesMeta> {
    catalog().iter().find(|sp| sp.id == id)
}

/// Pure-chemical inputs read through the same registry/provenance machinery.
#[derive(Clone, Debug, Default)]
pub(crate) struct ChemicalProperties {
    pub molecular_weight_g_mol: Option<f64>,
    pub pka: Vec<f64>,
    pub henry_air_water_ratio: Option<f64>,
    pub aroma_threshold_ug_l: Option<f64>,
    pub binding_half_life_s: Option<f64>,
}

pub(crate) fn properties(ctx: &mut Ctx, id: &str) -> Result<ChemicalProperties, ApiError> {
    let Some(meta) = species(id) else {
        return Err(ApiError(format!("unknown chemistry species {id:?}")));
    };
    let mut out = ChemicalProperties::default();
    for rid in &meta.registry_refs {
        let suffix = rid.rsplit('.').next().unwrap_or("");
        match suffix {
            "mw" => out.molecular_weight_g_mol = Some(ctx.param(rid, "g/mol")?.v),
            "pka1" | "pka2" | "pka3" => out.pka.push(ctx.param(rid, "1")?.v),
            "henry" => out.henry_air_water_ratio = Some(ctx.param(rid, "1")?.v),
            "threshold" => out.aroma_threshold_ug_l = Some(ctx.param(rid, "ug/L")?.v),
            "binding_half_life" => out.binding_half_life_s = Some(ctx.param(rid, "s")?.v),
            _ => {}
        }
    }
    Ok(out)
}

#[derive(Clone, Debug)]
pub(crate) struct PhaseInventory {
    pub id: &'static str,
    pub mass_fraction: Val,
    pub cup_transfer_fraction: Val,
}

fn composition(ctx: &mut Ctx, state: &BeanState, id: &str) -> Result<Val, ApiError> {
    let ar = ctx.param(&format!("chemistry.composition.{id}.arabica"), "%")?;
    let rob = ctx.param(&format!("chemistry.composition.{id}.robusta"), "%")?;
    let slope = ctx.param(
        &format!("chemistry.composition.{id}.roast_coefficient"),
        "1",
    )?;
    let available = (state.arabica.v * ar.v + (1.0 - state.arabica.v) * rob.v)
        * (1.0 + slope.v * (state.roast.v - 0.5)).max(0.0)
        / 100.0;
    Ok(Val::new(
        available,
        join(&[
            &ar.src,
            &rob.src,
            &slope.src,
            &state.arabica.src,
            &state.roast.src,
        ]),
    ))
}

fn transport(ctx: &mut Ctx, meta: &SpeciesMeta, mass: Val) -> Result<Species, ApiError> {
    let k = meta.kinetic_class.to_ascii_lowercase();
    let (d_id, p_id, s_id) = if matches!(meta.id.as_str(), "cqa3" | "cqa4") {
        (
            "model.species.cqa5.diffusivity_80c".to_string(),
            "model.species.cqa5.partition".to_string(),
            "model.species.cqa5.surface_fraction_scale".to_string(),
        )
    } else {
        let d = match meta.id.as_str() {
            "potassium" => "extraction.diffusivity.potassium.particle_80c".to_string(),
            "phosphate" => "extraction.diffusivity.phosphate.particle_80c".to_string(),
            "magnesium" => "extraction.diffusivity.magnesium.particle_80c".to_string(),
            _ => format!("chemistry.kinetics.{k}.diffusivity"),
        };
        (
            d,
            format!("chemistry.kinetics.{k}.partition"),
            format!("chemistry.kinetics.{k}.surface_scale"),
        )
    };
    // Metadata comes from the once-initialized static catalogue, so its ids
    // have the same lifetime as the measured M1 ids used by the bean builder.
    let id = species(&meta.id)
        .expect("catalogue entry exists")
        .id
        .as_str();
    Ok(Species {
        id,
        mass_fraction: mass,
        diffusivity: ctx.param(&d_id, "m^2/s")?,
        partition: ctx.param(&p_id, "1")?,
        surface_scale: ctx.param(&s_id, "1")?,
    })
}

/// Extends the unchanged first four M1 passengers with the M2 chemistry.
/// The phase inventories are available dry-dose fractions, not cup amounts.
pub(crate) fn augment(
    ctx: &mut Ctx,
    state: &BeanState,
    passengers: &mut Vec<Species>,
    extractable: &Val,
    co2_puck: Val,
) -> Result<Vec<PhaseInventory>, ApiError> {
    let storage = state.storage.as_deref().unwrap_or("sealed");
    let loss = ctx.param(&format!("chemistry.storage.{storage}.rate_multiplier"), "1")?;
    let aroma_half_life = ctx.param("chemistry.storage.aroma_half_life", "d")?;
    let methanethiol_half_life = ctx.param("chemistry.storage.methanethiol_half_life", "d")?;
    let anaerobic_acetic = if state.process.as_deref() == Some("anaerobic") {
        Some(ctx.param("chemistry.process.anaerobic_acetic_multiplier", "1")?)
    } else {
        None
    };
    let mut phases = Vec::new();
    for meta in catalog() {
        let id = meta.id.as_str();
        if matches!(
            id,
            "caffeine" | "trigonelline" | "cqa5" | "acids" | "unassigned_solubles"
        ) {
            continue;
        }
        let mut mass = if id == "co2" {
            co2_puck.clone()
        } else {
            composition(ctx, state, id)?
        };
        if id == "acetic_acid"
            && let Some(multiplier) = &anaerobic_acetic
        {
            mass = Val::new(
                mass.v * multiplier.v,
                join(&[&mass.src, &multiplier.src, "recipe:bean.process"]),
            );
        }
        if meta.family.starts_with("odorant:") {
            let half_life = if id == "methanethiol" {
                &methanethiol_half_life
            } else {
                &aroma_half_life
            };
            // ln(2) is a mathematical conversion, not an extra fitted parameter.
            let retained = exp(-std::f64::consts::LN_2 * state.days.v * loss.v / half_life.v);
            mass = Val::new(
                mass.v * retained,
                join(&[&mass.src, &half_life.src, &loss.src, &state.days.src]),
            );
        }
        if !mass.v.is_finite() || !(0.0..=1.0).contains(&mass.v) {
            return Err(ApiError(format!(
                "bean: M2 {id} inventory must be a finite fraction in [0,1]"
            )));
        }
        if meta.phase == "dissolved" {
            passengers.push(transport(ctx, meta, mass)?);
        } else {
            let cup_transfer_fraction =
                ctx.param(&format!("chemistry.phase.{id}.cup_transfer_fraction"), "1")?;
            phases.push(PhaseInventory {
                id,
                mass_fraction: mass,
                cup_transfer_fraction,
            });
        }
    }
    let named_total: f64 = passengers
        .iter()
        .filter(|sp| sp.id != "acids")
        .map(|sp| sp.mass_fraction.v)
        .sum();
    let remainder = (extractable.v - named_total).max(0.0);
    if named_total > extractable.v {
        ctx.note(format!("M2 chemistry: named dissolved inventories total {:.2}% of the dose, exceeding the {:.2}% extractable-solids budget. They are not rescaled; the unassigned remainder is zero and cup closure must be reported as a model inconsistency.", named_total * 100.0, extractable.v * 100.0));
    }
    let mut remainder_sources = vec![extractable.src.as_str()];
    remainder_sources.extend(
        passengers
            .iter()
            .filter(|sp| sp.id != "acids")
            .map(|sp| sp.mass_fraction.src.as_str()),
    );
    remainder_sources.push("model:M2 named dissolved inventory remainder");
    let remainder_source = join(&remainder_sources);
    passengers.push(Species {
        id: "unassigned_solubles",
        mass_fraction: Val::new(remainder, remainder_source),
        diffusivity: ctx.param("extraction.diffusivity.lumped.corrochano_80c", "m^2/s")?,
        partition: ctx.param("extraction.partition.lumped_80c", "1")?,
        surface_scale: Val::new(
            1.0,
            "model:unassigned solids share the lumped TDS transport basis",
        ),
    });
    ctx.note(format!("M2 chemistry: 55 catalogue compounds plus the legacy acids diagnostic and an unassigned-solids remainder; {:.2}% of the dry dose remains chemically unassigned. Estimated class transport and composition are not 55 independent espresso measurements. The acids aggregate overlaps named acids and is excluded from TDS; lipid and gas phases are separate.", remainder * 100.0));
    ctx.note(format!("Bean v2: {storage} storage changes estimated aroma inventories through a broad, uncalibrated whole-bean loss scenario. It does not alter measured caffeine, trigonelline or 5-CQA anchors, and aroma remaining in a bean is not the same as aroma reaching the cup."));
    if anaerobic_acetic.is_some() {
        ctx.note("Bean v2: anaerobic processing changes estimated acetic-acid inventory through a grade-D multiplier. Fermentation history is not identified by the process label alone.");
    }
    Ok(phases)
}
