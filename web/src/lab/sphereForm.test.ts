// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { estimateRunBytes, formatMegabytes, MEMORY_WARNING_BYTES } from '../engine/memory';
import { checkSphereParams } from '../engine/types';
import {
  AUTO_RUN_MAX_STEPS,
  AUTO_RUN_MAX_WORK,
  canAutoRun,
  DEFAULT_SPHERE_FORM,
  MESSAGES,
  parseDecimal,
  TAU_MESSAGE,
  validateSphereForm,
  type SphereForm,
} from './sphereForm';

const withField = (patch: Partial<SphereForm>): SphereForm => ({
  ...DEFAULT_SPHERE_FORM,
  ...patch,
});

describe('parseDecimal', () => {
  it.each([
    ['150', 150],
    [' 150 ', 150],
    ['0.5', 0.5],
    ['.5', 0.5],
    ['5.', 5],
    ['+2', 2],
    ['-3', -3],
    ['1e-10', 1e-10],
    ['1E-10', 1e-10],
    ['2.5e3', 2500],
  ])('reads %j as %d', (text, value) => {
    expect(parseDecimal(text)).toBe(value);
  });

  it.each([
    ['150', -6, 150e-6],
    ['0.1', -6, 0.1e-6],
    ['1.5e2', -6, 1.5e-4],
    ['-2E+3', 1, -2e4],
  ])('scales %j by 10^%d exactly like a decimal literal', (text, power, value) => {
    expect(parseDecimal(text, power)).toBe(value);
  });

  it.each([
    ['18,5', 18.5],
    ['0,125', 0.125],
    ['-2,5e-3', -0.0025],
    [',5', 0.5],
    ['1234,5', 1234.5],
  ])('reads the decimal comma in %j', (text, value) => {
    expect(parseDecimal(text)).toBe(value);
  });

  it.each([
    '',
    ' ',
    'abc',
    '1,500',
    '1,2,3',
    '1.5,2',
    '1e',
    '1e-',
    '-',
    '.',
    '0x10',
    'Infinity',
    'NaN',
    '1,000',
    '1 000',
    '1e400',
    '12abc',
  ])('rejects %j', (text) => {
    expect(parseDecimal(text)).toBeNull();
  });
});

function validParams() {
  const result = validateSphereForm(DEFAULT_SPHERE_FORM);
  if (!result.ok) throw new Error('defaults should be valid');
  return result.params;
}

describe('validateSphereForm', () => {
  it('accepts the defaults and converts µm to m', () => {
    const result = validateSphereForm(DEFAULT_SPHERE_FORM);
    expect(result).toEqual({
      ok: true,
      params: {
        radiusM: 150e-6,
        diffusivityM2S: 1e-10,
        nShells: 64,
        tEndS: 60,
        nSteps: 2000,
        grid: 'equal_volume',
        scheme: 'bdf2',
      },
      work: 64 * 2000,
    });
  });

  it('produces parameters the engine contract accepts', () => {
    const result = validateSphereForm(DEFAULT_SPHERE_FORM);
    if (!result.ok) throw new Error('defaults should be valid');
    expect(checkSphereParams(result.params)).toBeNull();
  });

  it('converts the radius exactly as a decimal literal would', () => {
    for (const [text, metres] of [
      ['150', 150e-6],
      ['0.1', 0.1e-6],
      ['333.3', 333.3e-6],
    ] as const) {
      const result = validateSphereForm(withField({ radiusUm: text }));
      expect(result.ok && result.params.radiusM).toBe(metres);
    }
  });

  it.each([
    ['radiusUm', ''],
    ['radiusUm', '0'],
    ['radiusUm', '-150'],
    ['radiusUm', 'big'],
    ['radiusUm', '1e-320'], // underflows to 0 m
    ['diffusivity', '0'],
    ['diffusivity', '1e-'],
    ['diffusivity', '-1e-10'],
    ['nShells', '1'],
    ['nShells', '64.5'],
    ['nShells', '100001'],
    ['nShells', ''],
    ['tEnd', '0'],
    ['tEnd', 'sixty'],
    ['nSteps', '0'],
    ['nSteps', '2.5'],
    ['nSteps', '10000001'],
  ] as const)('flags %s = %j', (field, value) => {
    const result = validateSphereForm(withField({ [field]: value }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({ [field]: MESSAGES[field] });
  });

  it('accepts the contract limits', () => {
    for (const patch of [
      { nShells: '2', nSteps: '1' },
      { nShells: '100000', nSteps: '1' },
      { nShells: '2', nSteps: '10000000' },
      { nSteps: '1e3' },
    ]) {
      expect(validateSphereForm(withField(patch)).ok).toBe(true);
    }
  });

  it('flags an unknown grid or scheme', () => {
    const result = validateSphereForm(
      withField({ grid: 'hexagonal' as never, scheme: 'euler' as never }),
    );
    expect(result).toEqual({ ok: false, errors: { grid: MESSAGES.grid, scheme: MESSAGES.scheme } });
  });

  it('reports every invalid field at once', () => {
    const result = validateSphereForm(withField({ radiusUm: '', nShells: 'x', nSteps: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.errors).sort()).toEqual(['nShells', 'nSteps', 'radiusUm']);
  });

  it('applies the core’s limit on the dimensionless end time D·t_end/a² ≤ 1e200', () => {
    // 150 µm, 1e-10 m²/s: τ = 1e-10 × t / 2.25e-8, so t = 1e200 s gives τ ≈ 4.4e197.
    expect(validateSphereForm(withField({ tEnd: '1e200' })).ok).toBe(true);
    for (const patch of [
      { tEnd: '1e203' }, // τ ≈ 4.4e200
      { radiusUm: '1e-300' }, // a² underflows to 0, so τ is infinite
      { diffusivity: '1e300', tEnd: '1e300' }, // D·t overflows
    ]) {
      const result = validateSphereForm(withField(patch));
      expect(result).toEqual({ ok: false, errors: { tEnd: TAU_MESSAGE } });
    }
    // The engine-side check agrees.
    expect(checkSphereParams({ ...validParams(), tEndS: 1e203 })).toMatch(/dimensionless time/);
    expect(checkSphereParams({ ...validParams(), tEndS: 1e200 })).toBeNull();
  });

  it('measures the work as shells × steps', () => {
    const result = validateSphereForm(withField({ nShells: '1000', nSteps: '100000' }));
    expect(result.ok && result.work).toBe(1e8);
    expect(1e8).toBeGreaterThan(AUTO_RUN_MAX_WORK);
  });
});

describe('canAutoRun', () => {
  it('starts small runs only, bounding both work and output size', () => {
    expect(canAutoRun({ nShells: 64, nSteps: 2000 })).toBe(true);
    expect(canAutoRun({ nShells: 250, nSteps: AUTO_RUN_MAX_STEPS })).toBe(true);
    expect(canAutoRun({ nShells: 251, nSteps: AUTO_RUN_MAX_STEPS })).toBe(false); // work
    expect(canAutoRun({ nShells: 2, nSteps: AUTO_RUN_MAX_STEPS + 1 })).toBe(false); // output
    // The review case: 2 shells × 10 million steps is little work but 240 MB of output.
    expect(canAutoRun({ nShells: 2, nSteps: 10_000_000 })).toBe(false);
    expect(canAutoRun({ nShells: 100_000, nSteps: 500 })).toBe(true);
    expect(canAutoRun({ nShells: 100_000, nSteps: 501 })).toBe(false);
  });

  it('keeps every automatic run under the memory warning', () => {
    for (const p of [
      { nShells: 250, nSteps: AUTO_RUN_MAX_STEPS },
      { nShells: 100_000, nSteps: 500 },
    ]) {
      expect(canAutoRun(p)).toBe(true);
      expect(estimateRunBytes(p)).toBeLessThan(MEMORY_WARNING_BYTES);
    }
  });
});

describe('estimateRunBytes', () => {
  it('grows with the number of steps and shells', () => {
    expect(estimateRunBytes({ nShells: 2, nSteps: 10_000_000 })).toBeGreaterThan(500e6);
    expect(estimateRunBytes({ nShells: 64, nSteps: 2000 })).toBeLessThan(1e6);
    expect(formatMegabytes(estimateRunBytes({ nShells: 2, nSteps: 1_000_000 }))).toBe('53 MB');
    expect(formatMegabytes(10)).toBe('1 MB');
  });
});
