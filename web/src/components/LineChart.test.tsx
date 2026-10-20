// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineChart, type LineChartProps } from './LineChart';

vi.mock('uplot', () => ({
  default: class FakeUPlot {
    constructor(_options: unknown, _data: unknown, target: HTMLElement) {
      target.append(document.createElement('canvas'));
    }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));
afterEach(cleanup);

const props: LineChartProps = {
  data: [
    [0, 0.2, 1.7, 2],
    [1, 2, 3, 4],
    [null, 12.345, null, 14],
  ],
  series: [
    { label: 'Current', slot: 0 },
    { label: 'Pinned trial', slot: 1 },
  ],
  xLabel: 'Time (s)',
  yLabel: 'bar',
  formatX: (v) => `${v} s`,
  formatY: (v) => `${v.toFixed(3)} bar`,
  formatTick: String,
  summary: 'Pressure against time for two runs',
};

describe('chart text readout', () => {
  it('exposes every aligned sample and pinned-run value with actual time', () => {
    render(<LineChart {...props} />);
    fireEvent.click(screen.getByText('Read chart values'));
    const slider = screen.getByRole('slider', { name: 'Time (s) sample' });
    fireEvent.change(slider, { target: { value: '1' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('0.2 s, sample 2 of 4');
    const output = document.getElementById(slider.getAttribute('aria-describedby') ?? '');
    expect(output?.getAttribute('aria-live')).toBe('polite');
    expect(output?.textContent).toContain('Current2.000 bar');
    expect(output?.textContent).toContain('Pinned trial12.345 bar');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(output?.textContent).toContain('Pinned trialNo value at this sample');
  });

  it('clamps the selected sample when data shrink and handles an empty result', () => {
    const view = render(<LineChart {...props} />);
    fireEvent.click(screen.getByText('Read chart values'));
    const slider = screen.getByRole('slider', { name: 'Time (s) sample' });
    fireEvent.change(slider, { target: { value: '3' } });
    view.rerender(<LineChart {...props} data={[[7], [8], [9]]} />);
    expect(slider.getAttribute('aria-valuetext')).toBe('7 s, sample 1 of 1');
    expect(screen.getByText('9.000 bar')).toBeTruthy();
    view.rerender(<LineChart {...props} data={[[], [], []]} />);
    expect(screen.getByText('No samples available.')).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
