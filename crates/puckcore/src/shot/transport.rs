// SPDX-License-Identifier: GPL-2.0-or-later
//! One implicit time step of extraction and transport: the bed liquid
//! (finite volumes in depth, exponentially fitted advection–dispersion
//! fluxes), the surface pools (saturating flux) and the kernels (spherical
//! shells), all coupled implicitly.
//!
//! **Inventories.** Mobile solute occupies only intergranular water, εwV.
//! Particle states hold total solute, including their absorbed pore solution,
//! on the envelope-volume basis used to measure K. Newly filled particle
//! water b carries b·c′ from the mobile liquid into each local reservoir.
//! This source is condensed implicitly with diffusion and dissolution, so
//! every transferred gram is debited from one inventory and credited to the
//! other. The hydraulic front and thermal capacity still include all water.
//!
//! **Condensation.** A kernel's wetted population starts from
//! [u − (1−w)u₀]/w; its dry remainder stays at u₀. During filling we use
//! backward Euler, u′_wet = u_hom + u_s w_boundary + b·c′/C_wet z,
//! where z = (V + hK)⁻¹V1 is nonnegative (algebraically 1−w_boundary).
//! The exact mass change supplies the liquid's source. The optional boundary
//! cap is u_s = min(c′/(Kε_c), u₀ + βc′/ε_c), β the absorbed water per
//! particle volume. It restricts excess loading while admitting carried
//! aqueous solute. Recipe builds use the uncapped partition relation.
//! Surface pools use a saturating exchange flux and a deposition ceiling
//! equal to initial content plus cumulative front-carried solute. Every
//! source response adds a nonnegative liquid diagonal, preserving the
//! tridiagonal M-matrix structure in each policy regime.
//!
//! **Regimes.** The saturating flux makes a pool's loss concave in c′ (the
//! smaller of two lines); the caps make the losses convex (the larger of a
//! line and a constant). The system is solved by nested policy iteration
//! (Hoffman & Karp 1966, with Howard's algorithm inside; Bokanowski, Maroso &
//! Zidani 2009): with the caps fixed, pick a regime per pool, solve, re-pick
//! from the solution until no regime changes (these iterates decrease
//! monotonically); then re-pick the caps from that solution and repeat (these
//! iterates increase monotonically, bounded by the solution). Both loops
//! terminate; one to three solves per step are typical. A choice is kept
//! while its candidates differ by less than 1e-10 of the pool's (or the
//! kernel's) content, or by less than the round-off of evaluating them:
//! without the band round-off can flip it by one ulp forever, and a band on
//! c′ alone would let a stiff pool (large k·Δt/V_p) end negative.
//!
//! **Conservation.** The liquid receives exactly what the pools and kernels
//! lose (the same linear functions of c′ in the final regimes), its interior
//! face fluxes cancel, the inlet carries no solute (Danckwerts, fresh water),
//! and the outlet flux goes to the cup. The soluble mass of particles +
//! liquid + cup is therefore conserved to round-off, for every scheme.
//!
//! **Positivity.** In the final regimes every right-hand-side term is
//! non-negative at c′ = 0 (liquid mass, pool intercepts, kernel loss α), so
//! c′ ≥ 0 (an M-matrix has a non-negative inverse), and u′ = u_hom + u_s w ≥ 0.
//! Backward Euler gives α = Δτ G u_hom,N ≥ 0 and u_hom ≥ 0; a BDF2 step whose
//! right-hand side or α would turn negative falls back to backward Euler.
//!
//! **Time schemes.** The liquid and the pools use backward Euler. Each kernel
//! class uses BDF2 (variable step) when Δτ = D Δt/a_k² ≤ 0.04 and backward
//! Euler above, as ADR 0005 recommends; a cell's first wet step uses backward
//! Euler, as do the fallbacks above. The liquid source is always the
//! kernel's exact mass change.
//!
//! **Layout and cost.** Kernel shells are stored shell-major,
//! `(offset_k + l) · n_cells_total + column · n_cells + j`, so one shell of
//! one class is contiguous across every cell of the bed. All cells of a class
//! share the kernel matrix, so a step runs in three phases: the homogeneous
//! kernel solves of the whole bed in lockstep
//! ([`TridiagonalLu::solve_many_in_place`]: vectorisable, and bit-identical
//! to solving them one at a time), the bed-liquid solve of each column, and
//! the kernel update of the whole bed. The homogeneous solution is written
//! over the previous time level in place, and the state buffers are swapped
//! once per step.
//!
//! **Species** are linear passengers: the same flows, holdup and
//! temperature, their own kernel diffusivity and partition coefficient, and
//! surface pools that dissolve congruently with the lumped pool of the same
//! cell and class (each species leaves the pool in proportion to its share of
//! the pool's mass; when the lumped flux reverses, solute returns in
//! proportion to the liquid's composition). Backward Euler keeps the pool
//! composition exactly unchanged during dissolution. Species with identical
//! transport parameters form a group, solved once for a unit mass fraction
//! (the loading cap scales with the content, so the scaling is exact).

use super::ShotError;
use super::model::{ClassModel, KernelGrid, Model};
use super::props;
use super::sim::State;
use crate::linalg::TridiagonalLu;
use crate::math::{fmax, fmin};

/// Kernel steps switch from BDF2 to backward Euler above this Δτ (ADR 0005).
const BDF2_MAX_DTAU: f64 = 0.04;
/// BDF2 needs the step ratio below 1 + √2 for zero-stability; we stay at 2.
const BDF2_MAX_RATIO: f64 = 2.0;
/// Base of the most column solves per step (all policy iterations); the
/// limit grows with the column's cells and classes (`solve_cap`).
const MAX_POLICY_SOLVES: usize = 100;
/// Relative width of the band inside which a regime or cap choice is kept
/// (far above round-off, far below anything physical).
const SWITCH_BAND: f64 = 1e-10;
/// Floor of a pool's band relative to its line terms k·Δt·c_sat: a few
/// times the round-off of evaluating them.
const ROUNDOFF_BAND: f64 = 16.0 * f64::EPSILON;

fn numerical(reason: impl Into<String>) -> ShotError {
    ShotError::Numerical {
        reason: reason.into(),
    }
}

/// One class's kernel matrices for this step (shared by all its cells).
#[derive(Clone, Debug)]
pub(crate) struct KernelStep {
    pub use_bdf: bool,
    pub lu_be: TridiagonalLu,
    pub w_be: Vec<f64>,
    /// Σ Ṽ w for backward Euler.
    pub beta_be: f64,
    /// Response to a uniform unit source in the backward Euler RHS.
    pub z_be: Vec<f64>,
    pub z_mass_be: f64,
    pub lu_bdf: TridiagonalLu,
    pub w_bdf: Vec<f64>,
    pub beta_bdf: f64,
    /// BDF2 right-hand side V[(1 + ω) u − ω²/(1 + ω) u_prev].
    pub c1: f64,
    pub c2: f64,
}

impl KernelStep {
    fn empty() -> Self {
        let lu = TridiagonalLu::new(&[], &[1.0], &[]).expect("1×1 identity");
        Self {
            use_bdf: false,
            lu_be: lu.clone(),
            w_be: Vec::new(),
            beta_be: 0.0,
            z_be: Vec::new(),
            z_mass_be: 0.0,
            lu_bdf: lu,
            w_bdf: Vec::new(),
            beta_bdf: 0.0,
            c1: 0.0,
            c2: 0.0,
        }
    }
}

/// Per-step inputs common to all columns.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StepInput<'a> {
    pub dt: f64,
    /// Previous step (0 before the first), for the BDF2 ratio.
    pub dt_prev: f64,
    /// Time at the start of the step.
    pub t_start: f64,
    /// Bed temperature for the diffusivities, °C.
    pub temp: f64,
    /// Mean flow into each column over the step, m³/s.
    pub flow: &'a [f64],
    /// Flow leaving each column's floor over the step, m³/s.
    pub outflow: &'a [f64],
    /// Active (wetted) cells of each column.
    pub active: &'a [usize],
    /// Wetted volume of each column at the start and the end of the step, m³.
    /// The end is not clamped at the column volume in the step that breaks
    /// through (the state is), so each face's open share stays exact.
    pub wetted_start: &'a [f64],
    pub wetted_end: &'a [f64],
    pub axial_dispersion: f64,
}

/// Work arrays, sized once.
#[derive(Clone, Debug)]
pub(crate) struct Scratch {
    lower: Vec<f64>,
    diag: Vec<f64>,
    upper: Vec<f64>,
    rhs: Vec<f64>,
    base_diag: Vec<f64>,
    base_rhs: Vec<f64>,
    /// Liquid holdup volume of every cell at the end of the step.
    hold: Vec<f64>,
    /// Newly filled intraparticle water per cell, m³.
    filling: Vec<f64>,
    /// Its allocation to each surface pool, per (cell, class), m³.
    pfill: Vec<f64>,
    /// Face coefficients of every interior face (`cell` = face below it).
    face_a: Vec<f64>,
    face_b: Vec<f64>,
    /// Pool lines of every cell for this step, per (cell, class): loss =
    /// intercept + slope·c′ saturated and unsaturated, the switch c′ and the
    /// band around it (in c′), the capped loss S − S₀ and the band in mass.
    sat0: Vec<f64>,
    sat1: Vec<f64>,
    uns0: Vec<f64>,
    uns1: Vec<f64>,
    switch: Vec<f64>,
    switch_band: Vec<f64>,
    cap_loss: Vec<f64>,
    mass_band: Vec<f64>,
    /// Kernel loss coefficients of every cell, per (cell, class): loss =
    /// ka − kd·u_s − ki·c′. Kept for all columns, so the back-substitution after
    /// every column converged uses exactly what the solves used.
    kd: Vec<f64>,
    ka: Vec<f64>,
    /// Surviving kernel front-source mass per unit liquid concentration.
    ki: Vec<f64>,
    /// Congruent factors from the lumped pools, per (cell, class): a species
    /// pool becomes (S_s + gain·c′_s)·keep.
    keep: Vec<f64>,
    gain: Vec<f64>,
    /// New concentration of one column's cells.
    c: Vec<f64>,
    /// Kernel boundary value u_s per (class, cell) (0 where dry).
    cb: Vec<f64>,
    /// Uniform kernel front source per (class, cell), in kernel units.
    ci: Vec<f64>,
    /// Initial concentration-equivalent kernel loading, per class.
    u0_lumped: Vec<f64>,
    /// Kernel mass loss at u_s = 0 (in units of σV), per (class, cell).
    alpha: Vec<f64>,
    /// Whether the cell's kernel used BDF2, per (class, cell).
    bdf: Vec<bool>,
    /// Cells wet during the step, and wet before it and fully (may use
    /// BDF2).
    active: Vec<bool>,
    eligible: Vec<bool>,
    /// Wetted share of every cell at the end of the step, and the cells the
    /// front is inside (their particles exchange in proportion).
    wet: Vec<f64>,
    partial: Vec<usize>,
    /// Right-hand-side coefficients of each cell: V(c1 u − c2 u_prev).
    coef1: Vec<f64>,
    coef2: Vec<f64>,
    /// Dry cells, and cells in their first wet step (backward Euler).
    dry: Vec<usize>,
    first: Vec<usize>,
    /// Cells that fall back from BDF2 to backward Euler (per class).
    fallback: Vec<usize>,
    /// One kernel's right-hand side (individual solves).
    column: Vec<f64>,
    klower: Vec<f64>,
    kdiag: Vec<f64>,
    lu: TridiagonalLu,
    pub lumped: Vec<KernelStep>,
    /// Kernel steps of each species group.
    pub groups: Vec<Vec<KernelStep>>,
    /// New lumped concentration of every cell (the column solves run before
    /// any back-substitution, so a step can be rejected unchanged).
    c_cols: Vec<f64>,
    /// Most column solves any step needed so far (a diagnostic).
    pub solves_max: usize,
    /// Overrides the solve limit (tests of the retry path only).
    pub solve_limit: Option<usize>,
}

impl Scratch {
    pub fn new(model: &Model) -> Self {
        let n = model.n_cells();
        let nt = n * model.columns.len();
        let k = model.n_classes();
        let max_shells = model
            .classes
            .iter()
            .map(ClassModel::shells)
            .max()
            .unwrap_or(0);
        let steps = || {
            model
                .classes
                .iter()
                .map(|_| KernelStep::empty())
                .collect::<Vec<_>>()
        };
        Self {
            lower: vec![0.0; n],
            diag: vec![0.0; n],
            upper: vec![0.0; n],
            rhs: vec![0.0; n],
            base_diag: vec![0.0; n],
            base_rhs: vec![0.0; n],
            hold: vec![0.0; nt],
            filling: vec![0.0; nt],
            pfill: vec![0.0; nt * k],
            face_a: vec![0.0; nt],
            face_b: vec![0.0; nt],
            sat0: vec![0.0; nt * k],
            sat1: vec![0.0; nt * k],
            uns0: vec![0.0; nt * k],
            uns1: vec![0.0; nt * k],
            switch: vec![0.0; nt * k],
            switch_band: vec![0.0; nt * k],
            cap_loss: vec![0.0; nt * k],
            mass_band: vec![0.0; nt * k],
            kd: vec![0.0; nt * k],
            ka: vec![0.0; nt * k],
            ki: vec![0.0; nt * k],
            keep: vec![1.0; nt * k],
            gain: vec![0.0; nt * k],
            c: vec![0.0; n],
            cb: vec![0.0; k * nt],
            ci: vec![0.0; k * nt],
            u0_lumped: vec![model.u0; k],
            alpha: vec![0.0; k * nt],
            bdf: vec![false; k * nt],
            active: vec![false; nt],
            eligible: vec![false; nt],
            wet: vec![0.0; nt],
            partial: Vec::with_capacity(model.columns.len()),
            coef1: vec![0.0; nt],
            coef2: vec![0.0; nt],
            dry: Vec::with_capacity(nt),
            first: Vec::with_capacity(nt),
            fallback: Vec::with_capacity(nt),
            column: Vec::with_capacity(max_shells),
            klower: Vec::with_capacity(max_shells),
            kdiag: Vec::with_capacity(max_shells),
            lu: TridiagonalLu::new(&[], &[1.0], &[]).expect("1×1 identity"),
            lumped: steps(),
            groups: model.groups.iter().map(|_| steps()).collect(),
            c_cols: vec![0.0; nt],
            solves_max: 0,
            solve_limit: None,
        }
    }
}

/// Factorises one class's kernel matrices for diffusivity `d`.
fn prepare_kernel(
    grid: &KernelGrid,
    radius: f64,
    d: f64,
    input: &StepInput<'_>,
    ks: &mut KernelStep,
    lower: &mut Vec<f64>,
    diag: &mut Vec<f64>,
) -> Result<(), ShotError> {
    let n = grid.len();
    let h = d * input.dt / (radius * radius);
    let omega = if input.dt_prev > 0.0 {
        input.dt / input.dt_prev
    } else {
        f64::INFINITY
    };
    ks.use_bdf = h <= BDF2_MAX_DTAU && omega <= BDF2_MAX_RATIO;
    let mut solve_w =
        |lu: &mut TridiagonalLu, w: &mut Vec<f64>, mass: f64| -> Result<f64, ShotError> {
            grid.factor_into(mass, h, lu, lower, diag)?;
            w.clear();
            w.resize(n, 0.0);
            w[n - 1] = h * grid.surface;
            lu.solve_in_place(w);
            Ok(w.iter()
                .zip(&grid.volume)
                .fold(0.0, |acc, (w, v)| acc + w * v))
        };
    ks.beta_be = solve_w(&mut ks.lu_be, &mut ks.w_be, 1.0)?;
    if ks.use_bdf {
        ks.c1 = 1.0 + omega;
        ks.c2 = omega * omega / (1.0 + omega);
        let mass = (1.0 + 2.0 * omega) / (1.0 + omega);
        ks.beta_bdf = solve_w(&mut ks.lu_bdf, &mut ks.w_bdf, mass)?;
    }
    // Algebraically z = 1 − w_BE. Solve directly to retain positivity
    // when a very stiff class makes that subtraction lose precision.
    ks.z_be.clone_from(&grid.volume);
    ks.lu_be.solve_in_place(&mut ks.z_be);
    ks.z_mass_be = ks.z_be.iter().zip(&grid.volume).map(|(z, v)| z * v).sum();
    Ok(())
}

/// Prepares every class's kernel step (lumped and species groups).
pub(crate) fn prepare(
    model: &Model,
    input: &StepInput<'_>,
    scratch: &mut Scratch,
) -> Result<(), ShotError> {
    let se = props::stokes_einstein_factor(input.temp, model.reference_temp);
    for (k, class) in model.classes.iter().enumerate() {
        let Some(grid) = &class.grid else { continue };
        prepare_kernel(
            grid,
            class.kernel_radius,
            model.diffusivity_ref * se,
            input,
            &mut scratch.lumped[k],
            &mut scratch.klower,
            &mut scratch.kdiag,
        )?;
        for (g, group) in model.groups.iter().enumerate() {
            prepare_kernel(
                grid,
                class.kernel_radius,
                group.diffusivity_ref * se,
                input,
                &mut scratch.groups[g][k],
                &mut scratch.klower,
                &mut scratch.kdiag,
            )?;
        }
    }
    Ok(())
}

/// Exponentially fitted face coefficients (a, b) for flux a c_up − b c_down,
/// with volumetric flow `q` and dispersive conductance `g` = A ε D/Δz.
/// a − b = q (up to the rounding of a), so constants are advected exactly.
fn face(q: f64, g: f64) -> (f64, f64) {
    if g <= 0.0 {
        return (q, 0.0);
    }
    let b = g * props::bernoulli(q / g);
    (q + b, b)
}

/// Computes the interior face coefficients of a column (stored for the
/// species, which share them). A face the wetting front crossed during the
/// step carries flow (and dispersion) only for the share of the step after
/// the crossing, (w₁ − edge)/(w₁ − w₀) with w the column's wetted volume, so
/// the face flux divergence supplies both mobile and particle-pore filling.
fn faces(
    model: &Model,
    state: &State,
    input: &StepInput<'_>,
    col: usize,
    n: usize,
    s: &mut Scratch,
) {
    let column = &model.columns[col];
    let share = column.share;
    let nc = model.n_cells();
    let (q, d_ax) = (input.flow[col], input.axial_dispersion);
    let (w0, w1) = (input.wetted_start[col], input.wetted_end[col]);
    for j in 0..n.saturating_sub(1) {
        let cj = &model.cells[j];
        let cn = &model.cells[j + 1];
        let edge = column.cum_volume[j + 1];
        let open = if w0 >= edge {
            1.0
        } else if w1 > w0 {
            fmin(fmax((w1 - edge) / (w1 - w0), 0.0), 1.0)
        } else {
            0.0
        };
        let eps_f = 0.5 * (state.eps[col * nc + j] + state.eps[col * nc + j + 1]);
        let dist = 0.5 * (cj.dz + cn.dz);
        let g = share * cj.bottom_area * eps_f * d_ax / dist;
        let (a, b) = face(q * open, g * open);
        s.face_a[col * nc + j] = a;
        s.face_b[col * nc + j] = b;
    }
}

/// Fills `diag`, `lower`, `upper` and `rhs` from the base arrays and the
/// column's faces.
fn assemble(s: &mut Scratch, col: usize, nc: usize, n: usize, dt: f64, q_out: f64) {
    for j in 0..n {
        s.diag[j] = s.base_diag[j];
        s.rhs[j] = s.base_rhs[j];
    }
    for j in 0..n.saturating_sub(1) {
        let (a, b) = (dt * s.face_a[col * nc + j], dt * s.face_b[col * nc + j]);
        s.diag[j] += a;
        s.upper[j] = -b;
        s.diag[j + 1] += b;
        s.lower[j] = -a;
    }
    s.diag[n - 1] += dt * q_out;
}

/// Solves the assembled system into `c`. A failed or non-positive pivot, or
/// a non-finite solution, is a numerical error (the matrix is an M-matrix
/// for every valid spec).
fn solve(s: &mut Scratch, n: usize) -> Result<(), ShotError> {
    s.lu.refactor(&s.lower[..n - 1], &s.diag[..n], &s.upper[..n - 1])
        .map_err(|e| numerical(format!("bed-liquid matrix: {e}")))?;
    if !s.lu.pivots_positive() {
        return Err(numerical("bed-liquid matrix lost its M-matrix structure"));
    }
    s.c[..n].copy_from_slice(&s.rhs[..n]);
    s.lu.solve_in_place(&mut s.c[..n]);
    if s.c[..n].iter().all(|x| x.is_finite()) {
        Ok(())
    } else {
        Err(numerical("non-finite bed-liquid concentration"))
    }
}

/// Liquid holdup volume of active cell `j` of column `col` (n active cells)
/// at the end of the step, m³: ε·V times the wetted share of
/// the front cell (1 for the cells above it, and in a column that is through).
pub(crate) fn holdup_volume(model: &Model, state: &State, col: usize, j: usize) -> f64 {
    let nc = model.n_cells();
    let cell = col * nc + j;
    let column = &model.columns[col];
    let vol = column.share * model.cells[j].volume;
    state.eps[cell] * vol * wet_share(model, state, col, j)
}

/// Wetted share of cell `j` of column `col`: 0 dry, 1 wet, in between at
/// the wetting front.
pub(crate) fn wet_share(model: &Model, state: &State, col: usize, j: usize) -> f64 {
    if state.through[col] {
        return 1.0;
    }
    let cum = &model.columns[col].cum_volume;
    let w = state.wetted[col];
    if w >= cum[j + 1] {
        1.0
    } else if w <= cum[j] {
        0.0
    } else {
        fmin(fmax((w - cum[j]) / (cum[j + 1] - cum[j]), 0.0), 1.0)
    }
}

/// Marks the cells wet during the step, those wet (fully) before it, and
/// the wetted share of each. A cell the front is inside exchanges with its
/// particles in proportion to its wetted share, by backward Euler.
fn mark_cells(model: &Model, state: &State, input: &StepInput<'_>, s: &mut Scratch) {
    let nc = model.n_cells();
    s.dry.clear();
    s.first.clear();
    s.partial.clear();
    for col in 0..model.columns.len() {
        for j in 0..nc {
            let g = col * nc + j;
            s.active[g] = j < input.active[col];
            s.wet[g] = if s.active[g] {
                wet_share(model, state, col, j)
            } else {
                0.0
            };
            let column = &model.columns[col];
            let old_wet = ((input.wetted_start[col] - column.cum_volume[j])
                / (column.cum_volume[j + 1] - column.cum_volume[j]))
                .clamp(0.0, 1.0);
            s.filling[g] = model.imbibed
                * column.share
                * model.cells[j].volume
                * (s.wet[g] - old_wet).max(0.0);
            s.eligible[g] =
                s.active[g] && state.t_wet[g] < input.t_start && old_wet == 1.0 && s.wet[g] == 1.0;
            if !s.active[g] {
                s.dry.push(g);
            } else if !s.eligible[g] {
                s.first.push(g);
            }
            if s.active[g] && s.wet[g] < 1.0 {
                s.partial.push(g);
            }
        }
    }
}

/// Restore the untouched dry population after solving the wet population.
/// Using u₀ here (rather than the old whole-cell average) preserves wet/dry
/// ownership even through repeated partial-wet steps or a zero-flow dwell.
fn mix_partial(model: &Model, u0: &[f64], b: &mut [f64], wet: &[f64], partial: &[usize]) {
    let nt = wet.len();
    for (k, class) in model.classes.iter().enumerate() {
        let Some(grid) = &class.grid else { continue };
        for l in 0..grid.len() {
            let start = (class.offset + l) * nt;
            for &g in partial {
                let i = start + g;
                b[i] = (1.0 - wet[g]) * u0[k] + wet[g] * b[i];
            }
        }
    }
}

/// Cells of the bed that need special treatment in a kernel step.
struct Special<'a> {
    eligible: &'a [bool],
    wet: &'a [f64],
    partial: &'a [usize],
    /// Dry cells (both time levels keep the same values).
    dry: &'a [usize],
    /// Cells in their first wet step (backward Euler).
    first: &'a [usize],
}

/// Solves one cell's kernel by backward Euler from `ub` into `bb`; returns
/// its homogeneous loss Σ Ṽ (u − u_hom).
fn kernel_be(
    ks: &KernelStep,
    vol: &[f64],
    ub: &[f64],
    bb: &mut [f64],
    nt: usize,
    g: usize,
    column: &mut Vec<f64>,
) -> f64 {
    column.clear();
    column.extend(vol.iter().enumerate().map(|(l, v)| v * ub[l * nt + g]));
    ks.lu_be.solve_in_place(column);
    let mut loss = 0.0;
    for (l, &x) in column.iter().enumerate() {
        bb[l * nt + g] = x;
        loss += vol[l] * (ub[l * nt + g] - x);
    }
    loss
}

/// Reconstructs the wetted population from its whole-cell average; the
/// remaining dry population still has its initial concentration.
fn wet_value(average: f64, initial: f64, wet: f64) -> f64 {
    initial + (average - initial) / wet
}

/// Kernels of a column that became capped during this step's iteration while
/// stepping by BDF2 are re-solved by backward Euler, which respects the
/// affine boundary bound (BDF2 can overshoot): capped kernels step by backward
/// Euler. Returns whether any changed (the column must then be re-solved).
#[allow(clippy::too_many_arguments)]
fn recap_backward_euler(
    model: &Model,
    steps: &[KernelStep],
    u: &[f64],
    b: &mut [f64],
    kcap: &[bool],
    alpha: &mut [f64],
    bdf: &mut [bool],
    col: usize,
    n: usize,
    column: &mut Vec<f64>,
) -> bool {
    let nc = model.n_cells();
    let nt = nc * model.columns.len();
    let nk = model.n_classes();
    let mut changed = false;
    for (k, class) in model.classes.iter().enumerate() {
        let Some(grid) = &class.grid else { continue };
        let ks = &steps[k];
        if !ks.use_bdf {
            continue;
        }
        let block = class.offset * nt..(class.offset + grid.len()) * nt;
        for j in 0..n {
            let g = col * nc + j;
            if bdf[k * nt + g] && kcap[g * nk + k] {
                bdf[k * nt + g] = false;
                alpha[k * nt + g] = kernel_be(
                    ks,
                    &grid.volume,
                    &u[block.clone()],
                    &mut b[block.clone()],
                    nt,
                    g,
                    column,
                );
                changed = true;
            }
        }
    }
    changed
}

/// Homogeneous kernel solves of every class over the whole bed, in place.
///
/// `u` holds the kernels at time level n and `b` at level n − 1, both
/// shell-major across all cells. On return `b` holds u_hom (the solution
/// with a zero boundary value) in wet cells and equals `u` in dry cells;
/// `alpha` = Σ Ṽ (u − u_hom) per (class, cell); `bdf` records the scheme.
/// Cells wet before the step use BDF2 when their class does; a cell's first
/// wet step, a kernel held at its loading cap (`kcap`, per (cell, class):
/// backward Euler respects its affine boundary bound), and a BDF2
/// step whose right-hand side or α would turn negative use backward Euler
/// (solved cell by cell; they are few).
#[allow(clippy::too_many_arguments)]
fn kernels_homogeneous(
    model: &Model,
    steps: &[KernelStep],
    u0: &[f64],
    u: &[f64],
    b: &mut [f64],
    kcap: &[bool],
    cells: &Special<'_>,
    coef1: &mut [f64],
    coef2: &mut [f64],
    alpha: &mut [f64],
    bdf: &mut [bool],
    fallback: &mut Vec<usize>,
    column: &mut Vec<f64>,
) {
    let nt = cells.eligible.len();
    let nk = model.n_classes();
    for (k, class) in model.classes.iter().enumerate() {
        let Some(grid) = &class.grid else { continue };
        let ks = &steps[k];
        let len = grid.len();
        let vol = &grid.volume;
        let block = class.offset * nt..(class.offset + len) * nt;
        let ub = &u[block.clone()];
        let bb = &mut b[block];
        let flags = &mut bdf[k * nt..(k + 1) * nt];
        // Capped kernels and cells in their first wet step use backward
        // Euler (solved below, cell by cell).
        fallback.clear();
        if ks.use_bdf {
            for g in 0..nt {
                flags[g] = cells.eligible[g];
                if flags[g] && kcap[g * nk + k] {
                    flags[g] = false;
                    fallback.push(g);
                }
                (coef1[g], coef2[g]) = if flags[g] { (ks.c1, ks.c2) } else { (1.0, 0.0) };
            }
        } else {
            flags.fill(false);
        }
        let mut negative = false;
        for (l, &v) in vol.iter().enumerate() {
            let row = l * nt..(l + 1) * nt;
            if ks.use_bdf {
                for (((x, &y), &c1), &c2) in bb[row.clone()]
                    .iter_mut()
                    .zip(&ub[row])
                    .zip(coef1.iter())
                    .zip(coef2.iter())
                {
                    *x = v * (c1 * y - c2 * *x);
                    negative |= *x < 0.0;
                }
            } else {
                for (x, &y) in bb[row.clone()].iter_mut().zip(&ub[row]) {
                    *x = v * y;
                }
            }
        }
        // Negative BDF2 right-hand sides fall back to backward Euler.
        if negative {
            for g in 0..nt {
                if flags[g] && (0..len).any(|l| bb[l * nt + g] < 0.0) {
                    flags[g] = false;
                    fallback.push(g);
                }
            }
        }
        let main = if ks.use_bdf { &ks.lu_bdf } else { &ks.lu_be };
        main.solve_many_in_place(bb, nt, 0..nt);
        if ks.use_bdf {
            for &g in cells.first.iter().chain(fallback.iter()) {
                kernel_be(ks, vol, ub, bb, nt, g, column);
            }
        }
        for &g in cells.dry {
            for l in 0..len {
                bb[l * nt + g] = ub[l * nt + g];
            }
        }
        let a = &mut alpha[k * nt..(k + 1) * nt];
        a.fill(0.0);
        for (l, &v) in vol.iter().enumerate() {
            let row = l * nt..(l + 1) * nt;
            for ((a, &x), &y) in a.iter_mut().zip(&ub[row.clone()]).zip(&bb[row]) {
                *a += v * (x - y);
            }
        }
        // Newly wetted particles start at u0; only the remaining dry
        // population is excluded. This also preserves a partially wet
        // population's history during a zero-flow dwell.
        for &g in cells.partial {
            column.clear();
            column.extend(
                vol.iter()
                    .enumerate()
                    .map(|(l, v)| v * wet_value(ub[l * nt + g], u0[k], cells.wet[g])),
            );
            ks.lu_be.solve_in_place(column);
            a[g] = 0.0;
            for (l, &x) in column.iter().enumerate() {
                bb[l * nt + g] = x;
                a[g] += vol[l] * (wet_value(ub[l * nt + g], u0[k], cells.wet[g]) - x);
            }
        }
        // A BDF2 step whose homogeneous loss is negative (its extrapolation
        // overshoots while the kernel loads) falls back to backward Euler,
        // whose α = Δτ·G·u_hom,N is never negative.
        if ks.use_bdf {
            fallback.clear();
            for g in 0..nt {
                if flags[g] && a[g] < 0.0 {
                    flags[g] = false;
                    fallback.push(g);
                }
            }
            for &g in fallback.iter() {
                a[g] = kernel_be(ks, vol, ub, bb, nt, g, column);
            }
        }
    }
}

/// Adds boundary and uniform front-source responses over the whole bed, in
/// place in `b` (`cb` holds u_s per (class, cell), 0 in dry cells). Returns
/// whether any new value is negative (an or-reduction, which vectorises; the
/// exact minimum is taken only then, and at the check points).
fn kernels_update(
    model: &Model,
    steps: &[KernelStep],
    b: &mut [f64],
    bdf: &[bool],
    cb: &[f64],
    ci: &[f64],
    nt: usize,
) -> bool {
    let mut negative = false;
    for (k, class) in model.classes.iter().enumerate() {
        let Some(grid) = &class.grid else { continue };
        let ks = &steps[k];
        let flags = &bdf[k * nt..(k + 1) * nt];
        let cbk = &cb[k * nt..(k + 1) * nt];
        let cik = &ci[k * nt..(k + 1) * nt];
        for l in 0..grid.len() {
            let we = ks.w_be[l];
            let wb = if ks.use_bdf { ks.w_bdf[l] } else { we };
            let start = (class.offset + l) * nt;
            let row = &mut b[start..start + nt];
            for (((x, &c), &injected), &f) in row.iter_mut().zip(cbk).zip(cik).zip(flags) {
                *x += c * if f { wb } else { we };
                *x += injected * ks.z_be[l];
                negative |= *x < 0.0;
            }
        }
    }
    negative
}

/// The smallest kernel value (all classes, all cells).
pub(crate) fn kernel_min(u: &[f64]) -> f64 {
    u.iter().fold(f64::INFINITY, |m, &x| fmin(m, x))
}

/// Net pool loss including carried solute. For wetted pool mass S, pore
/// normalization P, exchange coefficient kΔt and newly filled water b:
/// L_sat = kΔt·c_sat − (kΔt+b)c′;
/// L_uns = [γS − (kΔt+b)c′]/(1+γ), γ=kΔt/P.
/// The cap line is S_old−ceiling_old−b c′. The untouched dry mass cancels
/// from both sides. Its ceiling increment is committed only after all
/// columns converge.
fn pool_lines(model: &Model, state: &State, s: &mut Scratch, col: usize, n: usize, dt: f64) {
    let nc = model.n_cells();
    let nk = model.n_classes();
    let share = model.columns[col].share;
    let c_sat = model.saturation;
    for j in 0..n {
        let vol = share * model.cells[j].volume;
        for (k, class) in model.classes.iter().enumerate() {
            let i = (col * nc + j) * nk + k;
            let w = s.wet[col * nc + j];
            let fill = s.filling[col * nc + j] * class.fraction * class.pool_fraction;
            s.pfill[i] = fill;
            if !class.has_pool() {
                s.sat0[i] = 0.0;
                s.sat1[i] = 0.0;
                s.uns0[i] = 0.0;
                s.uns1[i] = 0.0;
                s.switch[i] = f64::INFINITY;
                s.switch_band[i] = 0.0;
                s.cap_loss[i] = 0.0;
                s.mass_band[i] = 0.0;
                continue;
            }
            let idx = i;
            let pool = state.pool[idx] - (1.0 - w) * state.pool0[idx];
            let pore = class.pool_pore * vol * w;
            let kb_dt = class.kb * vol * dt * w;
            let lines = pool_coefficients(pool, kb_dt, pore, c_sat, fill);
            (s.sat0[i], s.sat1[i], s.uns0[i], s.uns1[i], s.switch[i]) = lines;
            // The band is also kept above the round-off of evaluating the
            // lines (terms of size k·Δt·c_sat), or a stiff pool can chatter.
            let band = fmax(
                SWITCH_BAND * fmax(fmax(pool.abs(), state.pool0[idx]), pore * c_sat),
                ROUNDOFF_BAND * kb_dt * c_sat,
            );
            let gam = kb_dt / pore;
            s.switch_band[i] = if gam > 0.0 {
                band / ((kb_dt + fill) * (gam / (1.0 + gam)))
            } else {
                0.0
            };
            s.cap_loss[i] = state.pool[idx] - state.pool_ceiling[idx];
            s.mass_band[i] = band;
        }
    }
}

/// (saturated intercept, slope, unsaturated intercept, slope, switch c′) of
/// a pool holding `pool` kg, with kb·Δt = `kb_dt` (m³) and pore volume `pore`.
#[inline]
fn pool_coefficients(
    pool: f64,
    kb_dt: f64,
    pore: f64,
    c_sat: f64,
    fill: f64,
) -> (f64, f64, f64, f64, f64) {
    let gam = kb_dt / pore;
    (
        kb_dt * c_sat,
        -(kb_dt + fill),
        gam * pool / (1.0 + gam),
        -(kb_dt + fill) / (1.0 + gam),
        if kb_dt + fill > 0.0 {
            (pore * c_sat * (1.0 + gam) - pool) / (kb_dt + fill)
        } else {
            f64::INFINITY
        },
    )
}

/// The pool line (intercept, slope) of entry `i` in a regime.
#[inline]
fn pool_line(s: &Scratch, i: usize, saturated: bool) -> (f64, f64) {
    if saturated {
        (s.sat0[i], s.sat1[i])
    } else {
        (s.uns0[i], s.uns1[i])
    }
}

/// The kernels' loss coefficients of a column's cells for this step (after
/// the homogeneous solves): loss = ka − kd·u_s − ki·c′ per (cell, class).
fn kernel_coefficients(model: &Model, s: &mut Scratch, steps: &[KernelStep], col: usize, n: usize) {
    let nc = model.n_cells();
    let nt = nc * model.columns.len();
    let nk = model.n_classes();
    let share = model.columns[col].share;
    for j in 0..n {
        let g = col * nc + j;
        let vol = share * model.cells[j].volume;
        for (k, class) in model.classes.iter().enumerate() {
            let i = g * nk + k;
            if class.grid.is_none() {
                s.kd[i] = 0.0;
                s.ka[i] = 0.0;
                s.ki[i] = 0.0;
                continue;
            }
            let ks = &steps[k];
            let scale = class.sigma * vol * s.wet[g];
            let beta = if s.bdf[k * nt + g] {
                ks.beta_bdf
            } else {
                ks.beta_be
            };
            s.kd[i] = scale * beta;
            s.ka[i] = scale * s.alpha[k * nt + g];
            let fill = s.filling[g] * class.fraction * (1.0 - class.pool_fraction);
            s.ki[i] = fill * 3.0 * ks.z_mass_be;
        }
    }
}

/// Adds the pools' losses in their current regimes and caps to the system.
fn add_pools(regime: &[bool], pcap: &[bool], s: &mut Scratch, base: usize, n: usize, nk: usize) {
    for j in 0..n {
        let (mut d, mut r) = (0.0, 0.0);
        for k in 0..nk {
            let (i, idx) = ((base + j) * nk + k, (base + j) * nk + k);
            if pcap[idx] {
                r += s.cap_loss[i];
                d += s.pfill[i];
            } else {
                let (b0, b1) = pool_line(s, i, regime[idx]);
                d -= b1;
                r += b0;
            }
        }
        s.diag[j] += d;
        s.rhs[j] += r;
    }
}

/// Adds the kernels' losses in their current caps: ka − kd·c′/K_p (linear)
/// or ka − kd·(u₀ + water_ratio·c′) (capped), less the surviving
/// front-source gain ki·c′ in either case.
#[allow(clippy::too_many_arguments)]
fn add_kernels(
    kcap: &[bool],
    s: &mut Scratch,
    base: usize,
    n: usize,
    nk: usize,
    k_part: f64,
    u0: &[f64],
    water_ratio: f64,
) {
    for j in 0..n {
        let (mut d, mut r) = (0.0, 0.0);
        for (k, &u0k) in u0.iter().enumerate().take(nk) {
            let i = (base + j) * nk + k;
            d += s.ki[i];
            if kcap[i] {
                r += s.ka[i] - s.kd[i] * u0k;
                d += s.kd[i] * water_ratio;
            } else {
                d += s.kd[i] / k_part;
                r += s.ka[i];
            }
        }
        s.diag[j] += d;
        s.rhs[j] += r;
    }
}

/// Re-picks the regime of every uncapped pool from the solution; returns
/// whether any changed. A regime changes only when c′ leaves the band around
/// its switch point, where both lines agree.
fn update_regimes(
    model: &Model,
    regime: &mut [bool],
    pcap: &[bool],
    s: &Scratch,
    base: usize,
    n: usize,
) -> bool {
    let nk = model.n_classes();
    let mut changed = false;
    for j in 0..n {
        let c = s.c[j];
        for (k, class) in model.classes.iter().enumerate() {
            let (i, idx) = ((base + j) * nk + k, (base + j) * nk + k);
            if !class.has_pool() || class.kb == 0.0 || pcap[idx] {
                continue;
            }
            let (sw, band) = (s.switch[i], s.switch_band[i]);
            let saturated = if regime[idx] {
                c >= sw - band
            } else {
                c > sw + band
            };
            if saturated != regime[idx] {
                regime[idx] = saturated;
                changed = true;
            }
        }
    }
    changed
}

/// Re-picks the pool caps from the solution: a pool is capped when, free, it
/// would end above the previous ceiling plus this step's carried solute.
fn update_pool_caps(model: &Model, pcap: &mut [bool], s: &Scratch, base: usize, n: usize) -> bool {
    let nk = model.n_classes();
    let mut changed = false;
    for j in 0..n {
        let c = s.c[j];
        for (k, class) in model.classes.iter().enumerate() {
            let (i, idx) = ((base + j) * nk + k, (base + j) * nk + k);
            if !class.has_pool() || class.kb == 0.0 {
                continue;
            }
            let free = fmin(s.sat0[i] + s.sat1[i] * c, s.uns0[i] + s.uns1[i] * c);
            let (cap, band) = (s.cap_loss[i] - s.pfill[i] * c, s.mass_band[i]);
            let capped = if pcap[idx] {
                free <= cap + band
            } else {
                free < cap - band
            };
            if capped != pcap[idx] {
                pcap[idx] = capped;
                changed = true;
            }
        }
    }
    changed
}

/// Re-picks the kernel loading caps from the solution: a kernel is capped
/// when c′/K_p exceeds u₀ + water_ratio·c′. Returns whether any changed.
#[allow(clippy::too_many_arguments)]
fn update_kernel_caps(
    model: &Model,
    kcap: &mut [bool],
    s: &Scratch,
    base: usize,
    n: usize,
    k_part: f64,
    u0: &[f64],
) -> bool {
    let nk = model.n_classes();
    let mut changed = false;
    for j in 0..n {
        let ub = s.c[j] / k_part - model.loading_water_ratio * s.c[j];
        for (k, class) in model.classes.iter().enumerate() {
            if class.grid.is_none() {
                continue;
            }
            let idx = (base + j) * nk + k;
            let capped = if kcap[idx] {
                ub >= u0[k] * (1.0 - SWITCH_BAND)
            } else {
                ub > u0[k] * (1.0 + SWITCH_BAND)
            };
            if capped != kcap[idx] {
                kcap[idx] = capped;
                changed = true;
            }
        }
    }
    changed
}

/// Fills the column's base system (holdup and liquid mass), the kernel
/// coefficients, the faces and the pool lines for this step.
fn lumped_setup(
    model: &Model,
    state: &State,
    s: &mut Scratch,
    steps: &[KernelStep],
    input: &StepInput<'_>,
    col: usize,
    n: usize,
) {
    let base = col * model.n_cells();
    for j in 0..n {
        s.hold[base + j] = holdup_volume(model, state, col, j);
        s.base_diag[j] = s.hold[base + j];
        s.base_rhs[j] = state.m[base + j];
    }
    kernel_coefficients(model, s, steps, col, n);
    faces(model, state, input, col, n, s);
    pool_lines(model, state, s, col, n, input.dt);
}

/// Most column solves allowed in one step: generous, and growing with the
/// number of choices (a regime change can travel one cell per solve).
fn solve_cap(n: usize, nk: usize) -> usize {
    MAX_POLICY_SOLVES + 4 * n * nk
}

/// Solves the lumped bed liquid of one column by nested policy iteration,
/// after the homogeneous kernel solves, and stores c′ in `c_cols`. Returns
/// whether the iteration converged; the state is not changed except for the
/// regime and cap choices (the starting guess of a retry).
fn lumped_solve(
    model: &Model,
    state: &mut State,
    s: &mut Scratch,
    input: &StepInput<'_>,
    col: usize,
) -> Result<bool, ShotError> {
    let n = input.active[col];
    if n == 0 {
        return Ok(true);
    }
    let steps = std::mem::take(&mut s.lumped);
    let u0 = std::mem::take(&mut s.u0_lumped);
    lumped_setup(model, state, s, &steps, input, col, n);
    let result = lumped_iterate(model, state, s, &steps, input, col, n, &u0);
    s.lumped = steps;
    s.u0_lumped = u0;
    result
}

#[allow(clippy::too_many_arguments)]
fn lumped_iterate(
    model: &Model,
    state: &mut State,
    s: &mut Scratch,
    steps: &[KernelStep],
    input: &StepInput<'_>,
    col: usize,
    n: usize,
    u0: &[f64],
) -> Result<bool, ShotError> {
    let nc = model.n_cells();
    let nk = model.n_classes();
    let (dt, q_out) = (input.dt, input.outflow[col]);
    let k_part = model.kernel_partition;
    let base = col * nc;
    let cap = s.solve_limit.unwrap_or_else(|| solve_cap(n, nk));
    // Nested policy iteration: pool regimes inside, caps outside; then
    // capped kernels that stepped by BDF2 switch to backward Euler, and the
    // column is solved again.
    let mut solves = 0;
    loop {
        loop {
            loop {
                assemble(s, col, nc, n, dt, q_out);
                add_pools(&state.regime, &state.pcap, s, base, n, nk);
                add_kernels(
                    &state.kcap,
                    s,
                    base,
                    n,
                    nk,
                    k_part,
                    u0,
                    model.loading_water_ratio,
                );
                solve(s, n)?;
                solves += 1;
                if !update_regimes(model, &mut state.regime, &state.pcap, s, base, n) {
                    break;
                }
                if solves >= cap {
                    return Ok(false);
                }
            }
            let pools = update_pool_caps(model, &mut state.pcap, s, base, n);
            let kernels = model.loading_cap
                && update_kernel_caps(model, &mut state.kcap, s, base, n, k_part, u0);
            if !(pools || kernels) {
                break;
            }
            if solves >= cap {
                return Ok(false);
            }
        }
        if !recap_backward_euler(
            model,
            steps,
            &state.u,
            &mut state.u_prev,
            &state.kcap,
            &mut s.alpha,
            &mut s.bdf,
            col,
            n,
            &mut s.column,
        ) {
            break;
        }
        kernel_coefficients(model, s, steps, col, n);
        if solves >= cap {
            return Ok(false);
        }
    }
    s.solves_max = s.solves_max.max(solves);
    s.c_cols[base..base + n].copy_from_slice(&s.c[..n]);
    Ok(true)
}

/// Back-substitution of one column after every column converged: pools,
/// kernel losses, liquid and cup, with the final choices; records the kernel
/// boundary values for the update.
fn lumped_update(
    model: &Model,
    state: &mut State,
    s: &mut Scratch,
    input: &StepInput<'_>,
    col: usize,
) {
    let n = input.active[col];
    if n == 0 {
        return;
    }
    let nc = model.n_cells();
    let nt = nc * model.columns.len();
    let nk = model.n_classes();
    let dt = input.dt;
    let share = model.columns[col].share;
    let q_out = input.outflow[col];
    let k_part = model.kernel_partition;
    let base = col * nc;
    let u0 = std::mem::take(&mut s.u0_lumped);
    // The same linear functions the converged solve used (kept per cell).
    let mut min_c = state.min_conc;
    let mut max_c = state.max_conc;
    for j in 0..n {
        let cell = base + j;
        let vol = share * model.cells[j].volume;
        let c = s.c_cols[cell];
        min_c = fmin(min_c, c);
        max_c = fmax(max_c, c);
        let mut loss = 0.0;
        for (k, class) in model.classes.iter().enumerate() {
            let (i, idx) = (cell * nk + k, cell * nk + k);
            if class.has_pool() {
                let p_loss = if state.pcap[idx] {
                    s.cap_loss[i] - s.pfill[i] * c
                } else {
                    let (b0, b1) = pool_line(s, i, state.regime[idx]);
                    b0 + b1 * c
                };
                let new_pool = state.pool[idx] - p_loss;
                state.pool[idx] = new_pool;
                state.pool_ceiling[idx] += s.pfill[i] * c;
                loss += p_loss;
                min_c = fmin(min_c, new_pool / (class.pool_pore * vol));
                // Separate exchange from front carriage: both can occur
                // simultaneously. Only the wetted pool participates in the
                // congruent species map; its dry remainder stays unchanged.
                let exchange = p_loss + s.pfill[i] * c;
                let wet_pool = new_pool - (1.0 - s.wet[cell]) * state.pool0[idx];
                (s.keep[idx], s.gain[idx]) = if exchange > 0.0 {
                    if wet_pool > 0.0 {
                        (wet_pool / (wet_pool + exchange), s.pfill[i])
                    } else {
                        (0.0, s.pfill[i])
                    }
                } else if exchange < 0.0 && c > 0.0 {
                    (1.0, s.pfill[i] - exchange / c)
                } else {
                    (1.0, s.pfill[i])
                };
            }
            if class.grid.is_some() {
                let u_s = if state.kcap[idx] {
                    u0[k] + model.loading_water_ratio * c
                } else {
                    c / k_part
                };
                s.cb[k * nt + cell] = u_s;
                let fill = s.filling[cell] * class.fraction * (1.0 - class.pool_fraction);
                s.ci[k * nt + cell] = 3.0 * fill * c / (class.sigma * vol * s.wet[cell]);
                let k_loss = s.ka[i] - s.kd[i] * u_s - s.ki[i] * c;
                if k_loss < 0.0 {
                    state.kernel_uptake[k] -= k_loss;
                }
                loss += k_loss;
            }
        }
        state.particle[cell] -= loss;
        state.m[cell] = s.hold[cell] * c;
    }
    s.u0_lumped = u0;
    state.min_conc = min_c;
    state.max_conc = max_c;
    if q_out > 0.0 {
        let c_out = s.c_cols[base + n - 1];
        state.cup_solute += dt * q_out * c_out;
        state.cup_water += dt * q_out * model.liquid.water_mass_per_volume(c_out);
    }
}

/// The bed-liquid and pool step of one column for species group `g`, after
/// its lumped step and the group's homogeneous kernel solves.
fn species_liquid(
    model: &Model,
    state: &mut State,
    s: &mut Scratch,
    input: &StepInput<'_>,
    col: usize,
    g: usize,
) -> Result<(), ShotError> {
    let n = input.active[col];
    if n == 0 {
        return Ok(());
    }
    let nc = model.n_cells();
    let nt = nc * model.columns.len();
    let nk = model.n_classes();
    let dt = input.dt;
    let share = model.columns[col].share;
    let q_out = input.outflow[col];
    let group = &model.groups[g];
    let k_part = group.kernel_partition;
    let base = col * nc;

    {
        let st = &state.groups[g];
        for j in 0..n {
            let cell = base + j;
            // Pool loss = S_s (1 − keep) − gain·keep·c′_s.
            // The holdup of the lumped step (same porosity and front).
            let (mut d, mut r) = (s.hold[cell], st.m[cell]);
            for (k, class) in model.classes.iter().enumerate() {
                if class.has_pool() {
                    let idx = cell * nk + k;
                    let dry = (1.0 - s.wet[cell]) * group.pool0[k] * share * model.cells[j].volume;
                    r += (st.pool[idx] - dry) * (1.0 - s.keep[idx]);
                    d += s.gain[idx] * s.keep[idx];
                }
            }
            s.base_diag[j] = d;
            s.base_rhs[j] = r;
        }
    }
    let steps = std::mem::take(&mut s.groups[g]);
    kernel_coefficients(model, s, &steps, col, n);
    // The faces of the lumped step (same flow and porosity); policy
    // iteration over the kernel caps only. Its iterates increase
    // monotonically and each cap (and each kernel's switch to backward Euler)
    // happens at most once, so 2·n·classes + 1 solves always suffice.
    let cap = 2 * n * nk + 10;
    let mut solves = 0;
    let mut converged = false;
    'species: loop {
        assemble(s, col, nc, n, dt, q_out);
        add_kernels(
            &state.groups[g].kcap,
            s,
            base,
            n,
            nk,
            k_part,
            &group.kernel0,
            model.loading_water_ratio,
        );
        solve(s, n)?;
        solves += 1;
        let changed = model.loading_cap
            && update_kernel_caps(
                model,
                &mut state.groups[g].kcap,
                s,
                base,
                n,
                k_part,
                &group.kernel0,
            );
        if !changed {
            // Capped kernels that stepped by BDF2 switch to backward Euler.
            let st = &mut state.groups[g];
            if !recap_backward_euler(
                model,
                &steps,
                &st.u,
                &mut st.u_prev,
                &st.kcap,
                &mut s.alpha,
                &mut s.bdf,
                col,
                n,
                &mut s.column,
            ) {
                converged = true;
                break 'species;
            }
            kernel_coefficients(model, s, &steps, col, n);
        }
        if solves >= cap {
            break;
        }
    }
    s.groups[g] = steps;
    if !converged {
        return Err(numerical(
            "the species' kernel-cap iteration did not converge",
        ));
    }
    s.solves_max = s.solves_max.max(solves);

    let st = &mut state.groups[g];
    let mut min_c = st.min_conc;
    for j in 0..n {
        let cell = base + j;
        let vol = share * model.cells[j].volume;
        let c = s.c[j];
        min_c = fmin(min_c, c);
        for (k, class) in model.classes.iter().enumerate() {
            let idx = cell * nk + k;
            if class.has_pool() {
                let dry = (1.0 - s.wet[cell]) * group.pool0[k] * vol;
                let new_pool = dry + (st.pool[idx] - dry + s.gain[idx] * c) * s.keep[idx];
                st.pool[idx] = new_pool;
                min_c = fmin(min_c, new_pool / (class.pool_pore * vol));
            }
            if class.grid.is_some() {
                let fill = s.filling[cell] * class.fraction * (1.0 - class.pool_fraction);
                s.ci[k * nt + cell] = 3.0 * fill * c / (class.sigma * vol * s.wet[cell]);
                s.cb[k * nt + cell] = if st.kcap[idx] {
                    group.kernel0[k] + model.loading_water_ratio * c
                } else {
                    c / k_part
                };
            }
        }
        st.m[cell] = s.hold[cell] * c;
    }
    st.min_conc = min_c;
    if q_out > 0.0 {
        st.cup += dt * q_out * s.c[n - 1];
    }
    Ok(())
}

/// One coupled step of extraction and transport for the whole bed: kernel
/// matrices, then for the lumped solubles and each species group in turn the
/// homogeneous kernel solves, the column liquid solves and the kernel
/// update; finally the state buffers swap and the porosity follows the
/// local extraction.
///
/// Returns `Ok(false)`, with the state unchanged except for the regime
/// choices and the kernels' previous time level, when a lumped column's
/// policy iteration does not converge: the caller retries a shorter step
/// (by backward Euler, as the previous level is gone). Unconverged choices
/// are never accepted.
pub(crate) fn step(
    model: &Model,
    state: &mut State,
    s: &mut Scratch,
    input: &StepInput<'_>,
) -> Result<bool, ShotError> {
    prepare(model, input, s)?;
    mark_cells(model, state, input, s);
    let ncol = model.columns.len();
    let nt = ncol * model.n_cells();

    s.cb.fill(0.0);
    s.ci.fill(0.0);
    {
        let cells = Special {
            eligible: &s.eligible,
            wet: &s.wet,
            partial: &s.partial,
            dry: &s.dry,
            first: &s.first,
        };
        kernels_homogeneous(
            model,
            &s.lumped,
            &s.u0_lumped,
            &state.u,
            &mut state.u_prev,
            &state.kcap,
            &cells,
            &mut s.coef1,
            &mut s.coef2,
            &mut s.alpha,
            &mut s.bdf,
            &mut s.fallback,
            &mut s.column,
        );
    }
    for col in 0..ncol {
        if !lumped_solve(model, state, s, input, col)? {
            return Ok(false);
        }
    }
    for col in 0..ncol {
        lumped_update(model, state, s, input, col);
    }
    let negative = kernels_update(
        model,
        &s.lumped,
        &mut state.u_prev,
        &s.bdf,
        &s.cb,
        &s.ci,
        nt,
    );
    mix_partial(model, &s.u0_lumped, &mut state.u_prev, &s.wet, &s.partial);
    if negative {
        state.min_conc = fmin(state.min_conc, kernel_min(&state.u_prev));
    }

    for g in 0..model.groups.len() {
        s.cb.fill(0.0);
        s.ci.fill(0.0);
        {
            let cells = Special {
                eligible: &s.eligible,
                wet: &s.wet,
                partial: &s.partial,
                dry: &s.dry,
                first: &s.first,
            };
            let st = &mut state.groups[g];
            kernels_homogeneous(
                model,
                &s.groups[g],
                &model.groups[g].kernel0,
                &st.u,
                &mut st.u_prev,
                &st.kcap,
                &cells,
                &mut s.coef1,
                &mut s.coef2,
                &mut s.alpha,
                &mut s.bdf,
                &mut s.fallback,
                &mut s.column,
            );
        }
        for col in 0..ncol {
            species_liquid(model, state, s, input, col, g)?;
        }
        let st = &mut state.groups[g];
        let negative = kernels_update(
            model,
            &s.groups[g],
            &mut st.u_prev,
            &s.bdf,
            &s.cb,
            &s.ci,
            nt,
        );
        mix_partial(
            model,
            &model.groups[g].kernel0,
            &mut st.u_prev,
            &s.wet,
            &s.partial,
        );
        if negative {
            st.min_conc = fmin(st.min_conc, kernel_min(&st.u_prev));
        }
    }

    std::mem::swap(&mut state.u, &mut state.u_prev);
    for st in &mut state.groups {
        std::mem::swap(&mut st.u, &mut st.u_prev);
    }
    for col in 0..ncol {
        update_porosity(model, state, input.active[col], col, model.porosity_share);
    }
    Ok(true)
}

/// Updates the porosity of the column's active cells from their local EY:
/// ε = ε₀ + θ·max(EY, 0)·(1 − ε₀), capped at 0.95. It never decreases:
/// solute taken back up refills the particles' pores, not the intergranular
/// space.
fn update_porosity(model: &Model, state: &mut State, active: usize, col: usize, theta: f64) {
    if theta == 0.0 {
        return;
    }
    let nc = model.n_cells();
    for j in 0..active {
        let cell = col * nc + j;
        let ey = (state.particle0[cell] - state.particle[cell]) / state.dry[cell];
        let eps = model.eps0 + theta * fmax(ey, 0.0) * (1.0 - model.eps0);
        state.eps[cell] = fmax(state.eps[cell], fmin(eps, 0.95));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn face_coefficients_are_conservative_and_monotone() {
        for (q, g) in [
            (1e-6, 0.0),
            (1e-6, 1e-9),
            (1e-6, 1e-6),
            (1e-9, 1e-6),
            (0.0, 1e-7),
        ] {
            let (a, b) = face(q, g);
            assert!(a >= 0.0 && b >= 0.0);
            // a − b = q up to the rounding of a = q + b.
            assert!(((a - b) - q).abs() <= 2.0 * f64::EPSILON * a.max(1e-300));
        }
        // Pure dispersion: symmetric.
        let (a, b) = face(0.0, 2e-7);
        assert_eq!((a, b), (2e-7, 2e-7));
    }

    #[test]
    fn pool_lines_meet_at_the_switch() {
        let (pool, kb_dt, pore, c_sat) = (3.0e-4, 2e-6, 1e-6, 245.0);
        let (a0, a1, b0, b1, sw) = pool_coefficients(pool, kb_dt, pore, c_sat, 0.0);
        let (sa, sb) = (a0 + a1 * sw, b0 + b1 * sw);
        assert!((sa - sb).abs() < 1e-15 * sa.abs().max(1e-12), "{sa} {sb}");
        // At the switch the pool ends exactly at saturation.
        assert!(((pool - sa) / pore - c_sat).abs() < 1e-9);
        // Concave: the saturated slope is steeper.
        assert!(a1 < b1);
    }

    #[test]
    fn pool_band_bounds_the_pool_error_for_stiff_pools() {
        // A stiff pool (k·Δt = 10⁴ V_p): kept in the saturated regime while
        // c′ sits inside the band below the switch, the pool's loss is off
        // by at most 1e-10 of its content. The old band, 1e-10·c_sat in c′,
        // allowed k·Δt·2.45e-8, here 8000 times more.
        let (pool, kb_dt, pore, c_sat) = (3.0e-4, 1e-2, 1e-6, 245.0);
        let (a0, a1, b0, b1, sw) = pool_coefficients(pool, kb_dt, pore, c_sat, 0.0);
        let mass = SWITCH_BAND * pool.max(pore * c_sat);
        let gam = kb_dt / pore;
        let band = mass / (kb_dt * (gam / (1.0 + gam)));
        let c = sw - band;
        let (sat, uns) = (a0 + a1 * c, b0 + b1 * c);
        // Up to the round-off of evaluating the lines (terms of size k·Δt·c_sat).
        let roundoff = 8.0 * f64::EPSILON * kb_dt * c_sat;
        assert!((sat - uns).abs() <= mass + roundoff, "{sat} {uns} {mass}");
        let old = kb_dt * (gam / (1.0 + gam)) * (SWITCH_BAND * c_sat);
        assert!(old > 1000.0 * mass, "{old} {mass}");
        // At the band's edge the saturated line leaves the pool at
        // saturation less at most the band (scaled by (1 + γ)/γ).
        let after = pool - sat;
        assert!(after >= pore * c_sat - (mass + roundoff) * (1.0 + 1.0 / gam));
    }
}
