// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParticleProfile } from './microstructure';
import { ParticleInspector } from './ParticleInspector';
function profile(): ParticleProfile {
  return {
    classIndex: 1,
    radiusMm: 0.08,
    kernelRadiusMm: 0.064,
    radiusFraction: Float64Array.from([0.5, 1]),
    concentrationKgM3: Float64Array.from([400, 100]),
    remainingFraction: Float64Array.from([0.8, 0.2]),
    surfaceRemainingFraction: 0,
    source: 'coupled-core',
  };
}
afterEach(cleanup);
describe('coupled particle inspector', () => {
  it('renders exact shell averages and the correct intact-kernel radius in the table and figure', () => {
    render(
      <ParticleInspector ey={null} profile={profile()} index={3} count={80} onSelect={vi.fn()} />,
    );
    expect(
      screen.getByText(/Class 2 · diameter 160.0 µm · intact kernel radius 64.0 µm/),
    ).toBeTruthy();
    const details = screen.getByText('Shell data table').closest('details')!;
    details.open = true;
    const rows = within(details).getAllByRole('row');
    expect(
      within(rows[1])
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['0.5000', '400.0000', '80.00%']);
    expect(
      within(rows[2])
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1.0000', '100.0000', '20.00%']);
    expect(
      screen
        .getByRole('img', { name: /Exact coupled core shell-average/ })
        .querySelector('polyline')!
        .getAttribute('points'),
    ).toBe('190,30 340,142.5');
    expect(screen.getByText(/Surface-pool content remaining: 0.00%/)).toBeTruthy();
    expect(screen.getByText(/individual compound profiles are not resolved here/)).toBeTruthy();
  });
  it('describes all-surface particles without drawing an invented intact-kernel profile', () => {
    const allSurface = {
      ...profile(),
      kernelRadiusMm: 0,
      radiusFraction: new Float64Array(),
      concentrationKgM3: new Float64Array(),
      remainingFraction: null,
      surfaceRemainingFraction: 0.25,
    };
    render(
      <ParticleInspector ey={null} profile={allSurface} index={0} count={80} onSelect={vi.fn()} />,
    );
    expect(screen.getByText(/no intact kernel/)).toBeTruthy();
    expect(screen.getByText(/Surface-pool content remaining: 25.00%/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('Shell data table')).toBeNull();
  });
  it('distinguishes no initial surface content and unknown normalized loading from zero remaining', () => {
    const noPool = { ...profile(), surfaceRemainingFraction: null, remainingFraction: null };
    render(
      <ParticleInspector ey={null} profile={noPool} index={0} count={80} onSelect={vi.fn()} />,
    );
    expect(
      screen.getByText(/Surface-pool content remaining: no initial surface pool/),
    ).toBeTruthy();
    const details = screen.getByText('Shell data table').closest('details')!;
    details.open = true;
    const rows = within(details).getAllByRole('row');
    expect(within(rows[1]).getAllByRole('cell')[2].textContent).toBe('—');
    expect(within(rows[2]).getAllByRole('cell')[2].textContent).toBe('—');
  });
  it('reports unavailable coupled data instead of retaining the previous profile', () => {
    const { rerender } = render(
      <ParticleInspector ey={null} profile={profile()} index={0} count={80} onSelect={vi.fn()} />,
    );
    rerender(
      <ParticleInspector ey={null} profile={null} index={0} count={80} onSelect={vi.fn()} />,
    );
    expect(screen.getByText(/Run Explore again to export a different selected cell/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('Shell data table')).toBeNull();
  });
  it('maps one-based particle input to a finite clamped zero-based index', () => {
    const select = vi.fn();
    render(<ParticleInspector ey={null} profile={null} index={0} count={80} onSelect={select} />);
    const input = screen.getByRole('spinbutton', { name: 'Particle number' });
    for (const [value, expected] of [
      ['3', 2],
      ['999', 79],
      ['-5', 0],
      ['', 0],
      ['not-a-number', 0],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      expect(select).toHaveBeenLastCalledWith(expected);
    }
    expect(
      select.mock.calls.every(([index]) => typeof index === 'number' && Number.isFinite(index)),
    ).toBe(true);
  });
  it('provides the selected exact particle EY as described atomic text and distinguishes unavailable from zero', () => {
    const props = { profile: profile(), count: 80, onSelect: vi.fn() };
    const { rerender } = render(<ParticleInspector {...props} index={3} ey={0.123456} />);
    const input = screen.getByRole('spinbutton', { name: 'Particle number' });
    const readout = document.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(readout.textContent).toBe('Particle 4 extraction yield: 12.35%.');
    expect(readout.getAttribute('aria-live')).toBe('polite');
    expect(readout.getAttribute('aria-atomic')).toBe('true');
    rerender(<ParticleInspector {...props} index={4} ey={0} playing />);
    expect(readout.textContent).toBe('Particle 5 extraction yield: 0.00%.');
    expect(readout.getAttribute('aria-live')).toBe('off');
    rerender(<ParticleInspector {...props} index={4} ey={-0.01} />);
    expect(readout.textContent).toBe('Particle 5 extraction yield: -1.00%.');
    rerender(<ParticleInspector {...props} index={4} ey={null} />);
    expect(readout.textContent).toContain('unavailable for this selected cell and snapshot');
    expect(readout.textContent).not.toContain('-1.00');
    rerender(<ParticleInspector {...props} index={4} ey={NaN} />);
    expect(readout.textContent).toContain('unavailable');
  });
});
