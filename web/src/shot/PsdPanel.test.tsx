// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type uPlot from 'uplot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureRun } from '../../test/fixtures/shotFixture';
import { PsdPanel, type PsdRun } from './PsdPanel';
import { DEFAULT_RECIPE } from './recipeForm';

const charts = vi.hoisted(() => [] as { options: uPlot.Options; data: uPlot.AlignedData }[]);

// Keep uPlot's real numeric ranging while replacing the canvas that jsdom lacks.
vi.mock('uplot', async (importOriginal) => {
  // uPlot reads the device pixel ratio during import; jsdom has no matchMedia.
  vi.stubGlobal('matchMedia', () => new EventTarget());
  const original = await importOriginal<{ default: typeof uPlot }>();
  vi.unstubAllGlobals();
  return {
    default: class FakeUPlot {
      static pxRatio = 1;
      static rangeNum = original.default.rangeNum.bind(original.default);
      constructor(options: uPlot.Options, data: uPlot.AlignedData, target: HTMLElement) {
        charts.push({ options, data });
        target.append(Object.assign(document.createElement('div'), { className: 'uplot' }));
      }
      setData() {}
      setSize() {}
      destroy() {}
    },
  };
});

function particleRun(yields: number[]): PsdRun {
  const data = fixtureRun(DEFAULT_RECIPE, { classes: yields.length });
  data.result.spatial.class_ey?.forEach((entry, i) => {
    entry.ey = yields[i];
  });
  return {
    label: 'Current',
    slot: 0,
    outcome: {
      ...data,
      key: 'fixture',
      recipe: DEFAULT_RECIPE,
      kind: 'full',
      tier: 1,
      runtimeMs: 1,
      seq: 1,
    },
  };
}

afterEach(() => {
  cleanup();
  charts.length = 0;
});

describe('particle extraction chart', () => {
  it.each([
    [-0.02, 0.2],
    [-0.05, -0.02],
    [0.1, 0.2],
  ])('keeps yields %s and %s visible with a zero reference', (fine, coarse) => {
    render(<PsdPanel runs={[particleRun([fine, coarse])]} />);
    const chart = charts.find((entry) => entry.options.axes?.[1]?.label === 'EY (%)');
    expect(chart).toBeDefined();
    expect(chart?.data[1]).toEqual([fine * 100, coarse * 100]);

    const range = chart?.options.scales?.y.range;
    expect(typeof range).toBe('function');
    if (typeof range !== 'function') throw new Error('Missing automatic range');
    const [low, high] = range({} as uPlot, fine * 100, coarse * 100, 'y');
    expect(low).toBeLessThanOrEqual(Math.min(0, fine * 100));
    expect(high).toBeGreaterThanOrEqual(Math.max(0, coarse * 100));

    const valToPos = vi.fn(() => 100);
    const stroke = vi.fn();
    const plot = {
      valToPos,
      bbox: { left: 0, top: 0, width: 600, height: 200 },
      ctx: {
        save: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke,
        restore: vi.fn(),
      },
    } as unknown as uPlot;
    chart?.options.hooks?.drawAxes?.forEach((draw) => draw?.(plot));
    expect(valToPos).toHaveBeenCalledWith(0, 'y', true);
    expect(stroke).toHaveBeenCalledOnce();

    if (fine < 0) {
      expect(screen.getByText(`−${Math.abs(fine * 100).toFixed(2)}%`)).toBeTruthy();
      expect(screen.getByText(/Negative values mean those particles gained/)).toBeTruthy();
    }
  });
});
