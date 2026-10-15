// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureCatalog,
  fixtureResult,
  fixtureRun,
  type FixtureOptions,
} from '../../test/fixtures/shotFixture';
import { EngineError, type CallOptions, type Engine, type Timed } from '../engine/engine';
import { EngineContext } from '../engine/EngineContext';
import type { RecipeRunData, SweepPointData } from '../engine/shotData';
import type { Catalog, MachinePreset, Recipe } from '../engine/shotTypes';
import { SOURCE_URL } from '../config';
import { modelStatusText } from './modelStatus';
import { DEFAULT_RECIPE, defaultForm, withTier } from './recipeForm';
import { resetShotStore, useShotStore } from './shotStore';
import { ShotLab } from './ShotLab';

// jsdom has no canvas: replace uPlot with a stand-in.
vi.mock('uplot', () => ({
  default: class FakeUPlot {
    static pxRatio = 1;
    constructor(_options: unknown, _data: unknown, target: HTMLElement) {
      target.append(Object.assign(document.createElement('div'), { className: 'uplot' }));
    }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));

interface Pending<T> {
  recipe: Recipe;
  signal: AbortSignal | undefined;
  resolve: (options?: FixtureOptions) => void;
  reject: (error: Error) => void;
  value?: T;
}

/** The fixture catalog with the default machine preset changed. */
function catalogWithMachine(patch: Partial<MachinePreset>): Catalog {
  const catalog = structuredClone(fixtureCatalog());
  const id = DEFAULT_RECIPE.machine.preset;
  catalog.presets.machines = catalog.presets.machines.map((m) =>
    m.id === id ? { ...m, ...patch } : m,
  );
  return catalog;
}

/** An engine whose runs finish only when a test says so; aborted calls reject (unless told not to). */
function shotEngine({
  ignoreAbort = false,
  catalog,
}: { ignoreAbort?: boolean; catalog?: Catalog } = {}) {
  const runs: Pending<RecipeRunData>[] = [];
  const points: Pending<SweepPointData>[] = [];
  const builds: Pending<null>[] = [];
  const deferred = <T,>(
    list: Pending<T>[],
    recipe: Recipe,
    options: CallOptions | undefined,
    make: (o?: FixtureOptions) => T,
  ) =>
    new Promise<Timed<T>>((resolve, reject) => {
      const signal = options?.signal;
      list.push({
        recipe,
        signal,
        resolve: (o) => resolve({ result: make(o), runtimeMs: 3 }),
        reject,
      });
      if (!ignoreAbort) {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }
    });
  const engine: Engine = {
    coreVersion: () => Promise.resolve({ result: 'test', runtimeMs: 0 }),
    simulateSphereRelease: () => new Promise(() => {}),
    catalog: () => Promise.resolve({ result: catalog ?? fixtureCatalog(), runtimeMs: 1 }),
    buildShotSpec: (recipe, options) =>
      new Promise((resolve, reject) => {
        const signal = options?.signal;
        builds.push({
          recipe,
          signal,
          resolve: () => resolve({ result: fixtureRun(recipe).build, runtimeMs: 1 }),
          reject,
        });
        if (!ignoreAbort) {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }
      }),
    simulateRecipe: (recipe, options) =>
      deferred(runs, recipe, options, (o) => fixtureRun(recipe, o)),
    simulateShot: () => new Promise(() => {}),
    sweepPoint: (recipe, options) =>
      deferred(points, recipe, options, (o) => {
        const result = fixtureResult(o);
        return { summary: result.summary, diagnostics: result.diagnostics, coreMs: 1 };
      }),
    terminate: () => {},
  };
  return { engine, runs, points, builds };
}

function renderLab(engine: Engine) {
  render(
    <EngineContext.Provider value={engine}>
      <ShotLab />
    </EngineContext.Provider>,
  );
}

async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const status = () => document.getElementById('shot-status')?.textContent ?? '';
const tile = (name: string) =>
  document.querySelector(`[data-tile="${name}"] .tile-value`)?.textContent ?? '';
const announcement = () => document.querySelector('.run-bar [role="status"]')?.textContent ?? '';

/** Opens an editor section (jsdom does not toggle <details> on click). */
async function openSection(id: string) {
  const details = document.getElementById(`section-${id}`) as HTMLDetailsElement;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await advance();
}

async function startWithPreview(options: FixtureOptions = {}) {
  const fake = shotEngine();
  renderLab(fake.engine);
  await advance();
  expect(fake.runs).toHaveLength(1);
  fake.runs[0].resolve(options);
  await advance();
  return fake;
}

describe('ShotLab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetShotStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the catalog, then previews the recipe at tier 0', async () => {
    const fake = shotEngine();
    renderLab(fake.engine);
    expect(screen.getByText('Starting the engine and loading the presets…')).toBeTruthy();
    await advance();
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0].recipe).toEqual(withTier(DEFAULT_RECIPE, 0));
    expect(status()).toBe('Updating the preview…');
    fake.runs[0].resolve({ ey: 0.2 });
    await advance();
    expect(tile('ey')).toBe('20.0%');
    expect(tile('shot-time')).toBe('30.0 s');
    expect(tile('ratio')).toBe('1 : 2.0');
    expect(status()).toBe('Preview (tier 0). Press Run for the tier-1 result.');
    expect(screen.getByText('Preview, tier 0')).toBeTruthy();
    expect(screen.getByText('Fixture warning: not a real result.')).toBeTruthy();
    // Previews are quiet for screen readers.
    expect(announcement()).toBe('');
  });

  it('runs the recipe at its own tier on Run and announces the outcome', async () => {
    const fake = await startWithPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Run (tier 1)' }));
    await advance();
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1].recipe).toEqual(DEFAULT_RECIPE);
    expect(status()).toBe('Running tier 1…');
    fake.runs[1].resolve({ ey: 0.21 });
    await advance();
    expect(tile('ey')).toBe('21.0%');
    expect(status()).toBe('Up to date: tier 1, 13 ms in the engine.');
    expect(announcement()).toMatch(/^Run finished \(tier 1\): 30\.0 s, 36\.0 g, EY 21\.0%/);
    await advance(1000);
    expect(fake.runs).toHaveLength(2); // nothing new to preview
  });

  it('lets a newer edit supersede a preview in flight and ignores its late answer', async () => {
    const fake = shotEngine({ ignoreAbort: true });
    renderLab(fake.engine);
    await advance();
    await openSection('prep');
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '19' } });
    await advance(249);
    expect(fake.runs).toHaveLength(1);
    await advance(1);
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[0].signal?.aborted).toBe(true);
    expect(fake.runs[1].recipe.prep.dose_g).toBe(19);
    fake.runs[1].resolve({ ey: 0.25 });
    await advance();
    fake.runs[0].resolve({ ey: 0.1 }); // the superseded run answers anyway
    await advance();
    expect(tile('ey')).toBe('25.0%');
    expect(status()).toBe('Preview (tier 0). Press Run for the tier-1 result.');
  });

  it('shows a builder error in an alert and next to the field it names', async () => {
    const fake = shotEngine();
    renderLab(fake.engine);
    await advance();
    const message = 'prep.dose_g: 45 g makes a 89.1 mL bed, but the basket holds only 55.3 mL';
    fake.runs[0].reject(new EngineError('invalid-params', message));
    await advance();
    expect(screen.getByRole('alert').textContent).toContain(
      `The model cannot build these inputs: ${message}`,
    );
    expect(status()).toBe('The model cannot build these inputs; see the message.');
    // The section with the problem opens by itself and marks the field.
    const dose = screen.getByLabelText<HTMLInputElement>('Dose (g)');
    expect(dose.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(dose.getAttribute('aria-describedby')?.split(' ')[0] ?? '')
        ?.textContent,
    ).toBe(message);
    expect(document.querySelector('#section-prep .badge-error')?.textContent).toBe('1 problem');
  });

  it('flags invalid input without running it', async () => {
    const fake = await startWithPreview();
    await openSection('prep');
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '0' } });
    await advance(1000);
    expect(fake.runs).toHaveLength(1);
    expect(status()).toBe('Check the highlighted inputs.');
    expect(screen.getByText('Dose must be between 1 g and 60 g.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run (tier 1)' }).disabled).toBe(
      true,
    );
    expect(screen.getByText('Results for earlier inputs')).toBeTruthy();
  });

  it('cancels a full run, says so, and keeps focus on Cancel', async () => {
    const fake = await startWithPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Run (tier 1)' }));
    await advance();
    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
    expect(cancel.getAttribute('aria-disabled')).toBeNull();
    cancel.focus();
    fireEvent.click(cancel);
    await advance();
    expect(fake.runs[1].signal?.aborted).toBe(true);
    expect(status()).toBe('Preview (tier 0). Press Run for the tier-1 result.');
    expect(announcement()).toBe('Run cancelled.');
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(cancel);
  });

  it('draws the particle sizes, the compounds with provenance and the spec', async () => {
    await startWithPreview();
    fireEvent.click(screen.getByRole('tab', { name: 'Particles' }));
    expect(screen.getByText('Distribution statistics')).toBeTruthy();
    expect(screen.getByText('X50 (median)')).toBeTruthy();
    expect(screen.getByText(/fines/i, { selector: 'th' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Compounds' }));
    const table = screen.getByRole('table', { name: 'Compounds in the cup, with provenance' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual([
      'Compound',
      'Total dissolved solids',
      'Caffeine',
      'Trigonelline',
      '5-CQA (5-caffeoylquinic acid)',
      'Organic acids (lumped)',
    ]);
    const caffeine = table.querySelector('[data-species="caffeine"]');
    expect(caffeine?.textContent).toContain('weakest:');
    expect(within(caffeine as HTMLElement).getByText('Content in the beans')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Provenance' }));
    expect(screen.getByText('bed.dose_kg')).toBeTruthy();
    expect(screen.getByText('The built ShotSpec (JSON, SI units)')).toBeTruthy();
  });

  it('draws the cross-section on the basket and reads cells from the keyboard', async () => {
    await startWithPreview();
    fireEvent.click(screen.getByRole('tab', { name: 'Cross-section' }));
    // 3 columns × 4 depth cells, each drawn twice (both halves of the section).
    expect(document.querySelectorAll('.section-cell')).toHaveLength(24);
    expect(screen.getByText(/Puck cross-section at 30\.0 s/)).toBeTruthy();
    const slider = screen.getByLabelText<HTMLInputElement>('Snapshot');
    expect(slider.value).toBe('2');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(screen.getByText(/Puck cross-section at 10\.0 s/)).toBeTruthy();
    // The first snapshot has a negative cell, which the legend explains.
    expect(
      screen.getByText(/Values below 0 mean the particles there took solubles back up/),
    ).toBeTruthy();
    const figure = screen.getByRole('group', { name: /Cross-section cells/ });
    fireEvent.keyDown(figure, { key: 'ArrowRight' });
    fireEvent.keyDown(figure, { key: 'ArrowRight' });
    expect(document.querySelector('.section-readout')?.textContent).toMatch(
      /^Column 2 of 3 \(radius /,
    );
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'liquid_conc_kg_m3' } });
    expect(document.querySelector('.section-readout')?.textContent).toMatch(
      /solubles in the bed liquid 43 kg\/m³; wet; in this column the wetting front is 4\.5 mm below the top$/,
    );
  });

  it('draws a result with any number of columns (tier 0 may use just one)', async () => {
    await startWithPreview({ columns: 1 });
    fireEvent.click(screen.getByRole('tab', { name: 'Cross-section' }));
    expect(document.querySelectorAll('.section-cell')).toHaveLength(4 * 2);
    expect(document.querySelectorAll('.section-front')).toHaveLength(0);
    expect(screen.getByText(/has one column and 4 depth cells/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Snapshot'), {
      target: { value: '0' },
    });
    expect(document.querySelectorAll('.section-front')).toHaveLength(1);
  });

  it('marks the wetting front: dry cells hatched, a dashed front line, readout and table', async () => {
    await startWithPreview();
    fireEvent.click(screen.getByRole('tab', { name: 'Cross-section' }));
    // The last snapshot is wetted everywhere: nothing hatched, no front line.
    expect(document.querySelectorAll('.section-dry')).toHaveLength(0);
    expect(document.querySelectorAll('.section-hatch')).toHaveLength(0);
    expect(document.querySelectorAll('.section-front')).toHaveLength(0);
    expect(screen.queryByText(/the dashed line marks the wetting front/)).toBeNull();

    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Snapshot'), {
      target: { value: '0' },
    });
    // Per column: cell 0 wet, cell 1 half wetted, cells 2 and 3 dry (both halves drawn).
    expect(document.querySelectorAll('.section-dry')).toHaveLength(3 * 2 * 2);
    const hatches = [...document.querySelectorAll('.section-hatch')];
    expect(hatches).toHaveLength(3 * 3);
    expect(hatches.map((h) => h.getAttribute('opacity')).sort()).toEqual([
      '0.5',
      '0.5',
      '0.5',
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
    ]);
    // Dry cells carry no colour of their own: the hatch and the CSS grey show.
    expect(document.querySelector('.section-dry')?.getAttribute('fill')).toBeNull();
    expect(document.querySelectorAll('.section-front')).toHaveLength(3);
    expect(screen.getByText(/the dashed line marks the wetting front in each column/)).toBeTruthy();

    const figure = screen.getByRole('group', { name: /Cross-section cells/ });
    const readout = () => document.querySelector('.section-readout')?.textContent ?? '';
    fireEvent.keyDown(figure, { key: 'ArrowDown' });
    fireEvent.keyDown(figure, { key: 'ArrowDown' });
    expect(readout()).toMatch(
      /depth 3\.0–6\.0 mm below the top: .*; 50% wetted \(the front is here\); in this column the wetting front is 4\.5 mm below the top$/,
    );
    fireEvent.keyDown(figure, { key: 'ArrowDown' });
    expect(readout()).toMatch(/depth 6\.0–9\.0 mm below the top: .*; dry; /);

    const wetted = screen.getByRole('table', { name: /Wetted share at 10\.0 s/ });
    const rows = within(wetted).getAllByRole('row').slice(1);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))).toEqual([
      ['100%', '100%', '100%'],
      ['50%', '50%', '50%'],
      ['0%', '0%', '0%'],
      ['0%', '0%', '0%'],
    ]);
  });

  it('runs a sweep point by point, records failed points, and can be cancelled', async () => {
    const fake = await startWithPreview();
    fireEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    fireEvent.change(screen.getByLabelText('Points (2–41)'), { target: { value: '3' } });
    expect(screen.getByText('3 runs at tier 0.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    await advance();
    expect(fake.points).toHaveLength(1);
    expect(fake.points[0].recipe.prep.dose_g).toBe(16);
    expect(fake.points[0].recipe.numerics?.tier).toBe(0);
    fake.points[0].resolve({ ey: 0.18 });
    await advance();
    fake.points[1].reject(new EngineError('invalid-params', 'prep.dose_g: does not fit'));
    await advance();
    fake.points[2].resolve({ ey: 0.22 });
    await advance();
    expect(document.querySelector('.sweep-progress label')?.textContent).toBe(
      'Finished: 3 of 3 points',
    );
    expect(screen.getByText('1 point could not be simulated:')).toBeTruthy();
    expect(screen.getByText(/does not fit/)).toBeTruthy();
    expect(document.querySelectorAll('[data-chart^="sweep-"]')).toHaveLength(3);
    expect(screen.getByText('Sweep finished: 3 points, 1 could not be simulated.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pin sweep' }));
    expect(screen.getByText('Pinned sweeps (1/6)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sweep' }));
    await advance();
    expect(fake.points[3].signal?.aborted).toBe(true);
    expect(screen.getByText('Sweep cancelled after 0 of 3 points.')).toBeTruthy();
  });

  it('pins a run, overlays it and lists what differs from the current inputs', async () => {
    const fake = await startWithPreview({ ey: 0.2 });
    const pin = screen.getByRole<HTMLButtonElement>('button', { name: 'Pin this run' });
    pin.focus();
    fireEvent.click(pin);
    // Marked disabled, not disabled, so the keyboard focus stays on it.
    expect(pin.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(pin);
    fireEvent.click(pin);
    expect(useShotStore.getState().pins).toHaveLength(1);
    await openSection('prep');
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '20' } });
    await advance(250);
    fake.runs[1].resolve({ ey: 0.19 });
    await advance();
    const table = document.querySelector('.diff-table') as HTMLTableElement;
    const dose = within(table).getByText('Dose').closest('tr');
    expect(Array.from(dose?.querySelectorAll('td') ?? []).map((td) => td.textContent)).toEqual([
      '20 g',
      '18 g',
    ]);
    expect(screen.getByLabelText<HTMLInputElement>('Label of pinned run 1').value).toBe(
      'Run 1 (preview)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Run 1 (preview)' }));
    expect(document.querySelector('.diff-table')).toBeNull();
  });

  it('overrides a registry parameter in the sandbox and resets it', async () => {
    const fake = await startWithPreview();
    await openSection('overrides');
    fireEvent.change(screen.getByLabelText('Search the registry'), {
      target: { value: 'max_yield' },
    });
    await advance();
    const input = document.getElementById('rf-overrides-extraction-max_yield') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '26' } });
    await advance(250);
    expect(fake.runs.at(-1)?.recipe.overrides).toEqual({ 'extraction.max_yield': 26 });
    expect(screen.getAllByText('Overridden').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset all overrides' }));
    expect(useShotStore.getState().form.overrides).toEqual({});
  });

  it('describes a basket from scratch, checks it inline and draws it', async () => {
    await startWithPreview();
    await openSection('basket');
    fireEvent.click(screen.getByRole('button', { name: 'Edit a copy as a custom basket' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Custom shape' }).checked).toBe(
      true,
    );
    const height = screen.getByLabelText<HTMLInputElement>('Height of point 2 (mm)');
    expect(height.value).toBe('2');
    fireEvent.change(height, { target: { value: '0' } });
    expect(screen.getByText('Heights must increase: 0 mm is not above 0 mm.')).toBeTruthy();
    fireEvent.change(height, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a point' }));
    expect(screen.getByLabelText<HTMLInputElement>('Height of point 5 (mm)').value).toBe('26');
    expect(document.querySelector('.basket-svg')?.getAttribute('aria-label')).toMatch(
      /58\.5 mm at the rim, 54\.0 mm at the floor, 26\.0 mm tall/,
    );
  });

  it('imports a recipe file and exports the current recipe', async () => {
    await startWithPreview();
    const blobs: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (b: Blob) => (blobs.push(b), 'blob:x'),
        revokeObjectURL: () => {},
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Export recipe' }));
    expect(click).toHaveBeenCalledOnce();
    expect(JSON.parse(await blobs[0].text())).toEqual(DEFAULT_RECIPE);

    const file = new File(
      [JSON.stringify({ ...DEFAULT_RECIPE, prep: { dose_g: 16 }, extra: 1 })],
      'mine.json',
      {
        type: 'application/json',
      },
    );
    fireEvent.change(screen.getByLabelText('Recipe file to import'), { target: { files: [file] } });
    await advance();
    expect(screen.getByText('Loaded mine.json. Ignored the unknown field extra.')).toBeTruthy();
    expect(useShotStore.getState().form.prep.dose_g).toBe('16');
  });

  it('keeps working when the browser blocks storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {},
    });
    await startWithPreview();
    expect(screen.getByText(/does not allow the page to store data/)).toBeTruthy();
    expect(tile('ey')).toBe('20.0%');
  });

  it('stops a preview in flight when the inputs go back to a solved recipe, and ignores its answer', async () => {
    const fake = shotEngine({ ignoreAbort: true });
    renderLab(fake.engine);
    await advance();
    fake.runs[0].resolve();
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Run (tier 1)' }));
    await advance();
    fake.runs[1].resolve({ ey: 0.21 });
    await advance();
    await openSection('prep');
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '19' } });
    await advance(250);
    expect(fake.runs).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '18' } });
    await advance();
    expect(fake.runs[2].signal?.aborted).toBe(true);
    expect(status()).toBe('Up to date: tier 1, 13 ms in the engine.');
    fake.runs[2].resolve({ ey: 0.3 }); // the stale preview answers anyway
    await advance();
    expect(tile('ey')).toBe('21.0%');
    expect(status()).toBe('Up to date: tier 1, 13 ms in the engine.');
  });

  it('stops a stale preview after Reset and Undo as well', async () => {
    const fake = shotEngine({ ignoreAbort: true });
    renderLab(fake.engine);
    await advance();
    fake.runs[0].resolve();
    await advance();
    await openSection('prep');
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '19' } });
    await advance(250);
    fake.runs[1].resolve({ ey: 0.19 });
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await advance(250);
    expect(fake.runs).toHaveLength(3); // a preview of the defaults
    fireEvent.click(screen.getByRole('button', { name: 'Undo reset' }));
    await advance();
    expect(fake.runs[2].signal?.aborted).toBe(true);
    fake.runs[2].resolve({ ey: 0.5 });
    await advance();
    expect(tile('ey')).toBe('19.0%');
    expect(status()).toBe('Preview (tier 0). Press Run for the tier-1 result.');
  });

  it('stops a stale build check with the live preview off', async () => {
    const fake = shotEngine({ ignoreAbort: true });
    renderLab(fake.engine);
    await advance();
    fake.runs[0].resolve();
    await advance();
    fireEvent.click(screen.getByLabelText('Live preview (tier 0) while editing'));
    await openSection('prep');
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '19' } });
    await advance(250);
    expect(fake.builds).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '18' } });
    await advance();
    expect(fake.builds[0].signal?.aborted).toBe(true);
    fake.builds[0].resolve();
    await advance();
    expect(useShotStore.getState().check?.key).toBe(useShotStore.getState().run.latest?.key);
    expect(status()).toBe('Preview (tier 0). Press Run for the tier-1 result.');
  });

  it('tells an engine failure from an input error, and retries it', async () => {
    const fake = shotEngine();
    renderLab(fake.engine);
    await advance();
    fake.runs[0].reject(new EngineError('runtime', 'unreachable'));
    await advance();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The engine failed and was restarted: unreachable');
    expect(alert.textContent).toContain('not in your inputs');
    // No panic message came with this failure: no details to show.
    expect(alert.querySelector('.panic-details')).toBeNull();
    expect(status()).toBe('The engine failed; press Retry to run it again.');
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await advance();
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1].recipe.numerics?.tier).toBe(0);
    fake.runs[1].resolve();
    await advance();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(tile('ey')).toBe('20.0%');
  });

  it('drops unknown overrides on import, says so, and can undo the load', async () => {
    await startWithPreview();
    const file = new File(
      [
        JSON.stringify({
          ...DEFAULT_RECIPE,
          prep: { dose_g: 16 },
          overrides: { 'model.psd.fines_floor': 5 },
        }),
      ],
      'old.json',
      { type: 'application/json' },
    );
    fireEvent.change(screen.getByLabelText('Recipe file to import'), { target: { files: [file] } });
    await advance();
    expect(
      screen.getByText(
        /Loaded old\.json\. Removed overrides of parameters this version’s registry does not have: model\.psd\.fines_floor\./,
      ),
    ).toBeTruthy();
    expect(useShotStore.getState().form.overrides).toEqual({});
    expect(useShotStore.getState().form.prep.dose_g).toBe('16');
    fireEvent.click(screen.getByRole('button', { name: 'Undo load' }));
    expect(useShotStore.getState().form.prep.dose_g).toBe('18');
  });

  it('drops unknown overrides from a restored draft when the registry arrives', async () => {
    const form = defaultForm();
    form.overrides = { 'model.psd.fines_floor': '5' };
    resetShotStore(form);
    const fake = shotEngine();
    renderLab(fake.engine);
    await advance();
    expect(
      screen.getByText(/Removed overrides of parameters this version’s registry does not have/),
    ).toBeTruthy();
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0].recipe.overrides).toBeUndefined();
  });

  it('opens a closed section and its Advanced block to show a field the builder names', async () => {
    const fake = shotEngine();
    renderLab(fake.engine);
    await advance();
    const message = 'grinder.fines_at_340_pct = 50 is outside the plausible range 1 to 40 %';
    fake.runs[0].reject(new EngineError('invalid-params', message));
    await advance();
    // The section opened on the new problem; close it as a user might.
    const details = document.getElementById('section-grinder') as HTMLDetailsElement;
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    await advance();
    expect(document.getElementById('rf-grinder-fines_at_340_pct')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the field' }));
    await advance(200);
    const field = document.getElementById('rf-grinder-fines_at_340_pct');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field?.getAttribute('aria-invalid')).toBe('true');
  });

  it('moves focus to a neighbour after Unpin and after removing a basket point', async () => {
    await startWithPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Pin this run' }));
    const unpin = screen.getByRole('button', { name: 'Unpin Run 1 (preview)' });
    unpin.focus();
    fireEvent.click(unpin);
    await advance(200);
    expect(document.activeElement).toBe(document.getElementById('shot-pin'));

    await openSection('basket');
    fireEvent.click(screen.getByRole('button', { name: 'Edit a copy as a custom basket' }));
    const remove = screen.getByRole('button', { name: 'Remove point 2' });
    remove.focus();
    fireEvent.click(remove);
    await advance(200);
    // The row that was point 3 is now point 2, and its Remove button has the focus.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove point 2');
    expect(screen.getAllByRole('button', { name: /^Remove point/ })).toHaveLength(3);
  });

  it('labels the predictions honestly: a model caveat, TDS to one decimal, the EY spread as SD', async () => {
    await startWithPreview({ ey: 0.2 });
    expect(document.querySelector('.model-status')?.textContent).toBe(modelStatusText(SOURCE_URL));
    expect(tile('tds')).toBe('10.0%');
    expect(screen.getByText('Local EY spread (SD)')).toBeTruthy();
    expect(tile('uniformity')).toBe('2.0 points');
  });

  it('shows the outflow check next to the mass balance', async () => {
    await startWithPreview();
    expect(tile('mass-balance')).toBe('1.5 × 10⁻¹⁵');
    expect(tile('outflow-check')).toBe('1.2 × 10⁻³');
    expect(screen.getByText('cup solute vs ∫ flow × concentration')).toBeTruthy();
  });

  it('shows the engine’s panic message in the failure alert, for a bug report', async () => {
    const fake = shotEngine();
    renderLab(fake.engine);
    await advance();
    const panic = 'panicked at crates/puckcore/src/shot/sim.rs:10:5: index out of bounds';
    fake.runs[0].reject(new EngineError('runtime', 'unreachable', { detail: panic }));
    await advance();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The engine failed and was restarted: unreachable');
    const details = alert.querySelector('details.panic-details');
    expect(details?.querySelector('summary')?.textContent).toBe(
      'Technical details for a bug report',
    );
    expect(details?.querySelector('pre')?.textContent).toBe(panic);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows a sweep’s engine failure with the panic message', async () => {
    const fake = await startWithPreview();
    fireEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    fireEvent.change(screen.getByLabelText('Points (2–41)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    await advance();
    fake.points[0].reject(new EngineError('runtime', 'unreachable', { detail: 'panicked at x' }));
    await advance();
    const alert = screen.getByText(/The sweep stopped: /).closest('[role="alert"]') as HTMLElement;
    expect(alert.querySelector('.panic-details pre')?.textContent).toBe('panicked at x');
  });

  it('defaults the vent checkbox to the preset and sends only a choice that differs', async () => {
    const fake = shotEngine({ catalog: catalogWithMachine({ vent_headspace: true }) });
    renderLab(fake.engine);
    await advance();
    fake.runs[0].resolve();
    await advance();
    expect(fake.runs[0].recipe.machine.vent_headspace).toBeUndefined();
    await openSection('machine');
    const vent = screen.getByLabelText<HTMLInputElement>(
      'Vents the group after the shot (three-way valve)',
    );
    expect(vent.checked).toBe(true);
    expect(screen.getByText('No drip after the stop. From the preset: yes.')).toBeTruthy();
    fireEvent.click(vent);
    await advance(300);
    expect(vent.checked).toBe(false);
    expect(fake.runs.at(-1)?.recipe.machine.vent_headspace).toBe(false);
    expect(document.getElementById('section-machine-summary')?.textContent).not.toContain(
      'vents after the stop',
    );
    // Back to the preset's value: the choice is dropped, so another preset brings its own.
    fireEvent.click(vent);
    expect(vent.checked).toBe(true);
    expect(useShotStore.getState().form.machine.vent_headspace).toBe('');
    expect(document.getElementById('section-machine-summary')?.textContent).toContain(
      'vents after the stop',
    );
  });

  it('ticks the vent for a preset without one and sends it', async () => {
    const fake = await startWithPreview();
    await openSection('machine');
    const vent = screen.getByLabelText<HTMLInputElement>(
      'Vents the group after the shot (three-way valve)',
    );
    expect(vent.checked).toBe(false);
    fireEvent.click(vent);
    await advance(300);
    expect(fake.runs.at(-1)?.recipe.machine.vent_headspace).toBe(true);
  });

  it('says where an empty pump field comes from: the preset’s pump or the registry', async () => {
    const pump = { type: 'vibratory', free_flow_ml_s: 7, stall_pressure_bar: 15, opv_bar: 11 };
    const fake = shotEngine({
      catalog: catalogWithMachine({ pump: pump as MachinePreset['pump'] }),
    });
    renderLab(fake.engine);
    await advance();
    fake.runs[0].resolve();
    await advance();
    await openSection('machine');
    const input = (path: string) =>
      document.getElementById(`rf-${path.replaceAll('.', '-')}`) as HTMLInputElement;
    // The same type as the preset's pump: its values fill the gaps.
    fireEvent.click(screen.getByLabelText('Vibratory'));
    expect(input('machine.pump.free_flow_ml_s').value).toBe('7');
    fireEvent.change(input('machine.pump.free_flow_ml_s'), { target: { value: '' } });
    fireEvent.change(input('machine.pump.opv_bar'), { target: { value: '' } });
    expect(input('machine.pump.free_flow_ml_s').placeholder).toBe('7 from the preset');
    expect(input('machine.pump.stall_pressure_bar').placeholder).toBe('15 from the preset');
    expect(input('machine.pump.opv_bar').placeholder).toBe('11 from the preset');
    expect(screen.getByText('Empty fields take the preset pump’s values.')).toBeTruthy();
    expect(screen.getByText(/Empty keeps the preset’s valve/)).toBeTruthy();
    // Another type: the registry's defaults.
    fireEvent.click(screen.getByLabelText('Ideal (profiling)'));
    fireEvent.change(input('machine.pump.max_flow_ml_s'), { target: { value: '' } });
    expect(input('machine.pump.max_flow_ml_s').placeholder).toMatch(
      /^\d+(\.\d+)? \(registry default\)$/,
    );
    expect(
      screen.getByText(
        'Empty fields take the registry defaults (the preset’s pump is of another type).',
      ),
    ).toBeTruthy();
  });
});
