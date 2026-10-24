// SPDX-License-Identifier: GPL-2.0-or-later
/** Plain-language choices for the existing estimated roast model, not a color calibration. */
export const ROAST_ASSUMPTIONS = [
  { value: '0', label: 'Very light' },
  { value: '0.25', label: 'Light' },
  { value: '0.375', label: 'Medium-light' },
  { value: '0.5', label: 'Medium' },
  { value: '0.65', label: 'Medium-dark' },
  { value: '0.8', label: 'Dark' },
  { value: '1', label: 'Very dark' },
] as const;

export const ROAST_COLOR_SCALES = [
  { value: 'agtron-gourmet', label: 'Agtron Gourmet' },
  { value: 'agtron-commercial', label: 'Agtron Commercial' },
  { value: 'colorette', label: 'Colorette' },
  { value: 'cielab-lstar', label: 'CIELAB L*' },
  { value: 'other', label: 'Other scale' },
] as const;

export const ROAST_COLOR_SAMPLES = [
  { value: 'ground', label: 'Ground coffee' },
  { value: 'whole-bean', label: 'Whole beans' },
  { value: 'unspecified', label: 'Sample not specified' },
] as const;

export const ROAST_LABEL_BASIS =
  'Estimated model roast from a descriptive label; labels differ between roasters. Measured color is retained separately.';

export function roastAssumptionName(value: string | number | null | undefined): string {
  if (value === '' || value === undefined || value === null) return 'Preset roast assumption';
  const match = ROAST_ASSUMPTIONS.find((r) => Number(r.value) === Number(value));
  return match?.label ?? 'Custom model roast';
}

export function isSingleCoffeePreset(preset: { arabica_fraction: number }): boolean {
  return preset.arabica_fraction === 0 || preset.arabica_fraction === 1;
}
