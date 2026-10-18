// SPDX-License-Identifier: GPL-2.0-or-later
//! M3 explainable relative taste indices. This is an explicitly uncalibrated
//! mapping from M2 concentrations, not a validated sensory or quality model.
//! See `docs/model/m3-taste.md` for equations, evidence and omissions.

use puckcore::shot::ShotResult;
use serde::{Deserialize, Serialize};

use crate::{Built, Recipe, api::ApiError, registry::registry};

pub const TASTE_SCHEMA: &str = "puckworks.taste/1";

/// Post-shot context. Dilution means addition of chemically neutral water;
/// its acid/base equilibrium and serving-temperature perception are not solved.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TasteConditions {
    pub serving_temperature_c: Option<f64>,
    pub dilution_water_g: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TasteContext {
    pub chemistry_reference_temperature_c: Option<f64>,
    pub serving_temperature_c: Option<f64>,
    pub serving_temperature_modelled: bool,
    pub dilution_water_g: f64,
    pub original_beverage_g: f64,
    pub diluted_beverage_g: f64,
    pub aroma_age_s: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TasteDriver {
    pub id: String,
    pub label: String,
    pub value: f64,
    pub units: String,
    /// Additive dimensionless term before the display compression. This is
    /// neither a sensory share nor a contribution in 0–100 index points.
    pub contribution: f64,
    pub registry_refs: Vec<String>,
    pub source_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TasteAttribute {
    pub id: String,
    pub label: String,
    pub index: Option<f64>,
    pub trust: String,
    pub drivers: Vec<TasteDriver>,
    pub assumptions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TasteSource {
    pub id: String,
    pub citation: String,
    pub url: String,
    pub evidence_grade: String,
    pub scope: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TasteEstimate {
    pub schema: String,
    /// `estimated`, `no_cup`, `chemistry_disabled`, or `incomplete_chemistry`.
    pub status: String,
    pub trust: String,
    pub score_semantics: String,
    pub acidity_index: Option<f64>,
    pub bitterness_index: Option<f64>,
    pub astringency_index: Option<f64>,
    pub body_index: Option<f64>,
    pub conditions: TasteContext,
    pub attributes: Vec<TasteAttribute>,
    pub assumptions: Vec<String>,
    pub sources: Vec<TasteSource>,
}

impl TasteConditions {
    pub fn validate(&self) -> Result<(), ApiError> {
        if !self.dilution_water_g.is_finite() || !(0.0..=500.0).contains(&self.dilution_water_g) {
            return Err(ApiError(
                "taste.dilution_water_g must be finite and in [0,500]".into(),
            ));
        }
        if self
            .serving_temperature_c
            .is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v))
        {
            return Err(ApiError(
                "taste.serving_temperature_c must be finite and in [0,100]".into(),
            ));
        }
        Ok(())
    }
}

fn sources() -> Vec<TasteSource> {
    [
        ("gloess2013", "Gloess et al. (2013), Comparison of nine common coffee extraction methods", "https://doi.org/10.1007/s00217-013-1917-x", "A", "Measured chemistry/sensory correlations across nine methods, including espresso; does not establish these index equations or causal astringents."),
        ("frank2006", "Frank, Zehentbauer and Hofmann (2006), Bioresponse-guided decomposition of roast coffee beverage", "https://doi.org/10.1007/s00217-005-0143-6", "A", "Identification and sensory testing of bitter chlorogenic-acid lactones; grouped concentration here is not a threshold-calibrated prediction."),
        ("frank2007", "Frank et al. (2007), Sensory analysis of bitter 4-vinylcatechol oligomers", "https://doi.org/10.1021/jf0632280", "A", "Identifies harsh, lingering bitter phenylindanes; does not validate a common potency for this lumped family."),
        ("gigl2026", "Gigl, Kreissl and Frank (2026), Interactions between melanoidins and caffeine", "https://doi.org/10.1021/acs.jafc.5c17022", "A", "Model and tested coffee matrices show suppression of caffeine bitterness by high-molecular-weight fractions; no universal caffeine contribution or espresso correction is inferred."),
        ("m3heuristic", "Puckworks M3 uncalibrated index conventions (2026)", "https://github.com/sfmth/espresso-simulator/blob/main/docs/model/m3-taste.md", "D", "All reference scales, weights and the 0–100 display compression are explicit modelling assumptions, not fitted measurements."),
    ].into_iter().map(|(id, citation, url, evidence_grade, scope)| TasteSource {
        id: id.into(), citation: citation.into(), url: url.into(),
        evidence_grade: evidence_grade.into(), scope: scope.into(),
    }).collect()
}

fn driver(
    id: &str,
    label: &str,
    value: f64,
    units: &str,
    contribution: f64,
    registry_refs: &[&str],
    source_refs: &[&str],
) -> TasteDriver {
    TasteDriver {
        id: id.into(),
        label: label.into(),
        value,
        units: units.into(),
        contribution,
        registry_refs: registry_refs.iter().map(|v| (*v).into()).collect(),
        source_refs: source_refs.iter().map(|v| (*v).into()).collect(),
    }
}

fn attribute(
    id: &str,
    label: &str,
    trust: &str,
    drivers: Vec<TasteDriver>,
    assumptions: &[&str],
) -> TasteAttribute {
    let latent: f64 = drivers.iter().map(|d| d.contribution).sum();
    TasteAttribute {
        id: id.into(),
        label: label.into(),
        index: Some(100.0 * latent / (1.0 + latent)),
        trust: trust.into(),
        drivers,
        assumptions: assumptions.iter().map(|v| (*v).into()).collect(),
    }
}

/// Uses the same native/Wasm code for the baseline and uncertainty samples.
/// Never changes the physical result, applies a sensory fit or infers liking.
pub fn estimate(
    recipe: &Recipe,
    built: &Built,
    result: &ShotResult,
    conditions: &TasteConditions,
) -> Result<TasteEstimate, ApiError> {
    conditions.validate()?;
    let cup_kg = result.summary.beverage_mass_kg;
    if !cup_kg.is_finite()
        || cup_kg < 0.0
        || !result.summary.tds.is_finite()
        || result.summary.tds < 0.0
    {
        return Err(ApiError(
            "taste requires finite, nonnegative beverage mass and TDS".into(),
        ));
    }
    let chemistry_spec = built.spec.chemistry.as_ref();
    let mut out = TasteEstimate {
        schema: TASTE_SCHEMA.into(), status: "estimated".into(), trust: "low".into(),
        score_semantics: "Relative 0–100 heuristic indices for comparisons under this model; not sensory ratings, probabilities, quality scores or preference predictions. Values across different attributes are not directly comparable.".into(),
        acidity_index: None, bitterness_index: None, astringency_index: None, body_index: None,
        conditions: TasteContext {
            chemistry_reference_temperature_c: result.chemistry.as_ref().map(|c| c.reference_temp_c),
            serving_temperature_c: conditions.serving_temperature_c,
            serving_temperature_modelled: false,
            dilution_water_g: conditions.dilution_water_g,
            original_beverage_g: cup_kg * 1000.0,
            diluted_beverage_g: cup_kg * 1000.0 + conditions.dilution_water_g,
            aroma_age_s: chemistry_spec.map(|c| c.aroma_age_s),
        },
        attributes: Vec::new(), sources: sources(),
        assumptions: vec![
            "All taste coefficients are grade D estimates. No espresso sensory panel was used to fit or validate these indices.".into(),
            "Input uncertainty bands propagate selected scenarios only; missing sensory mechanisms and individual differences remain outside those bands.".into(),
            "Chemistry uses its stated reference temperature. Serving temperature is recorded without a perceptual correction; no hot-cup taste prediction is made.".into(),
            "Sweetness, aroma notes, balance, liking and a quality score are not inferred from extractable sugars, OAVs, TDS or EY.".into(),
            "Acidity, bitterness, astringency and body are separate dimensions; index values must not be compared across dimensions or summed.".into(),
        ],
    };
    if cup_kg == 0.0 {
        out.status = "no_cup".into();
        out.assumptions.push(
            "There is no recovered beverage; taste indices are unavailable rather than zero."
                .into(),
        );
        return Ok(out);
    }
    let Some(chemistry) = result.chemistry.as_ref() else {
        out.status = "chemistry_disabled".into();
        out.assumptions.push("M2 chemistry is unavailable; taste indices are unavailable rather than guessed from extraction yield.".into());
        return Ok(out);
    };
    let required = [
        "cgl_mono",
        "cgl_di",
        "phenylindanes",
        "caffeine",
        "cqa3",
        "cqa4",
        "cqa5",
        "fqa",
        "dicqa",
        "polysaccharides",
        "melanoidins_low",
        "melanoidins_medium",
        "melanoidins_high",
    ];
    if chemistry_spec.is_none()
        || required
            .iter()
            .any(|id| !result.summary.species.iter().any(|sp| sp.id == *id))
    {
        out.status = "incomplete_chemistry".into();
        out.assumptions.push("A required named compound or the chemistry spec is missing. Missing inventory is not interpreted as zero concentration.".into());
        return Ok(out);
    }
    if result
        .summary
        .species
        .iter()
        .any(|sp| !sp.mass_kg.is_finite() || sp.mass_kg < 0.0)
        || !chemistry.texture.lipid_mass_kg.is_finite()
        || chemistry.texture.lipid_mass_kg < 0.0
        || !chemistry
            .acidity
            .titratable_acidity_mmol_l_to_ph_6_6
            .is_finite()
        || chemistry.acidity.titratable_acidity_mmol_l_to_ph_6_6 < 0.0
    {
        return Err(ApiError(
            "taste requires finite, nonnegative compound masses and acidity".into(),
        ));
    }
    let reg = registry()?;
    let param = |id: &str, units: &str| -> Result<f64, ApiError> {
        let p = reg
            .get(id)
            .ok_or_else(|| ApiError(format!("taste registry parameter {id} is missing")))?;
        if p.units != units {
            return Err(ApiError(format!(
                "taste registry parameter {id} expects units {units}"
            )));
        }
        let value = recipe.overrides.get(id).copied().unwrap_or(p.default);
        if !value.is_finite() || !p.range.contains(value) {
            return Err(ApiError(format!(
                "taste registry override {id} is outside its finite range"
            )));
        }
        Ok(value)
    };
    let total_kg = cup_kg + conditions.dilution_water_g / 1000.0;
    let dilution = cup_kg / total_kg;
    let density = chemistry_spec.unwrap().water_density_kg_m3;
    if !density.is_finite() || density <= 0.0 {
        return Err(ApiError(
            "taste requires a positive finite cup density".into(),
        ));
    }
    // Same approximate mass-to-volume conversion as M2, not a hot-cup density.
    let cup_l = total_kg / density * 1000.0;
    let concentration = |ids: &[&str]| -> f64 {
        result
            .summary
            .species
            .iter()
            .filter(|sp| ids.contains(&sp.id.as_str()))
            .map(|sp| sp.mass_kg)
            .sum::<f64>()
            * 1000.0
            / cup_l
    };
    let ta = chemistry.acidity.titratable_acidity_mmol_l_to_ph_6_6 * dilution;
    let lactones = concentration(&["cgl_mono", "cgl_di"]);
    let phenylindanes = concentration(&["phenylindanes"]);
    let caffeine = concentration(&["caffeine"]);
    let phenolics = concentration(&["cqa3", "cqa4", "cqa5", "fqa", "dicqa"]);
    let polymers = concentration(&[
        "polysaccharides",
        "melanoidins_low",
        "melanoidins_medium",
        "melanoidins_high",
    ]);
    let lipid = chemistry.texture.lipid_mass_kg * 1000.0 / cup_l;
    let tds = result.summary.tds * dilution;
    out.attributes = vec![
        attribute(
            "acidity",
            "Acidity potential",
            "low",
            vec![driver(
                "titratable_acidity",
                "Titratable acidity to pH 6.6",
                ta,
                "mmol/L",
                ta / param("taste.acidity.reference_ta", "mol/m^3")?,
                &["taste.acidity.reference_ta"],
                &["gloess2013", "m3heuristic"],
            )],
            &[
                "TA is an acid-load proxy, not measured sourness. pH, acid identity, buffers and masking affect perception.",
                "M2 source-water alkalinity is already included in TA; hardness is not given a universal flavour benefit.",
                "CGA and unresolved buffers can contribute to TA without the same sensory effect as individual organic acids.",
            ],
        ),
        attribute(
            "bitterness",
            "Bitterness potential",
            "low",
            vec![
                driver(
                    "lactones",
                    "Lactones: coffee-like bitter family",
                    lactones,
                    "g/L",
                    lactones / param("taste.bitterness.lactone_reference", "kg/m^3")?,
                    &["taste.bitterness.lactone_reference"],
                    &["frank2006", "m3heuristic"],
                ),
                driver(
                    "phenylindanes",
                    "Phenylindanes: harsh/lingering bitter family",
                    phenylindanes,
                    "g/L",
                    phenylindanes / param("taste.bitterness.phenylindane_reference", "kg/m^3")?,
                    &["taste.bitterness.phenylindane_reference"],
                    &["frank2007", "m3heuristic"],
                ),
                driver(
                    "caffeine",
                    "Caffeine: matrix-dependent bitter family",
                    caffeine,
                    "g/L",
                    param("taste.bitterness.caffeine_weight", "1")? * caffeine
                        / param("taste.bitterness.caffeine_reference", "kg/m^3")?,
                    &[
                        "taste.bitterness.caffeine_weight",
                        "taste.bitterness.caffeine_reference",
                    ],
                    &["gigl2026", "m3heuristic"],
                ),
            ],
            &[
                "Family labels describe compounds, not a prediction of the perceived bitterness type.",
                "Lumped lactones and phenylindanes have different molecular potencies; reference scales are not water detection thresholds.",
                "Caffeine weight is an arbitrary relative scaling, not its percentage of perceived bitterness. Melanoidin suppression and other mixture effects are unresolved.",
                "DKPs, mozambioside products and other bitter compounds are omitted because contribution and mixture potency are insufficiently constrained.",
            ],
        ),
        attribute(
            "astringency",
            "Astringency correlate",
            "very_low",
            vec![driver(
                "phenolic_concentration",
                "Chlorogenic-acid family concentration",
                phenolics,
                "g/L",
                phenolics / param("taste.astringency.phenolic_reference", "kg/m^3")?,
                &["taste.astringency.phenolic_reference"],
                &["gloess2013", "m3heuristic"],
            )],
            &[
                "This is an empirical-direction correlate, not a salivary-protein or friction model. CGAs need not be the molecules causing astringency.",
                "Sip sequence, saliva, suspended particles, brew nonuniformity and individual oral responses are not predicted.",
            ],
        ),
        attribute(
            "body",
            "Body / texture potential",
            "low",
            vec![
                driver(
                    "true_coffee_tds",
                    "True coffee dissolved-solids fraction",
                    tds,
                    "1",
                    param("taste.body.tds_weight", "1")? * tds
                        / param("taste.body.tds_reference", "1")?,
                    &["taste.body.tds_weight", "taste.body.tds_reference"],
                    &["gloess2013", "m3heuristic"],
                ),
                driver(
                    "soluble_polymers",
                    "Polysaccharides and melanoidin fractions",
                    polymers,
                    "g/L",
                    param("taste.body.polymer_weight", "1")? * polymers
                        / param("taste.body.polymer_reference", "kg/m^3")?,
                    &["taste.body.polymer_weight", "taste.body.polymer_reference"],
                    &["gloess2013", "m3heuristic"],
                ),
                driver(
                    "lipid_emulsion",
                    "Lipid emulsion concentration",
                    lipid,
                    "g/L",
                    param("taste.body.lipid_weight", "1")? * lipid
                        / param("taste.body.lipid_reference", "kg/m^3")?,
                    &["taste.body.lipid_weight", "taste.body.lipid_reference"],
                    &["gloess2013", "m3heuristic"],
                ),
            ],
            &[
                "TDS uses true coffee solubles, excluding source minerals and refractometer temperature bias.",
                "Polymers already occur within TDS; this is an explicit composition reweighting, not a sum of distinct masses or measured viscosity.",
                "Lipid transfer is an M2 phase-recovery prior. Droplet size, suspended fines, foam stability and temperature-dependent viscosity are unresolved.",
            ],
        ),
    ];
    if chemistry.acidity.ph.is_none() {
        out.attributes[0].index = None;
        out.attributes[0].assumptions.push(
            "The M2 acid/base balance has no pH root; acidity is unavailable rather than zero."
                .into(),
        );
    }
    out.acidity_index = out.attributes[0].index;
    out.bitterness_index = out.attributes[1].index;
    out.astringency_index = out.attributes[2].index;
    out.body_index = out.attributes[3].index;
    if conditions.dilution_water_g > 0.0 {
        out.assumptions.push("Dilution scales concentrations and TA by original/final beverage mass using the M2 density convention. Added water is assumed chemically neutral; pH, carbonate equilibrium and aroma partitioning are not recalculated.".into());
    }
    if chemistry.mass_closure.overassigned_solubles_kg > 0.0 {
        out.assumptions.push("M2 named species exceed lumped dissolved solids. Concentrations are preserved without renormalisation; this inventory mismatch further limits taste interpretation.".into());
    }
    Ok(out)
}
