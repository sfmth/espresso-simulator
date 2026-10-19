// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureRun } from '../../test/fixtures/shotFixture';
import { DEFAULT_RECIPE, physicalKey } from '../shot/recipeForm';
import type { ShotOutcome } from '../shot/shotStore';
import { ExploreSection } from './ExploreSection';
import type { ExploreCell } from './useExploreState';

function outcome(seq: number, cells: number): ShotOutcome {
  return {
    ...fixtureRun(DEFAULT_RECIPE, { columns: 8, cells }),
    key: physicalKey(DEFAULT_RECIPE),
    recipe: DEFAULT_RECIPE,
    kind: 'full',
    tier: 1,
    runtimeMs: 10,
    seq,
  };
}

function Controlled({ shot, initialCell = 0 }: { shot: ShotOutcome; initialCell?: number }) {
  const [selected, setSelected] = useState<ExploreCell>({ col: 0, cell: initialCell });
  return (
    <ExploreSection outcome={shot} snapshotIndex={2} selected={selected} onSelect={setSelected} />
  );
}

function polygonYs(polygon: Element) {
  return (polygon.getAttribute('points') ?? '')
    .split(' ')
    .map((point) => Number(point.split(',')[1]));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Explore cross-section depth detail', () => {
  it('keeps every raw cell in the 30-row overview and 150-row detail, with actual grid labels', () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(
      <ExploreSection
        outcome={outcome(1, 30)}
        snapshotIndex={2}
        selected={null}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelectorAll('.explore-cell')).toHaveLength(8 * 30 * 2);
    expect(screen.getByText('Showing 8 columns × 30 depth cells.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Depth view').value).toBe('overview');
    expect(screen.getByLabelText<HTMLInputElement>('Cell boundaries').checked).toBe(false);
    const overviewSvg = screen.getByRole('img');
    expect(overviewSvg.getAttribute('height')).toBeNull();
    expect(overviewSvg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(container.querySelector('.explore-section-viewport.cell-detail')).toBeNull();

    rerender(
      <ExploreSection
        outcome={outcome(2, 150)}
        snapshotIndex={2}
        selected={null}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelectorAll('.explore-cell')).toHaveLength(8 * 150 * 2);
    expect(screen.getByText('Showing 8 columns × 150 depth cells.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Depth view').value).toBe('detail');
    expect(screen.getByLabelText<HTMLInputElement>('Cell boundaries').checked).toBe(true);
    expect(container.querySelector('.explore-section-svg.show-cell-boundaries')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Cell boundaries'));
    expect(container.querySelector('.show-cell-boundaries')).toBeNull();
    fireEvent.change(screen.getByLabelText('Depth view'), { target: { value: 'overview' } });
    expect(container.querySelectorAll('.explore-cell')).toHaveLength(8 * 150 * 2);
    expect(container.querySelector('.explore-section-viewport.cell-detail')).toBeNull();
  });

  it('crops detail to the real bed and gives each raw row at least four CSS pixels at any width', () => {
    const { container } = render(<Controlled shot={outcome(1, 150)} />);
    const svg = screen.getByRole('img');
    const viewBox = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    const cssHeight = Number(svg.getAttribute('height'));
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    expect(cssHeight).toBeGreaterThanOrEqual(615);
    // The bed begins at y=7, with no basket headspace above it. Its actual
    // 12 mm height spans 150 rows; CSS height is independent of the panel width.
    const first = container.querySelector('[data-col="0"][data-cell="0"] polygon')!;
    const last = container.querySelector('[data-col="0"][data-cell="149"] polygon')!;
    expect(Math.min(...polygonYs(first))).toBeCloseTo(7, 3);
    expect(Math.max(...polygonYs(last))).toBeCloseTo(607, 3);
    for (const polygon of container.querySelectorAll('.explore-cell')) {
      const ys = polygonYs(polygon);
      const rowHeight = ((Math.max(...ys) - Math.min(...ys)) * cssHeight) / viewBox[3];
      expect(rowHeight).toBeGreaterThanOrEqual(4 - 1e-8);
    }
    expect(screen.getByText(/coffee bed only/)).toBeTruthy();
    expect(screen.queryByText(/Height ×2/)).toBeNull();
  });

  it('preserves exact last-cell bounds and selection through clicks, keys, and the number control', () => {
    const { container } = render(<Controlled shot={outcome(1, 150)} initialCell={148} />);
    const svg = screen.getByRole('img');
    fireEvent.keyDown(svg, { key: 'ArrowDown' });
    expect(screen.getByLabelText<HTMLInputElement>('Depth cell').value).toBe('150');
    expect(screen.getByText(/depth 11\.92–12\.00 mm below the top/)).toBeTruthy();
    fireEvent.keyDown(svg, { key: 'ArrowDown' });
    expect(screen.getByLabelText<HTMLInputElement>('Depth cell').value).toBe('150');
    fireEvent.keyDown(svg, { key: 'ArrowUp' });
    expect(screen.getByLabelText<HTMLInputElement>('Depth cell').value).toBe('149');
    fireEvent.click(container.querySelector('[data-col="7"][data-cell="149"] polygon')!);
    expect(screen.getByLabelText<HTMLSelectElement>('Column').value).toBe('7');
    expect(screen.getByLabelText<HTMLInputElement>('Depth cell').value).toBe('150');
    expect(container.querySelectorAll('[data-col="7"][data-cell="149"] .selected')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Depth cell'), { target: { value: '1' } });
    expect(screen.getByText(/depth 0\.00–0\.08 mm below the top/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Depth cell'), { target: { value: '150' } });
    expect(screen.getByText(/depth 11\.92–12\.00 mm below the top/)).toBeTruthy();
  });

  it('scrolls only the local viewport to reveal a selected row, including view changes', () => {
    const rect = (top: number, height: number): DOMRect => ({
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 300,
      width: 300,
      height,
      toJSON: () => ({}),
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('.explore-section-viewport')) return rect(100, 448);
      if (this.matches('g[data-cell]')) {
        const viewport = this.closest('.explore-section-viewport')!;
        return rect(107 + Number(this.getAttribute('data-cell')) * 4 - viewport.scrollTop, 4);
      }
      return rect(0, 0);
    });
    const pageScroll = vi.spyOn(window, 'scrollTo');
    const { container } = render(<Controlled shot={outcome(1, 150)} />);
    const viewport = container.querySelector('.explore-section-viewport')!;
    expect(viewport.scrollTop).toBe(0);
    fireEvent.change(screen.getByLabelText('Depth cell'), { target: { value: '150' } });
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const last = container.querySelector('[data-col="0"][data-cell="149"]')!;
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(544);
    fireEvent.change(screen.getByLabelText('Depth view'), { target: { value: 'overview' } });
    expect(viewport.scrollTop).toBe(0);
    fireEvent.change(screen.getByLabelText('Depth view'), { target: { value: 'detail' } });
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(544);
    fireEvent.change(screen.getByLabelText('Depth cell'), { target: { value: '1' } });
    const first = container.querySelector('[data-col="0"][data-cell="0"]')!;
    expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(104);
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('resets depth and boundary defaults for each new result while preserving user choices within a result', () => {
    const shot = outcome(1, 150);
    const props = { snapshotIndex: 2, selected: null, onSelect: vi.fn() };
    const { rerender } = render(<ExploreSection outcome={shot} {...props} />);
    fireEvent.change(screen.getByLabelText('Depth view'), { target: { value: 'overview' } });
    fireEvent.click(screen.getByLabelText('Cell boundaries'));
    rerender(<ExploreSection outcome={shot} {...props} snapshotIndex={1} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Depth view').value).toBe('overview');
    expect(screen.getByLabelText<HTMLInputElement>('Cell boundaries').checked).toBe(false);
    rerender(<ExploreSection outcome={outcome(2, 150)} {...props} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Depth view').value).toBe('detail');
    expect(screen.getByLabelText<HTMLInputElement>('Cell boundaries').checked).toBe(true);
    rerender(<ExploreSection outcome={outcome(3, 30)} {...props} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Depth view').value).toBe('overview');
    expect(screen.getByLabelText<HTMLInputElement>('Cell boundaries').checked).toBe(false);
  });
});
