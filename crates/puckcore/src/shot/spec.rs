// SPDX-License-Identifier: GPL-2.0-or-later
//! [`ShotSpec`]: the complete physical description of one espresso shot.
//!
//! All quantities are SI. Every field name ends in its unit (`_m`, `_kg`,
//! `_s`, `_pa`, `_m3_s`, `_c` for °C). Dimensionless fractions have no suffix.
//! The JSON form is the contract in `docs/model/m1-contract.md`.
//!
//! Every struct implements `Default`, so callers can write
//! `ShotSpec { bed, ..Default::default() }` and stay source-compatible when
//! fields are added. New fields must therefore always have a default.
//!
//! The defaults are the parameter registry's central values where an entry
//! exists (`data/params/*.yaml`; the mapping is tabulated in
//! `docs/model/shot-model.md` §2). Real values for a recipe come from the
//! registry and the input models through `puckmodel`.

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

/// Complete physical description of a shot.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct ShotSpec {
    /// Schema id, `"puckworks.shot-spec/1"`.
    pub schema: String,
    pub basket: BasketGeometry,
    pub bed: BedSpec,
    pub solubles: SolublesSpec,
    pub hydraulics: HydraulicsSpec,
    pub thermal: ThermalSpec,
    pub machine: MachineSpec,
    pub numerics: NumericsSpec,
}

impl Default for ShotSpec {
    fn default() -> Self {
        Self {
            schema: super::SHOT_SPEC_SCHEMA.to_string(),
            basket: BasketGeometry::default(),
            bed: BedSpec::default(),
            solubles: SolublesSpec::default(),
            hydraulics: HydraulicsSpec::default(),
            thermal: ThermalSpec::default(),
            machine: MachineSpec::default(),
            numerics: NumericsSpec::default(),
        }
    }
}

/// Axisymmetric basket geometry. Straight, tapered and stepped baskets of any
/// diameter are all described by `profile_m` (PLAN design principle 7).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct BasketGeometry {
    /// Inner wall profile as `[height above the basket floor, inner radius]`, m.
    /// At least two points; heights start at 0 and strictly increase. The
    /// radius is linear between points.
    pub profile_m: Vec<[f64; 2]>,
    /// Radius of the perforated area on the floor, m (at most the floor radius).
    /// With `open_area_fraction` it sets the hole area of the floor.
    pub perforated_radius_m: f64,
    /// Open (hole) fraction of the perforated area, (0, 1]. Below 1 the holes
    /// act as an orifice plate in series with the puck,
    /// ΔP = ρQ²/(2 C_d² A_h²) with A_h = open fraction · π r_perf² and
    /// C_d = 0.61; 1 means the holes add no resistance.
    pub open_area_fraction: f64,
    /// Plain holes, or a pressurised (dual-wall) basket.
    pub outlet: Outlet,
    /// Volume between the basket rim and the shower screen that must fill with
    /// water before pressure builds, m³. The basket volume above the bed is
    /// added to this by the solver.
    pub extra_headspace_m3: f64,
}

impl Default for BasketGeometry {
    fn default() -> Self {
        Self {
            profile_m: vec![[0.0, 0.029], [0.025, 0.029]],
            perforated_radius_m: 0.027,
            open_area_fraction: 1.0,
            outlet: Outlet::Holes,
            extra_headspace_m3: 5e-6,
        }
    }
}

/// Basket outlet.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(
    feature = "serde",
    serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)
)]
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Outlet {
    /// Ordinary perforated floor.
    #[default]
    Holes,
    /// Dual-wall basket: the extract leaves through one orifice, which adds a
    /// quadratic resistance ΔP = ρQ²/(2 C_d² A_o²) in series with the puck.
    Pressurised {
        /// Orifice diameter, m.
        orifice_diameter_m: f64,
        /// Discharge coefficient C_d, typically 0.6–0.8.
        discharge_coefficient: f64,
    },
}

/// The coffee bed.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct BedSpec {
    /// Dry dose, kg.
    pub dose_kg: f64,
    /// Intergranular (between-particle) porosity after tamping.
    pub intergranular_porosity: f64,
    /// Intraparticle porosity ε_p (the default follows from the dry bulk
    /// density; Corrochano, who measured the partition coefficient, takes the
    /// swollen envelope equal to the dry one).
    pub intraparticle_porosity: f64,
    /// Skeletal (solid) density, kg/m³.
    pub skeletal_density_kg_m3: f64,
    /// Particle size classes. Volume fractions sum to 1.
    pub size_classes: Vec<SizeClass>,
    /// Parallel flow paths and their permeability spread.
    pub heterogeneity: Heterogeneity,
}

impl Default for BedSpec {
    fn default() -> Self {
        Self {
            dose_kg: 0.018,
            // bed.porosity.intergranular (mode).
            intergranular_porosity: 0.17,
            // From bed.porosity.total (0.635, "well constrained") and the
            // intergranular value: (0.635 − 0.17)/(1 − 0.17) = 0.56.
            intraparticle_porosity: 0.56,
            // bed.density.skeletal (centre of 1304–1400).
            skeletal_density_kg_m3: 1352.0,
            size_classes: vec![
                // psd.fines_mode (40 µm diameter); psd.fines_fraction.dry
                // (centre of 15–36%).
                SizeClass {
                    radius_m: 20e-6,
                    volume_fraction: 0.255,
                },
                // psd.two_class.boulder_radius.espresso_range (centre of 100–250 µm).
                SizeClass {
                    radius_m: 175e-6,
                    volume_fraction: 0.745,
                },
            ],
            heterogeneity: Heterogeneity::default(),
        }
    }
}

/// One particle size class. Particles are spheres; each has a broken-cell
/// surface pool of thickness `solubles.cell_size_m` around an intact kernel.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields))]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct SizeClass {
    /// Representative particle radius, m.
    pub radius_m: f64,
    /// Share of the solid volume in this class.
    pub volume_fraction: f64,
}

/// Bed heterogeneity: parallel 1D columns sharing one inlet pressure
/// (PLAN §7.3, module P). Columns are radial annuli of the basket: the outer
/// annulus is the edge column; the inner annuli share the rest of the area
/// equally and carry stratified log-normal permeability multipliers.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct Heterogeneity {
    /// Number of parallel columns (radial annuli × permeability strata),
    /// 1–64. Tier 0 uses three strata (one without spread) plus the edge
    /// annulus. A spread needs at least two inner columns; with fewer the
    /// solver warns that it is not represented.
    pub columns: usize,
    /// Standard deviation of ln(permeability multiplier) across the inner
    /// columns, 0–3. The inner columns are equal-probability strata of the
    /// log-normal, each carrying its conditional mean,
    /// m_k = n·[Φ(z_{k+1} − σ) − Φ(z_k − σ)] with z_k = Φ⁻¹(k/n); the
    /// multipliers have an area-weighted mean of exactly 1.
    pub sigma_ln_permeability: f64,
    /// Share of the bed in the outer annulus, 0–0.9. 0 means no edge column.
    /// With a single column the edge enters through the area-weighted
    /// multiplier (1 − f) + f·`edge_multiplier`.
    pub edge_area_fraction: f64,
    /// Extra permeability multiplier of the outer annulus (< 1 when the holes
    /// stop short of the wall; about 1 with a bottom paper filter).
    pub edge_multiplier: f64,
    /// Pre-wetting non-uniformity from headspace and shower screen, 0–1. It
    /// widens the permeability spread: the inner columns use
    /// σ = √(`sigma_ln_permeability`² + `prewet_nonuniformity`²).
    pub prewet_nonuniformity: f64,
}

impl Default for Heterogeneity {
    fn default() -> Self {
        Self {
            columns: 8,
            sigma_ln_permeability: 0.2,
            edge_area_fraction: 0.25,
            edge_multiplier: 1.0,
            prewet_nonuniformity: 0.0,
        }
    }
}

/// Soluble content and extraction kinetics.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct SolublesSpec {
    /// Extractable solubles per dry dose (maximum EY), kg/kg, 0–0.6. They
    /// are spread uniformly through the solid.
    pub extractable_fraction: f64,
    /// Thickness of the broken-cell shell on each particle, m. It sets the
    /// fast surface pool, a volume share 1 − ((a − δ)/a)³ of a particle of
    /// radius a; particles thinner than this are all surface. 0 means no
    /// surface pool.
    pub cell_size_m: f64,
    /// Saturation concentration capping surface dissolution, kg/m³: the
    /// surface flux is k·(min(c_pool, c_sat) − c) (Grudeva form).
    pub saturation_kg_m3: f64,
    /// Partition coefficient K = c_liquid/C_s at equilibrium, 0.01–100, with
    /// C_s the soluble mass per particle envelope volume (pore solution and
    /// matrix-bound solute together): Corrochano 2017, eq. 3.15–3.17. The
    /// state is total loading C_s = ε_c u, with ε_c = ε_p·(1 − u_w)
    /// a reference normalization. Thus the boundary is c/(K·ε_c).
    /// Internal pore water is included in C_s, not in the mobile inventory.
    /// The dilute-batch partition law is an extrapolation at espresso
    /// concentrations; runtime checks reject loss of positive water content.
    pub partition_coefficient: f64,
    /// Effective diffusivity of lumped solubles in intact kernels, m²/s, at
    /// `reference_temp_c`. It scales with temperature as T/μ_water(T)
    /// (Stokes–Einstein).
    pub kernel_diffusivity_m2_s: f64,
    /// Surface (broken-cell) dissolution coefficient, m/s.
    pub surface_rate_m_s: f64,
    /// Temperature at which the diffusivities apply, °C.
    pub reference_temp_c: f64,
    /// Individually tracked species (in addition to the lumped solubles).
    pub species: Vec<SpeciesSpec>,
    /// Apparent specific volume of the dissolved solids, m³/kg: a liquid
    /// holding c kg/m³ has density ρ_w(1 − v̄c) + c. Used to turn outflow
    /// volume into beverage mass and concentration into TDS (w/w).
    pub solute_specific_volume_m3_kg: f64,
    /// Optional cap on excess boundary loading:
    /// min(c/(K·ε_c), u₀ + βc/ε_c), where β = ε_p·water_fraction.
    /// The aqueous term admits solute carried into newly filled particle
    /// pores; total particle content may exceed its initial dry content.
    /// This deposition restriction is a modelling assumption, not a measured
    /// adsorption capacity. Recipe builds use `false` (linear partition).
    pub kernel_loading_cap: bool,
}

impl Default for SolublesSpec {
    fn default() -> Self {
        Self {
            // extraction.max_yield (centre of 22–34%).
            extractable_fraction: 0.28,
            // One cell (cell pockets 25–40 µm, note 01 §5.1).
            cell_size_m: 30e-6,
            // extraction.saturation.lumped (centre of 210–280 kg/m³).
            saturation_kg_m3: 245.0,
            // extraction.partition.lumped_80c (per particle envelope volume).
            partition_coefficient: 0.61,
            // extraction.diffusivity.lumped.corrochano_80c, measured at 80 °C.
            kernel_diffusivity_m2_s: 1.26e-10,
            // extraction.surface_rate.grudeva2026.
            surface_rate_m_s: 1e-3,
            reference_temp_c: 80.0,
            species: Vec::new(),
            // 25% w/w ≈ 275 kg/m³ at density 1.10 (note 01 §4.10, from
            // hydraulics.extract_density.low_temperature).
            solute_specific_volume_m3_kg: 6.4e-4,
            kernel_loading_cap: true,
        }
    }
}

/// A tracked species: a linear passenger on the lumped solution's flow and
/// temperature history, with its own kernel diffusivity and partition
/// coefficient. Its surface share dissolves congruently with the lumped
/// surface pool of the same class.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct SpeciesSpec {
    /// Identifier, e.g. `"caffeine"`, `"trigonelline"`, `"cqa5"`, `"acids"`;
    /// non-empty and unique.
    pub id: String,
    /// Extractable mass of the species per dry dose, kg/kg.
    pub mass_fraction: f64,
    /// Effective kernel diffusivity, m²/s, at the reference temperature.
    pub kernel_diffusivity_m2_s: f64,
    /// Partition coefficient on the same basis as the lumped one (per particle
    /// envelope volume, Corrochano 2017).
    pub partition_coefficient: f64,
    /// Multiplier on the geometric surface-pool fraction (1 = same as lumped);
    /// the species' surface share of a class is min(1, scale · pool fraction).
    pub surface_fraction_scale: f64,
}

impl Default for SpeciesSpec {
    fn default() -> Self {
        Self {
            id: String::new(),
            mass_fraction: 0.0,
            kernel_diffusivity_m2_s: 1e-10,
            partition_coefficient: 0.61,
            surface_fraction_scale: 1.0,
        }
    }
}

/// Flow through the bed (PLAN §7.3, module H).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct HydraulicsSpec {
    /// Bare base permeability κ₀ of the wetted bed, m² (calibrated). The local
    /// permeability is κ₀ · column multiplier · KC(ε)/KC(ε₀) · f_poro(ΔP) ·
    /// swelling · gas, so κ₀ excludes compaction, viscosity and swelling
    /// (unlike back-calculated in-shot values).
    pub permeability_m2: f64,
    /// Poroelastic saturation pressure P_c, Pa; `None` disables compaction.
    /// The factor f = [1 − (1 − x)⁴]/(4x), x = ΔP_bed/P_c (1/(4x) for x ≥ 1),
    /// reproduces Q/Q_c = 1 − (1 − ΔP/P_c)⁴ (Waszkiewicz 2026).
    pub poroelastic_pc_pa: Option<f64>,
    /// Update permeability with local porosity as solubles dissolve
    /// (relative Kozeny–Carman, KC(ε) = ε³/(1 − ε)²).
    pub dissolution_kozeny_carman: bool,
    /// Swelling: permeability factor 1 − A·(1 − e^(−t/τ)), t since the cell
    /// wetted; A in [0, 1).
    pub swelling: Relaxation,
    /// Gas (CO₂): permeability factor 1 − A·e^(−t/τ), t since the cell
    /// wetted; A in [0, 1).
    pub gas: Relaxation,
    /// Initial pore-air connectivity penalty, independent of roast CO₂.
    /// Its permeability factor is (1 − A·exp(−wet_age/τ))^n, where n is
    /// `pore_air_permeability_exponent`. This effective hydraulic closure
    /// does not represent a literal gas volume or a fixed startup delay.
    pub pore_air: Relaxation,
    /// Exponent n of the pore-air permeability factor, 1–10. A value above
    /// 1 represents nonlinear recovery of liquid connectivity. Coffee's
    /// relative-permeability curve is not measured; this is an estimate.
    pub pore_air_permeability_exponent: f64,
    /// Fines migration: outlet resistance A·R_bed(0)·(1 − e^(−t/τ)), t since
    /// the column's first drops; R_bed(0) is the column's fully wetted
    /// resistance with water at the brew temperature.
    pub fines_layer: Relaxation,
    /// Axial dispersion coefficient, m²/s.
    pub axial_dispersion_m2_s: f64,
    /// Extract viscosity model.
    pub viscosity: Viscosity,
    /// Reference particle-loading normalization u_w, 0–0.9:
    /// ε_c = ε_p·(1 − u_w). Also selects the absorbed-water fraction when
    /// `intraparticle_water_fraction` is omitted. It is not mobile holdup.
    pub wetting_uptake: f64,
    /// Fraction of intraparticle porosity filled by the sharp front, 0–1.
    /// `None` selects `wetting_uptake`; `Some(1)` fills all initial pores.
    /// Its water contributes to hydraulic and thermal storage; its solute
    /// belongs to total particle loading. Newly filled water carries local
    /// mobile solute implicitly into the particle reservoirs. This is a
    /// sharp-front closure, not a measured finite-rate water-exchange law.
    pub intraparticle_water_fraction: Option<f64>,
    /// Share θ of the dissolved solid volume that becomes intergranular pore
    /// space, [0, 1]: ε = ε₀ + θ·EY_local·(1 − ε₀), never decreasing. `null`
    /// (the default, replacing the former proportional rule)
    /// means θ = 0: solubles leave from inside cells whose insoluble walls
    /// keep the particle envelope, so dissolution raises the intraparticle
    /// porosity, not ε. 1 is particles shrinking at constant envelope density
    /// (Lee 2023), the upper bound.
    pub dissolution_porosity_share: Option<f64>,
}

impl Default for HydraulicsSpec {
    fn default() -> Self {
        Self {
            // hydraulics.permeability.reference: bare κ₀ at the reference
            // Sauter diameter (ADR 0009); registry default, to be calibrated.
            permeability_m2: 2.4e-14,
            // hydraulics.poroelastic.critical_pressure.
            poroelastic_pc_pa: Some(1.2e6),
            dissolution_kozeny_carman: true,
            swelling: Relaxation {
                amplitude: 0.0,
                // hydraulics.swelling.relaxation_time (centre of 19–33 s).
                tau_s: 26.0,
            },
            gas: Relaxation {
                amplitude: 0.0,
                tau_s: 5.0,
            },
            pore_air: Relaxation::default(),
            pore_air_permeability_exponent: 1.0,
            fines_layer: Relaxation {
                amplitude: 0.0,
                tau_s: 10.0,
            },
            // extraction.dispersion.axial_coefficient.
            axial_dispersion_m2_s: 5e-6,
            viscosity: Viscosity::default(),
            wetting_uptake: 0.5,
            intraparticle_water_fraction: None,
            // hydraulics.dissolution_porosity_share (mode 0).
            dissolution_porosity_share: None,
        }
    }
}

/// Amplitude and time constant of an exponential relaxation.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields))]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Relaxation {
    /// Amplitude, 0 disables the effect.
    pub amplitude: f64,
    /// Time constant, s (≥ 0; 0 makes the change immediate).
    pub tau_s: f64,
}

/// Extract viscosity: μ = μ_water(T) · exp(a1·w + a2·w²)^γ, with w the solute
/// mass fraction and γ the temperature exponent. μ_water(T) is the
/// Kestin–Sokolov–Wakeham (1978) correlation.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct Viscosity {
    /// a1: Moreno 2015's coffee solutions at 4 °C give a1 ≈ 4.2, a2 ≈ 11.8.
    pub ln_relative_a1: f64,
    /// a2.
    pub ln_relative_a2: f64,
    /// Exponent γ ≤ 1 shrinking the relative viscosity at brewing temperature.
    pub temperature_exponent: f64,
}

impl Default for Viscosity {
    fn default() -> Self {
        Self {
            ln_relative_a1: 4.2,
            ln_relative_a2: 11.8,
            // Relative viscosity 2.24 at 25% w/w, the centre of
            // hydraulics.viscosity.extract_relative (1.5–3).
            temperature_exponent: 0.45,
        }
    }
}

/// Lumped thermal model (PLAN §7.3, module H): one node for bed, basket and
/// portafilter, (C + ρ_w c_w V_water) dT/dt = ρ_w c_w Q (T_water − T) − h (T − T_ambient).
/// Temperatures must lie in 0–150 °C, the range of the water correlations.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct ThermalSpec {
    /// Brew water temperature, °C.
    pub water_temp_c: f64,
    /// Initial temperature of bed and basket, °C.
    pub initial_bed_temp_c: f64,
    /// Lumped heat capacity of bed, basket and portafilter, J/K (the water
    /// held in the wetted bed is added by the solver).
    pub heat_capacity_j_k: f64,
    /// Heat loss to the surroundings, W/K.
    pub heat_loss_w_k: f64,
    /// Temperature of the surroundings, °C.
    pub ambient_temp_c: f64,
}

impl Default for ThermalSpec {
    fn default() -> Self {
        Self {
            // shot.temperature (centre of 88–96 °C).
            water_temp_c: 92.0,
            initial_bed_temp_c: 70.0,
            heat_capacity_j_k: 150.0,
            heat_loss_w_k: 0.5,
            ambient_temp_c: 25.0,
        }
    }
}

/// Machine program, pump and stop rule (PLAN §7.3, module M). The headspace
/// fills first (at zero pressure); then pressure and flow follow from the
/// program, the pump, the bed and optional charged upstream compliance.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct MachineSpec {
    /// Phases, run in order; the last runs until the stop rule fires (its
    /// exit conditions are ignored).
    pub phases: Vec<Phase>,
    /// Pump characteristics.
    pub pump: Pump,
    /// When the shot ends.
    pub stop: StopRule,
    /// Optional upstream hydraulic compliance, m³/Pa (0 = legacy algebraic
    /// hydraulics). Stores the pump-supplied carrier volume C·P and obeys
    /// C dP/dt = Q_pump − Q_bed after the sequential headspace fill.
    /// Pressure caps throttle delivery without venting or reverse flow;
    /// retained pressure can exceed a newly lowered command while draining.
    /// This experimental lumped closure does not model gas or gravity.
    pub hydraulic_compliance_m3_pa: f64,
}

impl Default for MachineSpec {
    fn default() -> Self {
        Self {
            phases: vec![Phase::default()],
            pump: Pump::default(),
            stop: StopRule::default(),
            hydraulic_compliance_m3_pa: 0.0,
        }
    }
}

/// One phase of the machine program.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct Phase {
    /// What the machine controls during the phase.
    pub control: Control,
    /// Linear ramp from the previous target, s: the target moves linearly
    /// from the value of the controlled quantity when the phase starts (0 for
    /// the first phase) to the phase target.
    pub ramp_s: f64,
    /// Flow limit (m³/s) under pressure control, or pressure limit (Pa) under
    /// flow control. Ignored for `PumpFull`.
    pub limit: Option<f64>,
    /// When the phase ends (first condition met). All `None` = never.
    pub exit: PhaseExit,
}

impl Default for Phase {
    fn default() -> Self {
        Self {
            control: Control::Pressure { target_pa: 9e5 },
            ramp_s: 2.0,
            limit: Some(8e-6),
            exit: PhaseExit::default(),
        }
    }
}

/// Controlled quantity in a phase.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(
    feature = "serde",
    serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)
)]
#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    /// Hold the inlet pressure, Pa. While the headspace fills (zero
    /// pressure) the pump delivers its flow limit if the target is above 0.
    Pressure { target_pa: f64 },
    /// Hold the pump flow, m³/s.
    Flow { target_m3_s: f64 },
    /// Run the pump at full power; pressure follows from the pump curve and
    /// the bed.
    PumpFull,
}

impl Default for Control {
    fn default() -> Self {
        Self::Pressure { target_pa: 9e5 }
    }
}

/// Phase exit conditions; the first one met ends the phase. Steps land on
/// time events and localize mass and pressure crossings before switching.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PhaseExit {
    /// Time since the phase started, s.
    pub time_s: Option<f64>,
    /// Beverage mass in the cup, kg.
    pub beverage_mass_kg: Option<f64>,
    /// Inlet pressure reached, Pa.
    pub pressure_pa: Option<f64>,
}

/// Pump characteristics.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(
    feature = "serde",
    serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)
)]
#[derive(Clone, Debug, PartialEq)]
pub enum Pump {
    /// Follows the program exactly within these limits (profiling machines).
    Ideal {
        max_flow_m3_s: f64,
        max_pressure_pa: f64,
    },
    /// Vibratory pump: Q = Q_free·(1 − P/P_stall), optionally capped by an
    /// over-pressure valve.
    Vibratory {
        free_flow_m3_s: f64,
        stall_pressure_pa: f64,
        opv_pa: Option<f64>,
    },
}

impl Default for Pump {
    fn default() -> Self {
        Self::Ideal {
            max_flow_m3_s: 8e-6,
            max_pressure_pa: 1.2e6,
        }
    }
}

/// When the shot ends. The first condition met stops the pump; the extract
/// then drips for a while (`drip_tau_s`): the inlet pressure decays as
/// P_stop·e^(−t/τ) and the simulation runs 8τ more, or until the water left
/// in the headspace has drained into the puck. Without a condition the shot
/// runs to `numerics.max_duration_s`.
/// With nonzero `machine.hydraulic_compliance_m3_pa`, pressure instead follows
/// the stored-volume balance during the same 8τ observation window. Only
/// charged storage supplies the bed; unpressurised headspace stays retained.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct StopRule {
    /// Shot time, s.
    pub time_s: Option<f64>,
    /// Beverage mass on the scale, kg.
    pub beverage_mass_kg: Option<f64>,
    /// Time constant of the legacy post-stop drip, s (0 = none, at most 60).
    /// With nonzero hydraulic compliance, 8τ is only the tail observation
    /// horizon: pressure follows the compliance/bed balance, and only charged
    /// storage drains. Unpressurised headspace water remains retained.
    pub drip_tau_s: f64,
    /// The machine vents the headspace and any charged compliance at the stop
    /// (a three-way solenoid valve): their water leaves through the valve,
    /// none reaches the puck, and there is no drip.
    pub vent_headspace: bool,
}

impl Default for StopRule {
    fn default() -> Self {
        Self {
            time_s: None,
            beverage_mass_kg: Some(0.036),
            drip_tau_s: 1.0,
            vent_headspace: false,
        }
    }
}

/// Numerical settings (PLAN §7.2 fidelity tiers).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(deny_unknown_fields, default))]
#[derive(Clone, Debug, PartialEq)]
pub struct NumericsSpec {
    /// 0 = reduced preview model (3 permeability strata plus the edge
    /// annulus, 8 depth cells, 2 size classes, two-shell coarse kernels),
    /// 1 = standard model.
    pub tier: u8,
    /// Depth cells per column (tier 1), 2–1000.
    pub depth_cells: usize,
    /// Largest time step, s (at most 0.5). Steps also land on every output
    /// time, so the step is at most `output_interval_s`.
    pub max_dt_s: f64,
    /// Hard stop, s: the pump stops here if the stop rule has not fired.
    pub max_duration_s: f64,
    /// Spacing of the output time series, s.
    pub output_interval_s: f64,
    /// Number of spatial snapshots, evenly spread over the shot.
    pub snapshot_count: usize,
    /// Radial shells per intact kernel in tier 1 (equal-volume grid, 2–64).
    /// Tier 0 uses two for coarse classes and one (the linear driving force)
    /// for fines.
    pub kernel_shells: usize,
}

impl Default for NumericsSpec {
    fn default() -> Self {
        Self {
            tier: 1,
            depth_cells: 30,
            max_dt_s: 0.05,
            max_duration_s: 120.0,
            output_interval_s: 0.1,
            snapshot_count: 12,
            kernel_shells: 8,
        }
    }
}
