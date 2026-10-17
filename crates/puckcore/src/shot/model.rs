// SPDX-License-Identifier: GPL-2.0-or-later
//! The discretised shot model built from a validated [`ShotSpec`]: geometry,
//! columns, depth cells, size classes, kernel grids and species. Tier 0
//! coarsens the same physics here (3 permeability strata plus the edge
//! annulus, 8 cells, 2 classes, a two-shell kernel for the coarse class and
//! the linear driving force for fines); the solver itself is shared.

use super::geometry::{self, Cell, Profile};
use super::props::{self, Liquid, Poroelastic};
use super::*;
use crate::kernel::sphere::Grid;
use crate::kernel::sphere::shells::Shells;
use crate::linalg::TridiagonalLu;
use crate::math::{self, fmax, fmin};

/// Depth cells of tier 0.
const TIER0_CELLS: usize = 8;
/// Inner permeability strata of tier 0 (when the spread is not zero).
const TIER0_STRATA: usize = 3;
/// Kernel shells of tier 0's coarse class.
const TIER0_COARSE_SHELLS: usize = 2;
/// Particles below this diameter are fines (tier 0 split), m.
const FINES_DIAMETER_M: f64 = 100e-6;

/// Finite-volume grid of a unit sphere (volumes and conductances divided by
/// 4π, as in `kernel::sphere::shells`). One shell is the linear driving
/// force: G = 2·1³/(1 − 3/5) = 5, i.e. dū/dτ = 15 (c/K − ū) (Glueckauf 1955),
/// the N = 1 case of the parabola-exact conductances.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct KernelGrid {
    pub volume: Vec<f64>,
    pub conductance: Vec<f64>,
    pub surface: f64,
}

impl KernelGrid {
    pub fn new(n: usize) -> Self {
        if n == 1 {
            Self {
                volume: vec![1.0 / 3.0],
                conductance: Vec::new(),
                surface: 5.0,
            }
        } else {
            let s = Shells::new(Grid::EqualVolume, n);
            Self {
                volume: s.volume,
                conductance: s.conductance,
                surface: s.surface_conductance,
            }
        }
    }

    pub fn len(&self) -> usize {
        self.volume.len()
    }

    /// Factorises `mass·V + stiffness·K` into `lu` (no allocation once
    /// sized), using `lower` and `diag` as scratch. The matrix is a strictly
    /// diagonally dominant M-matrix, so a failure (non-finite entries) is a
    /// numerical error.
    pub fn factor_into(
        &self,
        mass: f64,
        stiffness: f64,
        lu: &mut TridiagonalLu,
        lower: &mut Vec<f64>,
        diag: &mut Vec<f64>,
    ) -> Result<(), ShotError> {
        let n = self.len();
        lower.clear();
        lower.extend(self.conductance.iter().map(|g| -stiffness * g));
        diag.clear();
        diag.extend((0..n).map(|j| {
            let inner = if j > 0 { self.conductance[j - 1] } else { 0.0 };
            let outer = if j + 1 < n {
                self.conductance[j]
            } else {
                self.surface
            };
            mass * self.volume[j] + stiffness * (inner + outer)
        }));
        lu.refactor(lower, diag, lower)
            .map_err(|e| ShotError::Numerical {
                reason: format!("kernel matrix: {e}"),
            })?;
        if lu.pivots_positive() {
            Ok(())
        } else {
            Err(ShotError::Numerical {
                reason: "kernel matrix lost its M-matrix structure".to_string(),
            })
        }
    }
}

/// One parallel column: a radial annulus of the basket.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ColumnModel {
    /// Share of the cross-section (constant with depth).
    pub share: f64,
    /// Permeability multiplier.
    pub multiplier: f64,
    /// Annulus radii at the floor, m.
    pub inner_radius: f64,
    pub outer_radius: f64,
    /// Bed volume of the column, m³.
    pub volume: f64,
    /// Column volume above each cell (n_cells + 1 values), m³.
    pub cum_volume: Vec<f64>,
    /// Fully wetted resistance with water at the brew temperature and the
    /// initial porosity, Pa s/m³ (scales the fines layer).
    pub r0: f64,
}

/// One particle size class.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClassModel {
    /// Particle radius a, m.
    pub radius: f64,
    /// Share of the solid volume.
    pub fraction: f64,
    /// Particle (envelope) volume per bed volume, (1 − ε₀)·fraction.
    pub phi: f64,
    /// Broken-cell (surface pool) volume share of a particle.
    pub pool_fraction: f64,
    /// Kernel radius a − δ, m (0 without a kernel).
    pub kernel_radius: f64,
    /// Kernel grid (`None` without a kernel).
    pub grid: Option<KernelGrid>,
    /// Offset of this class's shells in a cell's kernel block.
    pub offset: usize,
    /// Kernel mass per bed volume per unit Σ Ṽ u: 3 φ ε_p (a_k/a)³, m³/m³.
    pub sigma: f64,
    /// Pore volume of the surface pool per bed volume, ε_p · pool fraction · φ.
    pub pool_pore: f64,
    /// k_s · b: surface rate times outer surface per bed volume, 1/s.
    pub kb: f64,
}

impl ClassModel {
    pub fn shells(&self) -> usize {
        self.grid.as_ref().map_or(0, KernelGrid::len)
    }

    pub fn has_pool(&self) -> bool {
        self.pool_pore > 0.0
    }
}

/// A tracked species: its id, extractable mass fraction and transport group.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SpeciesModel {
    pub id: String,
    pub mass_fraction: f64,
    /// Index into [`Model::groups`].
    pub group: usize,
}

/// Species with identical transport parameters (diffusivity, partition
/// coefficient, surface share) form one group. Species are linear
/// passengers, so a group is solved once for a unit mass fraction and each
/// member is that solution scaled by its own mass fraction (exact up to
/// round-off).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SpeciesGroup {
    pub diffusivity_ref: f64,
    /// K·ε_c: liquid concentration / concentration-equivalent total loading.
    pub kernel_partition: f64,
    /// Surface-pool mass per bed volume for a unit mass fraction, by class, kg/m³.
    pub pool0: Vec<f64>,
    /// Initial concentration-equivalent kernel loading for a unit mass fraction, by class, kg/m³.
    pub kernel0: Vec<f64>,
}

/// The discretised model.
#[derive(Clone, Debug)]
pub(crate) struct Model {
    pub tier: u8,
    pub profile: Profile,
    pub bed_height: f64,
    pub bed_volume: f64,
    pub headspace_volume: f64,
    pub cells: Vec<Cell>,
    pub columns: Vec<ColumnModel>,
    pub classes: Vec<ClassModel>,
    pub species: Vec<SpeciesModel>,
    pub groups: Vec<SpeciesGroup>,
    /// Kernel shells per cell (all classes).
    pub shells_per_cell: usize,
    pub eps0: f64,
    /// Filled water porosity φ_T = ε₀ + (1 − ε₀) ε_p · water fraction.
    pub phi_t: f64,
    /// Absorbed water per bed volume, φ_T − ε₀. Its solute is included in
    /// total particle loading, separately from mobile intergranular liquid.
    pub imbibed: f64,
    /// Lumped solubles per particle volume, kg/m³ (E_max ρ_s (1 − ε_p)).
    pub s0: f64,
    /// Dry solid mass per bed volume, kg/m³.
    pub dry_density: f64,
    pub liquid: Liquid,
    pub poro: Poroelastic,
    /// Outlet resistance ΔP = a Q² (holes and pressurised orifice), Pa s²/m⁶.
    pub outlet_coefficient: f64,
    /// Water density at the brew temperature, kg/m³.
    pub rho_water: f64,
    pub saturation: f64,
    /// K·ε_c: liquid concentration / concentration-equivalent total loading;
    /// K is per particle envelope volume, ε_c is a reference normalization.
    pub kernel_partition: f64,
    /// Initial concentration-equivalent kernel loading of the lumped solubles, s₀/ε_c.
    pub u0: f64,
    /// Whether excess boundary loading is capped, admitting aqueous solute.
    pub loading_cap: bool,
    /// Absorbed water per particle envelope volume / loading normalization.
    pub loading_water_ratio: f64,
    pub diffusivity_ref: f64,
    pub reference_temp: f64,
    /// Share θ of dissolved solid volume that becomes intergranular pore space.
    pub porosity_share: f64,
}

impl Model {
    pub fn new(spec: &ShotSpec, warnings: &mut Vec<String>) -> Self {
        let bed = &spec.bed;
        let tier = spec.numerics.tier;
        let profile = Profile::new(&spec.basket.profile_m);
        let eps0 = bed.intergranular_porosity;
        let eps_p = bed.intraparticle_porosity;
        let bed_volume = bed.dose_kg / ((1.0 - eps0) * (1.0 - eps_p) * bed.skeletal_density_kg_m3);
        let bed_height = profile.height_for_volume(bed_volume);
        let basket_volume = profile.total_volume();
        let headspace_volume = fmax(basket_volume - profile.volume(0.0, bed_height), 0.0)
            + spec.basket.extra_headspace_m3;
        if basket_volume - bed_volume < 1e-3 * bed_volume && spec.basket.extra_headspace_m3 == 0.0 {
            warnings.push("the bed fills the basket: no headspace".to_string());
        }
        let n_cells = if tier == 0 {
            TIER0_CELLS
        } else {
            spec.numerics.depth_cells
        };
        let cells = geometry::cells(&profile, bed_height, n_cells);

        let rho_water = props::water_density_kg_m3(spec.thermal.water_temp_c);
        let s = &spec.solubles;
        let v = &spec.hydraulics.viscosity;
        let liquid = Liquid {
            rho_water,
            specific_volume: s.solute_specific_volume_m3_kg,
            a1: v.ln_relative_a1,
            a2: v.ln_relative_a2,
            gamma: v.temperature_exponent,
        };
        let poro = Poroelastic {
            pc: spec.hydraulics.poroelastic_pc_pa,
        };

        let mu_water = props::water_viscosity_pa_s(spec.thermal.water_temp_c);
        let columns = columns(
            spec,
            tier,
            &profile,
            &cells,
            bed_volume,
            spec.hydraulics.permeability_m2,
            mu_water,
        );
        // A spread needs at least two inner strata to be represented.
        let het = &bed.heterogeneity;
        let sigma = effective_sigma(het);
        let inner = if columns.len() > 1 && het.edge_area_fraction > 0.0 {
            columns.len() - 1
        } else {
            columns.len()
        };
        if sigma > 0.0 && inner < 2 {
            warnings.push(format!(
                "the permeability spread (σ = {sigma:.3}) is not represented with {} column(s): \
                 it needs at least two inner columns (bed.heterogeneity.columns ≥ 3 with an edge)",
                columns.len()
            ));
        }

        let (mut classes, shells_per_cell) = classes(spec, tier);
        let s0 = s.extractable_fraction * bed.skeletal_density_kg_m3 * (1.0 - eps_p);
        // Reference capacity of the pools/kernels. In the startup closure
        // these represent total particle solute, including pore solution.
        // The mobile liquid therefore uses only intergranular water.
        let eps_c = eps_p * (1.0 - spec.hydraulics.wetting_uptake);
        let water_fraction = spec
            .hydraulics
            .intraparticle_water_fraction
            .unwrap_or(spec.hydraulics.wetting_uptake);
        for c in &mut classes {
            c.phi = (1.0 - eps0) * c.fraction;
            c.pool_pore = eps_c * c.pool_fraction * c.phi;
            c.kb = s.surface_rate_m_s * 3.0 * c.phi / c.radius;
            let ratio = c.kernel_radius / c.radius;
            c.sigma = 3.0 * c.phi * eps_c * ratio * ratio * ratio;
        }
        // Species groups (identical transport parameters), each for a unit
        // mass fraction.
        let mut groups: Vec<(u64, u64, u64, SpeciesGroup)> = Vec::new();
        let mut species = Vec::with_capacity(s.species.len());
        for sp in &s.species {
            let key = (
                sp.kernel_diffusivity_m2_s.to_bits(),
                sp.partition_coefficient.to_bits(),
                sp.surface_fraction_scale.to_bits(),
            );
            let group = match groups.iter().position(|g| (g.0, g.1, g.2) == key) {
                Some(i) => i,
                None => {
                    let s0_s = bed.skeletal_density_kg_m3 * (1.0 - eps_p);
                    let mut pool0 = Vec::with_capacity(classes.len());
                    let mut kernel0 = Vec::with_capacity(classes.len());
                    for c in &classes {
                        // Surface share: all of it without a kernel, none
                        // without a pool, else min(1, scale · pool fraction).
                        let share = if c.grid.is_none() {
                            1.0
                        } else {
                            fmin(1.0, sp.surface_fraction_scale * c.pool_fraction)
                        };
                        pool0.push(s0_s * share * c.phi);
                        kernel0.push(if c.grid.is_some() {
                            s0_s * (1.0 - share) / (eps_c * (1.0 - c.pool_fraction))
                        } else {
                            0.0
                        });
                    }
                    groups.push((
                        key.0,
                        key.1,
                        key.2,
                        SpeciesGroup {
                            diffusivity_ref: sp.kernel_diffusivity_m2_s,
                            kernel_partition: sp.partition_coefficient * eps_c,
                            pool0,
                            kernel0,
                        },
                    ));
                    groups.len() - 1
                }
            };
            species.push(SpeciesModel {
                id: sp.id.clone(),
                mass_fraction: sp.mass_fraction,
                group,
            });
        }
        let groups: Vec<SpeciesGroup> = groups.into_iter().map(|g| g.3).collect();

        let outlet_coefficient = outlet_coefficient(&spec.basket, rho_water);
        Self {
            tier,
            profile,
            bed_height,
            bed_volume,
            headspace_volume,
            cells,
            columns,
            classes,
            species,
            groups,
            shells_per_cell,
            eps0,
            phi_t: eps0 + (1.0 - eps0) * eps_p * water_fraction,
            imbibed: (1.0 - eps0) * eps_p * water_fraction,
            s0,
            dry_density: bed.skeletal_density_kg_m3 * (1.0 - eps_p) * (1.0 - eps0),
            liquid,
            poro,
            outlet_coefficient,
            rho_water,
            saturation: s.saturation_kg_m3,
            kernel_partition: s.partition_coefficient * eps_c,
            u0: s0 / eps_c,
            loading_cap: s.kernel_loading_cap,
            loading_water_ratio: eps_p * water_fraction / eps_c,
            diffusivity_ref: s.kernel_diffusivity_m2_s,
            reference_temp: s.reference_temp_c,
            // null means θ = 0 (shot-model.md §5.5).
            porosity_share: spec.hydraulics.dissolution_porosity_share.unwrap_or(0.0),
        }
    }

    pub fn n_cells(&self) -> usize {
        self.cells.len()
    }

    pub fn n_classes(&self) -> usize {
        self.classes.len()
    }
}

/// a in ΔP = a Q² for the outlet: the floor's holes (if the open fraction is
/// below 1) plus a pressurised orifice, each ρ/(2 C_d² A²).
fn outlet_coefficient(b: &BasketGeometry, rho: f64) -> f64 {
    let orifice = |area: f64, cd: f64| rho / (2.0 * cd * cd * area * area);
    let mut a = 0.0;
    if b.open_area_fraction < 1.0 {
        let area = b.open_area_fraction
            * std::f64::consts::PI
            * b.perforated_radius_m
            * b.perforated_radius_m;
        a += orifice(area, props::HOLE_DISCHARGE_COEFFICIENT);
    }
    if let Outlet::Pressurised {
        orifice_diameter_m,
        discharge_coefficient,
    } = b.outlet
    {
        let area = 0.25 * std::f64::consts::PI * orifice_diameter_m * orifice_diameter_m;
        a += orifice(area, discharge_coefficient);
    }
    a
}

/// Column shares, multipliers and radii.
fn columns(
    spec: &ShotSpec,
    tier: u8,
    profile: &Profile,
    cells: &[Cell],
    bed_volume: f64,
    kappa0: f64,
    mu_water: f64,
) -> Vec<ColumnModel> {
    let het = &spec.bed.heterogeneity;
    let edge = het.edge_area_fraction;
    let sigma = effective_sigma(het);
    // Tier 0: three strata (or one for a uniform bed) plus the edge annulus.
    let n = if tier == 0 {
        let inner = if sigma > 0.0 { TIER0_STRATA } else { 1 };
        inner + usize::from(edge > 0.0)
    } else {
        het.columns
    };
    // (share, multiplier) from the centre outward.
    let mut layout: Vec<(f64, f64)> = Vec::with_capacity(n);
    if n == 1 {
        layout.push((1.0, (1.0 - edge) + edge * het.edge_multiplier));
    } else {
        let has_edge = edge > 0.0;
        let n_inner = if has_edge { n - 1 } else { n };
        let inner_share = if has_edge { 1.0 - edge } else { 1.0 };
        let strata = stratified_multipliers(n_inner, sigma);
        for m in strata {
            layout.push((inner_share / n_inner as f64, m));
        }
        if has_edge {
            layout.push((edge, het.edge_multiplier));
        }
    }
    let floor = profile.floor_radius();
    let total_inverse_area: f64 = cells.iter().map(|c| c.inverse_area).sum();
    let mut cum_share: f64 = 0.0;
    layout
        .iter()
        .enumerate()
        .map(|(i, &(share, multiplier))| {
            let inner = floor * cum_share.sqrt();
            cum_share = if i + 1 == layout.len() {
                1.0
            } else {
                cum_share + share
            };
            let outer = floor * fmin(cum_share, 1.0).sqrt();
            let mut cum_volume = Vec::with_capacity(cells.len() + 1);
            let mut acc = 0.0;
            cum_volume.push(0.0);
            for c in cells {
                acc += share * c.volume;
                cum_volume.push(acc);
            }
            ColumnModel {
                share,
                multiplier,
                inner_radius: inner,
                outer_radius: outer,
                volume: share * bed_volume,
                cum_volume,
                r0: mu_water * total_inverse_area / (share * kappa0 * multiplier),
            }
        })
        .collect()
}

/// The spread of ln κ over the inner columns, σ′ = √(σ² + σ_pw²).
pub(crate) fn effective_sigma(het: &Heterogeneity) -> f64 {
    (het.sigma_ln_permeability * het.sigma_ln_permeability
        + het.prewet_nonuniformity * het.prewet_nonuniformity)
        .sqrt()
}

/// Stratified log-normal multipliers of unit mean: equal-probability strata
/// [z_k, z_{k+1}] with z_k = Φ⁻¹(k/n), each represented by its conditional
/// mean of the unit-mean multiplier e^{σZ − σ²/2},
/// m_k = n·[Φ(z_{k+1} − σ) − Φ(z_k − σ)].
/// The means telescope to exactly 1, and the strata keep the distribution's
/// tails, unlike midpoint quantiles. They are laid out from the centre
/// outward in golden-ratio order so that permeability carries no radial
/// trend.
pub(crate) fn stratified_multipliers(n: usize, sigma: f64) -> Vec<f64> {
    if n == 1 || sigma == 0.0 {
        return vec![1.0; n];
    }
    let nf = n as f64;
    let cdf: Vec<f64> = (0..=n)
        .map(|k| {
            if k == 0 {
                0.0
            } else if k == n {
                1.0
            } else {
                props::normal_cdf(props::normal_quantile(k as f64 / nf) - sigma)
            }
        })
        .collect();
    let raw: Vec<f64> = (0..n)
        .map(|k| fmax(nf * (cdf[k + 1] - cdf[k]), 1e-12))
        .collect();
    let mean = raw.iter().sum::<f64>() / nf;
    // Annulus a takes the stratum ranked by frac((a + 1)·φ⁻¹).
    const INV_GOLDEN: f64 = 0.618_033_988_749_894_8;
    let key = |a: usize| {
        let x = (a as f64 + 1.0) * INV_GOLDEN;
        x - x.floor()
    };
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| key(a).partial_cmp(&key(b)).expect("finite keys"));
    // order[r] = annulus with rank r.
    let mut out = vec![0.0; n];
    for (rank, &annulus) in order.iter().enumerate() {
        out[annulus] = raw[rank] / mean;
    }
    out
}

/// Size classes: as specified (tier 1) or merged into fines and coarse
/// (tier 0). Returns the classes and the kernel shells per cell.
fn classes(spec: &ShotSpec, tier: u8) -> (Vec<ClassModel>, usize) {
    let delta = spec.solubles.cell_size_m;
    let total: f64 = spec
        .bed
        .size_classes
        .iter()
        .map(|c| c.volume_fraction)
        .sum();
    let pool_fraction = |a: f64| {
        if a <= delta {
            1.0
        } else {
            let r = (a - delta) / a;
            1.0 - r * r * r
        }
    };
    // (radius, fraction, pool fraction, kernel radius, shells)
    let mut raw: Vec<(f64, f64, f64, f64, usize)> = Vec::new();
    if tier == 0 {
        // Two classes: Sauter-mean radius Σx/Σ(x/r) of each group; the pool
        // share is the volume-weighted mean of the members' (so the pool
        // inventory is kept) and the kernel radius follows from it.
        for fines in [true, false] {
            let members: Vec<&SizeClass> = spec
                .bed
                .size_classes
                .iter()
                .filter(|c| {
                    (2.0 * c.radius_m < FINES_DIAMETER_M) == fines && c.volume_fraction > 0.0
                })
                .collect();
            let x: f64 = members.iter().map(|c| c.volume_fraction).sum();
            if members.is_empty() || x <= 0.0 {
                continue;
            }
            let inv: f64 = members.iter().map(|c| c.volume_fraction / c.radius_m).sum();
            let radius = x / inv;
            let pool: f64 = members
                .iter()
                .map(|c| c.volume_fraction * pool_fraction(c.radius_m))
                .sum::<f64>()
                / x;
            let pool = fmin(pool, 1.0);
            let kernel = if pool < 1.0 {
                radius * math::cbrt(1.0 - pool)
            } else {
                0.0
            };
            let shells = if fines { 1 } else { TIER0_COARSE_SHELLS };
            raw.push((radius, x / total, pool, kernel, shells));
        }
    } else {
        for c in &spec.bed.size_classes {
            let pool = pool_fraction(c.radius_m);
            let kernel = if pool < 1.0 { c.radius_m - delta } else { 0.0 };
            raw.push((
                c.radius_m,
                c.volume_fraction / total,
                pool,
                kernel,
                spec.numerics.kernel_shells,
            ));
        }
    }
    let mut offset = 0;
    let classes = raw
        .into_iter()
        .map(|(radius, fraction, pool_fraction, kernel_radius, shells)| {
            let grid = (kernel_radius > 0.0).then(|| KernelGrid::new(shells));
            let this = offset;
            offset += grid.as_ref().map_or(0, KernelGrid::len);
            ClassModel {
                radius,
                fraction,
                phi: 0.0,
                pool_fraction,
                kernel_radius,
                grid,
                offset: this,
                sigma: 0.0,
                pool_pore: 0.0,
                kb: 0.0,
            }
        })
        .collect();
    (classes, offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ldf_grid_is_glueckauf() {
        let g = KernelGrid::new(1);
        // dū/dτ = G (c − ū)/V = 15 (c − ū).
        assert_eq!(g.surface / g.volume[0], 15.0);
        let g8 = KernelGrid::new(8);
        assert_eq!(g8.len(), 8);
        assert!((g8.volume.iter().sum::<f64>() - 1.0 / 3.0).abs() < 1e-15);
    }

    #[test]
    fn strata_have_unit_mean_and_no_radial_trend() {
        for n in [2, 3, 7, 12, 63] {
            let m = stratified_multipliers(n, 0.4);
            let mean = m.iter().sum::<f64>() / n as f64;
            assert!((mean - 1.0).abs() < 1e-14, "{n}: {mean}");
            // Conditional means of the unit-mean log-normal: their spread
            // approaches the distribution's, e^{σ²} − 1, from below.
            let var = m.iter().map(|x| (x - 1.0) * (x - 1.0)).sum::<f64>() / n as f64;
            let full = (0.4_f64 * 0.4).exp() - 1.0;
            assert!(var < full && var > 0.3 * full, "{n}: {var} vs {full}");
            let mut sorted = m.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            // Every stratum appears exactly once.
            for w in sorted.windows(2) {
                assert!(w[1] > w[0]);
            }
        }
        let m = stratified_multipliers(7, 0.4);
        assert!(m.windows(2).any(|w| w[1] < w[0]) && m.windows(2).any(|w| w[1] > w[0]));
        assert_eq!(stratified_multipliers(5, 0.0), vec![1.0; 5]);
    }

    #[test]
    fn default_model_is_consistent() {
        let spec = ShotSpec::default();
        let mut w = Vec::new();
        let m = Model::new(&spec, &mut w);
        // Bed height from the dose (about 14 mm for 18 g in a 58 mm basket).
        assert!((m.bed_height - 0.0138).abs() < 5e-4, "{}", m.bed_height);
        let shares: f64 = m.columns.iter().map(|c| c.share).sum();
        assert!((shares - 1.0).abs() < 1e-15);
        assert_eq!(m.columns.len(), 8);
        assert!((m.columns[7].share - 0.25).abs() < 1e-15);
        let inner_mean: f64 = m.columns[..7].iter().map(|c| c.multiplier).sum::<f64>() / 7.0;
        assert!((inner_mean - 1.0).abs() < 1e-14);
        // The solubles add up to E_max · dose.
        let solubles: f64 = m.classes.iter().map(|c| c.phi).sum::<f64>() * m.s0 * m.bed_volume;
        let want = spec.solubles.extractable_fraction * spec.bed.dose_kg;
        assert!((solubles / want - 1.0).abs() < 1e-14);
        // Fines (20 µm) are all surface; boulders (175 µm) have a kernel.
        assert_eq!(m.classes[0].pool_fraction, 1.0);
        assert!(m.classes[0].grid.is_none());
        assert!((m.classes[1].kernel_radius - 145e-6).abs() < 1e-18);
        assert_eq!(m.shells_per_cell, 8);
    }

    #[test]
    fn tier0_merges_into_two_sauter_classes() {
        let mut spec = ShotSpec::default();
        spec.numerics.tier = 0;
        spec.bed.size_classes = vec![
            SizeClass {
                radius_m: 10e-6,
                volume_fraction: 0.1,
            },
            SizeClass {
                radius_m: 30e-6,
                volume_fraction: 0.1,
            },
            SizeClass {
                radius_m: 150e-6,
                volume_fraction: 0.4,
            },
            SizeClass {
                radius_m: 300e-6,
                volume_fraction: 0.4,
            },
        ];
        let m = Model::new(&spec, &mut Vec::new());
        assert_eq!(m.classes.len(), 2);
        // Three strata plus the edge annulus.
        assert_eq!(m.columns.len(), 4);
        assert_eq!(m.cells.len(), 8);
        assert!((m.classes[0].radius - 0.2 / (0.1 / 10e-6 + 0.1 / 30e-6)).abs() < 1e-18);
        assert!((m.classes[1].radius - 0.8 / (0.4 / 150e-6 + 0.4 / 300e-6)).abs() < 1e-16);
        assert_eq!(m.classes[1].shells(), 2);
        // A uniform bed without an edge needs one column.
        spec.bed.heterogeneity.sigma_ln_permeability = 0.0;
        spec.bed.heterogeneity.edge_area_fraction = 0.0;
        assert_eq!(Model::new(&spec, &mut Vec::new()).columns.len(), 1);
    }

    #[test]
    fn species_with_equal_parameters_share_a_group() {
        let mut spec = ShotSpec::default();
        let sp = |id: &str, w: f64, d: f64| SpeciesSpec {
            id: id.into(),
            mass_fraction: w,
            kernel_diffusivity_m2_s: d,
            ..SpeciesSpec::default()
        };
        spec.solubles.species = vec![
            sp("a", 0.01, 1e-10),
            sp("b", 0.02, 2e-10),
            sp("c", 0.03, 1e-10),
        ];
        let m = Model::new(&spec, &mut Vec::new());
        assert_eq!(m.groups.len(), 2);
        assert_eq!(
            (m.species[0].group, m.species[1].group, m.species[2].group),
            (0, 1, 0)
        );
        // K·ε_p·(1 − u_w), with the default uptake 0.5.
        assert!((m.groups[0].kernel_partition - 0.61 * 0.56 * 0.5).abs() < 1e-15);
    }
}
