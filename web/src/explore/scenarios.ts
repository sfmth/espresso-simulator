// SPDX-License-Identifier: GPL-2.0-or-later
/** Fixed, inspectable teaching inputs; outcomes always come from the shared core. */
import type { Recipe } from '../engine/shotTypes';
import { recipeToForm, type RecipeForm } from '../shot/recipeForm';

export type ScenarioId = 'reference' | 'finer' | 'coarser' | 'uneven' | 'paper' | 'bloom' | 'turbo';
export interface GuidedScenario {
  id: ScenarioId;
  title: string;
  question: string;
  changes: readonly string[];
  watchFor: readonly string[];
  assumptions: readonly string[];
}
const REFERENCE_RECIPE: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: { preset: 'medium-washed-arabica' },
  grinder: { preset: 'generic-flat-traditional-64', setting: 190 },
  basket: { preset: '58-precision-18g' },
  prep: { dose_g: 18, distribution: 'wdt', paper_bottom: false, puck_screen: false },
  machine: { preset: 'flat-9-bar' },
  stop: { beverage_g: 36 },
  numerics: { tier: 1 },
};
const COMMON =
  'Fixed teaching recipe: medium washed Arabica, 18 g, 58 mm basket. It replaces the shared recipe and supports Undo.';
const PREP =
  'Preparation and edge-flow closures use broad, estimated community evidence (grade D). The picture does not validate a physical mechanism.';
export const GUIDED_SCENARIOS: readonly GuidedScenario[] = [
  {
    id: 'reference',
    title: 'Reference shot',
    question: 'How do water and extraction move through this puck?',
    changes: [
      '190 µm burr gap, WDT, 9 bar program and 36 g pump-stop target; no paper or puck screen.',
    ],
    watchFor: [
      'Scrub the stored snapshots to follow wetting and local extraction.',
      'Compare the centre with the outer annulus at the same depth.',
    ],
    assumptions: [COMMON, PREP],
  },
  {
    id: 'finer',
    title: 'Finer grind',
    question: 'Why can grinding finer change both flow and extraction?',
    changes: ['Burr gap 190 → 140 µm; all other reference inputs stay fixed.'],
    watchFor: [
      'Compare particle sizes, shot time and the final cup with the reference.',
      'A finer grind also changes the modelled fines share and preparation spread.',
    ],
    assumptions: [
      COMMON,
      'A smaller gap does not guarantee higher or lower cup extraction. Read the simulated result; no measured direction is promised.',
    ],
  },
  {
    id: 'coarser',
    title: 'Coarser grind',
    question: 'How does a more permeable bed change the shot?',
    changes: ['Burr gap 190 → 250 µm; all other reference inputs stay fixed.'],
    watchFor: [
      'Compare local extraction and the simulated shot time with the reference.',
      'Inspect coarse particles and the sub-grid fines share.',
    ],
    assumptions: [
      COMMON,
      'The generic grinder mapping and permeability closure are estimates; these settings do not map to every grinder.',
    ],
  },
  {
    id: 'uneven',
    title: 'Uneven preparation',
    question: 'What does a broader spread of column permeability change?',
    changes: ['Distribution WDT → none; grind, dose, basket and machine program stay fixed.'],
    watchFor: [
      'Compare extraction across columns at one depth.',
      'Permeability strata are arranged for display; their positions are illustrative.',
    ],
    assumptions: [
      COMMON,
      PREP,
      'This varies the continuum heterogeneity closure; it is not a simulation of individual cracks or a particular distribution technique.',
    ],
  },
  {
    id: 'paper',
    title: 'Bottom paper',
    question: 'What changes when the model gives the edge more access to flow?',
    changes: ['Bottom paper false → true; all other reference inputs stay fixed.'],
    watchFor: [
      'Inspect the outer annulus and compare it with the centre.',
      'Read the resolved edge multiplier in provenance.',
    ],
    assumptions: [
      COMMON,
      PREP,
      'The paper changes the estimated edge-flow closure. A paper fibre layer, filtration and sediment are not resolved.',
    ],
  },
  {
    id: 'bloom',
    title: 'Pause and bloom',
    question: 'What happens during a programmed pause?',
    changes: [
      'Replace the 9 bar program with the blooming preset: fill at 4 mL/s, pause at zero commanded flow for 20 s, then pressure extraction.',
    ],
    watchFor: [
      'Follow inlet flow, pressure, wetting and local extraction across the pause.',
      'Commanded flow, water leaving storage and cup flow are different quantities.',
    ],
    assumptions: [
      COMMON,
      'The preset timing is illustrative. The pause uses the current published storage/drip closures and is not validated against measured blooming shots.',
    ],
  },
  {
    id: 'turbo',
    title: 'Coarse, lower-pressure shot',
    question: 'What changes when grind, pressure and brew ratio change together?',
    changes: [
      'Burr gap 190 → 300 µm.',
      'Replace the 9 bar program with the 6 bar turbo preset.',
      'Pump-stop target 36 → 54 g for an 18 g dose.',
    ],
    watchFor: [
      'Compare the final cup strength, shot time and extraction with the reference.',
      'Three controls change together; this does not isolate a single cause.',
    ],
    assumptions: [
      COMMON,
      'The 54 g value is a pump-stop target; final cup mass can include drip. The preset does not guarantee a 15 s shot or a measured taste outcome.',
    ],
  },
];

/** Fresh complete inputs, with no inherited user PSD, overrides, fit or journal data. */
export function scenarioRecipe(id: ScenarioId): Recipe {
  const recipe = structuredClone(REFERENCE_RECIPE);
  switch (id) {
    case 'reference':
      break;
    case 'finer':
      recipe.grinder.setting = 140;
      break;
    case 'coarser':
      recipe.grinder.setting = 250;
      break;
    case 'uneven':
      recipe.prep.distribution = 'none';
      break;
    case 'paper':
      recipe.prep.paper_bottom = true;
      break;
    case 'bloom':
      recipe.machine = { preset: 'blooming' };
      break;
    case 'turbo':
      recipe.grinder.setting = 300;
      recipe.machine = { preset: 'turbo-6-bar' };
      recipe.stop = { beverage_g: 54 };
      break;
    default:
      throw new Error(`Unknown guided scenario: ${String(id)}`);
  }
  return recipe;
}
export function scenarioForm(id: ScenarioId): RecipeForm {
  const converted = recipeToForm(scenarioRecipe(id));
  if (!converted.ok) throw new Error(converted.error);
  return converted.form;
}
