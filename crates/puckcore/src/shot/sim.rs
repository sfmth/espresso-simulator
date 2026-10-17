// SPDX-License-Identifier: GPL-2.0-or-later
//! The shot driver: state, machine program, hydraulics, time loop, events
//! and outputs. `docs/model/shot-model.md` describes the model; this file
//! follows its §4 (hydraulics, program, wetting), §6 (thermal) and §7.2
//! (time steps and events).

use super::hydraulics::{self, BedCurve, Supply};
use super::model::{ClassModel, Model};
use super::props::{self, kozeny_carman};
use super::transport::{self, Scratch, StepInput};
use super::validate;
use super::*;
use crate::math::{self, fmax, fmin};

/// Below this flow into the bed (m³/s), and below a tenth of the flow the
/// program asks for, the shot counts as stalled.
const CHOKE_FLOW_M3_S: f64 = 1e-8;
/// A stall lasting this long (s) while the program asks for flow ends the
/// shot as `"choked"`.
const CHOKE_TIME_S: f64 = 5.0;
/// Mass events fire within this margin, kg.
const MASS_TOLERANCE_KG: f64 = 1e-7;
/// Legacy decay time constants, or compliance-tail observation duration.
const DRIP_TAUS: f64 = 8.0;
/// Smallest wetted depth used for a column's resistance, as a share of the
/// bed height (it regularises the instant the front enters the bed).
const MIN_WETTED_DEPTH: f64 = 1e-6;
/// A step whose regimes do not converge is retried at half the step this many
/// times before the run fails.
const MAX_HALVINGS: usize = 12;
/// A step that overshoots a mass target is re-landed at most this many times.
const MAX_RELANDS: usize = 8;
/// The drip ends below this share of its initial source volume.
const DRIP_EMPTY: f64 = 1e-9;
/// Relative mass-balance error above which a warning is issued. The balance
/// is algebraic, so round-off alone stays near 1e-12 even for stiff specs at
/// the validation bounds (shot-model.md §7.4).
const MASS_WARN: f64 = 1e-9;
/// Relative mass-balance error above which the run fails: three orders above
/// the warning, and far above any round-off the bounds allow; the cup totals
/// would no longer be meaningful to their reported precision.
const MASS_FAIL: f64 = 1e-6;
/// Negative concentrations beyond these shares of the concentration scale
/// warn, or fail (a broken solve rather than round-off).
const NEGATIVE_WARN: f64 = 1e-9;
const NEGATIVE_FAIL: f64 = 1e-3;

/// The state of one species group, for a unit mass fraction (a member's
/// values are these times its mass fraction).
#[derive(Clone, Debug)]
pub(crate) struct SpeciesState {
    pub m: Vec<f64>,
    pub pool: Vec<f64>,
    pub u: Vec<f64>,
    pub u_prev: Vec<f64>,
    /// Kernel boundary value held at the initial content, per (cell, class).
    pub kcap: Vec<bool>,
    pub cup: f64,
    pub initial: f64,
    /// Smallest concentration seen, kg/m³ (unit mass fraction).
    pub min_conc: f64,
}

/// The evolving state. Cells are indexed `column · n_cells + j`; pools
/// `cell · n_classes + k`; kernel shells shell-major,
/// `(offset_k + l) · n_cells_total + cell` (see [`kernel_index`]).
#[derive(Clone, Debug)]
pub(crate) struct State {
    pub t: f64,
    pub temp: f64,
    /// Pressure of the optional charged upstream compliance, Pa gauge.
    pub stored_pressure: f64,
    pub headspace_filled: f64,
    pub headspace_full: bool,
    /// Wetted bed volume of each column, m³.
    pub wetted: Vec<f64>,
    pub through: Vec<bool>,
    pub t_through: Vec<f64>,
    /// Liquid solute mass per cell, kg.
    pub m: Vec<f64>,
    pub eps: Vec<f64>,
    /// When each cell wetted (∞ while dry).
    pub t_wet: Vec<f64>,
    /// Lumped solubles held by the particles of each cell, kg (updated
    /// incrementally; true sums are taken at check points).
    pub particle: Vec<f64>,
    pub particle0: Vec<f64>,
    /// Dry solid mass of each cell, kg.
    pub dry: Vec<f64>,
    pub pool: Vec<f64>,
    /// Initial pool content per (cell, class), kg: the pool cap.
    pub pool0: Vec<f64>,
    /// Pool regime (saturated) per (cell, class).
    pub regime: Vec<bool>,
    /// Pool held at its initial content, per (cell, class).
    pub pcap: Vec<bool>,
    /// Kernel boundary value held at u₀ (loading cap), per (cell, class).
    pub kcap: Vec<bool>,
    pub u: Vec<f64>,
    pub u_prev: Vec<f64>,
    /// Species groups (`Model::groups`).
    pub groups: Vec<SpeciesState>,
    pub cup_water: f64,
    pub cup_solute: f64,
    /// Integrated carrier-liquid volumes for hydraulic conservation. Solute
    /// displacement and dissolution-created porosity are not water sources.
    pub volume_in: f64,
    pub volume_out: f64,
    pub volume_vented: f64,
    pub min_conc: f64,
    /// Largest lumped bed-liquid concentration seen, kg/m³.
    pub max_conc: f64,
    pub initial_solubles: f64,
    /// Lumped solute the kernels of each class took up from the liquid
    /// (gross, summed over cells and steps), kg; a diagnostic of re-uptake.
    pub kernel_uptake: Vec<f64>,
}

impl State {
    fn new(model: &Model, spec: &ShotSpec) -> Self {
        let nc = model.n_cells();
        let ncol = model.columns.len();
        let nk = model.n_classes();
        let ns = model.shells_per_cell;
        let cells = ncol * nc;
        let u0 = model.u0;
        let mut pool = vec![0.0; cells * nk];
        let mut u = vec![0.0; cells * ns];
        let mut particle = vec![0.0; cells];
        let mut dry = vec![0.0; cells];
        let mut groups: Vec<SpeciesState> = model
            .groups
            .iter()
            .map(|_| SpeciesState {
                m: vec![0.0; cells],
                pool: vec![0.0; cells * nk],
                u: vec![0.0; cells * ns],
                u_prev: vec![0.0; cells * ns],
                kcap: vec![false; cells * nk],
                cup: 0.0,
                initial: 0.0,
                min_conc: f64::INFINITY,
            })
            .collect();
        for (i, column) in model.columns.iter().enumerate() {
            for (j, c) in model.cells.iter().enumerate() {
                let cell = i * nc + j;
                let vol = column.share * c.volume;
                dry[cell] = model.dry_density * vol;
                let mut held = 0.0;
                for (k, class) in model.classes.iter().enumerate() {
                    let p = model.s0 * class.pool_fraction * class.phi * vol;
                    pool[cell * nk + k] = p;
                    held += p;
                    if let Some(grid) = &class.grid {
                        for l in 0..grid.len() {
                            u[kernel_index(model, i, class.offset + l, j)] = u0;
                        }
                        held += class.sigma * vol * kernel_mass(model, &u, i, j, class);
                    }
                    for (g, group) in model.groups.iter().enumerate() {
                        let st = &mut groups[g];
                        st.pool[cell * nk + k] = group.pool0[k] * vol;
                        if let Some(grid) = &class.grid {
                            for l in 0..grid.len() {
                                st.u[kernel_index(model, i, class.offset + l, j)] =
                                    group.kernel0[k];
                            }
                        }
                    }
                }
                particle[cell] = held;
            }
        }
        for st in &mut groups {
            st.u_prev.copy_from_slice(&st.u);
        }
        let mut s = Self {
            t: 0.0,
            temp: spec.thermal.initial_bed_temp_c,
            stored_pressure: 0.0,
            headspace_filled: 0.0,
            headspace_full: model.headspace_volume <= 0.0,
            wetted: vec![0.0; ncol],
            through: vec![false; ncol],
            t_through: vec![f64::INFINITY; ncol],
            m: vec![0.0; cells],
            eps: vec![model.eps0; cells],
            t_wet: vec![f64::INFINITY; cells],
            particle0: particle.clone(),
            particle,
            dry,
            pool0: pool.clone(),
            pool,
            regime: vec![true; cells * nk],
            pcap: vec![false; cells * nk],
            kcap: vec![false; cells * nk],
            u_prev: u.clone(),
            u,
            groups,
            cup_water: 0.0,
            cup_solute: 0.0,
            volume_in: 0.0,
            volume_out: 0.0,
            volume_vented: 0.0,
            min_conc: f64::INFINITY,
            max_conc: 0.0,
            initial_solubles: 0.0,
            kernel_uptake: vec![0.0; nk],
        };
        let (lumped, by_group) = totals(model, &s);
        s.initial_solubles = lumped.particles;
        for (st, t) in s.groups.iter_mut().zip(by_group) {
            st.initial = t.particles;
        }
        s
    }

    /// Bed-liquid concentration of a cell, kg/m³ (0 while dry): its solute
    /// over its holdup (the wetted share of it at the front).
    pub fn conc(&self, model: &Model, cell: usize) -> f64 {
        let nc = model.n_cells();
        let hold = transport::holdup_volume(model, self, cell / nc, cell % nc);
        if self.t_wet[cell] < f64::INFINITY && hold > 0.0 {
            self.m[cell] / hold
        } else {
            0.0
        }
    }
}

/// Soluble inventory at one instant, kg.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Totals {
    pub particles: f64,
    pub liquid: f64,
    pub cup: f64,
}

/// Neumaier's compensated sum.
#[derive(Clone, Copy, Debug, Default)]
struct Sum {
    s: f64,
    c: f64,
}

impl Sum {
    fn add(&mut self, x: f64) {
        let t = self.s + x;
        if self.s.abs() >= x.abs() {
            self.c += (self.s - t) + x;
        } else {
            self.c += (x - t) + self.s;
        }
        self.s = t;
    }
    fn value(self) -> f64 {
        self.s + self.c
    }
}

/// Index of shell `shell` (class offset + l) of depth cell `j` in column
/// `col`: kernels are stored shell-major, contiguous across all cells.
#[inline]
pub(crate) fn kernel_index(model: &Model, col: usize, shell: usize, j: usize) -> usize {
    let nc = model.n_cells();
    shell * nc * model.columns.len() + col * nc + j
}

/// Σ Ṽ u of one class's kernel in one cell (compensated).
fn kernel_mass(model: &Model, u: &[f64], col: usize, j: usize, class: &ClassModel) -> f64 {
    let Some(grid) = &class.grid else { return 0.0 };
    let mut kernel = Sum::default();
    for (l, v) in grid.volume.iter().enumerate() {
        kernel.add(v * u[kernel_index(model, col, class.offset + l, j)]);
    }
    kernel.value()
}

/// True inventories (lumped, then each species group), with compensated sums.
fn totals(model: &Model, state: &State) -> (Totals, Vec<Totals>) {
    let nc = model.n_cells();
    let nk = model.n_classes();
    let one = |m: &[f64], pool: &[f64], u: &[f64], cup: f64| {
        let (mut part, mut liq) = (Sum::default(), Sum::default());
        for (i, column) in model.columns.iter().enumerate() {
            for (j, c) in model.cells.iter().enumerate() {
                let cell = i * nc + j;
                let vol = column.share * c.volume;
                liq.add(m[cell]);
                for (k, class) in model.classes.iter().enumerate() {
                    part.add(pool[cell * nk + k]);
                    if class.grid.is_some() {
                        part.add(class.sigma * vol * kernel_mass(model, u, i, j, class));
                    }
                }
            }
        }
        Totals {
            particles: part.value(),
            liquid: liq.value(),
            cup,
        }
    };
    let lumped = one(&state.m, &state.pool, &state.u, state.cup_solute);
    let groups = state
        .groups
        .iter()
        .map(|st| one(&st.m, &st.pool, &st.u, st.cup))
        .collect();
    (lumped, groups)
}

/// Per-cell particle solubles (true sums), for local EY.
fn cell_particles(model: &Model, state: &State, cell: usize) -> f64 {
    let nk = model.n_classes();
    let nc = model.n_cells();
    let (col, j) = (cell / nc, cell % nc);
    let vol = model.columns[col].share * model.cells[j].volume;
    let mut part = Sum::default();
    for (k, class) in model.classes.iter().enumerate() {
        part.add(state.pool[cell * nk + k]);
        if class.grid.is_some() {
            part.add(class.sigma * vol * kernel_mass(model, &state.u, col, j, class));
        }
    }
    part.value()
}

/// The machine program's position.
#[derive(Clone, Copy, Debug)]
struct Program {
    phase: usize,
    start: f64,
    ramp_from: f64,
}

/// What drives the inlet.
#[derive(Clone, Copy, Debug)]
enum Mode {
    Program,
    Drip {
        t_stop: f64,
        p_stop: f64,
        t_end: f64,
    },
}

/// Hydraulic state at one instant.
#[derive(Clone, Debug, Default)]
struct Hydro {
    pressure: f64,
    /// Pump flow into the headspace, bed and optional pressure storage, m³/s.
    pump_flow: f64,
    /// Flow of each column, m³/s.
    col_flow: Vec<f64>,
    /// Flow leaving the basket, m³/s.
    out_flow: f64,
}

/// The cheap part of the state an attempt changes before the transport can
/// fail (the step is then retried shorter).
#[derive(Clone, Debug)]
struct Light {
    stored_pressure: f64,
    headspace_filled: f64,
    headspace_full: bool,
    wetted: Vec<f64>,
    through: Vec<bool>,
    t_through: Vec<f64>,
    t_wet: Vec<f64>,
    temp: f64,
    first_drops: Option<f64>,
    drip_water: f64,
    curve: BedCurve,
}

/// A full copy, kept only for steps that may reach a mass target.
#[derive(Clone, Debug)]
struct Full {
    state: State,
    first_drops: Option<f64>,
    drip_water: f64,
    curve: BedCurve,
    dt_prev: f64,
}

/// Snapshot candidates, thinned by halving so their number stays bounded.
#[derive(Clone, Debug, Default)]
struct Snapshots {
    every: usize,
    kept: Vec<(usize, Snapshot)>,
    limit: usize,
}

struct Sim<'a> {
    spec: &'a ShotSpec,
    model: &'a Model,
    state: State,
    scratch: Scratch,
    program: Program,
    mode: Mode,
    /// Per-cell resistance without the time-dependent factors, at the
    /// current step's start, Pa s/m³.
    cell_r: Vec<f64>,
    curve: BedCurve,
    hydro: Hydro,
    dt_base: f64,
    dt_prev: f64,
    output_index: usize,
    series: Series,
    snapshots: Snapshots,
    first_drops: Option<f64>,
    max_pressure: f64,
    steps: usize,
    stop_reason: Option<&'static str>,
    shot_time: f64,
    cup_at_stop: f64,
    stall_since: Option<f64>,
    mass_error: f64,
    /// Remaining drip source: legacy headspace or charged storage, m³.
    drip_water: f64,
    /// Outlet solute flux now (Σ q·c over the columns through), kg/s, and
    /// its trapezoidal integral over the run, kg.
    outlet_flux: f64,
    outlet_integral: f64,
    /// Steps rejected and retried (unconverged regimes, overshot mass targets).
    rejected_steps: usize,
    warnings: Vec<String>,
}

/// Runs a validated spec.
pub(crate) fn run(spec: &ShotSpec) -> Result<ShotResult, ShotError> {
    let mut warnings = validate::validate(spec)?;
    let model = Model::new(spec, &mut warnings);
    let mut sim = Sim::new(spec, &model, warnings);
    sim.run()?;
    sim.finish()
}

impl<'a> Sim<'a> {
    fn new(spec: &'a ShotSpec, model: &'a Model, warnings: Vec<String>) -> Self {
        let state = State::new(model, spec);
        let ncol = model.columns.len();
        let ncells = ncol * model.n_cells();
        let n = &spec.numerics;
        let substeps = (n.output_interval_s / n.max_dt_s).ceil().max(1.0);
        let series = Series {
            species_cup_kg: model
                .species
                .iter()
                .map(|s| SpeciesSeries {
                    id: s.id.clone(),
                    values: Vec::new(),
                })
                .collect(),
            ..Series::default()
        };
        let mut curve = BedCurve {
            resistance: vec![0.0; ncol],
            through: vec![false; ncol],
            outlet: model.outlet_coefficient,
            poro: model.poro.pc,
            ..BedCurve::default()
        };
        curve.finish();
        Self {
            spec,
            model,
            state,
            scratch: Scratch::new(model),
            program: Program {
                phase: 0,
                start: 0.0,
                ramp_from: 0.0,
            },
            mode: Mode::Program,
            cell_r: vec![0.0; ncells],
            curve,
            hydro: Hydro {
                col_flow: vec![0.0; ncol],
                ..Hydro::default()
            },
            dt_base: n.output_interval_s / substeps,
            dt_prev: 0.0,
            output_index: 0,
            series,
            snapshots: Snapshots {
                every: 1,
                kept: Vec::new(),
                limit: 4 * n.snapshot_count.max(1),
            },
            first_drops: None,
            max_pressure: 0.0,
            steps: 0,
            stop_reason: None,
            shot_time: 0.0,
            cup_at_stop: 0.0,
            stall_since: None,
            mass_error: 0.0,
            drip_water: 0.0,
            outlet_flux: 0.0,
            outlet_integral: 0.0,
            rejected_steps: 0,
            warnings,
        }
    }

    // ----- Program and supply -------------------------------------------------

    fn pump_caps(&self) -> (f64, f64, Option<(f64, f64)>) {
        match &self.spec.machine.pump {
            Pump::Ideal {
                max_flow_m3_s,
                max_pressure_pa,
            } => (*max_flow_m3_s, *max_pressure_pa, None),
            Pump::Vibratory {
                free_flow_m3_s,
                stall_pressure_pa,
                opv_pa,
            } => (
                f64::INFINITY,
                opv_pa.map_or(*stall_pressure_pa, |o| fmin(o, *stall_pressure_pa)),
                Some((*free_flow_m3_s, *stall_pressure_pa)),
            ),
        }
    }

    /// Right-hand rate of the pressure cap. A pressure ramp can charge or
    /// discharge compliance even while pressure exactly tracks the command;
    /// the pump's own pressure limit stays constant.
    fn pressure_cap_rate(&self, t: f64) -> f64 {
        if !matches!(self.mode, Mode::Program) {
            return 0.0;
        }
        let ph = &self.spec.machine.phases[self.program.phase];
        let Control::Pressure { target_pa } = ph.control else {
            return 0.0;
        };
        let elapsed = t - self.program.start;
        if ph.ramp_s <= 0.0 || elapsed < 0.0 || elapsed >= ph.ramp_s {
            return 0.0;
        }
        let slope = (target_pa - self.program.ramp_from) / ph.ramp_s;
        let commanded =
            self.program.ramp_from + (target_pa - self.program.ramp_from) * (elapsed / ph.ramp_s);
        let (_, pump_cap, _) = self.pump_caps();
        if commanded > pump_cap || (commanded == pump_cap && slope >= 0.0) {
            0.0
        } else {
            slope
        }
    }

    /// The supply at time `t`, and the pump flow while the headspace fills.
    fn supply(&self, t: f64) -> (Supply, f64) {
        match self.mode {
            Mode::Drip { t_stop, p_stop, .. } => {
                if self.spec.machine.hydraulic_compliance_m3_pa > 0.0 {
                    // The charged volume supplies the bed after the pump
                    // stops. No empirical pressure boundary is imposed.
                    return (
                        Supply {
                            flow_cap: 0.0,
                            pump: None,
                            pressure_cap: 0.0,
                        },
                        0.0,
                    );
                }
                // The headspace water drains into the puck under the decaying
                // pressure until it is gone.
                let tau = self.spec.machine.stop.drip_tau_s;
                let p = if tau > 0.0 && self.drip_water > 0.0 {
                    p_stop * math::exp(-(t - t_stop) / tau)
                } else {
                    0.0
                };
                (
                    Supply {
                        flow_cap: f64::INFINITY,
                        pump: None,
                        pressure_cap: p,
                    },
                    0.0,
                )
            }
            Mode::Program => {
                let ph = &self.spec.machine.phases[self.program.phase];
                let (flow_cap, p_cap, pump) = self.pump_caps();
                let ramp = |target: f64| {
                    if ph.ramp_s > 0.0 {
                        let s = (t - self.program.start) / ph.ramp_s;
                        if s >= 1.0 {
                            target
                        } else {
                            self.program.ramp_from
                                + (target - self.program.ramp_from) * fmax(s, 0.0)
                        }
                    } else {
                        target
                    }
                };
                let limit = ph.limit.unwrap_or(f64::INFINITY);
                let supply = match ph.control {
                    Control::Pressure { target_pa } => Supply {
                        flow_cap: fmin(limit, flow_cap),
                        pump,
                        pressure_cap: fmin(ramp(target_pa), p_cap),
                    },
                    Control::Flow { target_m3_s } => {
                        let q = ramp(target_m3_s);
                        Supply {
                            flow_cap: fmin(q, flow_cap),
                            pump,
                            pressure_cap: fmin(limit, p_cap),
                        }
                    }
                    Control::PumpFull => Supply {
                        flow_cap,
                        pump,
                        pressure_cap: p_cap,
                    },
                };
                // A zero pressure limit disables delivery even while the
                // headspace is empty. During a pressure ramp-down, the
                // instantaneous positive command still delivers water.
                let fill = if supply.pressure_cap > 0.0 {
                    supply.at(0.0)
                } else {
                    0.0
                };
                (supply, fill)
            }
        }
    }

    /// The flow the program currently asks for, m³/s: the supply's flow at
    /// zero pressure (the flow target under flow control), or 0 when it asks
    /// for none (for stall detection).
    fn demand_flow(&self, t: f64) -> f64 {
        match self.mode {
            Mode::Drip { .. } => 0.0,
            Mode::Program => {
                let (s, fill) = self.supply(t);
                if s.pressure_cap > 0.0 { fill } else { 0.0 }
            }
        }
    }

    /// Exact integral of the unpressurised fill flow within the current
    /// phase. A flow ramp is piecewise affine after the pump caps; pressure
    /// programs deliver their free flow whenever the instantaneous pressure
    /// command is positive. Midpoints avoid counting the isolated zero at
    /// the start of a pressure ramp as half an integration interval.
    fn fill_volume(&self, t0: f64, t1: f64) -> f64 {
        if !matches!(self.mode, Mode::Program) {
            return 0.0;
        }
        let ph = &self.spec.machine.phases[self.program.phase];
        let mut edges = vec![t0, t1];
        if ph.ramp_s > 0.0 {
            let end = self.program.start + ph.ramp_s;
            if end > t0 && end < t1 {
                edges.push(end);
            }
            if let Control::Flow { target_m3_s } = ph.control {
                let slope = (target_m3_s - self.program.ramp_from) / ph.ramp_s;
                if slope != 0.0 {
                    let (cap, _, pump) = self.pump_caps();
                    let cap = pump.map_or(cap, |(free, _)| fmin(cap, free));
                    let at_cap = self.program.start + (cap - self.program.ramp_from) / slope;
                    if at_cap > t0 && at_cap < t1 && at_cap < end {
                        edges.push(at_cap);
                    }
                }
            }
        }
        edges.sort_by(|a, b| a.total_cmp(b));
        edges
            .windows(2)
            .map(|w| (w[1] - w[0]) * self.supply(0.5 * (w[0] + w[1])).1)
            .sum()
    }

    // ----- Hydraulics ------------------------------------------------------------

    /// Per-cell resistances without the time-dependent factors.
    fn update_cell_resistances(&mut self) {
        let m = self.model;
        let h = &self.spec.hydraulics;
        let nc = m.n_cells();
        let mu_w = props::water_viscosity_pa_s(self.state.temp);
        let kc0 = kozeny_carman(m.eps0);
        for (i, column) in m.columns.iter().enumerate() {
            let k_col = h.permeability_m2 * column.multiplier * column.share;
            for (j, c) in m.cells.iter().enumerate() {
                let cell = i * nc + j;
                // Dry cells hold no liquid yet: water viscosity, initial porosity.
                let eps = self.state.eps[cell];
                let conc = self.state.conc(m, cell);
                let kc = if h.dissolution_kozeny_carman {
                    kozeny_carman(eps) / kc0
                } else {
                    1.0
                };
                let mu = mu_w * m.liquid.relative_viscosity(conc);
                self.cell_r[cell] = mu * c.inverse_area / (k_col * kc);
            }
        }
    }

    /// Swelling × CO₂ × pore-air permeability factor since a cell wetted.
    fn time_factor(&self, t: f64, t_wet: f64) -> f64 {
        let h = &self.spec.hydraulics;
        let since = if t_wet < t { t - t_wet } else { 0.0 };
        let mut f = 1.0;
        if h.swelling.amplitude > 0.0 {
            let decay = if h.swelling.tau_s > 0.0 {
                math::exp(-since / h.swelling.tau_s)
            } else {
                0.0
            };
            f *= 1.0 - h.swelling.amplitude * (1.0 - decay);
        }
        if h.gas.amplitude > 0.0 {
            let decay = if h.gas.tau_s > 0.0 {
                math::exp(-since / h.gas.tau_s)
            } else {
                0.0
            };
            f *= 1.0 - h.gas.amplitude * decay;
        }
        if h.pore_air.amplitude > 0.0 && h.pore_air.tau_s > 0.0 {
            let connectivity = 1.0 - h.pore_air.amplitude * math::exp(-since / h.pore_air.tau_s);
            let n = h.pore_air_permeability_exponent;
            f *= if n == 1.0 {
                connectivity
            } else if n == 3.0 {
                connectivity * connectivity * connectivity
            } else {
                math::exp(n * math::ln(connectivity))
            };
        }
        f
    }

    /// Builds the bed curve at time `t` for wetted volumes `wetted`.
    fn build_curve(&mut self, t: f64, wetted: &[f64]) {
        let m = self.model;
        let h = &self.spec.hydraulics;
        let nc = m.n_cells();
        let timed =
            h.swelling.amplitude > 0.0 || h.gas.amplitude > 0.0 || h.pore_air.amplitude > 0.0;
        for (i, column) in m.columns.iter().enumerate() {
            let w = wetted[i];
            let through = w >= column.volume * (1.0 - 1e-12);
            let mut r = 0.0;
            for (j, c) in m.cells.iter().enumerate() {
                let top = column.cum_volume[j];
                if w <= top {
                    break;
                }
                let cell = i * nc + j;
                let f_t = if timed {
                    self.time_factor(t, self.state.t_wet[cell])
                } else {
                    1.0
                };
                let bottom = column.cum_volume[j + 1];
                if w >= bottom || through {
                    r += self.cell_r[cell] / f_t;
                } else {
                    // Partial front cell: ∫ dz/A from the cell top to the front.
                    let h_front = m.profile.height_below(c.h_top, (w - top) / column.share);
                    let part = m.profile.inverse_area_integral(h_front, c.h_top);
                    r += self.cell_r[cell] * (part / c.inverse_area) / f_t;
                }
            }
            if through {
                let f = &h.fines_layer;
                if f.amplitude > 0.0 {
                    let since = t - self.state.t_through[i];
                    let grow = if f.tau_s > 0.0 {
                        1.0 - math::exp(-fmax(since, 0.0) / f.tau_s)
                    } else {
                        1.0
                    };
                    // A·(R₀·grow): no layer (and no inf·0) before it grows.
                    if grow > 0.0 {
                        r += f.amplitude * (column.r0 * grow);
                    }
                }
            } else {
                // Regularise the instant the front enters the bed.
                let r_min = column.r0 * MIN_WETTED_DEPTH;
                r = fmax(r, r_min);
            }
            self.curve.resistance[i] = r;
            self.curve.through[i] = through;
        }
        self.curve.finish();
    }

    /// Operating point at time `t` on the current curve.
    fn solve_hydro(&self, t: f64, full: bool) -> Hydro {
        let (supply, fill) = self.supply(t);
        let ncol = self.model.columns.len();
        let mut col_flow = vec![0.0; ncol];
        if !full {
            return Hydro {
                pressure: 0.0,
                pump_flow: fill,
                col_flow,
                out_flow: 0.0,
            };
        }
        let compliance = self.spec.machine.hydraulic_compliance_m3_pa;
        let (p, q) = if compliance > 0.0 {
            let p = self.state.stored_pressure;
            let storage_flow = compliance * self.pressure_cap_rate(t);
            (
                p,
                supply.regulated_flow(p, self.curve.flow(p), storage_flow),
            )
        } else {
            hydraulics::operating_point(&self.curve, &supply)
        };
        self.curve.column_flows(p, &mut col_flow);
        // fold from +0 (an empty float `sum()` is −0).
        let out_flow = col_flow
            .iter()
            .zip(&self.curve.through)
            .filter(|(_, t)| **t)
            .fold(0.0, |acc, (q, _)| acc + q);
        let pump_flow = match self.mode {
            Mode::Program => q,
            Mode::Drip { .. } => 0.0,
        };
        Hydro {
            pressure: p,
            pump_flow,
            col_flow,
            out_flow,
        }
    }

    /// Recomputes the hydraulics for the current state and time.
    fn refresh_hydro(&mut self) {
        self.update_cell_resistances();
        let wetted = self.state.wetted.clone();
        self.build_curve(self.state.t, &wetted);
        self.hydro = self.solve_hydro(self.state.t, self.state.headspace_full);
    }

    // ----- Time loop --------------------------------------------------------------

    fn run(&mut self) -> Result<(), ShotError> {
        self.refresh_hydro();
        self.record_output();
        self.record_snapshot_candidate();
        loop {
            if let Mode::Drip { t_end, p_stop, .. } = self.mode
                && (self.state.t >= t_end
                    || self.drip_water
                        <= DRIP_EMPTY
                            * if self.spec.machine.hydraulic_compliance_m3_pa > 0.0 {
                                self.spec.machine.hydraulic_compliance_m3_pa * p_stop
                            } else {
                                self.model.headspace_volume
                            })
            {
                break;
            }
            self.step()?;
            if self.steps > 10_000_000 {
                return Err(ShotError::Numerical {
                    reason: "too many time steps".to_string(),
                });
            }
        }
        // The end of the drip (or of the shot without a drip).
        self.record_output_now();
        Ok(())
    }

    fn next_output_time(&self) -> f64 {
        (self.output_index + 1) as f64 * self.spec.numerics.output_interval_s
    }

    /// The beverage mass flow now, kg/s.
    fn mass_rate(&self) -> f64 {
        let m = self.model;
        let nc = m.n_cells();
        let mut rate = 0.0;
        for i in 0..m.columns.len() {
            if self.state.through[i] {
                let c = self.state.conc(m, i * nc + nc - 1);
                rate += self.hydro.col_flow[i] * m.liquid.density(c);
            }
        }
        rate
    }

    /// The outlet solute flux now, Σ q·c over the columns through, kg/s.
    fn outlet_flux_now(&self) -> f64 {
        let m = self.model;
        let nc = m.n_cells();
        let mut flux = 0.0;
        for i in 0..m.columns.len() {
            if self.state.through[i] {
                flux += self.hydro.col_flow[i] * self.state.conc(m, i * nc + nc - 1);
            }
        }
        flux
    }

    fn cup_mass(&self) -> f64 {
        self.state.cup_water + self.state.cup_solute
    }

    /// The end of the next step: the base step, the next output, and every
    /// predictable event; and the smallest mass target this step might reach
    /// (even if the mass flow rises fourfold within it).
    fn target_time(&self) -> (f64, Option<f64>) {
        let t = self.state.t;
        let spec = self.spec;
        let mut target = fmin(t + self.dt_base, self.next_output_time());
        let mut consider = |x: f64| {
            if x > t && x < target {
                target = x;
            }
        };
        // Land on each column's breakthrough, so that outflow starts at a
        // step boundary and the mass events below can be predicted from it.
        if self.state.headspace_full {
            let min_step = 1e-6 * self.dt_base;
            for (i, column) in self.model.columns.iter().enumerate() {
                let q = self.hydro.col_flow[i];
                if !self.state.through[i] && q > 0.0 {
                    let x = t + (column.volume - self.state.wetted[i]) * self.model.phi_t / q;
                    if x > t + min_step {
                        consider(x);
                    }
                }
            }
        }
        let rate = self.mass_rate();
        let cup = self.cup_mass();
        let mass_event = |m_target: f64| {
            if rate > 0.0 && m_target > cup {
                t + (m_target - cup) / rate
            } else {
                f64::INFINITY
            }
        };
        match self.mode {
            Mode::Program => {
                let phases = &spec.machine.phases;
                let last = self.program.phase + 1 == phases.len();
                if !last {
                    let exit = &phases[self.program.phase].exit;
                    if let Some(x) = exit.time_s {
                        consider(self.program.start + x);
                    }
                    if let Some(x) = exit.beverage_mass_kg {
                        consider(mass_event(x));
                    }
                }
                if let Some(x) = spec.machine.stop.time_s {
                    consider(x);
                }
                if let Some(x) = spec.machine.stop.beverage_mass_kg {
                    consider(mass_event(x));
                }
                consider(spec.numerics.max_duration_s);
            }
            Mode::Drip { t_end, .. } => {
                consider(t_end);
                // The headspace empties.
                let q: f64 = self.hydro.col_flow.iter().fold(0.0, |a, q| a + q);
                if q > 0.0 {
                    consider(t + self.drip_water / q);
                }
            }
        }
        let mut reach: Option<f64> = None;
        if !self.state.headspace_full {
            let remaining = self.model.headspace_volume - self.state.headspace_filled;
            if self.fill_volume(t, target) > remaining {
                target = hydraulics::solve_increasing(
                    |end| self.fill_volume(t, end) - remaining,
                    t,
                    target,
                );
            }
        }
        if let Mode::Program = self.mode {
            let phases = &spec.machine.phases;
            let exit = if self.program.phase + 1 < phases.len() {
                phases[self.program.phase].exit.beverage_mass_kg
            } else {
                None
            };
            for m in [exit, spec.machine.stop.beverage_mass_kg]
                .into_iter()
                .flatten()
            {
                let within = m > cup && m - cup <= 4.0 * rate * (target - t) + MASS_TOLERANCE_KG;
                if within && reach.is_none_or(|r| m < r) {
                    reach = Some(m);
                }
            }
        }
        (target, reach)
    }

    fn step(&mut self) -> Result<(), ShotError> {
        let t0 = self.state.t;
        let (mut t1, mass_target) = self.target_time();
        if t1.is_nan() || t1 <= t0 {
            t1 = t0 + self.dt_base;
        }
        // A step that may reach a mass target keeps a full copy of the state,
        // so an overshoot can be re-landed (L-a); every step keeps the cheap
        // hydraulic state, so a step whose regimes do not converge can be
        // retried shorter (H).
        let full = mass_target.map(|m| (m, self.save_full()));
        let light = self.save_light();
        let (mut halvings, mut relands, mut force_be) = (0, 0, false);
        loop {
            if !self.attempt(t0, t1, force_be)? {
                if halvings >= MAX_HALVINGS {
                    return Err(ShotError::Numerical {
                        reason: format!(
                            "the regime iteration did not converge at t = {t0:.3} s, \
                             even with the step halved {MAX_HALVINGS} times (Δt = {:.3e} s)",
                            t1 - t0
                        ),
                    });
                }
                self.restore_light(&light);
                t1 = t0 + 0.5 * (t1 - t0);
                halvings += 1;
                force_be = true;
                self.rejected_steps += 1;
                continue;
            }
            if let Some((m, saved)) = &full {
                let (cup0, cup1) = (
                    saved.state.cup_water + saved.state.cup_solute,
                    self.cup_mass(),
                );
                if cup1 > m + MASS_TOLERANCE_KG && cup1 > cup0 && relands < MAX_RELANDS {
                    // Secant on the step's own mass gain, kept inside the step.
                    let f = fmin(fmax((m - cup0) / (cup1 - cup0), 0.01), 0.99);
                    let t_new = t0 + f * (t1 - t0);
                    self.restore_full(saved);
                    t1 = t_new;
                    relands += 1;
                    self.rejected_steps += 1;
                    continue;
                }
            }
            break;
        }
        let dt = t1 - t0;

        self.state.t = t1;
        self.steps += 1;
        self.refresh_hydro();
        // Outlet accounting by quadrature: trapezoidal ∫ q·c dt.
        let flux = self.outlet_flux_now();
        self.outlet_integral += 0.5 * dt * (self.outlet_flux + flux);
        self.max_pressure = fmax(self.max_pressure, self.hydro.pressure);
        if self.output_due() {
            self.record_output();
            self.record_snapshot_candidate();
        }
        self.events();
        // Events may change the operating point (a phase change or the stop).
        self.outlet_flux = self.outlet_flux_now();
        Ok(())
    }

    /// One attempt at the step [t0, t1]: hydraulics, front, thermal node and
    /// transport. Returns `Ok(false)` when the transport's regime iteration
    /// does not converge; the caller then restores the saved state.
    fn attempt(&mut self, t0: f64, t1: f64, force_be: bool) -> Result<bool, ShotError> {
        let model = self.model;
        let ncol = model.columns.len();
        let nc = model.n_cells();
        let dt = t1 - t0;

        // Hydraulics at the start (cell resistances are fresh from the last
        // refresh) and the flows over the step.
        let h0 = self.hydro.clone();
        let wetted_start = self.state.wetted.clone();
        let mut wetted_end = self.state.wetted.clone();
        let mut flow = vec![0.0; ncol];
        let mut outflow = vec![0.0; ncol];
        let mut active = vec![0usize; ncol];
        let mut bed_inflow = 0.0;
        let mut supplied_volume = 0.0;
        if !self.state.headspace_full {
            // Land on the fill event using the integral of the commanded
            // flow, so ramp/cap changes cannot silently discard excess water.
            supplied_volume = self.fill_volume(t0, t1);
            self.state.headspace_filled += supplied_volume;
            if self.state.headspace_filled >= model.headspace_volume * (1.0 - 1e-12) {
                self.state.headspace_filled = model.headspace_volume;
                self.state.headspace_full = true;
            }
            for (i, a) in active.iter_mut().enumerate() {
                *a = self.active_cells(i, self.state.wetted[i]);
            }
        } else {
            // Heun predictor–corrector for the wetting fronts and flows.
            let w0 = self.state.wetted.clone();
            let mut w_pred = w0.clone();
            for i in 0..ncol {
                if !self.state.through[i] {
                    w_pred[i] = fmin(
                        w0[i] + dt * h0.col_flow[i] / model.phi_t,
                        model.columns[i].volume,
                    );
                }
            }
            self.build_curve(t1, &w_pred);
            let compliance = self.spec.machine.hydraulic_compliance_m3_pa;
            let mut average: Vec<f64> = if compliance > 0.0 {
                // First-order implicit pressure/storage balance on the
                // predicted end-front curve. The same bed volume enters
                // transport and wetting; delivered pump volume is independent.
                let (supply, _) = self.supply(t1);
                let (pressure, pump_flow) = hydraulics::compliant_step(
                    &self.curve,
                    &supply,
                    compliance,
                    self.state.stored_pressure,
                    dt,
                );
                self.state.stored_pressure = pressure;
                supplied_volume = dt * pump_flow;
                let mut flows = vec![0.0; ncol];
                self.curve.column_flows(pressure, &mut flows);
                flows
            } else {
                let h1 = self.solve_hydro(t1, true);
                h0.col_flow
                    .iter()
                    .zip(&h1.col_flow)
                    .map(|(a, b)| 0.5 * (a + b))
                    .collect()
            };
            if compliance == 0.0 && matches!(self.mode, Mode::Drip { .. }) {
                let requested: f64 = dt * average.iter().sum::<f64>();
                if requested > self.drip_water {
                    let scale = self.drip_water / requested;
                    for q in &mut average {
                        *q *= scale;
                    }
                }
            }
            for i in 0..ncol {
                let q = average[i];
                flow[i] = q;
                bed_inflow += q;
                if self.state.through[i] {
                    outflow[i] = q;
                    active[i] = nc;
                    continue;
                }
                let vol = model.columns[i].volume;
                let w_new = w0[i] + dt * q / model.phi_t;
                wetted_end[i] = w_new;
                if w_new >= vol * (1.0 - 1e-12) {
                    // The front reaches the floor during the step.
                    let s = if w_new > w0[i] {
                        fmin(fmax((vol - w0[i]) / (w_new - w0[i]), 0.0), 1.0)
                    } else {
                        1.0
                    };
                    let t_cross = t0 + s * dt;
                    self.state.wetted[i] = vol;
                    self.state.through[i] = true;
                    self.state.t_through[i] = t_cross;
                    outflow[i] = q * (1.0 - s);
                    self.first_drops = Some(self.first_drops.map_or(t_cross, |f| fmin(f, t_cross)));
                    active[i] = nc;
                } else {
                    self.state.wetted[i] = w_new;
                    active[i] = self.active_cells(i, w_new);
                }
                // Wetting times of the cells the front entered.
                for j in 0..active[i] {
                    let cell = i * nc + j;
                    if self.state.t_wet[cell] == f64::INFINITY {
                        let top = model.columns[i].cum_volume[j];
                        let w_end = self.state.wetted[i];
                        let s = if w_end > w0[i] {
                            fmin(fmax((top - w0[i]) / (w_end - w0[i]), 0.0), 1.0)
                        } else {
                            0.0
                        };
                        self.state.t_wet[cell] = t0 + s * dt;
                    }
                }
            }
        }

        if self.spec.machine.hydraulic_compliance_m3_pa > 0.0 {
            if matches!(self.mode, Mode::Drip { .. }) {
                self.drip_water = self.storage_volume();
            }
        } else if let Mode::Drip { .. } = self.mode {
            self.drip_water = fmax(self.drip_water - dt * bed_inflow, 0.0);
            self.state.headspace_filled = self.drip_water;
        } else {
            supplied_volume += dt * bed_inflow;
        }

        // Thermal node (backward Euler), then extraction and transport.
        let th = &self.spec.thermal;
        let cw = props::WATER_HEAT_CAPACITY_J_KG_K;
        let water_held: f64 = model.phi_t * self.state.wetted.iter().sum::<f64>();
        let cap = th.heat_capacity_j_k + model.rho_water * cw * water_held;
        let adv = model.rho_water * cw * bed_inflow;
        self.state.temp = (cap * self.state.temp
            + dt * (adv * th.water_temp_c + th.heat_loss_w_k * th.ambient_temp_c))
            / (cap + dt * (adv + th.heat_loss_w_k));

        if active.iter().any(|&a| a > 0) {
            let input = StepInput {
                dt,
                dt_prev: if force_be { 0.0 } else { self.dt_prev },
                t_start: t0,
                temp: self.state.temp,
                flow: &flow,
                outflow: &outflow,
                active: &active,
                wetted_start: &wetted_start,
                wetted_end: &wetted_end,
                axial_dispersion: self.spec.hydraulics.axial_dispersion_m2_s,
            };
            if !transport::step(model, &mut self.state, &mut self.scratch, &input)? {
                return Ok(false);
            }
        }
        self.dt_prev = if active.iter().any(|&a| a > 0) {
            dt
        } else {
            self.dt_prev
        };
        // Only commit the accounting after transport accepted the step. A
        // failed attempt restores the light state; a mass re-land restores
        // the complete State, including these integrated volumes.
        self.state.volume_in += supplied_volume;
        self.state.volume_out += dt * outflow.iter().sum::<f64>();
        Ok(true)
    }

    /// The hydraulic and front state a rejected attempt may have changed
    /// (the transport changes nothing else before it reports failure).
    fn save_light(&self) -> Light {
        Light {
            stored_pressure: self.state.stored_pressure,
            headspace_filled: self.state.headspace_filled,
            headspace_full: self.state.headspace_full,
            wetted: self.state.wetted.clone(),
            through: self.state.through.clone(),
            t_through: self.state.t_through.clone(),
            t_wet: self.state.t_wet.clone(),
            temp: self.state.temp,
            first_drops: self.first_drops,
            drip_water: self.drip_water,
            curve: self.curve.clone(),
        }
    }

    fn restore_light(&mut self, l: &Light) {
        self.state.stored_pressure = l.stored_pressure;
        self.state.headspace_filled = l.headspace_filled;
        self.state.headspace_full = l.headspace_full;
        self.state.wetted.clone_from(&l.wetted);
        self.state.through.clone_from(&l.through);
        self.state.t_through.clone_from(&l.t_through);
        self.state.t_wet.clone_from(&l.t_wet);
        self.state.temp = l.temp;
        self.first_drops = l.first_drops;
        self.drip_water = l.drip_water;
        self.curve = l.curve.clone();
    }

    /// Everything a successful attempt changes.
    fn save_full(&self) -> Full {
        Full {
            state: self.state.clone(),
            first_drops: self.first_drops,
            drip_water: self.drip_water,
            curve: self.curve.clone(),
            dt_prev: self.dt_prev,
        }
    }

    fn restore_full(&mut self, f: &Full) {
        self.state.clone_from(&f.state);
        self.first_drops = f.first_drops;
        self.drip_water = f.drip_water;
        self.curve = f.curve.clone();
        self.dt_prev = f.dt_prev;
    }

    /// Cells the front has entered in column `i`.
    fn active_cells(&self, i: usize, w: f64) -> usize {
        let cum = &self.model.columns[i].cum_volume;
        let mut n = 0;
        while n < self.model.n_cells() && w > cum[n] {
            n += 1;
        }
        n
    }

    fn output_due(&self) -> bool {
        let next = self.next_output_time();
        self.state.t >= next - 1e-9 * self.spec.numerics.output_interval_s
    }

    fn warn(&mut self, w: &str) {
        if !self.warnings.iter().any(|x| x == w) {
            self.warnings.push(w.to_string());
        }
    }

    /// Phase exits, the stop rule, stalls and the drip.
    fn events(&mut self) {
        let t = self.state.t;
        let spec = self.spec;
        let cup = self.cup_mass();
        let eps_t = 1e-9 * fmax(t, 1.0);
        match self.mode {
            Mode::Program => {
                // Phase exits (not for the last phase).
                let phases = &spec.machine.phases;
                if self.program.phase + 1 < phases.len() {
                    let exit = &phases[self.program.phase].exit;
                    let fired = exit
                        .time_s
                        .is_some_and(|x| t >= self.program.start + x - eps_t)
                        || exit
                            .beverage_mass_kg
                            .is_some_and(|x| cup >= x - MASS_TOLERANCE_KG)
                        || exit.pressure_pa.is_some_and(|x| self.hydro.pressure >= x);
                    if fired {
                        let next = &phases[self.program.phase + 1];
                        let from = match next.control {
                            Control::Pressure { .. } => self.hydro.pressure,
                            Control::Flow { .. } => self.hydro.pump_flow,
                            Control::PumpFull => 0.0,
                        };
                        self.program = Program {
                            phase: self.program.phase + 1,
                            start: t,
                            ramp_from: from,
                        };
                        self.hydro = self.solve_hydro(t, self.state.headspace_full);
                        self.max_pressure = fmax(self.max_pressure, self.hydro.pressure);
                    }
                }
                // Stall detection, against the flow the program asks for (a
                // slow soak is not a stall). Compliance can accept pump
                // delivery while pressure rises, or supply the bed while
                // the pump is closed. Both flows must be negligible.
                let demand = self.demand_flow(t);
                let actual = if self.spec.machine.hydraulic_compliance_m3_pa > 0.0 {
                    fmax(self.hydro.pump_flow, self.hydro.col_flow.iter().sum())
                } else {
                    self.hydro.pump_flow
                };
                let stalled = self.state.headspace_full
                    && demand > 0.0
                    && actual < fmin(CHOKE_FLOW_M3_S, 0.1 * demand);
                if stalled {
                    let since = *self.stall_since.get_or_insert(t);
                    if t - since >= CHOKE_TIME_S {
                        self.stop("choked");
                        return;
                    }
                } else {
                    self.stall_since = None;
                }
                let stop = &spec.machine.stop;
                if stop
                    .beverage_mass_kg
                    .is_some_and(|x| cup >= x - MASS_TOLERANCE_KG)
                {
                    self.stop("beverage_mass");
                } else if stop.time_s.is_some_and(|x| t >= x - eps_t) {
                    self.stop("time");
                } else if t >= spec.numerics.max_duration_s - eps_t {
                    self.stop("max_duration");
                }
            }
            Mode::Drip { .. } => {}
        }
    }

    fn stop(&mut self, reason: &'static str) {
        let t = self.state.t;
        self.stop_reason = Some(reason);
        self.shot_time = t;
        self.cup_at_stop = self.cup_mass();
        if reason == "choked" {
            self.warn("the shot choked: the flow stayed negligible");
        }
        if reason == "max_duration" {
            self.warn("the stop rule never fired; the shot ran to numerics.max_duration_s");
        }
        // Record the stop itself (unless it was just recorded as an output).
        self.record_output_now();
        // The legacy drip spends headspace water. With compliance, only the
        // separately charged volume can discharge; a vent dumps both stores.
        let stop = &self.spec.machine.stop;
        let compliance = self.spec.machine.hydraulic_compliance_m3_pa;
        let available = if compliance > 0.0 {
            self.storage_volume()
        } else {
            self.state.headspace_filled
        };
        let (t_end, water) = if stop.vent_headspace || self.hydro.pressure <= 0.0 {
            (t, 0.0)
        } else {
            (t + DRIP_TAUS * stop.drip_tau_s, available)
        };
        self.drip_water = water;
        if stop.vent_headspace {
            self.state.volume_vented += self.state.headspace_filled + self.storage_volume();
            self.state.headspace_filled = 0.0;
            self.state.stored_pressure = 0.0;
        }
        self.mode = Mode::Drip {
            t_stop: t,
            p_stop: self.hydro.pressure,
            t_end,
        };
        self.hydro = self.solve_hydro(t, self.state.headspace_full);
        if compliance > 0.0 {
            // Right-limit stop state: in particular a vent's P=0 and C·P=0
            // must appear at the same timestamp as its accounted volume.
            self.replace_output_now();
        } else {
            // Preserve the legacy instantaneous series while recording the
            // instantaneous vent in the new cumulative/inventory channels.
            let retained = self.retained_volume();
            if let Some(v) = self.series.retained_volume_m3.last_mut() {
                *v = retained;
            }
            if let Some(v) = self.series.cumulative_vented_volume_m3.last_mut() {
                *v = self.state.volume_vented;
            }
        }
    }

    // ----- Outputs -----------------------------------------------------------------

    fn storage_volume(&self) -> f64 {
        self.spec.machine.hydraulic_compliance_m3_pa * self.state.stored_pressure
    }

    fn retained_volume(&self) -> f64 {
        self.state.headspace_filled
            + self.model.phi_t * self.state.wetted.iter().sum::<f64>()
            + self.storage_volume()
    }

    fn record_output(&mut self) {
        self.output_index += 1;
        // Snap the clock to the output time (the steps were aimed at it).
        let t_out = self.output_index as f64 * self.spec.numerics.output_interval_s;
        if (self.state.t - t_out).abs() <= 1e-9 * self.spec.numerics.output_interval_s {
            self.state.t = t_out;
        }
        self.push_series();
    }

    fn record_output_now(&mut self) {
        let last = self.series.t_s.last().copied();
        if last != Some(self.state.t) {
            self.push_series();
        }
    }

    fn replace_output_now(&mut self) {
        let s = &mut self.series;
        if s.t_s.last().copied() == Some(self.state.t) {
            for values in [
                &mut s.t_s,
                &mut s.pressure_pa,
                &mut s.flow_in_m3_s,
                &mut s.flow_out_m3_s,
                &mut s.storage_volume_m3,
                &mut s.cumulative_inlet_volume_m3,
                &mut s.cumulative_outlet_volume_m3,
                &mut s.cumulative_vented_volume_m3,
                &mut s.retained_volume_m3,
                &mut s.beverage_mass_kg,
                &mut s.tds_cup,
                &mut s.tds_outlet,
                &mut s.ey,
                &mut s.outlet_temp_c,
                &mut s.wetted_fraction,
            ] {
                values.pop();
            }
            for species in &mut s.species_cup_kg {
                species.values.pop();
            }
        }
        self.push_series();
    }

    fn push_series(&mut self) {
        let m = self.model;
        let nc = m.n_cells();
        let storage = self.storage_volume();
        let retained = self.retained_volume();
        let s = &mut self.series;
        let t = self.state.t;
        s.t_s.push(t);
        s.pressure_pa.push(self.hydro.pressure);
        s.flow_in_m3_s.push(self.hydro.pump_flow);
        s.flow_out_m3_s.push(self.hydro.out_flow);
        s.storage_volume_m3.push(storage);
        s.cumulative_inlet_volume_m3.push(self.state.volume_in);
        s.cumulative_outlet_volume_m3.push(self.state.volume_out);
        s.cumulative_vented_volume_m3.push(self.state.volume_vented);
        s.retained_volume_m3.push(retained);
        let cup = self.state.cup_water + self.state.cup_solute;
        s.beverage_mass_kg.push(cup);
        s.tds_cup.push(if cup > 0.0 {
            self.state.cup_solute / cup
        } else {
            0.0
        });
        // Flow-weighted outlet concentration.
        let (mut qc, mut q) = (0.0, 0.0);
        for i in 0..m.columns.len() {
            if self.state.through[i] {
                let c = self.state.conc(m, i * nc + nc - 1);
                qc += self.hydro.col_flow[i] * c;
                q += self.hydro.col_flow[i];
            }
        }
        let c_out = if q > 0.0 { qc / q } else { 0.0 };
        s.tds_outlet.push(m.liquid.mass_fraction(c_out));
        s.ey.push(self.state.cup_solute / self.spec.bed.dose_kg);
        s.outlet_temp_c.push(self.state.temp);
        for (out, sp) in s.species_cup_kg.iter_mut().zip(&m.species) {
            out.values
                .push(sp.mass_fraction * self.state.groups[sp.group].cup);
        }
        let wetted: f64 = self.state.wetted.iter().sum();
        s.wetted_fraction.push(fmin(wetted / m.bed_volume, 1.0));
    }

    fn snapshot(&self) -> Snapshot {
        let m = self.model;
        let nc = m.n_cells();
        let mut local_ey = Vec::with_capacity(m.columns.len());
        let mut conc = Vec::with_capacity(m.columns.len());
        let mut wetted = Vec::with_capacity(m.columns.len());
        for (i, column) in m.columns.iter().enumerate() {
            let mut ey = Vec::with_capacity(nc);
            let mut cc = Vec::with_capacity(nc);
            let mut ww = Vec::with_capacity(nc);
            let w = self.state.wetted[i];
            for j in 0..nc {
                let cell = i * nc + j;
                let held = cell_particles(m, &self.state, cell);
                ey.push((self.state.particle0[cell] - held) / self.state.dry[cell]);
                cc.push(self.state.conc(m, cell));
                let (top, bottom) = (column.cum_volume[j], column.cum_volume[j + 1]);
                ww.push(if self.state.through[i] || w >= bottom {
                    1.0
                } else if w <= top {
                    0.0
                } else {
                    fmin(fmax((w - top) / (bottom - top), 0.0), 1.0)
                });
            }
            local_ey.push(ey);
            conc.push(cc);
            wetted.push(ww);
        }
        Snapshot {
            t_s: self.state.t,
            local_ey,
            liquid_conc_kg_m3: conc,
            wetted_fraction: wetted,
        }
    }

    /// Records a snapshot candidate every `every` outputs, halving the set
    /// when it grows past its limit; also checks the mass balance.
    fn record_snapshot_candidate(&mut self) {
        let index = self.output_index;
        if !index.is_multiple_of(self.snapshots.every) {
            return;
        }
        self.check_mass();
        let snap = self.snapshot();
        self.snapshots.kept.push((index, snap));
        if self.snapshots.kept.len() > self.snapshots.limit {
            self.snapshots.every *= 2;
            let every = self.snapshots.every;
            self.snapshots.kept.retain(|(i, _)| i % every == 0);
        }
    }

    fn check_mass(&mut self) {
        // The kernels' exact minimum is taken here (the steps flag any
        // negative value as it happens).
        let min_k = transport::kernel_min(&self.state.u);
        self.state.min_conc = fmin(self.state.min_conc, min_k);
        for st in &mut self.state.groups {
            st.min_conc = fmin(st.min_conc, transport::kernel_min(&st.u));
        }
        let (lumped, groups) = totals(self.model, &self.state);
        let rel = |t: Totals, initial: f64| {
            if initial > 0.0 {
                ((t.particles + t.liquid + t.cup) - initial).abs() / initial
            } else {
                0.0
            }
        };
        let mut err = rel(lumped, self.state.initial_solubles);
        for (t, st) in groups.iter().zip(&self.state.groups) {
            err = fmax(err, rel(*t, st.initial));
        }
        self.mass_error = fmax(self.mass_error, err);
    }

    /// The smallest concentration seen (lumped, and each species scaled by
    /// its mass fraction), kg/m³.
    fn min_concentration(&self) -> f64 {
        let mut min_c = self.state.min_conc;
        for sp in &self.model.species {
            let g = self.state.groups[sp.group].min_conc;
            if g.is_finite() {
                min_c = fmin(min_c, sp.mass_fraction * g);
            }
        }
        if min_c.is_finite() { min_c } else { 0.0 }
    }

    fn finish(mut self) -> Result<ShotResult, ShotError> {
        self.check_mass();
        let m = self.model;
        let spec = self.spec;
        let nc = m.n_cells();
        let final_snap = self.snapshot();
        let t_end = self.state.t;
        // Snapshots: the candidates nearest k·t_end/n, then the final state.
        let n = spec.numerics.snapshot_count;
        let mut snapshots = Vec::with_capacity(n);
        if n > 0 {
            for k in 1..n {
                let target = t_end * (k as f64 / n as f64);
                let best = self
                    .snapshots
                    .kept
                    .iter()
                    .min_by(|a, b| {
                        let da = (a.1.t_s - target).abs();
                        let db = (b.1.t_s - target).abs();
                        da.partial_cmp(&db).expect("finite times")
                    })
                    .map(|(_, s)| s.clone());
                if let Some(s) = best {
                    snapshots.push(s);
                }
            }
            snapshots.push(final_snap.clone());
        }
        // Uniformity over all cells, weighted by dry mass.
        let (mut w_sum, mut ey_sum) = (0.0, 0.0);
        let (mut ey_min, mut ey_max) = (f64::INFINITY, f64::NEG_INFINITY);
        for (i, row) in final_snap.local_ey.iter().enumerate() {
            for (j, &ey) in row.iter().enumerate() {
                let w = self.state.dry[i * nc + j];
                w_sum += w;
                ey_sum += w * ey;
                ey_min = fmin(ey_min, ey);
                ey_max = fmax(ey_max, ey);
            }
        }
        let ey_mean = ey_sum / w_sum;
        let mut var = 0.0;
        for (i, row) in final_snap.local_ey.iter().enumerate() {
            for (j, &ey) in row.iter().enumerate() {
                let w = self.state.dry[i * nc + j];
                var += w * (ey - ey_mean) * (ey - ey_mean);
            }
        }
        let uniformity = Uniformity {
            ey_std: (var / w_sum).sqrt(),
            ey_min,
            ey_max,
            ey_mean,
        };
        // Class EY.
        let class_ey = m
            .classes
            .iter()
            .enumerate()
            .map(|(k, class)| {
                let (mut held, mut init, mut dry) = (0.0, 0.0, 0.0);
                for (i, column) in m.columns.iter().enumerate() {
                    for (j, c) in m.cells.iter().enumerate() {
                        let cell = i * nc + j;
                        let vol = column.share * c.volume;
                        held += self.state.pool[cell * m.n_classes() + k];
                        if class.grid.is_some() {
                            held += class.sigma * vol * kernel_mass(m, &self.state.u, i, j, class);
                        }
                        init += m.s0 * class.phi * vol;
                        dry += m.dry_density * class.fraction * vol;
                    }
                }
                ClassEy {
                    radius_m: class.radius,
                    ey: if dry > 0.0 { (init - held) / dry } else { 0.0 },
                }
            })
            .collect();
        let species = m
            .species
            .iter()
            .map(|sp| {
                // A unit-mass-fraction group cup over the dose is the
                // extracted fraction of every member.
                let cup = self.state.groups[sp.group].cup;
                SpeciesTotal {
                    id: sp.id.clone(),
                    mass_kg: sp.mass_fraction * cup,
                    extracted_fraction: if sp.mass_fraction > 0.0 {
                        cup / spec.bed.dose_kg
                    } else {
                        0.0
                    },
                }
            })
            .collect();
        let cup = self.cup_mass();
        if self.first_drops.is_none() {
            self.warn("no drops reached the cup");
        }
        let min_conc = self.min_concentration();
        // Health of the solve: the mass balance and positivity.
        let c_ref = fmax(m.saturation, m.u0);
        if self.mass_error.is_nan() || self.mass_error > MASS_FAIL {
            return Err(ShotError::Numerical {
                reason: format!(
                    "soluble mass balance error {:.3e} exceeds {MASS_FAIL:e}",
                    self.mass_error
                ),
            });
        }
        // The liquid never reaches the water-content limit: validation bounds
        // v̄·max(c_sat, K·s₀) below 0.9 and the liquid stays below that.
        if m.liquid.specific_volume * self.state.max_conc >= 0.95 {
            return Err(ShotError::Numerical {
                reason: format!(
                    "the bed liquid reached {:.0} kg/m³, where it holds almost no water",
                    self.state.max_conc
                ),
            });
        }
        if min_conc < -NEGATIVE_FAIL * c_ref {
            return Err(ShotError::Numerical {
                reason: format!("negative concentration {min_conc:.3e} kg/m³"),
            });
        }
        if self.mass_error > MASS_WARN {
            let w = format!(
                "soluble mass balance error {:.2e} is above {MASS_WARN:e}",
                self.mass_error
            );
            self.warn(&w);
        }
        if min_conc < -NEGATIVE_WARN * c_ref {
            let w = format!("a concentration went negative ({min_conc:.2e} kg/m³)");
            self.warn(&w);
        }
        let outflow_error = if self.state.cup_solute > 0.0 {
            (self.state.cup_solute - self.outlet_integral).abs() / self.state.cup_solute
        } else {
            0.0
        };
        let retained_volume = self.retained_volume();
        let hydraulic_volume_balance_error = if self.state.volume_in > 0.0 {
            (self.state.volume_in
                - self.state.volume_out
                - retained_volume
                - self.state.volume_vented)
                .abs()
                / self.state.volume_in
        } else {
            0.0
        };
        let columns = m
            .columns
            .iter()
            .map(|c| ColumnInfo {
                inner_radius_m: c.inner_radius,
                outer_radius_m: c.outer_radius,
                area_fraction: c.share,
                permeability_multiplier: c.multiplier,
            })
            .collect();
        Ok(ShotResult {
            schema: SHOT_RESULT_SCHEMA.to_string(),
            core_version: crate::VERSION.to_string(),
            summary: Summary {
                stop_reason: self.stop_reason.unwrap_or("max_duration").to_string(),
                shot_time_s: self.shot_time,
                first_drops_s: self.first_drops,
                beverage_mass_kg: cup,
                drip_mass_kg: cup - self.cup_at_stop,
                tds: if cup > 0.0 {
                    self.state.cup_solute / cup
                } else {
                    0.0
                },
                ey: self.state.cup_solute / spec.bed.dose_kg,
                max_pressure_pa: self.max_pressure,
                bed_height_m: m.bed_height,
                headspace_m3: m.headspace_volume,
                species,
                uniformity,
            },
            series: self.series,
            spatial: Spatial {
                depth_m: m.cells.iter().map(|c| c.depth_centre).collect(),
                depth_edges_m: std::iter::once(0.0)
                    .chain(m.cells.iter().map(|c| m.bed_height - c.h_bottom))
                    .collect(),
                columns,
                snapshots,
                class_ey,
            },
            diagnostics: Diagnostics {
                hydraulic_volume_balance_error,
                mass_balance_error: self.mass_error,
                steps: self.steps,
                warnings: self.warnings,
                min_concentration_kg_m3: min_conc,
                tier: m.tier,
                outflow_integral_error: outflow_error,
                max_regime_solves: self.scratch.solves_max,
                rejected_steps: self.rejected_steps,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a spec and returns the result with the kernels' gross uptake and
    /// initial content per class, kg.
    fn run_with_uptake(spec: &ShotSpec) -> (ShotResult, Vec<f64>, Vec<f64>) {
        let mut warnings = validate::validate(spec).unwrap();
        let model = Model::new(spec, &mut warnings);
        let mut sim = Sim::new(spec, &model, warnings);
        sim.run().unwrap();
        let uptake = sim.state.kernel_uptake.clone();
        let content = model
            .classes
            .iter()
            .map(|c| {
                let kernel_volume = c
                    .grid
                    .as_ref()
                    .map_or(0.0, |g| g.volume.iter().sum::<f64>());
                c.sigma * kernel_volume * model.u0 * model.bed_volume
            })
            .collect();
        (sim.finish().unwrap(), uptake, content)
    }

    /// Runs a spec with the regime solves per step limited to `limit`.
    fn run_limited(spec: &ShotSpec, limit: usize) -> Result<ShotResult, ShotError> {
        let mut warnings = validate::validate(spec)?;
        let model = Model::new(spec, &mut warnings);
        let mut sim = Sim::new(spec, &model, warnings);
        sim.scratch.solve_limit = Some(limit);
        sim.run()?;
        sim.finish()
    }

    #[test]
    fn unconverged_regimes_are_never_accepted() {
        // A stiff, fine, coarse-step spec, with the solves per step limited
        // far below what it needs: steps are rejected and retried at half
        // the step (by backward Euler) until the regimes converge; the result
        // stays conservative and positive, and close to the unlimited run.
        let mut spec = ShotSpec::default();
        spec.solubles.surface_rate_m_s = 1.0;
        spec.hydraulics.axial_dispersion_m2_s = 0.0;
        spec.numerics.depth_cells = 200;
        spec.numerics.max_dt_s = 0.5;
        spec.numerics.output_interval_s = 0.5;
        let free = run_limited(&spec, usize::MAX).unwrap();
        let limited = run_limited(&spec, 3).unwrap();
        let d = &limited.diagnostics;
        assert!(d.rejected_steps > 0, "{}", d.rejected_steps);
        assert!(d.max_regime_solves <= 3);
        assert!(d.mass_balance_error < 1e-10 && d.min_concentration_kg_m3 >= 0.0);
        assert!((limited.summary.ey / free.summary.ey - 1.0).abs() < 0.02);
        assert_eq!(free.diagnostics.rejected_steps, 0);
        // With one solve allowed, a newly wetted cell's first regime guess
        // can never be corrected: after the bounded halvings the run fails
        // with a clear reason.
        match run_limited(&spec, 1) {
            Err(ShotError::Numerical { reason }) => assert!(reason.contains("did not converge")),
            other => panic!("expected a numerical error, got {other:?}"),
        }
    }

    #[test]
    fn pressure_storage_is_restored_when_transport_rejects_a_step() {
        let mut spec = ShotSpec::default();
        spec.machine.hydraulic_compliance_m3_pa = 1e-11;
        spec.solubles.surface_rate_m_s = 1.0;
        spec.hydraulics.axial_dispersion_m2_s = 0.0;
        spec.numerics.depth_cells = 200;
        spec.numerics.max_dt_s = 0.5;
        spec.numerics.output_interval_s = 0.5;
        let free = run_limited(&spec, usize::MAX).unwrap();
        let limited = run_limited(&spec, 3).unwrap();
        assert!(limited.diagnostics.rejected_steps > 0);
        assert!(limited.diagnostics.max_regime_solves <= 3);
        assert!(limited.diagnostics.hydraulic_volume_balance_error < 1e-10);
        assert!(limited.diagnostics.mass_balance_error < 1e-10);
        assert!(limited.diagnostics.min_concentration_kg_m3 >= 0.0);
        assert!((limited.summary.ey / free.summary.ey - 1.0).abs() < 0.03);
        for i in 0..limited.series.t_s.len() {
            let a = &limited.series;
            let residual = a.cumulative_inlet_volume_m3[i]
                - a.cumulative_outlet_volume_m3[i]
                - a.cumulative_vented_volume_m3[i]
                - a.retained_volume_m3[i];
            assert!(residual.abs() < 1e-16);
        }
    }

    #[test]
    fn the_loading_cap_bounds_reuptake() {
        // With the cap, kernels take back at most what they lost; without
        // it, near-saturated liquid loads them (K·ε_p·u₀ < c_sat here).
        let spec = ShotSpec::default();
        let (capped, up_cap, content) = run_with_uptake(&spec);
        let mut lin = spec.clone();
        lin.solubles.kernel_loading_cap = false;
        let (linear, up_lin, _) = run_with_uptake(&lin);
        assert!(
            capped.spatial.snapshots.iter().all(|s| s
                .local_ey
                .iter()
                .flatten()
                .all(|&e| e >= -1e-12))
        );
        assert!(up_lin[1] > up_cap[1]);
        assert!(linear.summary.ey < capped.summary.ey);
        if std::env::var("PUCKWORKS_REPORT").is_ok() {
            for (k, c) in spec.bed.size_classes.iter().enumerate() {
                println!(
                    "class a = {:.0} µm: kernel content {:.3} g; uptake with cap {:.4} g ({:.2}%), linear {:.4} g ({:.2}%)",
                    c.radius_m * 1e6,
                    content[k] * 1e3,
                    up_cap[k] * 1e3,
                    100.0 * up_cap[k] / content[k].max(1e-300),
                    up_lin[k] * 1e3,
                    100.0 * up_lin[k] / content[k].max(1e-300)
                );
            }
            for (name, r) in [("cap", &capped), ("linear", &linear)] {
                let ser = &r.series;
                let at = |t: f64| {
                    ser.t_s
                        .iter()
                        .position(|&x| x >= t - 1e-9)
                        .unwrap_or(ser.t_s.len() - 1)
                };
                let pts: Vec<String> = [8.0, 10.0, 12.0, 15.0, 18.0]
                    .iter()
                    .map(|&t| {
                        let i = at(t);
                        format!(
                            "{:.0} s: EY {:.2}% TDS_out {:.2}%",
                            ser.t_s[i],
                            ser.ey[i] * 100.0,
                            ser.tds_outlet[i] * 100.0
                        )
                    })
                    .collect();
                println!(
                    "{name}: EY {:.2}%, TDS {:.2}%, time {:.2} s, min local EY {:.3}%; {}",
                    r.summary.ey * 100.0,
                    r.summary.tds * 100.0,
                    r.summary.shot_time_s,
                    r.summary.uniformity.ey_min * 100.0,
                    pts.join("; ")
                );
            }
        }
    }
}
