// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { routeNotes } from './notes';
import { parseProvenance, presetOf, registryIdsUsed, registryIndex, tokensFor } from './provenance';
import { DEFAULT_RECIPE } from './recipeForm';

describe('provenance tokens', () => {
  it('parses every kind of token', () => {
    expect(
      parseProvenance(
        'registry:psd.x50_gap_ratio, preset:grinder_family/flat-traditional, recipe:grinder.setting, ' +
          'model:hard stop of at least 120 s, and well past the stop, override:a.b, calibration:c.d',
      ),
    ).toEqual([
      { kind: 'registry', id: 'psd.x50_gap_ratio', raw: 'registry:psd.x50_gap_ratio' },
      {
        kind: 'preset',
        id: 'flat-traditional',
        presetKind: 'grinder_family',
        raw: 'preset:grinder_family/flat-traditional',
      },
      { kind: 'recipe', id: 'grinder.setting', raw: 'recipe:grinder.setting' },
      // A comma inside a model description does not split it.
      {
        kind: 'model',
        id: 'hard stop of at least 120 s, and well past the stop',
        raw: 'model:hard stop of at least 120 s, and well past the stop',
      },
      { kind: 'override', id: 'a.b', raw: 'override:a.b' },
      { kind: 'calibration', id: 'c.d', raw: 'calibration:c.d' },
    ]);
    expect(parseProvenance('something odd')).toEqual([
      { kind: 'other', id: 'something odd', raw: 'something odd' },
    ]);
  });

  it('resolves every token of a real build against the registry and the presets', () => {
    const catalog = fixtureCatalog();
    const build = fixtureBuild({ ...DEFAULT_RECIPE, overrides: { 'extraction.max_yield': 26 } });
    const registry = registryIndex(catalog);
    const ids = registryIdsUsed(build.derived.provenance);
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(registry.has(id), id).toBe(true);
    const presets = Object.values(build.derived.provenance)
      .flatMap(parseProvenance)
      .filter((t) => t.kind === 'preset');
    expect(presets.length).toBeGreaterThan(0);
    for (const token of presets) expect(presetOf(catalog, token), token.raw).toBeDefined();
    expect(
      tokensFor(build.derived.provenance, 'solubles.extractable_fraction').map((t) => t.kind),
    ).toContain('override');
    expect(tokensFor(build.derived.provenance, 'no.such.field')).toEqual([]);
  });
});

describe('note routing', () => {
  it('sends each builder note to the section it is about', () => {
    const catalog = fixtureCatalog();
    const routed = routeNotes(
      [
        'Grinder: no setting given; using the default.',
        'Puck prep: distribution not given; assuming tap.',
        'Medium-roast washed Arabica: Composition priors are …',
        '58 mm precision basket, 18 g: Basket dimensions are estimates.',
        'Override extraction.max_yield has no effect on this recipe.',
        'Flat 9 bar: An ideal pump holds the programmed pressure.',
        'Something else entirely.',
      ],
      catalog,
    );
    expect(routed.grinder).toHaveLength(1);
    expect(routed.prep).toHaveLength(1);
    expect(routed.bean).toHaveLength(1);
    expect(routed.basket).toHaveLength(1);
    expect(routed.overrides).toHaveLength(1);
    expect(routed.machine).toHaveLength(1);
    expect(routed.other).toEqual(['Something else entirely.']);
  });

  it('routes the notes of a real build without leaving many unplaced', () => {
    const catalog = fixtureCatalog();
    const notes = fixtureBuild(DEFAULT_RECIPE).derived.notes;
    const routed = routeNotes(notes, catalog);
    expect(routed.other).toEqual([]);
  });
});
