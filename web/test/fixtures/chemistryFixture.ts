// SPDX-License-Identifier: GPL-2.0-or-later
/** Deliberately simple cup values for display/serialization tests, not calibration. */
import type { CupChemistryResult } from '../../src/engine/shotTypes';

export function fixtureChemistry(): CupChemistryResult {
  return {
    schema: 'puckworks.cup-chemistry/1',
    reference_temp_c: 25,
    acidity: {
      ph: 5.21,
      titratable_acidity_mmol_l_to_ph_6_6: 7.25,
      titratable_acidity_mmol_l_to_ph_8: 8.5,
      status: 'estimated_intrinsic_ph_charge_closure',
      water_alkalinity_mmol_l: 0.8,
      carbonate_mol_l: 0.0004,
      background_charge_mol_l: 0.001,
      acids: [{ id: 'citric_acid', total_mol_l: 0.0005, mean_charge: 1.5, ionized_fraction: 0.9 }],
    },
    aroma: [
      {
        id: 'furfurylthiol',
        extracted_mass_kg: 1e-8,
        liquid_mass_kg: 6e-9,
        headspace_mass_kg: 1e-9,
        bound_mass_kg: 3e-9,
        liquid_concentration_ug_l: 0.15,
        headspace_concentration_ug_l: 0.01,
        odor_activity_ratio: 10,
        mass_balance_residual_kg: 0,
      },
    ],
    phases: [
      { id: 'lipids', available_mass_kg: 0.002, cup_mass_kg: 0.0002, retained_mass_kg: 0.0018 },
    ],
    texture: {
      lipid_mass_kg: 0.0002,
      lipid_concentration_g_l: 5,
      co2_recovered_mass_kg: 0.00002,
      crema_gas_volume_m3: 5e-6,
      crema_volume_proxy_m3: 6e-6,
    },
    refractometer: {
      coffee_true_tds: 0.1,
      water_mineral_tds: 0.00015,
      coffee_equivalent_tds_at_reference: 0.098,
      apparent_tds: 0.09815,
      temperature_bias: 0,
      sample_temp_c: 25,
      reference_temp_c: 25,
      mineral_blank_subtracted: false,
    },
    mass_closure: {
      lumped_solubles_kg: 0.004,
      quantified_dissolved_species_kg: 0.001,
      unassigned_solubles_kg: 0.003,
      overassigned_solubles_kg: 0,
      excluded_diagnostic_mass_kg: 0.0001,
      phase_inventory_mass_kg: 0.0002,
      transport_unassigned_solubles_kg: 0.003,
      transported_dissolved_species_kg: 0.004,
      relative_transport_closure_error: 0,
    },
    warnings: ['Fixture chemistry uses illustrative parameters.'],
  };
}
