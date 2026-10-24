// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { COFFEE_CATALOG, coffeeToBeanInput } from './catalog';
import provenance from './catalog.metadata.json';

describe('curated single-origin coffee catalogue', () => {
  it('keeps the provenance sidecar aligned with the included source snapshots', () => {
    expect(provenance.count).toBe(COFFEE_CATALOG.length);
    expect(provenance.sources).toEqual(
      COFFEE_CATALOG.map(({ id, roaster, source_url, verified_at, availability }) => ({
        id,
        roaster,
        url: source_url,
        verified_at,
        availability,
      })),
    );
  });

  it('keeps traceable dated source facts and explicit modelling assumptions for every lot', () => {
    expect(new Set(COFFEE_CATALOG.map((coffee) => coffee.id)).size).toBe(COFFEE_CATALOG.length);
    expect(new Set(COFFEE_CATALOG.map((coffee) => coffee.roaster)).size).toBeGreaterThanOrEqual(8);
    for (const coffee of COFFEE_CATALOG) {
      expect(new URL(coffee.source_url).protocol).toBe('https:');
      expect(coffee.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(coffee.country).not.toBe('');
      expect(coffee.varieties.length).toBeGreaterThan(0);
      expect(coffee.assumptions.join(' ')).toContain('editable estimate');
      const bean = coffeeToBeanInput(coffee);
      expect(bean.components).toBeUndefined();
      expect(bean.coffee?.source_url).toBe(coffee.source_url);
      expect(bean.coffee?.roast_date).toBeUndefined();
      expect(bean.days_off_roast).toBeUndefined();
      expect(bean.storage).toBeUndefined();
      expect(bean.roast_level).toBeGreaterThanOrEqual(0);
      expect(bean.roast_level).toBeLessThanOrEqual(1);
    }
  });

  it('retains ground Agtron 128 on its stated scale without turning it into a roast-index measurement', () => {
    const entry = COFFEE_CATALOG.find((coffee) => coffee.id === 'onyx-las-lajas-natural-2026')!;
    const bean = coffeeToBeanInput(entry);
    expect(bean.coffee?.roast_color).toEqual({
      scale: 'agtron-gourmet',
      value: 128,
      sample: 'ground',
      instrument: 'Agtron M Basic III',
    });
    expect(bean.roast_level).toBe(0.25);
    expect(bean.coffee?.model_roast_basis).toContain('not measured roast chemistry');
  });

  it('does not falsely translate wet-hulled processing to washed', () => {
    const bean = coffeeToBeanInput(COFFEE_CATALOG.find((coffee) => coffee.roaster === 'Klatch')!);
    expect(bean.coffee?.process_label).toBe('Wet-Hulled');
    expect(bean.process).toBeNull();
    expect(bean.coffee?.model_roast_basis).toContain('left unspecified');
  });

  it('marks an elevation midpoint as estimated and keeps the published endpoints in provenance', () => {
    const bean = coffeeToBeanInput(COFFEE_CATALOG[0]);
    expect(bean.altitude_m).toBe(2150);
    expect(bean.coffee?.model_roast_basis).toContain('estimated midpoint');
    expect(bean.coffee?.model_roast_basis).toContain('1900–2400 m');
  });

  it('isolates editable recipe metadata from the shared catalogue and later selections', () => {
    const entry = COFFEE_CATALOG.find((coffee) => coffee.roast_color)!;
    const bean = coffeeToBeanInput(entry);
    bean.coffee!.varieties![0] = 'User correction';
    bean.coffee!.roast_color!.value = 99;
    const next = coffeeToBeanInput(entry);
    expect(next.coffee?.varieties).toEqual(entry.varieties);
    expect(next.coffee?.varieties?.[0]).not.toBe('User correction');
    expect(next.coffee?.roast_color?.value).toBe(128);
  });
});
