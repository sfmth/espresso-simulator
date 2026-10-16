// SPDX-License-Identifier: GPL-2.0-or-later
//! Diffusion out of one sphere into a perfect sink.
//!
//! At t = 0 a sphere of radius `a` holds a uniform concentration `c0`. For
//! t > 0 its surface is held at c = 0, and the solute diffuses out with
//! constant diffusivity `D`. The released fraction has the classic series
//! solution (Crank 1975, eq. 6.20):
//!
//! ```text
//! M_t / M_inf = 1 - (6 / pi^2) * sum_{n >= 1} exp(-n^2 pi^2 D t / a^2) / n^2
//! ```
//!
//! This is the kernel of every particle in the extraction model
//! (docs/PLAN.md §7.3, module X). It is also milestone M0's end-to-end
//! verification case. The full specification, with measured errors and
//! convergence orders, is in `docs/model/particle-kernel.md`.
//!
//! **Method.**
//! - *Space.* A conservative finite-volume method on N shells (uniform radius
//!   or equal volume), with shell averages as the unknowns. Face
//!   conductances are exact for parabolic profiles A + B r² (see
//!   `shells.rs`), which makes the method second order on both grids.
//! - *Time.* Backward Euler; BDF2 (first step backward Euler); or
//!   Crank–Nicolson, whose first two steps are each replaced by two
//!   backward-Euler half-steps (Rannacher start-up).
//! - *Start-up.* The first few output intervals are integrated with the same
//!   scheme on a finer sub-grid ([`SolverOptions`]). This resolves the
//!   √t singularity of the initial layer.
//! - *Mass accounting.* The mass released through the surface is accumulated
//!   with the scheme's own time discretisation (the BDF2 recurrence,
//!   trapezoidal rule, ...). Released plus remaining mass is therefore
//!   conserved to round-off.
//! - *Cost.* Each step solves one tridiagonal system whose factors were
//!   computed before the time loop. The loop does not allocate.
//!
//! All arithmetic is IEEE-754 basic operations plus the deterministic
//! [`crate::math`] functions, so native and WebAssembly builds return
//! identical bits.
//!
//! The public items that existed in the M0 skeleton are a frozen contract,
//! used by `puckcore-wasm`, `puckcore-py`, the web app and the Python tools.

mod analytic;
pub(crate) mod shells;

pub use analytic::crank_sphere_release_fraction;
use analytic::dimensionless_time;

use std::fmt;

use crate::linalg::TridiagonalLu;
use shells::Shells;

/// Radial discretisation of the sphere into shells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grid {
    /// Shells of equal thickness.
    UniformRadius,
    /// Shells of equal volume: finer near the surface, where gradients are steep.
    EqualVolume,
}

impl Grid {
    /// Parses the binding-facing name: `"uniform_radius"` or `"equal_volume"`.
    pub fn parse(name: &str) -> Result<Self, KernelError> {
        match name {
            "uniform_radius" => Ok(Self::UniformRadius),
            "equal_volume" => Ok(Self::EqualVolume),
            _ => Err(KernelError::invalid(
                "grid",
                "expected \"uniform_radius\" or \"equal_volume\"",
            )),
        }
    }

    /// The binding-facing name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UniformRadius => "uniform_radius",
            Self::EqualVolume => "equal_volume",
        }
    }
}

/// Time-integration scheme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    /// Backward Euler: first order, L-stable.
    BackwardEuler,
    /// Second-order backward differentiation, started with one backward-Euler step.
    Bdf2,
    /// Crank–Nicolson (second order) with backward-Euler start-up steps
    /// (Rannacher smoothing).
    CrankNicolson,
}

impl Scheme {
    /// Parses the binding-facing name: `"backward_euler"`, `"bdf2"` or `"crank_nicolson"`.
    pub fn parse(name: &str) -> Result<Self, KernelError> {
        match name {
            "backward_euler" => Ok(Self::BackwardEuler),
            "bdf2" => Ok(Self::Bdf2),
            "crank_nicolson" => Ok(Self::CrankNicolson),
            _ => Err(KernelError::invalid(
                "scheme",
                "expected \"backward_euler\", \"bdf2\" or \"crank_nicolson\"",
            )),
        }
    }

    /// The binding-facing name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BackwardEuler => "backward_euler",
            Self::Bdf2 => "bdf2",
            Self::CrankNicolson => "crank_nicolson",
        }
    }
}

/// Inputs of [`simulate_sphere_release`].
///
/// Valid ranges: `radius_m`, `diffusivity_m2_s` and `t_end_s` finite and
/// positive, with the dimensionless end time τ_end = D·t_end/a² ≤ 1e200;
/// 2 ≤ `n_shells` ≤ 100 000; 1 ≤ `n_steps` ≤ 10 000 000.
#[derive(Clone, Debug, PartialEq)]
pub struct SphereReleaseParams {
    /// Sphere radius `a`, m: finite and > 0.
    pub radius_m: f64,
    /// Diffusivity `D`, m²/s: finite and > 0.
    pub diffusivity_m2_s: f64,
    /// Number of radial shells, from 2 to 100 000.
    pub n_shells: usize,
    /// End time, s: finite and > 0, with D·t_end/a² ≤ 1e200 (beyond that the
    /// matrix entries would overflow; by τ = 75 even the slowest mode has
    /// decayed by e^-740).
    pub t_end_s: f64,
    /// Number of equal time steps, from 1 to 10 000 000.
    pub n_steps: usize,
    /// Radial discretisation.
    pub grid: Grid,
    /// Time-integration scheme.
    pub scheme: Scheme,
}

/// Outputs of [`simulate_sphere_release`].
#[derive(Clone, Debug, PartialEq)]
pub struct SphereReleaseResult {
    /// Output times, s: `n_steps + 1` values from 0 to `t_end_s`.
    pub t_s: Vec<f64>,
    /// Numerical released fraction M_t/M_inf at each output time.
    pub released_fraction: Vec<f64>,
    /// Analytic released fraction ([`crank_sphere_release_fraction`]) at each output time.
    pub analytic_fraction: Vec<f64>,
    /// Outer radius of each shell, m (`n_shells` values; the last equals `radius_m`).
    pub shell_outer_radii_m: Vec<f64>,
    /// Concentration relative to the initial one, c/c0, in each shell at `t_end_s`.
    pub final_profile: Vec<f64>,
    /// Largest |numerical − analytic| released fraction over the output times.
    pub max_abs_error: f64,
    /// Largest gap between the mass that left through the surface and the mass
    /// lost from the shells, as a fraction of the initial mass. It measures
    /// discrete conservation.
    pub mass_balance_error: f64,
}

/// Errors from the kernel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelError {
    /// A parameter is outside its valid range.
    InvalidParameter {
        /// Parameter name, as in [`SphereReleaseParams`] or [`SolverOptions`].
        name: &'static str,
        /// What is wrong with it.
        reason: &'static str,
    },
}

impl KernelError {
    fn invalid(name: &'static str, reason: &'static str) -> Self {
        Self::InvalidParameter { name, reason }
    }
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidParameter { name, reason } => {
                write!(f, "invalid parameter `{name}`: {reason}")
            }
        }
    }
}

impl std::error::Error for KernelError {}

/// Numerical options for [`simulate_sphere_release_with`].
///
/// [`simulate_sphere_release`] uses [`SolverOptions::DEFAULT`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SolverOptions {
    /// Number of output intervals at the start of the run that are integrated
    /// on a finer sub-grid (default 4). Capped at `n_steps`.
    pub startup_intervals: usize,
    /// Equal sub-steps per start-up interval, from 1 to 1024 (default 8).
    /// 1 turns the start-up refinement off: every step then has the user's size.
    pub startup_substeps: usize,
    /// Crank–Nicolson only: how many steps at the start of the run are each
    /// replaced by two backward-Euler half-steps (Rannacher start-up; default 2).
    /// The steps counted are sub-steps when the start-up refinement is on.
    pub rannacher_steps: usize,
}

impl SolverOptions {
    /// The options used by [`simulate_sphere_release`]: four start-up
    /// intervals of eight sub-steps each, and two Rannacher steps (four
    /// half-steps).
    pub const DEFAULT: Self = Self {
        startup_intervals: 4,
        startup_substeps: 8,
        rannacher_steps: 2,
    };
}

impl Default for SolverOptions {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Run statistics from [`simulate_sphere_release_with`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolverDiagnostics {
    /// Smallest shell concentration c/c0 at any step, start-up sub-steps and
    /// half-steps included (1 if it never fell below the initial value).
    pub min_concentration: f64,
    /// Number of tridiagonal solves (steps, sub-steps and half-steps).
    pub linear_solves: usize,
}

/// Largest dimensionless end time D t_end / a² accepted. It keeps every
/// matrix entry finite. By τ = 75 even the slowest mode has decayed by e^{-740}.
const MAX_TAU: f64 = 1e200;

/// Largest value accepted for [`SolverOptions::startup_substeps`].
const MAX_STARTUP_SUBSTEPS: usize = 1024;

/// Simulates release from the sphere with a conservative finite-volume method.
///
/// Uses [`SolverOptions::DEFAULT`]. Returns an error if a parameter is out of
/// range, including D·t_end/a² > 1e200 (see [`SphereReleaseParams`]).
pub fn simulate_sphere_release(
    p: &SphereReleaseParams,
) -> Result<SphereReleaseResult, KernelError> {
    simulate_sphere_release_with(p, &SolverOptions::DEFAULT).map(|(result, _)| result)
}

/// [`simulate_sphere_release`] with explicit numerical options, also
/// returning run statistics.
///
/// Returns an error if a parameter or option is out of range, or if the
/// dimensionless end time D t_end / a² exceeds 1e200.
pub fn simulate_sphere_release_with(
    p: &SphereReleaseParams,
    options: &SolverOptions,
) -> Result<(SphereReleaseResult, SolverDiagnostics), KernelError> {
    validate(p)?;
    validate_options(options)?;
    let tau_end = dimensionless_time(p.t_end_s, p.radius_m, p.diffusivity_m2_s);
    let tau_ok = tau_end.is_finite() && tau_end <= MAX_TAU;
    if !tau_ok {
        return Err(KernelError::invalid(
            "t_end_s",
            "the dimensionless time D * t_end / radius^2 must not exceed 1e200",
        ));
    }
    let n_steps = p.n_steps;
    let dtau = tau_end / n_steps as f64;
    let shells = Shells::new(p.grid, p.n_shells);

    // All factorisations and buffers are set up before the time loop.
    let substeps = options.startup_substeps;
    let startup_intervals = if substeps > 1 {
        options.startup_intervals.min(n_steps)
    } else {
        0
    };
    let startup = (startup_intervals > 0)
        .then(|| Stepper::new(&shells, p.scheme, dtau / substeps as f64, true));
    let main = (startup_intervals < n_steps)
        .then(|| Stepper::new(&shells, p.scheme, dtau, startup_intervals == 0));
    let mut state = State::new(&shells);
    let mut recorder = Recorder::new(p, state.initial_mass);
    let mut saved_c = vec![0.0; p.n_shells];
    let mut saved_released = 0.0;
    recorder.record(0, &state);

    if let Some(stepper) = &startup {
        let mut index = 0;
        for k in 1..=startup_intervals {
            if k == startup_intervals {
                // BDF2 continues from here with the full step, so it needs
                // the state one output interval back.
                saved_c.copy_from_slice(&state.c);
                saved_released = state.released.value();
            }
            for _ in 0..substeps {
                state.step(stepper, p.scheme, index, options.rannacher_steps);
                index += 1;
            }
            recorder.record(k, &state);
        }
    }
    if let Some(stepper) = &main {
        if startup_intervals > 0 && p.scheme == Scheme::Bdf2 {
            state.c_prev.copy_from_slice(&saved_c);
            state.last_increment = state.released.value() - saved_released;
        }
        for (index, k) in (startup_intervals + 1..=n_steps).enumerate() {
            state.step(stepper, p.scheme, index, options.rannacher_steps);
            recorder.record(k, &state);
        }
    }

    let analytic_fraction: Vec<f64> = recorder
        .t_s
        .iter()
        .map(|&t| crank_sphere_release_fraction(t, p.radius_m, p.diffusivity_m2_s))
        .collect();
    let max_abs_error = recorder
        .released
        .iter()
        .zip(&analytic_fraction)
        .skip(1)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max);
    let shell_outer_radii_m = shells.faces[1..].iter().map(|r| p.radius_m * r).collect();
    let diagnostics = SolverDiagnostics {
        min_concentration: state.min_concentration,
        linear_solves: state.linear_solves,
    };
    let result = SphereReleaseResult {
        t_s: recorder.t_s,
        released_fraction: recorder.released,
        analytic_fraction,
        shell_outer_radii_m,
        final_profile: state.c,
        max_abs_error,
        mass_balance_error: recorder.mass_balance_error,
    };
    Ok((result, diagnostics))
}

fn validate(p: &SphereReleaseParams) -> Result<(), KernelError> {
    let positive = |x: f64| x.is_finite() && x > 0.0;
    if !positive(p.radius_m) {
        return Err(KernelError::invalid("radius_m", "must be finite and > 0"));
    }
    if !positive(p.diffusivity_m2_s) {
        return Err(KernelError::invalid(
            "diffusivity_m2_s",
            "must be finite and > 0",
        ));
    }
    if !positive(p.t_end_s) {
        return Err(KernelError::invalid("t_end_s", "must be finite and > 0"));
    }
    if !(2..=100_000).contains(&p.n_shells) {
        return Err(KernelError::invalid(
            "n_shells",
            "must be between 2 and 100000",
        ));
    }
    if !(1..=10_000_000).contains(&p.n_steps) {
        return Err(KernelError::invalid(
            "n_steps",
            "must be between 1 and 10000000",
        ));
    }
    Ok(())
}

fn validate_options(o: &SolverOptions) -> Result<(), KernelError> {
    if !(1..=MAX_STARTUP_SUBSTEPS).contains(&o.startup_substeps) {
        return Err(KernelError::invalid(
            "startup_substeps",
            "must be between 1 and 1024",
        ));
    }
    Ok(())
}

/// Neumaier's compensated sum: accurate to about one rounding for any number of terms.
#[derive(Clone, Copy, Debug, Default)]
struct CompensatedSum {
    sum: f64,
    compensation: f64,
}

impl CompensatedSum {
    fn add(&mut self, x: f64) {
        let t = self.sum + x;
        if self.sum.abs() >= x.abs() {
            self.compensation += (self.sum - t) + x;
        } else {
            self.compensation += (x - t) + self.sum;
        }
        self.sum = t;
    }

    fn value(self) -> f64 {
        self.sum + self.compensation
    }
}

/// Σ a_i b_i with compensated summation.
fn compensated_dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = CompensatedSum::default();
    for (x, y) in a.iter().zip(b) {
        s.add(x * y);
    }
    s.value()
}

/// Factorised matrices for one step size.
struct Stepper {
    /// Step size in τ.
    h: f64,
    /// Backward Euler: V + hK. BDF2: 3V + 2hK. Crank–Nicolson: V + (h/2)K,
    /// which is also the matrix of a backward-Euler half-step.
    main: TridiagonalLu,
    /// BDF2 starting the run: V + hK for its backward-Euler first step.
    first: Option<TridiagonalLu>,
    /// Whether this stepper takes the first step of the run.
    starts_run: bool,
}

impl Stepper {
    fn new(shells: &Shells, scheme: Scheme, h: f64, starts_run: bool) -> Self {
        let (main, first) = match scheme {
            Scheme::BackwardEuler => (shells.factor(1.0, h), None),
            Scheme::Bdf2 => (
                shells.factor(3.0, 2.0 * h),
                starts_run.then(|| shells.factor(1.0, h)),
            ),
            Scheme::CrankNicolson => (shells.factor(1.0, 0.5 * h), None),
        };
        Self {
            h,
            main,
            first,
            starts_run,
        }
    }
}

/// The evolving solution and its bookkeeping.
struct State<'a> {
    shells: &'a Shells,
    /// Σ V_j: the discrete initial mass (c0 = 1).
    initial_mass: f64,
    /// G_s / M0: released fraction per unit τ per unit outer-shell concentration.
    surface_rate: f64,
    /// Shell concentrations c/c0.
    c: Vec<f64>,
    /// BDF2: the state one step back.
    c_prev: Vec<f64>,
    /// Right-hand side and solution buffer.
    work: Vec<f64>,
    /// Released fraction, accumulated with the scheme's time discretisation.
    released: CompensatedSum,
    /// Released fraction during the last step (BDF2 recurrence in increment form).
    last_increment: f64,
    min_concentration: f64,
    linear_solves: usize,
}

impl<'a> State<'a> {
    fn new(shells: &'a Shells) -> Self {
        let n = shells.len();
        let mut mass = CompensatedSum::default();
        for &v in &shells.volume {
            mass.add(v);
        }
        let initial_mass = mass.value();
        Self {
            shells,
            initial_mass,
            surface_rate: shells.surface_conductance / initial_mass,
            c: vec![1.0; n],
            c_prev: vec![1.0; n],
            work: vec![0.0; n],
            released: CompensatedSum::default(),
            last_increment: 0.0,
            min_concentration: 1.0,
            linear_solves: 0,
        }
    }

    fn outer(&self) -> f64 {
        self.c[self.c.len() - 1]
    }

    /// Mass left in the shells, Σ V_j c_j.
    fn shell_mass(&self) -> f64 {
        compensated_dot(&self.shells.volume, &self.c)
    }

    /// Takes step number `index` (counted from the stepper's first step).
    fn step(&mut self, stepper: &Stepper, scheme: Scheme, index: usize, rannacher_steps: usize) {
        let h = stepper.h;
        match scheme {
            Scheme::BackwardEuler => self.backward_euler(&stepper.main, h),
            Scheme::Bdf2 => match &stepper.first {
                Some(first) if stepper.starts_run && index == 0 => {
                    self.c_prev.copy_from_slice(&self.c);
                    self.backward_euler(first, h);
                }
                _ => self.bdf2(&stepper.main, h),
            },
            Scheme::CrankNicolson => {
                if stepper.starts_run && index < rannacher_steps {
                    self.backward_euler(&stepper.main, 0.5 * h);
                    self.backward_euler(&stepper.main, 0.5 * h);
                } else {
                    self.crank_nicolson(&stepper.main, h);
                }
            }
        }
    }

    /// (V + hK) c⁺ = V c; released += h G_s c⁺_N / M0.
    fn backward_euler(&mut self, lu: &TridiagonalLu, h: f64) {
        for ((w, v), c) in self.work.iter_mut().zip(&self.shells.volume).zip(&self.c) {
            *w = v * c;
        }
        lu.solve_in_place(&mut self.work);
        std::mem::swap(&mut self.c, &mut self.work);
        let increment = h * self.surface_rate * self.outer();
        self.finish(increment);
    }

    /// (3V + 2hK) c⁺ = V (4c − c⁻); the released fraction follows the same
    /// recurrence, written for its increments: δ⁺ = (δ + 2h G_s c⁺_N / M0) / 3.
    fn bdf2(&mut self, lu: &TridiagonalLu, h: f64) {
        for (((w, v), c), cp) in self
            .work
            .iter_mut()
            .zip(&self.shells.volume)
            .zip(&self.c)
            .zip(&self.c_prev)
        {
            *w = v * (4.0 * c - cp);
        }
        lu.solve_in_place(&mut self.work);
        std::mem::swap(&mut self.c_prev, &mut self.c);
        std::mem::swap(&mut self.c, &mut self.work);
        let increment = (self.last_increment + 2.0 * h * self.surface_rate * self.outer()) / 3.0;
        self.finish(increment);
    }

    /// Crank–Nicolson as a backward-Euler half-step followed by extrapolation:
    /// (V + (h/2)K) c^½ = V c, then c⁺ = 2c^½ − c. This equals
    /// (V + (h/2)K) c⁺ = (V − (h/2)K) c. The trapezoidal surface flux,
    /// (h/2)(f + f⁺), equals h f^½.
    fn crank_nicolson(&mut self, lu: &TridiagonalLu, h: f64) {
        for ((w, v), c) in self.work.iter_mut().zip(&self.shells.volume).zip(&self.c) {
            *w = v * c;
        }
        lu.solve_in_place(&mut self.work);
        let increment = h * self.surface_rate * self.work[self.work.len() - 1];
        for (c, half) in self.c.iter_mut().zip(&self.work) {
            *c = 2.0 * half - *c;
        }
        self.finish(increment);
    }

    fn finish(&mut self, increment: f64) {
        self.released.add(increment);
        self.last_increment = increment;
        self.linear_solves += 1;
        self.min_concentration = self.c.iter().fold(self.min_concentration, |m, &x| m.min(x));
    }
}

/// Output series, filled at each output time without reallocating.
struct Recorder {
    t_end_s: f64,
    n_steps: usize,
    initial_mass: f64,
    t_s: Vec<f64>,
    released: Vec<f64>,
    mass_balance_error: f64,
}

impl Recorder {
    fn new(p: &SphereReleaseParams, initial_mass: f64) -> Self {
        Self {
            t_end_s: p.t_end_s,
            n_steps: p.n_steps,
            initial_mass,
            t_s: Vec::with_capacity(p.n_steps + 1),
            released: Vec::with_capacity(p.n_steps + 1),
            mass_balance_error: 0.0,
        }
    }

    /// Records output time k (t = k/n · t_end, so the last time is exactly t_end).
    fn record(&mut self, k: usize, state: &State<'_>) {
        let released = state.released.value();
        let lost_from_shells = (self.initial_mass - state.shell_mass()) / self.initial_mass;
        self.mass_balance_error = self
            .mass_balance_error
            .max((released - lost_from_shells).abs());
        self.t_s.push(k as f64 / self.n_steps as f64 * self.t_end_s);
        self.released.push(released);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> SphereReleaseParams {
        SphereReleaseParams {
            radius_m: 150e-6,
            diffusivity_m2_s: 1e-10,
            n_shells: 64,
            t_end_s: 60.0,
            n_steps: 2000,
            grid: Grid::EqualVolume,
            scheme: Scheme::Bdf2,
        }
    }

    #[test]
    fn solver_tracks_the_analytic_solution() {
        let r = simulate_sphere_release(&reference()).unwrap();
        assert_eq!(r.t_s.len(), 2001);
        assert_eq!(r.t_s[0], 0.0);
        assert_eq!(r.t_s[2000], 60.0);
        assert_eq!(r.released_fraction[0], 0.0);
        assert_eq!(r.shell_outer_radii_m.len(), 64);
        assert_eq!(r.shell_outer_radii_m[63], 150e-6);
        assert!(r.max_abs_error < 1e-3, "max abs error {}", r.max_abs_error);
        assert!(
            r.mass_balance_error < 1e-12,
            "mass balance {}",
            r.mass_balance_error
        );
    }

    #[test]
    fn rejects_bad_parameters() {
        let mut p = SphereReleaseParams {
            radius_m: 1e-4,
            diffusivity_m2_s: 1e-10,
            n_shells: 1,
            t_end_s: 1.0,
            n_steps: 10,
            grid: Grid::UniformRadius,
            scheme: Scheme::BackwardEuler,
        };
        assert!(simulate_sphere_release(&p).is_err());
        p.n_shells = 8;
        p.radius_m = f64::NAN;
        assert!(simulate_sphere_release(&p).is_err());
        assert!(Grid::parse("hexagonal").is_err());
        assert_eq!(Scheme::parse("bdf2"), Ok(Scheme::Bdf2));
    }

    #[test]
    fn rejects_bad_options() {
        let p = reference();
        for substeps in [0, 1025] {
            let o = SolverOptions {
                startup_substeps: substeps,
                ..SolverOptions::DEFAULT
            };
            let err = simulate_sphere_release_with(&p, &o).unwrap_err();
            assert_eq!(
                err,
                KernelError::invalid("startup_substeps", "must be between 1 and 1024")
            );
        }
    }

    #[test]
    fn counts_solves_for_each_start_up() {
        let count = |scheme, n_steps, options: SolverOptions| {
            let p = SphereReleaseParams {
                scheme,
                n_steps,
                ..reference()
            };
            simulate_sphere_release_with(&p, &options)
                .unwrap()
                .1
                .linear_solves
        };
        let d = SolverOptions::DEFAULT;
        // Four intervals of eight sub-steps, then six full steps.
        assert_eq!(count(Scheme::BackwardEuler, 10, d), 4 * 8 + 6);
        assert_eq!(count(Scheme::Bdf2, 10, d), 4 * 8 + 6);
        // Two sub-steps become four half-steps.
        assert_eq!(count(Scheme::CrankNicolson, 10, d), 4 * 8 + 2 + 6);
        let plain = SolverOptions {
            startup_substeps: 1,
            ..d
        };
        assert_eq!(count(Scheme::BackwardEuler, 10, plain), 10);
        assert_eq!(count(Scheme::CrankNicolson, 10, plain), 12);
        // Start-up longer than the run: everything is sub-stepped.
        assert_eq!(count(Scheme::Bdf2, 2, d), 2 * 8);
    }

    #[test]
    fn plain_backward_euler_matches_a_direct_implementation() {
        // With the start-up off, backward Euler is the textbook recurrence.
        let p = SphereReleaseParams {
            n_shells: 5,
            n_steps: 7,
            grid: Grid::UniformRadius,
            scheme: Scheme::BackwardEuler,
            ..reference()
        };
        let options = SolverOptions {
            startup_substeps: 1,
            ..SolverOptions::DEFAULT
        };
        let (r, _) = simulate_sphere_release_with(&p, &options).unwrap();
        let shells = Shells::new(Grid::UniformRadius, 5);
        let dtau = p.diffusivity_m2_s * p.t_end_s / (p.radius_m * p.radius_m) / 7.0;
        let lu = shells.factor(1.0, dtau);
        let mut c = vec![1.0; 5];
        let mut released = 0.0;
        for k in 1..=7 {
            let mut rhs: Vec<f64> = c.iter().zip(&shells.volume).map(|(c, v)| c * v).collect();
            lu.solve_in_place(&mut rhs);
            c = rhs;
            released += dtau * shells.surface_conductance * c[4] / (1.0 / 3.0);
            assert!((r.released_fraction[k] - released).abs() < 1e-14);
        }
        for (a, b) in r.final_profile.iter().zip(&c) {
            assert!((a - b).abs() < 1e-14);
        }
    }

    #[test]
    fn rejects_overflowing_dimensionless_time() {
        let p = SphereReleaseParams {
            radius_m: 1e-160,
            ..reference()
        };
        assert!(simulate_sphere_release(&p).is_err());
        // An underflowing one is harmless: nothing is released.
        let p = SphereReleaseParams {
            radius_m: 1e160,
            ..reference()
        };
        let r = simulate_sphere_release(&p).unwrap();
        assert!(r.released_fraction.iter().all(|&f| f == 0.0));
        assert!(r.final_profile.iter().all(|&c| c == 1.0));
    }

    #[test]
    fn extreme_but_valid_inputs_use_the_overflow_safe_time() {
        // D·t and a² both overflow to infinity, yet τ = D t / a² = 1.
        let p = SphereReleaseParams {
            radius_m: 1e155,
            diffusivity_m2_s: 1e300,
            t_end_s: 1e10,
            ..reference()
        };
        let tau = dimensionless_time(p.t_end_s, p.radius_m, p.diffusivity_m2_s);
        assert!((tau - 1.0).abs() < 1e-15, "{tau}");
        let r = simulate_sphere_release(&p).unwrap();
        let unit = SphereReleaseParams {
            radius_m: 1.0,
            diffusivity_m2_s: 1.0,
            t_end_s: 1.0,
            ..reference()
        };
        let u = simulate_sphere_release(&unit).unwrap();
        for (a, b) in r.released_fraction.iter().zip(&u.released_fraction) {
            assert!((a - b).abs() < 1e-13);
        }
        for (a, b) in r.analytic_fraction.iter().zip(&u.analytic_fraction) {
            assert!((a - b).abs() < 1e-14);
        }
        assert!(r.max_abs_error.is_finite());
        assert_eq!(r.shell_outer_radii_m[63], 1e155);
        // Ordinary inputs keep the original evaluation order, bit for bit.
        let ordinary = reference();
        assert_eq!(
            dimensionless_time(
                ordinary.t_end_s,
                ordinary.radius_m,
                ordinary.diffusivity_m2_s
            )
            .to_bits(),
            (1e-10_f64 * 60.0 / (150e-6 * 150e-6)).to_bits()
        );
    }
}
