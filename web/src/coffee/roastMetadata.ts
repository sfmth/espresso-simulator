// SPDX-License-Identifier: GPL-2.0-or-later
import type { CoffeeMetadata } from '../engine/shotTypes';
import { COFFEE_CATALOG, coffeeToBeanInput } from './catalog';

const OVERRIDE_MARKER = '\nCurrent model roast override: ';
const LIMIT = 2000;

/** Keep source assumptions separate from the latest user override, without growing on each edit. */
export function roastBasisWithOverride(
  facts: Pick<CoffeeMetadata, 'id' | 'model_roast_basis'>,
  override: string,
): string {
  const catalog = COFFEE_CATALOG.find((entry) => entry.id === facts.id);
  const original = catalog
    ? (coffeeToBeanInput(catalog).coffee?.model_roast_basis ?? '')
    : (facts.model_roast_basis ?? '');
  const previous = original.split(OVERRIDE_MARKER)[0];
  const suffix = `${OVERRIDE_MARKER}${override}`;
  const budget = Math.max(0, LIMIT - suffix.length);
  const shortened = '\n[Earlier basis shortened to fit the metadata limit.]';
  const basis =
    previous.length <= budget
      ? previous
      : `${previous.slice(0, Math.max(0, budget - shortened.length))}${shortened}`;
  return `${basis}${suffix}`.slice(0, LIMIT);
}
