// SPDX-License-Identifier: GPL-2.0-or-later
/** Exploded preparation layers and replaceable baskets share the actual recipe. */
import { useId } from 'react';
import { InlineConstraintControl } from '../../setup/ConstraintContext';
import type { BasketPreset, Catalog } from '../../engine/shotTypes';
import { parseDecimal } from '../../lab/sphereForm';
import { checkProfile, profileIsValid } from '../basketGeometry';
import { fieldId } from '../fields';
import { focusSoon } from '../focus';
import { profileRow, shiftedText, type RecipeForm } from '../recipeForm';
import { useShotStore } from '../shotStore';
import { useEditorContext } from '../editor/context';
import './PortafilterInternals.css';

function sourceBasket(form: RecipeForm, catalog: Catalog): BasketPreset | undefined {
  const id =
    form.basket.mode === 'machine'
      ? catalog.presets.machines.find((p) => p.id === form.machine.preset)?.default_basket
      : form.basket.preset;
  return catalog.presets.baskets.find((p) => p.id === id);
}

function wallPath(profile: readonly (readonly [number, number])[], width = 210, height = 65) {
  const diameter = Math.max(...profile.map(([, d]) => d));
  const top = profile.at(-1)![0];
  const x = (d: number) => 230 + ((d / diameter) * width) / 2;
  const y = (h: number) => 300 - (h / top) * height;
  const left = [...profile].reverse().map(([h, d]) => `${x(-d)},${y(h)}`);
  const right = profile.map(([h, d]) => `${x(d)},${y(h)}`);
  return `M${[...left, ...right].join(' L')}`;
}

export function PortafilterInternals() {
  const id = useId();
  const { catalog, errors } = useEditorContext();
  const form = useShotStore((s) => s.form);
  const patch = useShotStore((s) => s.patchForm);
  const undo = useShotStore((s) => s.undo);
  const source = sourceBasket(form, catalog);
  const basket = form.basket;
  const raw =
    basket.mode === 'custom'
      ? basket.profile.map((p) => [parseDecimal(p.height), parseDecimal(p.diameter)] as const)
      : source?.profile_mm;
  const profile =
    raw && raw.every(([h, d]) => h !== null && d !== null)
      ? (raw as readonly (readonly [number, number])[])
      : null;
  const perforated =
    basket.mode === 'custom'
      ? parseDecimal(basket.perforated_diameter_mm)
      : source?.perforated_diameter_mm;
  const orifice =
    basket.mode === 'custom'
      ? basket.outlet === 'pressurised'
        ? parseDecimal(basket.pressurised_orifice_mm)
        : null
      : source?.pressurised_orifice_mm;
  const valid =
    profile &&
    perforated !== null &&
    perforated !== undefined &&
    !(basket.mode === 'custom' && basket.outlet === 'pressurised' && orifice === null) &&
    profile.every(([h, d]) => Number.isFinite(h) && Number.isFinite(d)) &&
    profileIsValid(checkProfile(profile, perforated, orifice ?? null));
  const dualWall = basket.mode === 'custom' ? basket.outlet === 'pressurised' : !!orifice;
  const layers = [
    { key: 'puck_screen', name: 'Puck screen', y: 70 },
    { key: 'paper_top', name: 'Top paper', y: 105 },
    { key: 'paper_bottom', name: 'Bottom paper', y: 210 },
  ] as const;
  const replaceOutlet = (outlet: 'holes' | 'pressurised') => {
    if (basket.mode === 'custom') {
      patch('basket', { outlet });
      return;
    }
    if (!source) return;
    // A custom copy keeps every measured/preset wall and outlet coefficient.
    useShotStore.getState().loadForm(
      {
        ...form,
        basket: {
          ...basket,
          mode: 'custom',
          outlet,
          profile: source.profile_mm.map(([h, d]) => profileRow(String(h), String(d))),
          perforated_diameter_mm: String(source.perforated_diameter_mm),
          open_area_fraction:
            typeof source.open_area_fraction === 'number'
              ? shiftedText(source.open_area_fraction, 2)
              : '',
          pressurised_orifice_mm:
            typeof source.pressurised_orifice_mm === 'number'
              ? String(source.pressurised_orifice_mm)
              : basket.pressurised_orifice_mm,
          discharge_coefficient:
            typeof source.discharge_coefficient === 'number'
              ? String(source.discharge_coefficient)
              : '',
        },
      },
      'Undo basket part change',
    );
  };
  return (
    <section className="portafilter-internals" aria-labelledby={`${id}-heading`}>
      <header>
        <p className="portafilter-eyebrow">Inside the portafilter</p>
        <h3 id={`${id}-heading`}>Build the coffee bed, layer by layer</h3>
        <p>Swap a basket or add a layer. Each choice updates your shared recipe.</p>
      </header>
      <svg viewBox="0 0 480 355" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>Exploded portafilter and preparation layers</title>
        <desc id={`${id}-desc`}>
          Layers are separated for clarity: puck screen, top paper, coffee puck, bottom paper and
          basket.{' '}
          {dualWall
            ? 'A dual-wall outlet adds a restricted exit.'
            : 'Plain holes drain the basket.'}{' '}
          Basket wall proportions follow the recipe; layer spacing is illustrative.
        </desc>
        <path className="pf-axis" d="M230 35 V325" />
        {layers.map((layer, index) => (
          <g
            key={layer.key}
            className={form.prep[layer.key] ? 'pf-layer is-installed' : 'pf-layer'}
            data-portafilter-layer={layer.key}
          >
            <ellipse cx="230" cy={layer.y} rx="103" ry="10" />
            {layer.key === 'puck_screen' && <path d="M145 66 H315 M145 73 H315" />}
            <path className="pf-leader" d={`M127 ${layer.y} H65`} />
            <circle cx="48" cy={layer.y} r="14" />
            <text x="48" y={layer.y + 5} textAnchor="middle">
              {index + 1}
            </text>
          </g>
        ))}
        <g className="pf-puck">
          <path d="M127 145 Q230 123 333 145 V180 Q230 202 127 180 Z" />
          <ellipse cx="230" cy="145" rx="103" ry="11" />
          {Array.from({ length: 15 }, (_, i) => (
            <circle key={i} cx={145 + i * 12} cy={161 + (i % 3) * 7} r="2" />
          ))}
        </g>
        {valid ? (
          <g className="pf-basket" data-portafilter-outlet={dualWall ? 'pressurised' : 'holes'}>
            <path d={wallPath(profile)} />
            <path className="pf-handle" d="M338 245 L455 261 L452 278 L336 258 Z" />
            <path className="pf-holes" d="M150 303 H310" />
            {dualWall && (
              <path className="pf-dual" d="M135 310 Q230 345 325 310 M225 330 V341 M235 330 V341" />
            )}
          </g>
        ) : (
          <text className="pf-empty" x="230" y="275" textAnchor="middle">
            Choose a valid basket below
          </text>
        )}
      </svg>
      <p className="portafilter-caption">Exploded view · dashed layers are absent</p>
      <div className="portafilter-layers" role="group" aria-label="Portafilter preparation layers">
        {layers.map((layer, index) => (
          <button
            key={layer.key}
            type="button"
            aria-pressed={form.prep[layer.key]}
            data-prep-part-choice={layer.key}
            onClick={() => patch('prep', { [layer.key]: !form.prep[layer.key] })}
          >
            <span>
              {index + 1} {layer.name}
            </span>
            <small>{form.prep[layer.key] ? 'Installed' : 'Add layer'}</small>
          </button>
        ))}
      </div>
      <p className="note">
        Screen and bottom-paper effects use estimated preparation coefficients. Top paper is
        recorded in the recipe; it has no modeled extraction effect.
      </p>
      {layers.map((layer) => (
        <InlineConstraintControl key={layer.key} path={`prep.${layer.key}`} />
      ))}
      <div className="portafilter-baskets" role="group" aria-label="Replace the basket">
        {catalog.presets.baskets.map((p) => (
          <button
            key={p.id}
            type="button"
            data-basket-part-choice={p.id}
            aria-pressed={basket.mode !== 'custom' && source?.id === p.id}
            onClick={() =>
              useShotStore
                .getState()
                .loadForm(
                  { ...form, basket: { ...basket, mode: 'preset', preset: p.id } },
                  'Undo basket part change',
                )
            }
          >
            <svg viewBox="110 225 240 90" aria-hidden="true" focusable="false">
              <path d={wallPath(p.profile_mm)} />
              {p.pressurised_orifice_mm ? (
                <path d="M130 307 Q230 340 330 307" />
              ) : (
                <path d="M150 307 H310" />
              )}
            </svg>
            <span>{p.name}</span>
            <small>{p.nominal_dose_g} g nominal</small>
          </button>
        ))}
      </div>
      <fieldset className="portafilter-outlets">
        <legend>Internal basket outlet</legend>
        <button
          type="button"
          aria-pressed={!dualWall}
          disabled={basket.mode !== 'custom' && !source}
          onClick={() => replaceOutlet('holes')}
        >
          Plain holes
        </button>
        <button
          type="button"
          aria-pressed={dualWall}
          disabled={basket.mode !== 'custom' && !source}
          onClick={() => replaceOutlet('pressurised')}
        >
          Dual wall
        </button>
      </fieldset>
      {dualWall && basket.mode === 'custom' && (
        <div className="field">
          <label htmlFor={`${id}-orifice`}>Internal outlet diameter (mm)</label>
          <input
            id={`${id}-orifice`}
            type="text"
            inputMode="decimal"
            value={basket.pressurised_orifice_mm}
            aria-invalid={!!errors['basket.custom.pressurised_orifice_mm'] || undefined}
            aria-describedby={
              errors['basket.custom.pressurised_orifice_mm'] ? `${id}-error` : undefined
            }
            onChange={(e) => patch('basket', { pressurised_orifice_mm: e.target.value })}
          />
          {errors['basket.custom.pressurised_orifice_mm'] && (
            <p id={`${id}-error`} className="field-error">
              {errors['basket.custom.pressurised_orifice_mm']}
            </p>
          )}
          <InlineConstraintControl path="basket.custom.pressurised_orifice_mm" />
        </div>
      )}
      {undo?.label === 'Undo basket part change' && (
        <button type="button" className="button" onClick={() => useShotStore.getState().undoLast()}>
          Undo basket part change
        </button>
      )}
      <button
        type="button"
        className="button button-quiet"
        onClick={() => {
          if (basket.mode !== 'custom' && source) replaceOutlet(dualWall ? 'pressurised' : 'holes');
          useShotStore.getState().revealField('basket.custom.profile_mm');
          focusSoon([fieldId('basket.custom.profile_mm.0.0'), 'section-basket-summary'], 10, () =>
            useShotStore.getState().clearReveal(),
          );
        }}
      >
        Edit basket dimensions below
      </button>
    </section>
  );
}
