// SPDX-License-Identifier: GPL-2.0-or-later
//! Plausibility bounds of recipe inputs (docs/model/input-models.md §1).
//!
//! Every numeric recipe field is checked here, with an error naming the field.
//! `data/schema/recipe.schema.json` states the same bounds; a Python test
//! checks that the builder and the schema reject the same values.

use crate::api::ApiError;

// Bean.
pub(crate) const BEAN_TEMP_C: (f64, f64) = (-200.0, 60.0);
pub(crate) const MAX_DAYS_OFF_ROAST: f64 = 3650.0;
// Grinder.
pub(crate) const MAX_GAP_UM: f64 = 3000.0;
pub(crate) const MAX_GAP_PER_UNIT_UM: f64 = 1000.0;
pub(crate) const BURR_DIAMETER_MM: (f64, f64) = (10.0, 300.0);
pub(crate) const MAX_RPM: f64 = 5000.0;
/// u_G: a 340 µm median leaves room for at most about 45% below 100 µm.
pub(crate) const FINES_AT_340_PCT: (f64, f64) = (1.0, 40.0);
pub(crate) const COARSE_LOG_WIDTH: (f64, f64) = (0.1, 1.0);
pub(crate) const BOULDER_WEIGHT: (f64, f64) = (0.0, 0.3);
/// The solver takes particle radii of 0.1 µm–5 mm.
pub(crate) const PSD_DIAMETER_UM: (f64, f64) = (0.2, 5000.0);
pub(crate) const MAX_PSD_BINS: usize = 2000;
// Basket.
pub(crate) const BASKET_DIAMETER_MM: (f64, f64) = (20.0, 120.0);
pub(crate) const MAX_BASKET_HEIGHT_MM: f64 = 100.0;
pub(crate) const MIN_PERFORATED_DIAMETER_MM: f64 = 5.0;
pub(crate) const ORIFICE_MM: (f64, f64) = (0.05, 10.0);
pub(crate) const MIN_OPEN_AREA: f64 = 0.001;
pub(crate) const DISCHARGE_COEFFICIENT: (f64, f64) = (0.1, 1.0);
// Puck preparation.
pub(crate) const DOSE_G: (f64, f64) = (1.0, 60.0);
pub(crate) const MAX_TAMP_KGF: f64 = 100.0;
// Machine.
pub(crate) const WATER_TEMP_C: (f64, f64) = (20.0, 100.0);
pub(crate) const MAX_HEADSPACE_ML: f64 = 200.0;
pub(crate) const MAX_PUMP_FLOW_ML_S: f64 = 30.0;
pub(crate) const MAX_PUMP_PRESSURE_BAR: f64 = 30.0;
pub(crate) const MAX_TARGET_PRESSURE_BAR: f64 = 20.0;
pub(crate) const MAX_TARGET_FLOW_ML_S: f64 = 20.0;
pub(crate) const MAX_PHASE_TIME_S: f64 = 600.0;
pub(crate) const MAX_BEVERAGE_G: f64 = 500.0;
// Stop rule and numerics.
pub(crate) const MAX_STOP_TIME_S: f64 = 600.0;
/// Longest simulated shot (numerics.max_duration_s), s.
pub(crate) const MAX_DURATION_S: f64 = 1200.0;
pub(crate) const SIZE_CLASSES: (usize, usize) = (2, 60);

/// A number for messages: plain for 0 and 0.001 ≤ |x| < 10⁶, scientific
/// otherwise (`1e-18` rather than `0.000000000000000001`).
pub(crate) fn num(x: f64) -> String {
    let a = x.abs();
    if x == 0.0 || !x.is_finite() || (1e-3..1e6).contains(&a) {
        format!("{x}")
    } else {
        format!("{x:e}")
    }
}

/// `lo ≤ x ≤ hi`.
pub(crate) fn check(x: f64, lo: f64, hi: f64, path: &str, unit: &str) -> Result<f64, ApiError> {
    if !x.is_finite() {
        return Err(ApiError(format!("{path} must be a finite number")));
    }
    if x < lo || x > hi {
        return Err(ApiError(format!(
            "{path} = {} is outside the plausible range {} to {}{}",
            num(x),
            num(lo),
            num(hi),
            unit_suffix(unit)
        )));
    }
    Ok(x)
}

/// `0 < x ≤ hi`.
pub(crate) fn check_pos(x: f64, hi: f64, path: &str, unit: &str) -> Result<f64, ApiError> {
    if !x.is_finite() {
        return Err(ApiError(format!("{path} must be a finite number")));
    }
    if x <= 0.0 || x > hi {
        return Err(ApiError(format!(
            "{path} = {} must be > 0 and at most {}{}",
            num(x),
            num(hi),
            unit_suffix(unit)
        )));
    }
    Ok(x)
}

/// Checks an optional field.
pub(crate) fn opt(
    x: Option<f64>,
    f: impl Fn(f64) -> Result<f64, ApiError>,
) -> Result<Option<f64>, ApiError> {
    x.map(f).transpose()
}

fn unit_suffix(unit: &str) -> String {
    if unit.is_empty() {
        String::new()
    } else {
        format!(" {unit}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_name_the_field() {
        assert_eq!(check(5.0, 0.0, 10.0, "a.b", "g").unwrap(), 5.0);
        assert!(
            check(11.0, 0.0, 10.0, "a.b", "g")
                .unwrap_err()
                .0
                .contains("a.b = 11")
        );
        assert!(
            check_pos(0.0, 10.0, "c.d", "")
                .unwrap_err()
                .0
                .contains("c.d = 0 must be > 0")
        );
        assert!(
            check(f64::NAN, 0.0, 1.0, "e", "")
                .unwrap_err()
                .0
                .contains("finite")
        );
        assert_eq!(opt(None, |x| check(x, 0.0, 1.0, "f", "")).unwrap(), None);
        assert_eq!(num(0.0), "0");
        assert_eq!(num(3000.5), "3000.5");
        assert_eq!(num(1e-18), "1e-18");
        assert_eq!(num(2.4e-14), "2.4e-14");
        assert_eq!(num(1e308), "1e308");
        assert!(
            check(1e-20, 1e-18, 1e-10, "g", "m^2")
                .unwrap_err()
                .0
                .contains("g = 1e-20 is outside the plausible range 1e-18 to 1e-10 m^2")
        );
    }
}
