// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks of a [`ShotSpec`]: exactly the solver's own validation
//! (`puckcore::shot::validate_shot_spec`), so the builder never emits a spec
//! the solver rejects and never rejects one it accepts. The builder runs the
//! same check on its output and maps any failure to the recipe field or
//! override responsible.

use puckcore::shot::ShotSpec;

/// Checks a spec as the solver does: its warnings, or the first invalid field
/// with the reason.
pub fn check_spec(spec: &ShotSpec) -> Result<Vec<String>, String> {
    puckcore::shot::validate_shot_spec(spec).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegates_to_the_solver() {
        let spec = ShotSpec::default();
        check_spec(&spec).unwrap();
        let mut bad = spec.clone();
        bad.hydraulics.permeability_m2 = f64::NAN;
        assert!(
            check_spec(&bad)
                .unwrap_err()
                .contains("hydraulics.permeability_m2")
        );
        let mut bad = spec;
        bad.thermal.initial_bed_temp_c = -5.0;
        assert!(
            check_spec(&bad)
                .unwrap_err()
                .contains("thermal.initial_bed_temp_c")
        );
    }
}
