// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { COFFEE_CATALOG, coffeeToBeanInput } from './catalog';
import { roastBasisWithOverride } from './roastMetadata';

describe('source facts and model roast edits', () => {
  it('retains the original catalog assumptions and published elevation range after changing roast', () => {
    const source = COFFEE_CATALOG.find((entry) => entry.altitude_range_m)!;
    const facts = coffeeToBeanInput(source).coffee!;
    const changed = roastBasisWithOverride(facts, 'Dark; estimated from a label.');
    expect(changed).toContain(facts.model_roast_basis);
    expect(changed).toContain(
      `${source.altitude_range_m![0]}–${source.altitude_range_m![1]} m range`,
    );
    expect(changed).toContain('Current model roast override: Dark');
  });
  it('preserves custom source notes but replaces its own previous override', () => {
    const original = 'User assay and storage notes; no color conversion.';
    let basis = original;
    for (let i = 0; i < 30; i++)
      basis = roastBasisWithOverride({ model_roast_basis: basis }, `Choice ${i}`);
    expect(basis).toBe(`${original}\nCurrent model roast override: Choice 29`);
  });
  it('bounds a long custom basis and explicitly marks any shortening', () => {
    const basis = roastBasisWithOverride({ model_roast_basis: 'x'.repeat(2000) }, 'Light');
    expect(basis.length).toBeLessThanOrEqual(2000);
    expect(basis).toContain('Earlier basis shortened');
    expect(basis.endsWith('Current model roast override: Light')).toBe(true);
  });
});
