// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Chart colours. uPlot paints on a canvas, which cannot read CSS variables, so
 * the theme tokens from styles.css are read here and re-read when the colour
 * scheme changes.
 *
 * - Series colours are the categorical slots of the validated palette (blue,
 *   orange, aqua, yellow, magenta, green, violet), assigned in fixed order and
 *   never cycled: slot 0 is the current run, slots 1–6 pinned runs. The seven
 *   pass the colour-vision checks (adjacent CVD ΔE ≥ 8, normal-vision ΔE ≥ 15)
 *   in both themes; three light-mode slots sit below 3:1 on the surface, so
 *   every chart also has a legend and a table view.
 * - The sequential ramp (heatmaps) is one hue, light to dark on a light
 *   surface and dark to light on a dark one, so "more" always means more
 *   contrast with the surface.
 */
import { useEffect, useState } from 'react';

export interface ChartTheme {
  /** Axis values and labels. */
  text: string;
  /** Gridlines. */
  grid: string;
  /** Ticks and baselines. */
  axis: string;
  /** Chart background, used for marker rings. */
  surface: string;
  /** Categorical series colours, in slot order. */
  series: readonly string[];
  /** Sequential ramp from low to high values for the current theme. */
  ramp: readonly string[];
  /**
   * Diverging ramp for values on both sides of zero: red (below) through a
   * neutral grey (zero) to blue (above), more contrast with the surface at the ends.
   */
  diverging: readonly string[];
  dark: boolean;
}

/** Number of categorical slots: the current run plus six pins. */
export const SERIES_SLOTS = 7;

const LIGHT_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7'];
const DARK_SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];

/** The blue ramp, steps 100 → 700. */
const BLUE_RAMP = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
];

const LIGHT_DIVERGING = ['#a8312b', '#f0efec', '#104281'];
const DARK_DIVERGING = ['#f2a29c', '#383835', '#b7d3f6'];

const LIGHT: ChartTheme = {
  text: '#52514e',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#fcfcfb',
  series: LIGHT_SERIES,
  ramp: BLUE_RAMP,
  diverging: LIGHT_DIVERGING,
  dark: false,
};

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function readTheme(): ChartTheme {
  if (typeof document === 'undefined') return LIGHT;
  const dark = prefersDark();
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const defaults = dark ? DARK_SERIES : LIGHT_SERIES;
  return {
    text: token('--ink-2', LIGHT.text),
    grid: token('--chart-grid', LIGHT.grid),
    axis: token('--chart-axis', LIGHT.axis),
    surface: token('--surface', LIGHT.surface),
    series: defaults.map((fallback, i) => token(`--series-${i + 1}`, fallback)),
    ramp: dark ? [...BLUE_RAMP].reverse() : BLUE_RAMP,
    diverging: dark ? DARK_DIVERGING : LIGHT_DIVERGING,
    dark,
  };
}

/** The current chart colours; updates when the system switches between light and dark. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTheme(readTheme());
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return theme;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The ramp colour at `t` in [0, 1], interpolated between its steps. */
export function rampColor(ramp: readonly string[], t: number): string {
  if (ramp.length === 0) return '#888888';
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  if (ramp.length === 1) return ramp[0];
  const f = x - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
