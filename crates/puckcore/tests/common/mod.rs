// SPDX-License-Identifier: GPL-2.0-or-later
//! Explicit small physical fixture, independent of the registry/builder.
use puckcore::shot::*;

pub fn chemistry_spec() -> ChemistrySpec {
    ChemistrySpec {
        water: WaterChemistrySpec {
            alkalinity_mg_l_caco3: 40.0,
            hardness_mg_l_caco3: 68.0,
            calcium_mg_l: 20.0,
            magnesium_mg_l: 4.0,
            tds_mg_l: 120.0,
            ph: 7.0,
        },
        compounds: vec![
            CompoundChemistrySpec {
                id: "caffeine".into(),
                phase: "dissolved".into(),
                counts_toward_tds: true,
                molecular_weight_g_mol: Some(194.19),
                ..Default::default()
            },
            CompoundChemistrySpec {
                id: "citric_acid".into(),
                phase: "dissolved".into(),
                counts_toward_tds: true,
                molecular_weight_g_mol: Some(192.12),
                pka: vec![3.13, 4.76, 6.4],
                ..Default::default()
            },
            CompoundChemistrySpec {
                id: "furfurylthiol".into(),
                phase: "dissolved".into(),
                counts_toward_tds: true,
                molecular_weight_g_mol: Some(114.17),
                henry_air_water_ratio: Some(0.5),
                aroma_threshold_ug_l: Some(0.01),
                binding_half_life_s: Some(600.0),
                ..Default::default()
            },
            CompoundChemistrySpec {
                id: "co2".into(),
                phase: "gas".into(),
                ..Default::default()
            },
            CompoundChemistrySpec {
                id: "lipid_emulsion".into(),
                phase: "lipid".into(),
                ..Default::default()
            },
        ],
        phase_inventories: vec![
            PhaseInventorySpec {
                id: "co2".into(),
                available_mass_kg: 0.0001,
                cup_transfer_fraction: 0.4,
            },
            PhaseInventorySpec {
                id: "lipid_emulsion".into(),
                available_mass_kg: 0.003,
                cup_transfer_fraction: 0.03,
            },
        ],
        coffee_reference_ph: 5.0,
        background_buffer_pka: 6.5,
        background_buffer_mol_per_kg_solubles: 1.0,
        water_pkw: 14.0,
        carbonate_pka: [6.35, 10.33],
        calcium_carbonate_molar_mass_g_mol: 100.0869,
        water_density_kg_m3: 997.0,
        cup_headspace_m3: 50e-6,
        aroma_age_s: 120.0,
        measurement: RefractometerSpec {
            sample_temp_c: 25.0,
            reference_temp_c: 20.0,
            residual_temperature_coefficient_per_c: 0.0,
            coffee_response_factor: 1.0,
            mineral_response_factor: 1.0,
            mineral_blank_subtracted: false,
        },
        crema: CremaSpec {
            co2_id: "co2".into(),
            lipid_id: "lipid_emulsion".into(),
            co2_capture_fraction: 0.3,
            bubble_gas_density_kg_m3: 1.84,
            foam_gas_volume_fraction: 0.9,
        },
    }
}
