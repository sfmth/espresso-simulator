// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * TypeScript mirror of the M1 shot contract (docs/model/m1-contract.md). The
 * Rust types and their doc comments are the field definitions:
 * - Recipe: crates/puckmodel/src/recipe.rs (practical units: g, mm, µm, bar, mL/s, °C);
 * - ShotSpec: crates/puckcore/src/shot/spec.rs (SI, unit in every field name);
 * - ShotResult: crates/puckcore/src/shot/result.rs (SI; TDS and EY are fractions);
 * - `derived`: crates/puckmodel/src/builder.rs (`Derived`);
 * - presets and registry: crates/puckmodel/generated/{presets,registry}.json.
 *
 * Input documents (Recipe, ShotSpec) reject unknown fields in the core, so the
 * app only ever writes the fields listed here. Output documents may gain fields
 * at any time: code reading them must tolerate fields it does not know, and
 * fields marked optional here may be missing from older cores.
 */

export const RECIPE_SCHEMA = 'puckworks.recipe/1';
export const SHOT_SPEC_SCHEMA = 'puckworks.shot-spec/1';
export const SHOT_RESULT_SCHEMA = 'puckworks.shot-result/1';
export const PRESETS_SCHEMA = 'puckworks.presets/1';
export const REGISTRY_SCHEMA = 'puckworks.registry/1';

// ---------------------------------------------------------------- Recipe

export type BeanProcess = 'washed' | 'natural' | 'honey' | 'anaerobic';
export type PsdMethod = 'dry_laser' | 'wet_laser' | 'image' | 'sieve' | 'other';
export type Distribution = 'none' | 'tap' | 'wdt';
export type PhaseControl = 'pressure' | 'flow' | 'pump';

export const BEAN_PROCESSES: readonly BeanProcess[] = ['washed', 'natural', 'honey', 'anaerobic'];
export const PSD_METHODS: readonly PsdMethod[] = [
  'dry_laser',
  'wet_laser',
  'image',
  'sieve',
  'other',
];
export const DISTRIBUTIONS: readonly Distribution[] = ['none', 'tap', 'wdt'];
export const PHASE_CONTROLS: readonly PhaseControl[] = ['pressure', 'flow', 'pump'];

/** A complete shot description (`puckworks.recipe/1`). */
export interface Recipe {
  schema: string;
  bean: BeanInput;
  grinder: GrinderInput;
  basket: BasketInput;
  prep: PrepInput;
  machine: MachineInput;
  stop: StopInput;
  numerics?: NumericsInput;
  /** Parameter-registry id → value in the registry's units; applied last. */
  overrides?: Record<string, number>;
}

/** The coffee; omitted fields come from the preset or the default bean preset. */
export interface BeanInput {
  preset?: string | null;
  /** Arabica share of the blend, 0–1. */
  arabica_fraction?: number | null;
  /** 0 = very light … 1 = very dark. */
  roast_level?: number | null;
  days_off_roast?: number | null;
  /** Recorded; no effect in bean model v1. */
  process?: BeanProcess | null;
  /** Bean temperature when ground, °C. */
  bean_temp_c?: number | null;
}

/** A preset and dial setting; a burr family and gap; or a measured PSD. */
export interface GrinderInput {
  preset?: string | null;
  /** Dial setting in the preset's own scale. */
  setting?: number | null;
  /** Burr family id, used with `gap_um` when there is no preset. */
  family?: string | null;
  /** Nominal burr gap, µm. */
  gap_um?: number | null;
  /** Measured distribution; overrides everything else. */
  psd?: PsdInput | null;
  burr_diameter_mm?: number | null;
  rpm?: number | null;
  gap_at_ref_um?: number | null;
  gap_per_unit_um?: number | null;
  /** κ_G: X50 / burr gap. */
  x50_gap_ratio?: number | null;
  /** u_G: volume % below 100 µm at X50 = 340 µm. */
  fines_at_340_pct?: number | null;
  /** σ_c: standard deviation of ln(diameter) of the coarse mode. */
  coarse_log_width?: number | null;
  /** w_b: volume share of the boulder tail. */
  boulder_weight?: number | null;
}

/** A measured, volume-weighted particle-size distribution. */
export interface PsdInput {
  /** Particle diameters, µm, increasing. */
  diameter_um: number[];
  /** Volume fraction in each bin (any scale; normalised by the builder). */
  volume_fraction: number[];
  method?: PsdMethod | null;
}

export interface BasketInput {
  preset?: string | null;
  custom?: BasketCustom | null;
}

/** A basket described from scratch (any axisymmetric shape). */
export interface BasketCustom {
  /** Inner wall profile as [height above the floor, inner diameter], mm. */
  profile_mm: [number, number][];
  /** Diameter of the perforated area on the floor, mm. */
  perforated_diameter_mm: number;
  /** Open (hole) fraction of the perforated area, 0–1. */
  open_area_fraction?: number | null;
  /** Orifice diameter of a pressurised (dual-wall) basket, mm. */
  pressurised_orifice_mm?: number | null;
  /** Discharge coefficient of the pressurised orifice, 0–1. */
  discharge_coefficient?: number | null;
}

export interface PrepInput {
  /** Dry dose, g. */
  dose_g: number;
  distribution?: Distribution | null;
  tamp_kgf?: number | null;
  puck_screen?: boolean | null;
  paper_bottom?: boolean | null;
  paper_top?: boolean | null;
}

export interface MachineInput {
  preset?: string | null;
  temperature_c?: number | null;
  /** Pressure/flow program; replaces the preset's program. */
  profile?: PhaseInput[] | null;
  /** Pump; replaces the preset's pump. */
  pump?: PumpInput | null;
  /** Water volume between the basket rim and the shower screen, mL. */
  headspace_ml?: number | null;
  /**
   * A three-way valve vents the group after the shot, so nothing drips
   * (replaces the preset's value). *(Coming in M1, workstream D.)*
   */
  vent_headspace?: boolean | null;
}

export type PumpInput =
  | { type: 'ideal'; max_flow_ml_s?: number | null; max_pressure_bar?: number | null }
  | {
      type: 'vibratory';
      free_flow_ml_s?: number | null;
      stall_pressure_bar?: number | null;
      opv_bar?: number | null;
    };

/** One phase of a pressure/flow program. */
export interface PhaseInput {
  control: PhaseControl;
  /** bar under pressure control, mL/s under flow control. */
  target?: number | null;
  ramp_s?: number | null;
  /** Flow limit (mL/s) under pressure control, or pressure limit (bar) under flow control. */
  limit?: number | null;
  until_time_s?: number | null;
  until_beverage_g?: number | null;
  until_pressure_bar?: number | null;
}

/** When to stop the shot (the first condition met). */
export interface StopInput {
  beverage_g?: number | null;
  time_s?: number | null;
}

export interface NumericsInput {
  /** 0 = preview, 1 = standard (default). */
  tier?: 0 | 1 | null;
  /** Number of particle size classes, 2–60 (default 30). */
  size_classes?: number | null;
}

// ---------------------------------------------------------------- ShotSpec (SI)

export interface ShotSpec {
  schema: string;
  basket: BasketGeometry;
  bed: BedSpec;
  solubles: SolublesSpec;
  hydraulics: HydraulicsSpec;
  thermal: ThermalSpec;
  machine: MachineSpec;
  numerics: NumericsSpec;
}

export interface BasketGeometry {
  /** [height above the basket floor, inner radius], m. */
  profile_m: [number, number][];
  perforated_radius_m: number;
  open_area_fraction: number;
  outlet: Outlet;
  extra_headspace_m3: number;
}

export type Outlet =
  | { type: 'holes' }
  | { type: 'pressurised'; orifice_diameter_m: number; discharge_coefficient: number };

export interface BedSpec {
  dose_kg: number;
  intergranular_porosity: number;
  intraparticle_porosity: number;
  skeletal_density_kg_m3: number;
  size_classes: SizeClass[];
  heterogeneity: Heterogeneity;
}

export interface SizeClass {
  radius_m: number;
  volume_fraction: number;
}

export interface Heterogeneity {
  columns: number;
  sigma_ln_permeability: number;
  edge_area_fraction: number;
  edge_multiplier: number;
  prewet_nonuniformity: number;
}

export interface SolublesSpec {
  extractable_fraction: number;
  cell_size_m: number;
  saturation_kg_m3: number;
  partition_coefficient: number;
  kernel_diffusivity_m2_s: number;
  surface_rate_m_s: number;
  reference_temp_c: number;
  species: SpeciesSpec[];
  /** Volume of dissolved solids per mass, m³/kg (added by the M1 solver). */
  solute_specific_volume_m3_kg?: number;
  /** Cap kernel loading at the content (default true); false keeps the linear partition. */
  kernel_loading_cap?: boolean;
}

export interface SpeciesSpec {
  id: string;
  /** Extractable mass of the species per dry dose, kg/kg. */
  mass_fraction: number;
  kernel_diffusivity_m2_s: number;
  partition_coefficient: number;
  surface_fraction_scale: number;
}

export interface Relaxation {
  amplitude: number;
  tau_s: number;
}

export interface HydraulicsSpec {
  permeability_m2: number;
  poroelastic_pc_pa: number | null;
  dissolution_kozeny_carman: boolean;
  swelling: Relaxation;
  gas: Relaxation;
  fines_layer: Relaxation;
  axial_dispersion_m2_s: number;
  viscosity: { ln_relative_a1: number; ln_relative_a2: number; temperature_exponent: number };
  wetting_uptake: number;
  /** M1.1 pore-water inventory; omitted/null retains the legacy uptake-based holdup. */
  intraparticle_water_fraction?: number | null;
  /** Effective trapped-air mobility closure, separate from the CO₂ penalty. */
  pore_air?: Relaxation;
  pore_air_permeability_exponent?: number;
  /** Share of dissolution that opens intergranular porosity (added by the M1 solver). */
  dissolution_porosity_share?: number;
}

export interface ThermalSpec {
  water_temp_c: number;
  initial_bed_temp_c: number;
  heat_capacity_j_k: number;
  heat_loss_w_k: number;
  /** Surroundings, °C (added by the M1 solver). */
  ambient_temp_c?: number;
}

export type Control =
  | { type: 'pressure'; target_pa: number }
  | { type: 'flow'; target_m3_s: number }
  | { type: 'pump_full' };

export interface Phase {
  control: Control;
  ramp_s: number;
  limit: number | null;
  exit: { time_s: number | null; beverage_mass_kg: number | null; pressure_pa: number | null };
}

export type Pump =
  | { type: 'ideal'; max_flow_m3_s: number; max_pressure_pa: number }
  | { type: 'vibratory'; free_flow_m3_s: number; stall_pressure_pa: number; opv_pa: number | null };

export interface MachineSpec {
  phases: Phase[];
  pump: Pump;
  /** Experimental upstream pressure storage, m³/Pa; 0 or omitted keeps legacy hydraulics. */
  hydraulic_compliance_m3_pa?: number;
  stop: {
    time_s: number | null;
    beverage_mass_kg: number | null;
    /** Legacy drip time constant, s (at most 60); with compliance, only the 8τ observation horizon. */
    drip_tau_s: number;
    /** The headspace and charged pressure storage are vented at the stop: no drip (newer cores). */
    vent_headspace?: boolean;
  };
}

export interface NumericsSpec {
  tier: number;
  depth_cells: number;
  /** Largest time step, s (at most 0.5). */
  max_dt_s: number;
  max_duration_s: number;
  output_interval_s: number;
  snapshot_count: number;
  /** Radial shells per kernel (added by the M1 solver). */
  kernel_shells?: number;
}

// ---------------------------------------------------------------- ShotResult (SI)

/**
 * A shot result. `A` is the array type of the time series: `number[]` in the
 * JSON document, `Float64Array` once the engine worker has converted (and, for
 * very long shots, thinned) them for transfer (engine/shotData.ts).
 */
export interface ShotResult<A = number[]> {
  schema: string;
  core_version: string;
  summary: Summary;
  series: Series<A>;
  spatial: Spatial;
  diagnostics: Diagnostics;
}

export interface Summary {
  /** "beverage_mass", "time", "max_duration" or "choked" (others may be added). */
  stop_reason: string;
  shot_time_s: number;
  first_drops_s: number | null;
  /** Beverage mass in the cup, including the post-stop drip, kg. */
  beverage_mass_kg: number;
  /** Beverage mass added by the post-stop drip, kg (newer cores). */
  drip_mass_kg?: number;
  tds: number;
  ey: number;
  max_pressure_pa: number;
  bed_height_m: number;
  headspace_m3: number;
  species: SpeciesTotal[];
  uniformity: Uniformity;
}

export interface SpeciesTotal {
  id: string;
  mass_kg: number;
  /** Share of the species' extractable content that reached the cup. */
  extracted_fraction: number;
}

/**
 * Mass-weighted statistics of local EY over all bed cells. Local EY counts what
 * has left the particles, so its mean exceeds the cup EY by what is still in
 * the bed liquid.
 */
export interface Uniformity {
  ey_std: number;
  ey_min: number;
  ey_max: number;
  /** Mass-weighted mean (newer cores). */
  ey_mean?: number;
}

/** Time series at the output interval (plus the stop and the end of the drip). */
export interface Series<A = number[]> {
  t_s: A;
  pressure_pa: A;
  flow_in_m3_s: A;
  flow_out_m3_s: A;
  /** Charged upstream carrier volume C·P, m³ (newer cores; zero without compliance). */
  storage_volume_m3?: A;
  /** Cumulative pump-delivered carrier volume, m³ (newer cores). */
  cumulative_inlet_volume_m3?: A;
  /** Cumulative basket-outlet carrier volume, m³ (newer cores). */
  cumulative_outlet_volume_m3?: A;
  /** Cumulative carrier volume discharged through the stop vent, m³ (newer cores). */
  cumulative_vented_volume_m3?: A;
  /** Headspace, wetted pore inventory and charged storage, m³; not solvent mass (newer cores). */
  retained_volume_m3?: A;
  beverage_mass_kg: A;
  tds_cup: A;
  tds_outlet: A;
  ey: A;
  outlet_temp_c: A;
  species_cup_kg: SpeciesSeries<A>[];
  /** Wetted share of the bed volume (newer cores). */
  wetted_fraction?: A;
}

export interface SpeciesSeries<A = number[]> {
  id: string;
  values: A;
}

/** The time-series fields every result has, in display order. */
export const SERIES_FIELDS = [
  'pressure_pa',
  'flow_in_m3_s',
  'flow_out_m3_s',
  'beverage_mass_kg',
  'tds_cup',
  'tds_outlet',
  'ey',
  'outlet_temp_c',
] as const;

export type SeriesField = (typeof SERIES_FIELDS)[number];

/** Optional hydraulic inventories, introduced after the original result contract. */
export const HYDRAULIC_VOLUME_FIELDS = [
  'storage_volume_m3',
  'cumulative_inlet_volume_m3',
  'cumulative_outlet_volume_m3',
  'cumulative_vented_volume_m3',
  'retained_volume_m3',
] as const;

export interface Spatial {
  /** Depth of each cell centre below the bed top, m. */
  depth_m: number[];
  /** Depth of each cell face below the bed top, m: cells + 1 values from 0 to the bed height (newer cores). */
  depth_edges_m?: number[];
  columns: ColumnInfo[];
  snapshots: Snapshot[];
  class_ey: ClassEy[];
}

export interface ColumnInfo {
  /** Inner radius of the annulus at the floor, m. */
  inner_radius_m: number;
  /** Outer radius of the annulus at the floor, m. */
  outer_radius_m: number;
  area_fraction: number;
  permeability_multiplier: number;
}

/** Bed state at one instant; arrays are [column][depth cell]. */
export interface Snapshot {
  t_s: number;
  /** Net soluble loss of each cell's particles over their dry mass. */
  local_ey: number[][];
  /**
   * Concentration of lumped solubles in the bed liquid (intergranular plus
   * imbibed water), kg/m³; 0 where dry.
   */
  liquid_conc_kg_m3: number[][];
  /** Wetted share of each cell: 0 dry, 1 wet, in between at the wetting front (newer cores). */
  wetted_fraction?: number[][];
}

export interface ClassEy {
  radius_m: number;
  ey: number;
}

export interface Diagnostics {
  mass_balance_error: number;
  steps: number;
  warnings: string[];
  /** Smallest concentration seen in any step, kg/m³: a positivity check (newer cores). */
  min_concentration_kg_m3?: number;
  /** Fidelity tier that produced the result (newer cores). */
  tier?: number;
  /**
   * Independent outlet check: relative difference between the cup's solute and
   * the integral of outlet flow × concentration (about 1e-3 expected; near 1
   * flags an inconsistency) (newer cores).
   */
  outflow_integral_error?: number;
  /** Hydraulic carrier-volume residual; not an exact solvent-mass balance. */
  hydraulic_volume_balance_error?: number;
}

// ---------------------------------------------------------------- derived

/** `{spec, derived}` from `buildShotSpec`. */
export interface BuiltSpec {
  spec: ShotSpec;
  derived: Derived;
}

/** What the builder derived while building the spec (an output document). */
export interface Derived {
  psd_curve: { diameter_um: number[]; volume_density: number[] };
  notes: string[];
  /** Spec field path → comma-separated provenance tokens. */
  provenance: Record<string, string>;
  psd?: PsdSummary;
  bean?: BeanSummary;
  bed?: BedSummary;
  /** Presets used, by kind (`bean`, `grinder` or `grinder_family`, `basket`, `machine`). */
  presets?: Record<string, string>;
  flags?: string[];
}

export interface PsdSummary {
  source: string;
  grinder: string | null;
  setting: number | null;
  gap_um: number | null;
  x50_um: number;
  fines_fraction: number;
  d32_um: number;
  d43_um: number;
  mixture: { component: string; weight: number; mode_um: number; log_width: number }[];
  classes: number;
  burr_diameter_mm: number | null;
  rpm: number | null;
}

export interface BeanSummary {
  preset: string;
  arabica_fraction: number;
  roast_level: number;
  roast_colorette_pt: number;
  days_off_roast: number;
  process: string | null;
  bean_temp_c: number;
  co2_beans_mg_g: number;
  co2_puck_mg_g: number;
}

export interface BedSummary {
  height_mm: number;
  bulk_density_kg_m3: number;
  total_porosity: number;
  basket_volume_ml: number;
  headspace_ml: number;
  sauter_diameter_um: number;
  permeability_m2: number;
}

// ---------------------------------------------------------------- presets

export interface Source {
  citation: string;
  doi?: string;
  url?: string;
  locator?: string;
}

/** Fields every preset carries. */
export interface PresetBase {
  id: string;
  name: string;
  description: string;
  /** e.g. "generic", "estimated", "unverified", "disputed", "owner-gear". */
  flags: string[];
  notes: string[];
  sources: Source[];
  evidence_grade: string;
  tag: string;
  registry_refs?: string[];
}

/** PSD parameters of a family or a grinder (crates/puckmodel/src/presets.rs). */
export interface PsdParameters {
  x50_gap_ratio?: number;
  fines_at_340_pct?: number;
  coarse_log_width?: number;
  boulder_weight?: number;
  /** μ_f: fines mode, µm. */
  fines_mode_um?: number;
}

export interface GrinderFamilyPreset extends PresetBase {
  burr: string;
  psd: PsdParameters;
}

export interface GrinderDial {
  label: string;
  min: number;
  max: number;
  default: number;
  ref: number;
  gap_at_ref_um: number;
  gap_per_unit_um: number;
  /** Settings at which the grinder's PSD was measured (outside them the model extrapolates). */
  anchored?: { min: number; max: number } | null;
}

export interface GrinderPreset extends PresetBase {
  family: string;
  burr_diameter_mm?: number;
  rpm?: number;
  dial: GrinderDial;
  psd?: PsdParameters;
}

export interface BasketPreset extends PresetBase {
  nominal_dose_g: number;
  dose_range_g: [number, number];
  profile_mm: [number, number][];
  perforated_diameter_mm: number;
  open_area_fraction?: number | null;
  pressurised_orifice_mm?: number | null;
  discharge_coefficient?: number | null;
}

export interface MachinePreset extends PresetBase {
  program: PhaseInput[];
  pump?: PumpInput | null;
  temperature_c?: number;
  temperature_range_c?: [number, number];
  basket_diameter_mm?: number;
  default_basket?: string;
  drip_tau_s?: number;
  preheat_temp_c?: number;
  headspace_ml?: number;
  /** The machine vents the group after the shot (a three-way valve). */
  vent_headspace?: boolean;
}

export interface BeanPreset extends PresetBase {
  default?: boolean;
  arabica_fraction: number;
  roast_level: number;
  days_off_roast: number;
  process: BeanProcess | null;
}

export interface PresetsDoc {
  schema: string;
  grinder_families: GrinderFamilyPreset[];
  grinders: GrinderPreset[];
  baskets: BasketPreset[];
  machines: MachinePreset[];
  beans: BeanPreset[];
}

// ---------------------------------------------------------------- registry

export interface RegistryRange {
  min?: number;
  max?: number;
}

export type RegistryPrior =
  | { distribution: 'uniform'; min: number; max: number }
  | { distribution: 'normal'; mean: number; sd: number }
  | { distribution: 'lognormal'; median: number; gsd?: number; sigma?: number }
  | { distribution: 'triangular'; min: number; mode: number; max: number }
  | { distribution: string; [key: string]: unknown };

/** One parameter record (crates/puckmodel/generated/registry.json). */
export interface RegistryParameter {
  id: string;
  name: string;
  symbol?: string;
  description: string;
  units: string;
  value?: number;
  prior?: RegistryPrior;
  range: RegistryRange;
  conditions?: string;
  tag: string;
  evidence_grade: string;
  sources: Source[];
  research_note_ref?: string[];
  used_by?: string[];
  status?: string;
  licence_note?: string;
  relation?: string;
  /** The value the model uses unless overridden. */
  default: number;
  /** Where `default` comes from: `value`, `prior` or `calibration`. */
  default_from: string;
}

export interface RegistryDoc {
  schema: string;
  calibration: unknown;
  parameters: RegistryParameter[];
}

/** Everything the UI needs from the engine before the first build. */
export interface Catalog {
  coreVersion: string;
  presets: PresetsDoc;
  registry: RegistryDoc;
}
