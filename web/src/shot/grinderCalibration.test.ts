// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import {
  calibrateDialAtSetting,
  calibrateDialFromAnchors,
  makeCustomDial,
  resolveGrinderGap,
} from './grinderCalibration';
import { defaultForm, formToRecipe, recipeToForm } from './recipeForm';
import { validateAlternativeGrind } from '../setup/SetupPrediction';

const catalog = fixtureCatalog();
function recipe(form: ReturnType<typeof defaultForm>) {
  const result = formToRecipe(form, { catalog });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}
describe('custom grinder number calibration', () => {
  it.each(catalog.presets.grinders.map((p) => p.id))(
    'keeps native physics when relabeling %s',
    (id) => {
      const form = defaultForm();
      form.grinder.preset = id;
      form.grinder.setting = '';
      const before = fixtureBuild(recipe(form));
      for (const direction of ['coarser', 'finer'] as const) {
        const result = makeCustomDial(form, catalog, 12.5, direction);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const custom = recipe(result.value);
        expect(custom.grinder.setting).toBe(12.5);
        expect(custom.grinder.setting_ref).toBe(12.5);
        expect(fixtureBuild(custom).spec).toEqual(before.spec);
        expect(() => validateAlternativeGrind(custom, catalog, fixtureBuild(custom))).not.toThrow();
        const imported = recipeToForm(custom);
        expect(imported.ok).toBe(true);
        if (imported.ok) expect(recipe(imported.form)).toEqual(custom);
        result.value.grinder.setting = '13.5';
        expect(resolveGrinderGap(result.value.grinder, catalog.presets.grinders)).toBeCloseTo(
          before.derived.psd!.gap_um! + (direction === 'coarser' ? 10 : -10),
        );
      }
    },
  );
  it('preserves explicit and registry PSD overrides when changing the number scale', () => {
    const form = defaultForm();
    form.grinder.preset = 'bentwood-v63';
    form.grinder.fines_at_340_pct = '18';
    form.overrides['model.psd.coarse_log_width'] = '0.5';
    const result = makeCustomDial(form, catalog, -3, 'finer');
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(fixtureBuild(recipe(result.value)).spec).toEqual(fixtureBuild(recipe(form)).spec);
  });
  it('supports negative two-point sensitivity and arbitrary reference coordinates', () => {
    const result = calibrateDialFromAnchors({
      first: { setting: 11, effectiveGapUm: 220 },
      second: { setting: 14, effectiveGapUm: 160 },
    });
    expect(result).toEqual({
      ok: true,
      value: { setting: 11, setting_ref: 11, gap_at_ref_um: 220, gap_per_unit_um: -20 },
    });
    expect(
      calibrateDialFromAnchors({
        first: { setting: 1, effectiveGapUm: 200 },
        second: { setting: 1, effectiveGapUm: 210 },
      }).ok,
    ).toBe(false);
    expect(calibrateDialAtSetting({ setting: 1, effectiveGapUm: 190, gapPerUnitUm: 0 }).ok).toBe(
      false,
    );
  });
  it('refuses to relabel an invalid or clamped grind as an exact conversion', () => {
    const form = defaultForm();
    form.grinder.setting = '99999';
    expect(makeCustomDial(form, catalog, 10, 'coarser').ok).toBe(false);
    form.grinder.mode = 'psd';
    expect(makeCustomDial(form, catalog, 10, 'coarser').ok).toBe(false);
  });
});
