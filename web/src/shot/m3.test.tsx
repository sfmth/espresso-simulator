// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureTaste, fixtureUncertainty } from '../../test/fixtures/m3Fixture';
import { fixtureRun } from '../../test/fixtures/shotFixture';
import type { CallOptions, Engine, Timed } from '../engine/engine';
import { EngineContext } from '../engine/EngineContext';
import type { UncertaintyOptions, UncertaintyResult } from '../engine/m3Types';
import type { Recipe } from '../engine/shotTypes';
import { DEFAULT_RECIPE, physicalKey } from './recipeForm';
import type { ShotOutcome } from './shotStore';
import { SummaryTiles } from './SummaryTiles';
import { TastePanel } from './TastePanel';
import { UncertaintyPanel } from './UncertaintyPanel';
import { useUncertainty } from './useUncertainty';

vi.mock('uplot', () => ({
  default: class {
    static pxRatio = 1;
    constructor(_options: unknown, _data: unknown, target: HTMLElement) {
      target.append(document.createElement('div'));
    }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));

function outcome(): ShotOutcome {
  return {
    ...fixtureRun(DEFAULT_RECIPE),
    key: physicalKey(DEFAULT_RECIPE),
    recipe: DEFAULT_RECIPE,
    kind: 'full',
    tier: 1,
    runtimeMs: 3,
    seq: 1,
    taste: fixtureTaste(),
  };
}

function setup() {
  const pending: {
    signal: AbortSignal | undefined;
    options: UncertaintyOptions;
    resolve: (value: Timed<UncertaintyResult>) => void;
  }[] = [];
  const engine: Engine = {
    coreVersion: () => new Promise(() => {}),
    simulateSphereRelease: () => new Promise(() => {}),
    catalog: () => new Promise(() => {}),
    buildShotSpec: () => new Promise(() => {}),
    simulateRecipe: () => new Promise(() => {}),
    simulateShot: () => new Promise(() => {}),
    sweepPoint: () => new Promise(() => {}),
    terminate() {},
    simulateUncertainty: (_recipe: Recipe, options: UncertaintyOptions, call?: CallOptions) =>
      new Promise((resolve) => pending.push({ signal: call?.signal, options, resolve })),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>
  );
  return { engine, pending, wrapper };
}

afterEach(cleanup);

describe('M3 scenario lifecycle', () => {
  it('keeps old results stale after edits and rejects late cancelled answers', async () => {
    const fake = setup();
    const hook = renderHook(({ recipe }) => useUncertainty(recipe), {
      wrapper: fake.wrapper,
      initialProps: { recipe: DEFAULT_RECIPE },
    });
    act(() => hook.result.current.run());
    expect(hook.result.current.running).toBe(true);
    expect(fake.pending[0].options.seed).toBe(1729);
    await act(async () => {
      fake.pending[0].resolve({ result: fixtureUncertainty(), runtimeMs: 12 });
      await Promise.resolve();
    });
    expect(hook.result.current.current).toBe(true);
    act(() => hook.result.current.run());
    hook.rerender({ recipe: { ...DEFAULT_RECIPE, prep: { ...DEFAULT_RECIPE.prep, dose_g: 19 } } });
    expect(fake.pending[1].signal?.aborted).toBe(true);
    expect(hook.result.current.current).toBe(false);
    expect(hook.result.current.running).toBe(false);
    await act(async () => {
      fake.pending[1].resolve({ result: { ...fixtureUncertainty(), seed: 999 }, runtimeMs: 1 });
      await Promise.resolve();
    });
    expect(hook.result.current.outcome?.result.seed).toBe(1729);
    hook.rerender({ recipe: DEFAULT_RECIPE });
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.state).toBe('cancelled');
    act(() => hook.result.current.run());
    expect(hook.result.current.running).toBe(true);
  });

  it('defaults a supplied PSD to measured while preserving explicit knowledge choices', () => {
    const fake = setup();
    const hook = renderHook(({ recipe }) => useUncertainty(recipe), {
      wrapper: fake.wrapper,
      initialProps: { recipe: DEFAULT_RECIPE },
    });
    expect(hook.result.current.options.groups.grinder_psd).toBe('unknown');
    const measured = {
      ...DEFAULT_RECIPE,
      grinder: { psd: { diameter_um: [100, 300], volume_fraction: [0.2, 0.8] } },
    };
    hook.rerender({ recipe: measured });
    expect(hook.result.current.options.groups.grinder_psd).toBe('measured');
    act(() => hook.result.current.setGroup('grinder_psd', 'fixed'));
    hook.rerender({ recipe: DEFAULT_RECIPE });
    expect(hook.result.current.options.groups.grinder_psd).toBe('fixed');
  });

  it('aborts manual cancellation and unmount without accepting later results', async () => {
    const fake = setup();
    const hook = renderHook(() => useUncertainty(DEFAULT_RECIPE), { wrapper: fake.wrapper });
    act(() => hook.result.current.run());
    act(() => hook.result.current.cancel());
    expect(fake.pending[0].signal?.aborted).toBe(true);
    await act(async () => {
      fake.pending[0].resolve({ result: fixtureUncertainty(), runtimeMs: 2 });
      await Promise.resolve();
    });
    expect(hook.result.current.outcome).toBeNull();
    expect(hook.result.current.state).toBe('cancelled');
    act(() => hook.result.current.run());
    hook.unmount();
    expect(fake.pending[1].signal?.aborted).toBe(true);
  });
});

describe('M3 honest output labels', () => {
  it('leaves the central values intact and labels separate Tier-0 ranges', () => {
    render(<SummaryTiles outcome={outcome()} uncertainty={fixtureUncertainty()} />);
    expect(document.querySelector('[data-tile="ey"] .tile-value')?.textContent).toBe('20.0%');
    expect(screen.getByText('Scenario range: 17.0%–24.0%')).toBeTruthy();
    expect(screen.getByText(/Ranges show separate input scenarios/)).toBeTruthy();
  });

  it('explains taste drivers, grade-D mapping and unavailable estimates without inventing scores', () => {
    render(<TastePanel outcome={outcome()} stale={false} uncertainty={fixtureUncertainty()} />);
    expect(screen.getByText('Low trust: unvalidated relative indices.')).toBeTruthy();
    expect(screen.getByText('very low trust')).toBeTruthy();
    expect(screen.getByText(/p05–p95 7.0–13.0/)).toBeTruthy();
    const driverTable = screen.getByRole('table', {
      name: 'Acidity potential drivers',
      hidden: true,
    });
    expect(within(driverTable).getByText('1.25 g/L')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Illustrative source', hidden: true }).getAttribute('href'),
    ).toBe('https://example.com/paper');
  });

  it('shows failures, successful-member counts, baseline comparison and searchable numeric bands', async () => {
    const fake = setup();
    const scenario = fixtureUncertainty();
    scenario.sample_failures = [{ sample_index: 7, message: 'Invalid scenario example' }];
    scenario.samples_completed = 7;
    scenario.warning_counts = { 'Example warning': 3 };
    function Panel() {
      const controls = useUncertainty(DEFAULT_RECIPE);
      return (
        <UncertaintyPanel
          validation={{ ok: true, recipe: DEFAULT_RECIPE, notes: [] }}
          controls={controls}
          central={outcome()}
        />
      );
    }
    render(
      <fake.wrapper>
        <Panel />
      </fake.wrapper>,
    );
    fireEvent.change(screen.getByLabelText('Scenario count'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run uncertainty' }));
    await act(async () => {
      fake.pending[0].resolve({ result: scenario, runtimeMs: 12 });
      await Promise.resolve();
    });
    expect(screen.getByText(/1 scenarios failed/)).toBeTruthy();
    expect(screen.getByText('Scenario 8: Invalid scenario example')).toBeTruthy();
    expect(
      screen.getByRole('table', { name: 'Central shot and preview baseline comparison' }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Find an output interval'), {
      target: { value: '/chemistry/acidity/ph' },
    });
    const table = screen.getByRole('table', {
      name: 'All numeric scenario intervals',
      hidden: true,
    });
    expect(within(table).getByText('/chemistry/acidity/ph')).toBeTruthy();
    expect(within(table).queryByText('/summary/ey')).toBeNull();
  });
});
