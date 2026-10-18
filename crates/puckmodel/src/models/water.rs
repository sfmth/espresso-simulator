// SPDX-License-Identifier: GPL-2.0-or-later
//! Registry-backed M2 water and post-shot observation settings.

use puckcore::shot::{
    ChemistrySpec, CompoundChemistrySpec, CremaSpec, PhaseInventorySpec, RefractometerSpec,
    WaterChemistrySpec,
};

use super::{bean::BeanOut, chemistry_catalog};
use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, join};
use crate::recipe::{ChemistryInput, WaterInput};

#[allow(clippy::too_many_arguments)] // Each boundary keeps its input and output provenance explicit.
fn supplied(
    ctx: &mut Ctx,
    id: &str,
    units: &str,
    value: Option<f64>,
    recipe_path: &str,
    output_path: &str,
    lo: f64,
    hi: f64,
) -> Result<f64, ApiError> {
    let input = value
        .map(|v| {
            bounds::check(v, lo, hi, recipe_path, units)
                .map(|v| Val::new(v, format!("recipe:{recipe_path}")))
        })
        .transpose()?;
    let v = ctx.resolve(id, units, input, None, None)?;
    ctx.provenance.insert(output_path.into(), v.src);
    Ok(v.v)
}

fn param(ctx: &mut Ctx, id: &str, units: &str, path: &str) -> Result<f64, ApiError> {
    let v = ctx.param(id, units)?;
    ctx.provenance.insert(path.into(), v.src);
    Ok(v.v)
}

pub(crate) fn model(
    ctx: &mut Ctx,
    water: &WaterInput,
    cup: &ChemistryInput,
    bean: &BeanOut,
    dose_kg: f64,
) -> Result<Option<ChemistrySpec>, ApiError> {
    // Validate supplied inputs even when cup chemistry is disabled.
    for (value, name, hi) in [
        (
            water.alkalinity_mg_l_caco3,
            "water.alkalinity_mg_l_caco3",
            500.0,
        ),
        (
            water.hardness_mg_l_caco3,
            "water.hardness_mg_l_caco3",
            1000.0,
        ),
        (water.calcium_mg_l, "water.calcium_mg_l", 400.0),
        (water.magnesium_mg_l, "water.magnesium_mg_l", 200.0),
        (water.tds_mg_l, "water.tds_mg_l", 5000.0),
        (water.ph, "water.ph", 14.0),
        (cup.aroma_age_s, "chemistry.aroma_age_s", 86400.0),
        (cup.cup_headspace_ml, "chemistry.cup_headspace_ml", 1000.0),
        (
            cup.sample_temperature_c,
            "chemistry.sample_temperature_c",
            100.0,
        ),
    ] {
        if let Some(v) = value {
            bounds::check(v, 0.0, hi, name, "")?;
        }
    }
    if cup.enabled == Some(false) {
        ctx.note("M2 cup chemistry is disabled; the four legacy M1 transport diagnostics remain available.");
        return Ok(None);
    }
    let mut take = |id: &str, value: Option<f64>, name: &str, units: &str, hi: f64| {
        supplied(
            ctx,
            id,
            units,
            value,
            &format!("water.{name}"),
            &format!("chemistry.water.{name}"),
            0.0,
            hi,
        )
    };
    let water = WaterChemistrySpec {
        alkalinity_mg_l_caco3: take(
            "water.default.alkalinity_mg_l_caco3",
            water.alkalinity_mg_l_caco3,
            "alkalinity_mg_l_caco3",
            "mg/L",
            500.0,
        )?,
        hardness_mg_l_caco3: take(
            "water.default.hardness_mg_l_caco3",
            water.hardness_mg_l_caco3,
            "hardness_mg_l_caco3",
            "mg/L",
            1000.0,
        )?,
        calcium_mg_l: take(
            "water.default.calcium_mg_l",
            water.calcium_mg_l,
            "calcium_mg_l",
            "mg/L",
            400.0,
        )?,
        magnesium_mg_l: take(
            "water.default.magnesium_mg_l",
            water.magnesium_mg_l,
            "magnesium_mg_l",
            "mg/L",
            200.0,
        )?,
        tds_mg_l: take(
            "water.default.tds_mg_l",
            water.tds_mg_l,
            "tds_mg_l",
            "mg/L",
            5000.0,
        )?,
        ph: take("water.default.ph", water.ph, "ph", "1", 14.0)?,
    };
    let mut compounds = Vec::new();
    for (i, meta) in chemistry_catalog::catalog().iter().enumerate() {
        let p = chemistry_catalog::properties(ctx, &meta.id)?;
        for id in &meta.registry_refs {
            let suffix = id.rsplit('.').next().unwrap_or("");
            let property = match suffix {
                "mw" => Some(("molecular_weight_g_mol", "g/mol")),
                "pka1" => Some(("pka[0]", "1")),
                "pka2" => Some(("pka[1]", "1")),
                "pka3" => Some(("pka[2]", "1")),
                "henry" => Some(("henry_air_water_ratio", "1")),
                "threshold" => Some(("aroma_threshold_ug_l", "ug/L")),
                "binding_half_life" => Some(("binding_half_life_s", "s")),
                _ => None,
            };
            if let Some((name, unit)) = property {
                let value = ctx.param(id, unit)?;
                ctx.provenance
                    .insert(format!("chemistry.compounds[{i}].{name}"), value.src);
            }
        }
        compounds.push(CompoundChemistrySpec {
            id: meta.id.clone(),
            phase: meta.phase.clone(),
            counts_toward_tds: meta.counts_toward_tds,
            molecular_weight_g_mol: p.molecular_weight_g_mol,
            pka: p.pka,
            henry_air_water_ratio: p.henry_air_water_ratio,
            aroma_threshold_ug_l: p.aroma_threshold_ug_l,
            binding_half_life_s: p.binding_half_life_s,
        });
    }
    let phase_inventories = bean
        .phase_inventories
        .iter()
        .enumerate()
        .map(|(i, phase)| {
            ctx.provenance.insert(
                format!("chemistry.phase_inventories[{i}].available_mass_kg"),
                join(&[&phase.mass_fraction.src, "recipe:prep.dose_g"]),
            );
            ctx.provenance.insert(
                format!("chemistry.phase_inventories[{i}].cup_transfer_fraction"),
                phase.cup_transfer_fraction.src.clone(),
            );
            PhaseInventorySpec {
                id: phase.id.to_string(),
                available_mass_kg: dose_kg * phase.mass_fraction.v,
                cup_transfer_fraction: phase.cup_transfer_fraction.v,
            }
        })
        .collect();
    let headspace = supplied(
        ctx,
        "chemistry.cup.headspace",
        "mL",
        cup.cup_headspace_ml,
        "chemistry.cup_headspace_ml",
        "chemistry.cup_headspace_m3",
        0.0,
        1000.0,
    )? / 1e6;
    let age = supplied(
        ctx,
        "chemistry.cup.aroma_age",
        "s",
        cup.aroma_age_s,
        "chemistry.aroma_age_s",
        "chemistry.aroma_age_s",
        0.0,
        86400.0,
    )?;
    let sample_temp = supplied(
        ctx,
        "chemistry.refractometer.sample_temperature",
        "degC",
        cup.sample_temperature_c,
        "chemistry.sample_temperature_c",
        "chemistry.measurement.sample_temp_c",
        0.0,
        100.0,
    )?;
    let blank = cup.mineral_blank_subtracted.unwrap_or(false);
    ctx.provenance.insert(
        "chemistry.measurement.mineral_blank_subtracted".into(),
        if cup.mineral_blank_subtracted.is_some() {
            "recipe:chemistry.mineral_blank_subtracted"
        } else {
            "model:no mineral blank subtraction"
        }
        .into(),
    );
    ctx.note("M2 pH uses an estimated intrinsic coffee pH/background-buffer closure at 25 C; chemistry does not establish taste, and water hardness does not impose an extraction multiplier.");
    ctx.note("Aroma headspace is a closed-cup equilibrium estimate; gas/oil recovery and crema are proxies, with no calibrated foam lifetime or open-cup evaporation.");
    Ok(Some(ChemistrySpec {
        water,
        compounds,
        phase_inventories,
        coffee_reference_ph: param(
            ctx,
            "water.coffee.reference_ph",
            "1",
            "chemistry.coffee_reference_ph",
        )?,
        background_buffer_pka: param(
            ctx,
            "water.coffee.background_buffer_pka",
            "1",
            "chemistry.background_buffer_pka",
        )?,
        background_buffer_mol_per_kg_solubles: param(
            ctx,
            "water.coffee.background_buffer_mol_per_kg_solubles",
            "mol/kg",
            "chemistry.background_buffer_mol_per_kg_solubles",
        )?,
        water_pkw: param(ctx, "water.equilibrium.pkw", "1", "chemistry.water_pkw")?,
        carbonate_pka: [
            param(
                ctx,
                "water.equilibrium.carbonate_pka1",
                "1",
                "chemistry.carbonate_pka[0]",
            )?,
            param(
                ctx,
                "water.equilibrium.carbonate_pka2",
                "1",
                "chemistry.carbonate_pka[1]",
            )?,
        ],
        calcium_carbonate_molar_mass_g_mol: param(
            ctx,
            "water.equilibrium.caco3_molar_mass",
            "g/mol",
            "chemistry.calcium_carbonate_molar_mass_g_mol",
        )?,
        water_density_kg_m3: param(
            ctx,
            "water.equilibrium.reference_density",
            "kg/m^3",
            "chemistry.water_density_kg_m3",
        )?,
        cup_headspace_m3: headspace,
        aroma_age_s: age,
        measurement: RefractometerSpec {
            sample_temp_c: sample_temp,
            reference_temp_c: param(
                ctx,
                "chemistry.refractometer.reference_temperature",
                "degC",
                "chemistry.measurement.reference_temp_c",
            )?,
            residual_temperature_coefficient_per_c: param(
                ctx,
                "chemistry.refractometer.residual_temperature_coefficient",
                "K^-1",
                "chemistry.measurement.residual_temperature_coefficient_per_c",
            )?,
            coffee_response_factor: param(
                ctx,
                "chemistry.refractometer.coffee_response",
                "1",
                "chemistry.measurement.coffee_response_factor",
            )?,
            mineral_response_factor: param(
                ctx,
                "chemistry.refractometer.mineral_response",
                "1",
                "chemistry.measurement.mineral_response_factor",
            )?,
            mineral_blank_subtracted: blank,
        },
        crema: CremaSpec {
            co2_id: "co2".into(),
            lipid_id: "lipid_emulsion".into(),
            co2_capture_fraction: param(
                ctx,
                "chemistry.crema.co2_capture_fraction",
                "1",
                "chemistry.crema.co2_capture_fraction",
            )?,
            bubble_gas_density_kg_m3: param(
                ctx,
                "chemistry.crema.gas_density",
                "kg/m^3",
                "chemistry.crema.bubble_gas_density_kg_m3",
            )?,
            foam_gas_volume_fraction: param(
                ctx,
                "chemistry.crema.gas_volume_fraction",
                "1",
                "chemistry.crema.foam_gas_volume_fraction",
            )?,
        },
    }))
}
