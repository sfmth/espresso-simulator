// SPDX-License-Identifier: GPL-2.0-or-later
/** Short explanations of the terms the lab uses, shown by the help buttons. */

export interface Term {
  title: string;
  text: string;
}

export const GLOSSARY: Record<string, Term> = {
  ey: {
    title: 'Extraction yield (EY)',
    text: 'The share of the dry coffee dose that dissolved into the cup: dissolved solids in the cup divided by the dose. Typical espresso: 18–22%.',
  },
  tds: {
    title: 'Total dissolved solids (TDS)',
    text: 'The strength of the drink: the mass fraction of dissolved coffee solids in the beverage. Typical espresso: 8–12%. “Outlet” TDS is the strength of what is dripping out right now; “cup” TDS is the whole cup so far.',
  },
  ratio: {
    title: 'Brew ratio',
    text: 'Beverage mass per gram of dry coffee, e.g. 1 : 2 for 18 g in and 36 g out.',
  },
  headspace: {
    title: 'Headspace',
    text: 'The water-filled volume above the puck: the basket above the bed plus the space up to the shower screen. It must fill before pressure builds, and a large one wets the puck less evenly.',
  },
  opv: {
    title: 'Over-pressure valve (OPV)',
    text: 'A valve on a vibratory-pump machine that opens at a set pressure and caps the pressure at the puck. Without one, the pressure can rise to the pump’s stall pressure.',
  },
  vibratory: {
    title: 'Vibratory pump',
    text: 'A pump whose flow falls as pressure rises: Q = Q_free × (1 − P/P_stall). The free flow is the flow at zero pressure; the stall pressure is where flow stops.',
  },
  ideal: {
    title: 'Ideal (profiling) pump',
    text: 'A pump that follows the program exactly, within its maximum flow and pressure: profiling machines, levers, or rotary pumps with a bypass.',
  },
  'open-area': {
    title: 'Open area',
    text: 'The share of the basket floor’s perforated field that is holes. Small open areas add resistance near the outlet and can starve the puck’s edge.',
  },
  perforated: {
    title: 'Perforated diameter',
    text: 'The diameter of the field of holes on the basket floor. Holes that stop short of the wall leave the puck’s edge with a longer path and lower flow.',
  },
  pressurised: {
    title: 'Pressurised (dual-wall) basket',
    text: 'A basket whose extract leaves through one small orifice instead of many holes. The orifice adds a resistance that grows with the square of the flow, which keeps pressure up even with a coarse grind.',
  },
  discharge: {
    title: 'Discharge coefficient',
    text: 'How efficiently the orifice of a pressurised basket passes flow, between 0 and 1 (typically 0.6–0.8). Lower values mean more resistance.',
  },
  gap: {
    title: 'Burr gap',
    text: 'The distance between the burrs. The median particle size (X50) is about 1.4 times the gap on the one grinder where both were measured.',
  },
  x50: {
    title: 'X50 and the X50/gap ratio',
    text: 'X50 is the volume median particle diameter: half the coffee’s volume is in smaller particles. κ_G = X50 / burr gap describes a grinder.',
  },
  fines: {
    title: 'Fines',
    text: 'Particles below 100 µm. They extract fast and slow the flow. u_G is a grinder’s fines percentage at a median of 340 µm; lower means a more unimodal grinder.',
  },
  'coarse-width': {
    title: 'Coarse-mode width σ_c',
    text: 'How spread out the main (coarse) peak of the particle sizes is: the standard deviation of ln(diameter). Unimodal flat burrs are narrow (about 0.3), conical burrs wider (about 0.4).',
  },
  boulders: {
    title: 'Boulder share w_b',
    text: 'The volume share of the tail of oversized particles (boulders) above the main peak.',
  },
  d32: {
    title: 'Sauter diameter D[3,2]',
    text: 'The diameter of a particle with the same volume-to-surface ratio as the whole distribution. It sets how strongly the bed resists flow.',
  },
  d43: {
    title: 'Volume mean diameter D[4,3]',
    text: 'The volume-weighted mean particle diameter, the size most laser-diffraction instruments report.',
  },
  'size-classes': {
    title: 'Size classes',
    text: 'The solver represents the particle-size distribution with this many classes (default 30). Tier 0 merges them into a few.',
  },
  tier: {
    title: 'Fidelity tier',
    text: 'Tier 0 is a fast preview: the same physics on a much coarser grid (one column, a few depth cells, two merged size classes). Tier 1 is the standard model, with several columns, finer depth cells and every size class. The live preview always uses tier 0.',
  },
  roast: {
    title: 'Roast level',
    text: '0 is a very light roast, 1 a very dark one. It changes composition, CO₂ content and how fine the beans grind.',
  },
  tamp: {
    title: 'Tamp force',
    text: 'Recorded only: three datasets found no effect above about 10 kgf. Below about 5 kgf the model notes a loose bed.',
  },
  wdt: {
    title: 'Distribution',
    text: 'How the grounds were spread before tamping: none, tapping the portafilter, or WDT (stirring with fine needles). Better distribution narrows the spread of flow paths.',
  },
  ramp: {
    title: 'Ramp',
    text: 'Seconds to move linearly from the previous phase’s target to this one.',
  },
  limit: {
    title: 'Limit',
    text: 'A cap on the other quantity: a maximum flow (mL/s) while holding pressure, or a maximum pressure (bar) while holding flow.',
  },
  uniformity: {
    title: 'Uniformity',
    text: 'How evenly the bed extracted: the spread of local extraction over all bed cells, weighted by their coffee mass. Local values count what left the particles, so they also include what is still in the bed liquid.',
  },
  'mass-balance': {
    title: 'Mass-balance error',
    text: 'A numerical check: the relative mismatch between the solubles at the start and those in the particles, the bed liquid and the cup at the end. It should be tiny.',
  },
  vent: {
    title: 'Venting the group (three-way valve)',
    text: 'Some machines open a three-way valve when the shot stops: the water above the puck leaves through the valve instead of the puck, so the extract stops dripping almost at once.',
  },
  outflow: {
    title: 'Outflow check',
    text: 'A second, independent conservation check: the solubles in the cup compared with the outlet flow times the outlet concentration, summed over the shot. It is first-order in the time step, so about 0.001 is expected; values near 1 would mean the flow and the transport disagree.',
  },
  'liquid-conc': {
    title: 'Solubles in the bed liquid',
    text: 'The concentration of dissolved coffee in the water held in the bed, between and inside the particles, per volume of that water. It is 0 where the water has not arrived yet.',
  },
  wetting: {
    title: 'Wetting front',
    text: 'Water enters the dry puck from the top; the front is where it has got to. Cells below it are still dry, and cells it is passing through are partly wet.',
  },
  'first-drops': {
    title: 'First drops',
    text: 'When extract first leaves the basket, after the headspace and the puck have filled with water.',
  },
  'local-ey': {
    title: 'Local extraction yield',
    text: 'The share of the coffee in one cell of the bed that has left its particles. It is never negative in the standard model; with the kernel loading cap switched off, particles can take solubles back up from the liquid and the value can dip below zero.',
  },
  provenance: {
    title: 'Provenance',
    text: 'Where a number comes from: a registry parameter (with its source, evidence grade and tag), a preset, a field of your recipe, or a model rule. Grades run from A (strong evidence) to D (estimate); tags say whether a value was measured, derived, estimated or fitted.',
  },
  flags: {
    title: 'Preset flags',
    text: 'generic: a typical example, not a product. estimated: values judged, not measured. unverified: from retail listings no manufacturer confirmed. disputed: sources conflict. owner-gear: the maintainer’s own equipment, still unverified.',
  },
  overrides: {
    title: 'Sandbox overrides',
    text: 'Replace any parameter of the registry with your own value. An override applies wherever the models use that parameter, including values a preset or the bean model would otherwise supply.',
  },
};
