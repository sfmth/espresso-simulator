// SPDX-License-Identifier: GPL-2.0-or-later
//! M2 post-extraction cup chemistry, with an explicit boundary on its claims.
//!
//! This module does not change M1 hydraulics, extraction, EY, or time series.
//! Speciation is an ideal dilute-solution calculation at 25 °C. Coffee's
//! unknown counterions and macromolecular buffers are represented by a supplied
//! reference pH and background buffer: absolute pH is consequently an estimate,
//! not an ab-initio prediction. Gas/oil recovery and crema are explicit proxies.
//! All empirical/physical inputs are supplied by the parameter-registry builder.

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

use super::{ShotError, ShotResult, ShotSpec};
use crate::math::exp;

/// Optional cup chemistry; numerical zero defaults do not supply physical priors.
/// The input-model builder fills the physical parameters from the registry.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ChemistrySpec {
    pub water: WaterChemistrySpec,
    pub compounds: Vec<CompoundChemistrySpec>,
    /// Non-dissolved source inventories; never injected into M1 solubles/TDS.
    pub phase_inventories: Vec<PhaseInventorySpec>,
    /// Effective intrinsic coffee pH without source-water carbonate, at 25 °C.
    pub coffee_reference_ph: f64,
    /// Effective monoprotic unresolved coffee buffer, explicitly estimated.
    pub background_buffer_pka: f64,
    pub background_buffer_mol_per_kg_solubles: f64,
    /// Thermodynamic pKw at the 25 °C acidity reference temperature.
    pub water_pkw: f64,
    pub carbonate_pka: [f64; 2],
    pub calcium_carbonate_molar_mass_g_mol: f64,
    /// Density used for the approximate cup/source-water volume, kg/m³.
    pub water_density_kg_m3: f64,
    /// Closed headspace in equilibrium with the cup; not an open-room model.
    pub cup_headspace_m3: f64,
    /// Time after extraction for effective thiol binding, s.
    pub aroma_age_s: f64,
    pub measurement: RefractometerSpec,
    pub crema: CremaSpec,
}

/// Source-water analysis. Hardness and ion concentrations are reported inputs,
/// not an assumed universal enhancement of extraction.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct WaterChemistrySpec {
    pub alkalinity_mg_l_caco3: f64,
    pub hardness_mg_l_caco3: f64,
    pub calcium_mg_l: f64,
    pub magnesium_mg_l: f64,
    pub tds_mg_l: f64,
    pub ph: f64,
}

/// Chemistry associated with a transport passenger or a separate phase proxy.
/// An empty pKa list means no acid calculation, rather than guessing a pKa.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct CompoundChemistrySpec {
    pub id: String,
    pub phase: String,
    pub counts_toward_tds: bool,
    pub molecular_weight_g_mol: Option<f64>,
    pub pka: Vec<f64>,
    /// Dimensionless equilibrium concentration ratio c_air/c_water at 25 °C.
    pub henry_air_water_ratio: Option<f64>,
    /// Odour threshold in water; OAV is not a sensory intensity prediction.
    pub aroma_threshold_ug_l: Option<f64>,
    /// Effective first-order irreversible binding half life, not volatilisation.
    pub binding_half_life_s: Option<f64>,
}

/// Explicit separate-phase recovery prior, not a diffusion prediction.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PhaseInventorySpec {
    pub id: String,
    pub available_mass_kg: f64,
    pub cup_transfer_fraction: f64,
}

/// Coffee-equivalent optical reading, separate from true coffee solids.
/// `residual_temperature_coefficient_per_c` is the instrument's uncompensated
/// residual bias after its own ATC; zero represents ideal compensation.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RefractometerSpec {
    pub sample_temp_c: f64,
    pub reference_temp_c: f64,
    pub residual_temperature_coefficient_per_c: f64,
    pub coffee_response_factor: f64,
    pub mineral_response_factor: f64,
    pub mineral_blank_subtracted: bool,
}

/// Simple gas-volume proxy; foam stabilisation/lifetime is not modelled.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct CremaSpec {
    pub co2_id: String,
    pub lipid_id: String,
    pub co2_capture_fraction: f64,
    pub bubble_gas_density_kg_m3: f64,
    pub foam_gas_volume_fraction: f64,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ChemistryResult {
    pub schema: String,
    /// Acidity/headspace reference, fixed at 25 °C; not hot-shot pH.
    pub reference_temp_c: f64,
    pub acidity: AcidityResult,
    pub aroma: Vec<AromaResult>,
    pub phases: Vec<PhaseInventoryResult>,
    pub texture: TextureResult,
    pub refractometer: RefractometerResult,
    pub mass_closure: ChemistryMassClosure,
    pub warnings: Vec<String>,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AcidityResult {
    /// None when no cup exists or charge balance has no root in pH 0–14.
    pub ph: Option<f64>,
    /// Base equivalents to each endpoint; 0 when the cup already exceeds it.
    pub titratable_acidity_mmol_l_to_ph_6_6: f64,
    pub titratable_acidity_mmol_l_to_ph_8: f64,
    pub status: String,
    /// Source alkalinity after dilution by the extracted coffee solids.
    pub water_alkalinity_mmol_l: f64,
    pub carbonate_mol_l: f64,
    /// Effective fixed coffee charge closing electroneutrality at reference pH.
    pub background_charge_mol_l: f64,
    pub acids: Vec<AcidSpeciation>,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AcidSpeciation {
    pub id: String,
    pub total_mol_l: f64,
    pub mean_charge: f64,
    pub ionized_fraction: f64,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AromaResult {
    pub id: String,
    pub extracted_mass_kg: f64,
    pub liquid_mass_kg: f64,
    pub headspace_mass_kg: f64,
    pub bound_mass_kg: f64,
    pub liquid_concentration_ug_l: f64,
    pub headspace_concentration_ug_l: f64,
    /// Liquid concentration divided by a threshold measured in water.
    pub odor_activity_ratio: Option<f64>,
    pub mass_balance_residual_kg: f64,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PhaseInventoryResult {
    pub id: String,
    pub available_mass_kg: f64,
    pub cup_mass_kg: f64,
    pub retained_mass_kg: f64,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TextureResult {
    pub lipid_mass_kg: f64,
    pub lipid_concentration_g_l: f64,
    pub co2_recovered_mass_kg: f64,
    pub crema_gas_volume_m3: f64,
    pub crema_volume_proxy_m3: f64,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RefractometerResult {
    /// Physical M1 coffee solute mass/cup mass, before the optional cup aging.
    /// Gas, emulsion and source-water minerals are excluded from this value.
    pub coffee_true_tds: f64,
    /// Source mineral mass divided by M1 beverage mass, separately reported.
    pub water_mineral_tds: f64,
    /// Instrument response factors applied at the reference temperature.
    pub coffee_equivalent_tds_at_reference: f64,
    pub apparent_tds: f64,
    /// Additive bias from the residual ATC coefficient and sample temperature.
    pub temperature_bias: f64,
    pub sample_temp_c: f64,
    pub reference_temp_c: f64,
    pub mineral_blank_subtracted: bool,
}

/// Diagnostic closure relative to the independently modelled lumped solubles.
/// Measured species are never silently renormalised to make this close.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ChemistryMassClosure {
    pub lumped_solubles_kg: f64,
    pub quantified_dissolved_species_kg: f64,
    pub unassigned_solubles_kg: f64,
    pub overassigned_solubles_kg: f64,
    pub excluded_diagnostic_mass_kg: f64,
    pub phase_inventory_mass_kg: f64,
    /// Independently transported residual pool, distinct from accounting slack.
    pub transport_unassigned_solubles_kg: f64,
    /// Named species plus the independently transported residual.
    pub transported_dissolved_species_kg: f64,
    /// |transported species − lumped| / lumped (0 when both are zero).
    pub relative_transport_closure_error: f64,
}

fn bounded(field: &str, x: f64, lo: f64, hi: f64) -> Result<(), ShotError> {
    if x.is_finite() && x >= lo && x <= hi {
        Ok(())
    } else {
        Err(ShotError::invalid(
            field,
            format!("must be in [{lo}, {hi}]"),
        ))
    }
}

pub(crate) fn validate(
    c: &ChemistrySpec,
    shot: &ShotSpec,
    warnings: &mut Vec<String>,
) -> Result<(), ShotError> {
    for (name, value) in [
        ("alkalinity_mg_l_caco3", c.water.alkalinity_mg_l_caco3),
        ("hardness_mg_l_caco3", c.water.hardness_mg_l_caco3),
        ("calcium_mg_l", c.water.calcium_mg_l),
        ("magnesium_mg_l", c.water.magnesium_mg_l),
        ("tds_mg_l", c.water.tds_mg_l),
    ] {
        bounded(&format!("chemistry.water.{name}"), value, 0.0, 10000.0)?;
    }
    bounded("chemistry.water.ph", c.water.ph, 0.0, 14.0)?;
    bounded(
        "chemistry.coffee_reference_ph",
        c.coffee_reference_ph,
        1.0,
        13.0,
    )?;
    bounded(
        "chemistry.background_buffer_pka",
        c.background_buffer_pka,
        0.0,
        16.0,
    )?;
    bounded(
        "chemistry.background_buffer_mol_per_kg_solubles",
        c.background_buffer_mol_per_kg_solubles,
        0.0,
        100.0,
    )?;
    bounded("chemistry.water_pkw", c.water_pkw, 10.0, 16.0)?;
    for (i, pka) in c.carbonate_pka.iter().enumerate() {
        bounded(&format!("chemistry.carbonate_pka[{i}]"), *pka, 0.0, 16.0)?;
    }
    if c.carbonate_pka[0] >= c.carbonate_pka[1] {
        return Err(ShotError::invalid(
            "chemistry.carbonate_pka",
            "must strictly increase",
        ));
    }
    bounded(
        "chemistry.calcium_carbonate_molar_mass_g_mol",
        c.calcium_carbonate_molar_mass_g_mol,
        1.0,
        1000.0,
    )?;
    bounded(
        "chemistry.water_density_kg_m3",
        c.water_density_kg_m3,
        900.0,
        1200.0,
    )?;
    bounded("chemistry.cup_headspace_m3", c.cup_headspace_m3, 0.0, 1.0)?;
    bounded("chemistry.aroma_age_s", c.aroma_age_s, 0.0, 86400.0)?;
    if c.compounds.len() > 128 {
        return Err(ShotError::invalid(
            "chemistry.compounds",
            "at most 128 compounds",
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    for (i, sp) in c.compounds.iter().enumerate() {
        let f = format!("chemistry.compounds[{i}]");
        if sp.id.trim().is_empty() || !ids.insert(&sp.id) {
            return Err(ShotError::invalid(
                &format!("{f}.id"),
                "must be non-empty and unique",
            ));
        }
        if !matches!(
            sp.phase.as_str(),
            "dissolved" | "gas" | "lipid" | "diagnostic"
        ) {
            return Err(ShotError::invalid(
                &format!("{f}.phase"),
                "must be dissolved, gas, lipid or diagnostic",
            ));
        }
        if sp.counts_toward_tds && sp.phase != "dissolved" {
            return Err(ShotError::invalid(
                &format!("{f}.counts_toward_tds"),
                "only dissolved species may count toward TDS",
            ));
        }
        if let Some(mw) = sp.molecular_weight_g_mol {
            bounded(&format!("{f}.molecular_weight_g_mol"), mw, 0.1, 1e7)?;
        }
        if !sp.pka.is_empty() && (sp.molecular_weight_g_mol.is_none() || !sp.counts_toward_tds) {
            return Err(ShotError::invalid(
                &format!("{f}.pka"),
                "acid speciation needs a dissolved, TDS-counted compound with a molecular weight",
            ));
        }
        if sp.pka.len() > 4 {
            return Err(ShotError::invalid(
                &format!("{f}.pka"),
                "at most four dissociations",
            ));
        }
        for (j, pka) in sp.pka.iter().enumerate() {
            bounded(&format!("{f}.pka[{j}]"), *pka, 0.0, 16.0)?;
        }
        if sp.pka.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(ShotError::invalid(
                &format!("{f}.pka"),
                "must strictly increase",
            ));
        }
        if let Some(h) = sp.henry_air_water_ratio {
            bounded(&format!("{f}.henry_air_water_ratio"), h, 0.0, 1e6)?;
        }
        if let Some(t) = sp.aroma_threshold_ug_l {
            bounded(&format!("{f}.aroma_threshold_ug_l"), t, 1e-12, 1e12)?;
        }
        if let Some(t) = sp.binding_half_life_s {
            bounded(&format!("{f}.binding_half_life_s"), t, 1e-9, 1e12)?;
        }
    }
    if c.phase_inventories.len() > 128 {
        return Err(ShotError::invalid(
            "chemistry.phase_inventories",
            "at most 128 phases",
        ));
    }
    let mut phase_ids = std::collections::BTreeSet::new();
    for (i, phase) in c.phase_inventories.iter().enumerate() {
        let f = format!("chemistry.phase_inventories[{i}]");
        let metadata = c.compounds.iter().find(|sp| sp.id == phase.id);
        if phase.id.trim().is_empty() || !phase_ids.insert(&phase.id) {
            return Err(ShotError::invalid(
                &format!("{f}.id"),
                "must be non-empty and unique",
            ));
        }
        if metadata.is_none_or(|sp| !matches!(sp.phase.as_str(), "gas" | "lipid")) {
            return Err(ShotError::invalid(
                &format!("{f}.id"),
                "needs gas or lipid compound metadata",
            ));
        }
        if shot.solubles.species.iter().any(|sp| sp.id == phase.id) {
            return Err(ShotError::invalid(
                &format!("{f}.id"),
                "a phase inventory cannot also be a dissolved transport passenger",
            ));
        }
        bounded(
            &format!("{f}.available_mass_kg"),
            phase.available_mass_kg,
            0.0,
            10.0,
        )?;
        bounded(
            &format!("{f}.cup_transfer_fraction"),
            phase.cup_transfer_fraction,
            0.0,
            1.0,
        )?;
    }
    let r = &c.measurement;
    bounded(
        "chemistry.measurement.sample_temp_c",
        r.sample_temp_c,
        0.0,
        150.0,
    )?;
    bounded(
        "chemistry.measurement.reference_temp_c",
        r.reference_temp_c,
        0.0,
        150.0,
    )?;
    bounded(
        "chemistry.measurement.residual_temperature_coefficient_per_c",
        r.residual_temperature_coefficient_per_c,
        -0.1,
        0.1,
    )?;
    bounded(
        "chemistry.measurement.coffee_response_factor",
        r.coffee_response_factor,
        0.0,
        10.0,
    )?;
    bounded(
        "chemistry.measurement.mineral_response_factor",
        r.mineral_response_factor,
        0.0,
        10.0,
    )?;
    bounded(
        "chemistry.crema.co2_capture_fraction",
        c.crema.co2_capture_fraction,
        0.0,
        1.0,
    )?;
    bounded(
        "chemistry.crema.bubble_gas_density_kg_m3",
        c.crema.bubble_gas_density_kg_m3,
        1e-6,
        1000.0,
    )?;
    bounded(
        "chemistry.crema.foam_gas_volume_fraction",
        c.crema.foam_gas_volume_fraction,
        1e-6,
        1.0,
    )?;
    for sp in &shot.solubles.species {
        if !c.compounds.iter().any(|meta| meta.id == sp.id) {
            warnings.push(format!("M2 has no metadata for transport species {}; its mass is not assigned to a named chemistry pool", sp.id));
        }
    }
    warnings.push("M2 pH/TA use ideal 25 °C speciation and an estimated intrinsic-pH/background-buffer charge closure; Ca/Mg do not multiply extraction".into());
    Ok(())
}

/// Mean deprotonation charge and fraction with at least one proton lost.
/// The weight recurrence is the full polyprotic Henderson–Hasselbalch system.
fn charge(ph: f64, pka: &[f64]) -> (f64, f64) {
    let mut weight = 1.0;
    let mut sum = 1.0;
    let mut charge_sum = 0.0;
    for (i, pk) in pka.iter().enumerate() {
        weight *= exp(std::f64::consts::LN_10 * (ph - pk));
        sum += weight;
        charge_sum += (i + 1) as f64 * weight;
    }
    (charge_sum / sum, 1.0 - 1.0 / sum)
}

fn water_charge(ph: f64, pkw: f64) -> f64 {
    exp(std::f64::consts::LN_10 * (ph - pkw)) - exp(-std::f64::consts::LN_10 * ph)
}

/// Evaluate a completed physical shot. Public for analysis of stored results;
/// callers must use validated chemistry parameters (the normal simulator does).
/// The independent lumped result is retained even when species exceed its mass.
pub(crate) fn evaluate(c: &ChemistrySpec, result: &ShotResult) -> ChemistryResult {
    let cup_kg = result.summary.beverage_mass_kg;
    let cup_m3 = cup_kg / c.water_density_kg_m3;
    let cup_l = cup_m3 * 1000.0;
    let lumped = cup_kg * result.summary.tds;
    let carrier_fraction = (1.0 - result.summary.tds).clamp(0.0, 1.0);
    let mut out = ChemistryResult {
        schema: "puckworks.cup-chemistry/1".into(),
        reference_temp_c: 25.0,
        ..ChemistryResult::default()
    };
    out.warnings.push("Estimated acidity: unmeasured counterions and macromolecular buffering are closed with the supplied intrinsic coffee pH/background buffer; no sensory prediction".into());
    if cup_kg <= 0.0 {
        out.acidity.status = "no_beverage".into();
        out.warnings.push("No beverage reached the cup; concentration, pH and phase recovery are undefined and reported as zero/none".into());
        return out;
    }
    let species_mass = |id: &str| {
        result
            .summary
            .species
            .iter()
            .find(|sp| sp.id == id)
            .map_or(0.0, |sp| sp.mass_kg)
    };
    let quantified: f64 = c
        .compounds
        .iter()
        .filter(|sp| sp.counts_toward_tds && sp.id != "unassigned_solubles")
        .map(|sp| species_mass(&sp.id))
        .sum();
    let excluded: f64 = c
        .compounds
        .iter()
        .filter(|sp| sp.phase == "diagnostic")
        .map(|sp| species_mass(&sp.id))
        .sum();
    let transport_unassigned = species_mass("unassigned_solubles");
    let transported_total = quantified + transport_unassigned;
    out.mass_closure = ChemistryMassClosure {
        lumped_solubles_kg: lumped,
        quantified_dissolved_species_kg: quantified,
        unassigned_solubles_kg: (lumped - quantified).max(0.0),
        overassigned_solubles_kg: (quantified - lumped).max(0.0),
        excluded_diagnostic_mass_kg: excluded,
        phase_inventory_mass_kg: 0.0,
        transport_unassigned_solubles_kg: transport_unassigned,
        transported_dissolved_species_kg: transported_total,
        relative_transport_closure_error: if lumped > 0.0 {
            (transported_total - lumped).abs() / lumped
        } else if transported_total == 0.0 {
            0.0
        } else {
            1.0
        },
    };
    if quantified > lumped {
        out.warnings.push("Named dissolved species exceed the lumped coffee solids; masses are preserved, overassignment is reported, and no silent renormalisation is applied".into());
    }
    for phase in &c.phase_inventories {
        let cup_mass = phase.available_mass_kg * phase.cup_transfer_fraction;
        out.phases.push(PhaseInventoryResult {
            id: phase.id.clone(),
            available_mass_kg: phase.available_mass_kg,
            cup_mass_kg: cup_mass,
            retained_mass_kg: phase.available_mass_kg - cup_mass,
        });
        out.mass_closure.phase_inventory_mass_kg += cup_mass;
    }
    if !out.phases.is_empty() {
        out.warnings.push("Gas/oil cup recoveries are supplied transfer proxies separate from dissolved extraction, cup TDS and EY; crema is a gas-volume proxy without foam stability".into());
    }
    let phase_mass = |id: &str| {
        out.phases
            .iter()
            .find(|phase| phase.id == id)
            .map_or(0.0, |phase| phase.cup_mass_kg)
    };
    let lipid = phase_mass(&c.crema.lipid_id);
    let gas = phase_mass(&c.crema.co2_id);
    let crema_gas = gas * c.crema.co2_capture_fraction / c.crema.bubble_gas_density_kg_m3;
    out.texture = TextureResult {
        lipid_mass_kg: lipid,
        lipid_concentration_g_l: lipid * 1000.0 / cup_l,
        co2_recovered_mass_kg: gas,
        crema_gas_volume_m3: crema_gas,
        crema_volume_proxy_m3: crema_gas / c.crema.foam_gas_volume_fraction,
    };
    // Acid concentrations are based only on explicitly identified acids, not
    // the legacy aggregate `acids` diagnostic, which would double count them.
    let acids: Vec<(&CompoundChemistrySpec, f64)> = c
        .compounds
        .iter()
        .filter(|sp| !sp.pka.is_empty() && sp.counts_toward_tds)
        .map(|sp| {
            (
                sp,
                species_mass(&sp.id) * 1000.0 / sp.molecular_weight_g_mol.unwrap() / cup_l,
            )
        })
        .collect();
    let buffer = c.background_buffer_mol_per_kg_solubles * lumped / cup_l;
    let coffee_charge = |ph: f64| {
        acids
            .iter()
            .map(|(sp, mol)| mol * charge(ph, &sp.pka).0)
            .sum::<f64>()
            + buffer * charge(ph, &[c.background_buffer_pka]).0
    };
    let fixed_coffee_charge = if lumped > 0.0 {
        coffee_charge(c.coffee_reference_ph) + water_charge(c.coffee_reference_ph, c.water_pkw)
    } else {
        0.0
    };
    // CaCO3 carries two equivalents per mole; mg→g contributes the 1000.
    let source_alk =
        c.water.alkalinity_mg_l_caco3 * 2.0 / (1000.0 * c.calcium_carbonate_molar_mass_g_mol);
    let source_carbonate = ((source_alk - water_charge(c.water.ph, c.water_pkw))
        / charge(c.water.ph, &c.carbonate_pka).0)
        .max(0.0);
    let carbonate = source_carbonate * carrier_fraction;
    let fixed_water_charge = source_alk * carrier_fraction;
    let total_base = |ph: f64| {
        coffee_charge(ph)
            + carbonate * charge(ph, &c.carbonate_pka).0
            + water_charge(ph, c.water_pkw)
    };
    let target = fixed_coffee_charge + fixed_water_charge;
    let mut lo = 0.0;
    let mut hi = 14.0;
    let ph = if total_base(lo) <= target && total_base(hi) >= target {
        for _ in 0..80 {
            let mid = 0.5 * (lo + hi);
            if total_base(mid) > target {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Some(0.5 * (lo + hi))
    } else {
        None
    };
    out.acidity = AcidityResult {
        ph,
        titratable_acidity_mmol_l_to_ph_6_6: ph
            .map_or(0.0, |_| ((total_base(6.6) - target) * 1000.0).max(0.0)),
        titratable_acidity_mmol_l_to_ph_8: ph
            .map_or(0.0, |_| ((total_base(8.0) - target) * 1000.0).max(0.0)),
        status: if ph.is_some() {
            "estimated_intrinsic_ph_charge_closure"
        } else {
            "no_charge_balance_root"
        }
        .into(),
        water_alkalinity_mmol_l: fixed_water_charge * 1000.0,
        carbonate_mol_l: carbonate,
        background_charge_mol_l: fixed_coffee_charge,
        acids: acids
            .iter()
            .map(|(sp, mol)| {
                let (mean_charge, ionized_fraction) =
                    ph.map_or((0.0, 0.0), |ph| charge(ph, &sp.pka));
                AcidSpeciation {
                    id: sp.id.clone(),
                    total_mol_l: *mol,
                    mean_charge,
                    ionized_fraction,
                }
            })
            .collect(),
    };
    if source_alk < water_charge(c.water.ph, c.water_pkw) {
        out.warnings.push("Source-water pH and alkalinity imply negative carbonate; carbonate is zero and the non-carbonate alkalinity closure is an approximation".into());
    }
    for compound in &c.compounds {
        if compound.henry_air_water_ratio.is_none()
            && compound.aroma_threshold_ug_l.is_none()
            && compound.binding_half_life_s.is_none()
        {
            continue;
        }
        let total = species_mass(&compound.id) + phase_mass(&compound.id);
        let remaining = compound.binding_half_life_s.map_or(total, |half_life| {
            total * exp(-std::f64::consts::LN_2 * c.aroma_age_s / half_life)
        });
        let bound = total - remaining;
        let h = compound.henry_air_water_ratio.unwrap_or(0.0);
        let liquid = remaining / (1.0 + h * c.cup_headspace_m3 / cup_m3);
        let air = remaining - liquid;
        let concentration = liquid * 1e9 / cup_l;
        out.aroma.push(AromaResult {
            id: compound.id.clone(),
            extracted_mass_kg: total,
            liquid_mass_kg: liquid,
            headspace_mass_kg: air,
            bound_mass_kg: bound,
            liquid_concentration_ug_l: concentration,
            headspace_concentration_ug_l: if c.cup_headspace_m3 > 0.0 {
                air * 1e9 / (c.cup_headspace_m3 * 1000.0)
            } else {
                0.0
            },
            odor_activity_ratio: compound
                .aroma_threshold_ug_l
                .map(|threshold| concentration / threshold),
            mass_balance_residual_kg: total - liquid - air - bound,
        });
    }
    if !out.aroma.is_empty() {
        out.warnings.push("Aroma is closed-headspace equilibrium at 25 °C plus effective post-shot binding; water-threshold OAVs omit matrix effects, open-cup loss, mixture interactions and sensory intensity".into());
    }
    // Source minerals travel with carrier water; they never count as coffee EY.
    let mineral_tds = c.water.tds_mg_l * 1e-3 / c.water_density_kg_m3 * carrier_fraction;
    let r = &c.measurement;
    let at_reference = result.summary.tds * r.coffee_response_factor
        + if r.mineral_blank_subtracted {
            0.0
        } else {
            mineral_tds * r.mineral_response_factor
        };
    let temperature_bias =
        r.residual_temperature_coefficient_per_c * (r.sample_temp_c - r.reference_temp_c);
    out.refractometer = RefractometerResult {
        coffee_true_tds: result.summary.tds,
        water_mineral_tds: mineral_tds,
        coffee_equivalent_tds_at_reference: at_reference,
        apparent_tds: (at_reference + temperature_bias).max(0.0),
        temperature_bias,
        sample_temp_c: r.sample_temp_c,
        reference_temp_c: r.reference_temp_c,
        mineral_blank_subtracted: r.mineral_blank_subtracted,
    };
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // This fixture uses specified elementary acid chemistry, not coffee data.
    fn spec() -> ChemistrySpec {
        ChemistrySpec {
            water: WaterChemistrySpec {
                ph: 7.0,
                ..Default::default()
            },
            compounds: vec![CompoundChemistrySpec {
                id: "acetic_acid".into(),
                phase: "dissolved".into(),
                counts_toward_tds: true,
                molecular_weight_g_mol: Some(60.052),
                pka: vec![4.76],
                ..Default::default()
            }],
            coffee_reference_ph: 5.0,
            background_buffer_pka: 6.5,
            water_pkw: 14.0,
            carbonate_pka: [6.35, 10.33],
            calcium_carbonate_molar_mass_g_mol: 100.0869,
            water_density_kg_m3: 1000.0,
            measurement: RefractometerSpec {
                sample_temp_c: 20.0,
                reference_temp_c: 20.0,
                coffee_response_factor: 1.0,
                mineral_response_factor: 1.0,
                ..Default::default()
            },
            crema: CremaSpec {
                bubble_gas_density_kg_m3: 1.84,
                foam_gas_volume_fraction: 0.9,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn cup() -> ShotResult {
        ShotResult {
            summary: super::super::Summary {
                beverage_mass_kg: 0.04,
                tds: 0.1,
                species: vec![super::super::SpeciesTotal {
                    id: "acetic_acid".into(),
                    mass_kg: 60.052e-6,
                    extracted_fraction: 1.0,
                }],
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn close(a: f64, b: f64, tolerance: f64) {
        assert!((a - b).abs() < tolerance, "{a} != {b}");
    }

    #[test]
    fn polyprotic_speciation_matches_exact_symmetric_distribution() {
        let (mean, ionized) = charge(5.0, &[3.0, 5.0, 7.0]);
        // Relative populations 1:100:100:1, hence mean charge 1.5.
        close(mean, 1.5, 1e-14);
        close(ionized, 201.0 / 202.0, 1e-14);
        close(charge(4.76, &[4.76]).0, 0.5, 1e-15);
    }

    #[test]
    fn reference_charge_closure_and_titration_match_independent_monoprotic_solution() {
        let c = spec();
        let r = evaluate(&c, &cup());
        close(r.acidity.ph.unwrap(), 5.0, 1e-12);
        // 1 mmol / 40 mL = 25 mmol/L; independent HH endpoint fractions.
        let concentration_mmol_l = 25.0;
        let alpha = |ph: f64| 1.0 / (1.0 + 10.0_f64.powf(4.76 - ph));
        for (endpoint, got) in [
            (6.6, r.acidity.titratable_acidity_mmol_l_to_ph_6_6),
            (8.0, r.acidity.titratable_acidity_mmol_l_to_ph_8),
        ] {
            let water = ((10.0_f64.powf(endpoint - 14.0) - 10.0_f64.powf(-endpoint))
                - (1e-9 - 1e-5))
                * 1000.0;
            let expected = concentration_mmol_l * (alpha(endpoint) - alpha(5.0)) + water;
            close(got, expected, 1e-12);
        }
        assert!(
            r.acidity.titratable_acidity_mmol_l_to_ph_8
                > r.acidity.titratable_acidity_mmol_l_to_ph_6_6
        );
    }

    #[test]
    fn source_water_alkalinity_raises_ph_and_reduces_titratable_acidity() {
        let low = evaluate(&spec(), &cup());
        let mut high_spec = spec();
        high_spec.water.alkalinity_mg_l_caco3 = 40.0;
        let high = evaluate(&high_spec, &cup());
        assert!(high.acidity.ph > low.acidity.ph);
        assert!(
            high.acidity.titratable_acidity_mmol_l_to_ph_6_6
                < low.acidity.titratable_acidity_mmol_l_to_ph_6_6
        );
    }

    #[test]
    fn no_coffee_reproduces_source_water_ph_without_intrinsic_coffee_charge() {
        let mut c = spec();
        c.water.alkalinity_mg_l_caco3 = 40.0;
        c.water.ph = 7.8;
        let mut r = cup();
        r.summary.tds = 0.0;
        r.summary.species.clear();
        let out = evaluate(&c, &r);
        close(out.acidity.ph.unwrap(), 7.8, 1e-12);
    }

    #[test]
    fn binding_and_headspace_partition_have_an_independent_mass_account() {
        let mut c = spec();
        c.compounds.push(CompoundChemistrySpec {
            id: "test_aroma".into(),
            phase: "dissolved".into(),
            counts_toward_tds: true,
            henry_air_water_ratio: Some(0.5),
            aroma_threshold_ug_l: Some(1.0),
            binding_half_life_s: Some(600.0),
            ..Default::default()
        });
        c.aroma_age_s = 600.0;
        c.cup_headspace_m3 = 40e-6;
        let mut r = cup();
        r.summary.species.push(super::super::SpeciesTotal {
            id: "test_aroma".into(),
            mass_kg: 1e-9,
            extracted_fraction: 1.0,
        });
        let out = evaluate(&c, &r);
        let aroma = &out.aroma[0];
        close(aroma.bound_mass_kg, 0.5e-9, 1e-23);
        close(aroma.liquid_mass_kg, 1e-9 / 3.0, 1e-23);
        close(aroma.headspace_mass_kg, 1e-9 / 6.0, 1e-23);
        close(aroma.mass_balance_residual_kg, 0.0, 1e-23);
        close(
            aroma.headspace_concentration_ug_l / aroma.liquid_concentration_ug_l,
            0.5,
            1e-14,
        );
    }

    #[test]
    fn optics_distinguishes_coffee_water_blank_and_residual_temperature_bias() {
        let mut c = spec();
        c.water.tds_mg_l = 100.0;
        c.measurement.sample_temp_c = 30.0;
        c.measurement.residual_temperature_coefficient_per_c = -1e-4;
        let out = evaluate(&c, &cup());
        close(out.refractometer.coffee_true_tds, 0.1, 1e-15);
        close(out.refractometer.water_mineral_tds, 0.00009, 1e-15);
        close(out.refractometer.temperature_bias, -0.001, 1e-15);
        close(out.refractometer.apparent_tds, 0.09909, 1e-15);
        c.measurement.mineral_blank_subtracted = true;
        let blanked = evaluate(&c, &cup());
        close(blanked.refractometer.apparent_tds, 0.099, 1e-15);
        assert_eq!(
            blanked.refractometer.water_mineral_tds,
            out.refractometer.water_mineral_tds
        );
    }

    #[test]
    fn mass_assignment_reports_overlap_without_rescaling_and_checks_transport_residual() {
        let c = spec();
        let mut r = cup();
        r.summary.species[0].mass_kg = 0.005;
        let out = evaluate(&c, &r);
        close(
            out.mass_closure.quantified_dissolved_species_kg,
            0.005,
            1e-15,
        );
        close(out.mass_closure.overassigned_solubles_kg, 0.001, 1e-15);
        close(
            out.mass_closure.relative_transport_closure_error,
            0.25,
            1e-15,
        );
        r.summary.species[0].mass_kg = 0.001;
        r.summary.species.push(super::super::SpeciesTotal {
            id: "unassigned_solubles".into(),
            mass_kg: 0.003,
            ..Default::default()
        });
        let out = evaluate(&c, &r);
        close(
            out.mass_closure.transport_unassigned_solubles_kg,
            0.003,
            1e-15,
        );
        close(
            out.mass_closure.relative_transport_closure_error,
            0.0,
            1e-15,
        );
    }

    #[test]
    fn no_beverage_does_not_create_aroma_or_phase_recovery() {
        let c = spec();
        let out = evaluate(&c, &ShotResult::default());
        assert_eq!(out.acidity.ph, None);
        assert_eq!(out.acidity.status, "no_beverage");
        assert!(out.aroma.is_empty());
        assert!(out.phases.is_empty());
    }
}
