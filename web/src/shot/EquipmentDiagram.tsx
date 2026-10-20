// SPDX-License-Identifier: GPL-2.0-or-later
/** A schematic map into the same recipe form used by the full editor. */
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Catalog, Distribution } from '../engine/shotTypes';
import { findPreset, presetOptions, useEditorContext } from './editor/context';
import { fieldId } from './fields';
import { focusSoon } from './focus';
import { changeGrinderMode, changeGrinderPreset, changeMachinePreset } from './recipeForm';
import { useShotStore } from './shotStore';
import './EquipmentDiagram.css';

const PARTS = [
  {
    id: 'bean',
    title: 'Beans',
    short: 'Beans',
    x: 112,
    y: 40,
    path: 'bean.preset',
    description: 'The coffee in the hopper. Roast and age affect the model’s starting material.',
    leader: 'M112 40 V80 H175 V108',
  },
  {
    id: 'grinder',
    title: 'Grinder',
    short: 'Grinder',
    x: 69,
    y: 205,
    path: 'grinder.preset',
    description:
      'The burrs break beans into particles. Your grinder and setting determine their size distribution.',
    leader: 'M69 205 H125 L182 186',
  },
  {
    id: 'machine',
    title: 'Machine',
    short: 'Machine',
    x: 474,
    y: 55,
    path: 'machine.preset',
    description: 'The machine supplies water, heat and pressure to the group above the basket.',
    leader: 'M474 55 V91 H414 V150',
  },
  {
    id: 'basket',
    title: 'Portafilter / basket',
    short: 'Basket',
    x: 493,
    y: 215,
    path: 'basket.preset',
    description:
      'The handled portafilter holds the basket. Its wall and outlet shape the coffee bed and flow.',
    leader: 'M493 215 V231 H432 L397 249',
  },
  {
    id: 'prep',
    title: 'Puck / dose',
    short: 'Puck / dose',
    x: 123,
    y: 385,
    path: 'prep.dose_g',
    description:
      'The puck is the packed coffee inside the basket. Dose and distribution change the bed.',
    leader: 'M123 385 V346 H297 V280 L370 255',
  },
  {
    id: 'stop',
    title: 'Cup / stop',
    short: 'Cup / stop',
    x: 474,
    y: 386,
    path: 'stop.beverage_g',
    description:
      'The scale measures beverage in the cup. A stop target turns off the pump; any modeled drip follows.',
    leader: 'M474 386 V354 H380 V337',
  },
] as const;
type Part = (typeof PARTS)[number];
type PartId = Part['id'];

function equipmentId(path: string): string {
  return `equipment-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function QuickField({
  path,
  label,
  hint,
  children,
}: {
  path: string;
  label: string;
  hint?: string;
  children: (props: {
    id: string;
    'aria-invalid': true | undefined;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}) {
  const { errors } = useEditorContext();
  const id = equipmentId(path);
  const error = errors[path];
  const described =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field equipment-field">
      <label htmlFor={id}>Diagram {label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': described })}
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

function QuickText({
  path,
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  path: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <QuickField path={path} label={label} hint={hint}>
      {(props) => (
        <input
          {...props}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </QuickField>
  );
}

function QuickSelect({
  path,
  label,
  value,
  onChange,
  options,
  hint,
}: {
  path: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  hint?: string;
}) {
  return (
    <QuickField path={path} label={label} hint={hint}>
      {(props) => (
        <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </QuickField>
  );
}

function QuickSettings({ part, catalog }: { part: PartId; catalog: Catalog }) {
  const form = useShotStore((state) => state.form);
  const patch = useShotStore((state) => state.patchForm);
  const undo = useShotStore((state) => state.undo);
  const undoLast = useShotStore((state) => state.undoLast);
  const bean =
    findPreset(catalog.presets.beans, form.bean.preset) ??
    catalog.presets.beans.find((preset) => preset.default);
  const grinder = findPreset(catalog.presets.grinders, form.grinder.preset);
  const machine = findPreset(catalog.presets.machines, form.machine.preset);
  switch (part) {
    case 'bean':
      return (
        <>
          <QuickSelect
            path="bean.preset"
            label="bean preset"
            value={form.bean.preset}
            options={[
              { value: '', label: 'Default bean' },
              ...presetOptions(catalog.presets.beans),
            ]}
            onChange={(preset) => patch('bean', { preset })}
          />
          <QuickText
            path="bean.roast_level"
            label="roast level (0–1)"
            value={form.bean.roast_level}
            placeholder={bean ? `${bean.roast_level} from preset` : undefined}
            hint="0 is light; 1 is dark. Empty follows the bean preset."
            onChange={(roast_level) => patch('bean', { roast_level })}
          />
          <QuickText
            path="bean.days_off_roast"
            label="days off roast"
            value={form.bean.days_off_roast}
            placeholder={bean ? `${bean.days_off_roast} from preset` : undefined}
            onChange={(days_off_roast) => patch('bean', { days_off_roast })}
          />
        </>
      );
    case 'grinder':
      return (
        <>
          <QuickSelect
            path="grinder.preset"
            label="grinder preset"
            value={form.grinder.mode === 'preset' ? form.grinder.preset : '__custom'}
            options={[
              ...(form.grinder.mode !== 'preset'
                ? [
                    {
                      value: '__custom',
                      label:
                        form.grinder.mode === 'psd' ? 'Measured PSD in use' : 'Burr family in use',
                      disabled: true,
                    },
                  ]
                : []),
              { value: '', label: 'Choose a grinder…' },
              ...presetOptions(catalog.presets.grinders),
            ]}
            hint="Choosing a grinder clears the previous grinder’s calibration and PSD overrides."
            onChange={(id) => {
              const next = changeGrinderMode(form.grinder, 'preset', catalog.presets.grinders);
              patch(
                'grinder',
                changeGrinderPreset(next, findPreset(catalog.presets.grinders, id), id),
              );
            }}
          />
          {form.grinder.mode !== 'psd' &&
            (form.grinder.by === 'gap' ? (
              <QuickText
                path="grinder.gap_um"
                label="burr gap (µm)"
                value={form.grinder.gap_um}
                onChange={(gap_um) => patch('grinder', { gap_um })}
              />
            ) : (
              <QuickText
                path="grinder.setting"
                label={`grinder setting${grinder ? ` (${grinder.dial.label})` : ''}`}
                value={form.grinder.setting}
                placeholder={grinder ? `${grinder.dial.default} from preset` : undefined}
                hint={
                  grinder
                    ? `Dial range ${grinder.dial.min}–${grinder.dial.max}; settings are specific to this grinder.`
                    : undefined
                }
                onChange={(setting) => patch('grinder', { setting })}
              />
            ))}
        </>
      );
    case 'machine': {
      const fromPreset = machine?.vent_headspace === true;
      const vent =
        form.machine.vent_headspace === '' ? fromPreset : form.machine.vent_headspace === 'yes';
      return (
        <>
          <QuickSelect
            path="machine.preset"
            label="machine preset"
            value={form.machine.preset}
            options={[
              { value: '', label: 'Custom program and pump' },
              ...presetOptions(catalog.presets.machines),
            ]}
            onChange={(id) => {
              const next = changeMachinePreset(form.machine, id);
              if (next.discarded)
                useShotStore
                  .getState()
                  .loadForm({ ...form, machine: next.machine }, 'Undo machine change');
              else patch('machine', next.machine);
            }}
          />
          <QuickText
            path="machine.temperature_c"
            label="brew temperature (°C)"
            value={form.machine.temperature_c}
            placeholder={
              machine?.temperature_c !== undefined
                ? `${machine.temperature_c} from preset`
                : 'Registry default'
            }
            onChange={(temperature_c) => patch('machine', { temperature_c })}
          />
          <div className="equipment-check">
            <input
              id="equipment-machine-vent-headspace"
              type="checkbox"
              checked={vent}
              onChange={(event) =>
                patch('machine', {
                  vent_headspace:
                    event.target.checked === fromPreset ? '' : event.target.checked ? 'yes' : 'no',
                })
              }
            />
            <label htmlFor="equipment-machine-vent-headspace">Diagram vent after stop</label>
            <p className="field-hint">
              A vent sends remaining group water to the tray instead of through the puck.
            </p>
          </div>
          {undo?.label === 'Undo machine change' && (
            <p className="equipment-note">
              The program and pump now follow this preset.{' '}
              <button className="button button-small" type="button" onClick={undoLast}>
                Undo machine change
              </button>
            </p>
          )}
        </>
      );
    }
    case 'basket':
      return (
        <QuickSelect
          path="basket.preset"
          label="basket preset"
          value={form.basket.mode === 'preset' ? form.basket.preset : `__${form.basket.mode}`}
          options={[
            ...(form.basket.mode === 'custom'
              ? [{ value: '__custom', label: 'Custom basket profile in use', disabled: true }]
              : []),
            { value: '__machine', label: 'Use the machine’s basket' },
            ...presetOptions(catalog.presets.baskets),
          ]}
          hint="Use More settings to draw a custom wall or change the basket’s outlet."
          onChange={(preset) =>
            patch(
              'basket',
              preset === '__machine' ? { mode: 'machine' } : { mode: 'preset', preset },
            )
          }
        />
      );
    case 'prep':
      return (
        <>
          <QuickText
            path="prep.dose_g"
            label="dry dose (g)"
            value={form.prep.dose_g}
            hint="Dry ground coffee packed into the basket."
            onChange={(dose_g) => patch('prep', { dose_g })}
          />
          <QuickSelect
            path="prep.distribution"
            label="distribution"
            value={form.prep.distribution}
            options={[
              { value: '', label: 'Not given (tapping assumed)' },
              { value: 'none', label: 'None' },
              { value: 'tap', label: 'Tapping' },
              { value: 'wdt', label: 'WDT (needle stirring)' },
            ]}
            onChange={(distribution) =>
              patch('prep', { distribution: distribution as '' | Distribution })
            }
          />
        </>
      );
    case 'stop':
      return (
        <>
          <QuickText
            path="stop.beverage_g"
            label="beverage stop (g)"
            value={form.stop.beverage_g}
            hint="Mass at pump stop. Final cup mass includes any modeled drip."
            onChange={(beverage_g) => patch('stop', { beverage_g })}
          />
          <QuickText
            path="stop.time_s"
            label="time stop (s)"
            value={form.stop.time_s}
            hint="The first stop condition reached turns off the pump."
            onChange={(time_s) => patch('stop', { time_s })}
          />
        </>
      );
  }
}

function EquipmentDrawing({ active }: { active: PartId | null }) {
  const partClass = (id: PartId) => `equipment-part${active === id ? ' is-active' : ''}`;
  return (
    <svg
      className="equipment-art"
      viewBox="0 0 600 450"
      role="img"
      aria-labelledby="equipment-art-title equipment-art-desc"
    >
      <title id="equipment-art-title">Espresso equipment and the coffee’s path to the cup</title>
      <desc id="equipment-art-desc">
        An illustrative grinder with beans and burrs beside an espresso machine. Below the machine’s
        group is a handled portafilter, a basket containing the coffee puck, and a cup on a scale.
        Six numbered controls connect to these parts.
      </desc>
      <g aria-hidden="true">
        <path className="equipment-counter" d="M105 346 H468" />
        <g className={partClass('grinder')} data-equipment-part="grinder">
          <rect className="equipment-highlight" x="140" y="139" width="105" height="177" rx="24" />
          <path className="equipment-metal" d="M157 142 H219 L228 283 H148 Z" />
          <rect className="equipment-metal" x="133" y="284" width="108" height="19" rx="8" />
          <circle className="equipment-burr" cx="187" cy="185" r="26" />
          <circle className="equipment-outline" cx="187" cy="185" r="15" />
          <path
            className="equipment-detail"
            d="M177 167 L181 177 M199 165 L195 176 M206 187 L196 187 M196 205 L192 195 M176 205 L180 195 M167 183 L178 185"
          />
          <circle className="equipment-metal" cx="165" cy="240" r="12" />
          <path
            className="equipment-detail"
            d="M165 231 V239 M158 249 L161 246 M171 249 L169 246"
          />
          <path className="equipment-metal" d="M218 211 L247 217 V232 L221 227 Z" />
          <path className="equipment-detail" d="M168 268 H210 M174 274 H204" />
        </g>
        <g className={partClass('bean')} data-equipment-part="bean">
          <path className="equipment-highlight" d="M134 74 H239 L218 151 H155 Z" />
          <path className="equipment-glass" d="M145 82 H228 L211 142 H161 Z" />
          <rect className="equipment-metal" x="141" y="74" width="91" height="9" rx="4" />
          {[
            [167, 111, -24],
            [188, 106, 28],
            [210, 113, -21],
            [178, 127, 40],
            [198, 128, -35],
          ].map(([x, y, angle]) => (
            <g key={x} transform={`rotate(${angle} ${x} ${y})`}>
              <ellipse className="equipment-coffee" cx={x} cy={y} rx="6" ry="9" />
              <path className="equipment-bean-seam" d={`M${x + 1} ${y - 6} q-4 6 0 12`} />
            </g>
          ))}
        </g>
        <g className={partClass('machine')} data-equipment-part="machine">
          <rect className="equipment-highlight" x="278" y="108" width="204" height="220" rx="24" />
          <path
            className="equipment-metal"
            d="M297 121 H456 Q468 121 468 135 V316 H294 V137 Q294 121 297 121 Z"
          />
          <path className="equipment-outline" d="M306 145 H457 M305 152 H455" />
          <rect className="equipment-machine-face" x="310" y="157" width="145" height="47" rx="7" />
          <circle className="equipment-outline" cx="429" cy="180" r="15" />
          <path
            className="equipment-detail"
            d="M429 180 L436 172 M418 183 H421 M429 168 V171 M438 183 H441"
          />
          <circle className="equipment-indicator" cx="326" cy="177" r="4" />
          <rect className="equipment-outline" x="340" y="171" width="33" height="12" rx="4" />
          <path className="equipment-detail" d="M316 194 H365" />
          <path className="equipment-cutout" d="M319 213 H443 V316 H319 Z" />
          <rect className="equipment-metal" x="343" y="211" width="65" height="22" rx="5" />
          <path
            className="equipment-detail"
            d="M351 231 V239 M400 231 V239 M463 211 Q486 228 467 251 L458 276"
          />
          <path className="equipment-metal" d="M288 316 H474 V329 H288 Z" />
          <path className="equipment-detail" d="M294 126 V113 H467 V126 M321 321 H432" />
        </g>
        <g className={partClass('basket')} data-equipment-part="basket">
          <rect className="equipment-highlight" x="334" y="235" width="132" height="42" rx="15" />
          <rect className="equipment-metal" x="341" y="240" width="68" height="10" rx="4" />
          <path className="equipment-metal" d="M347 250 H403 L394 268 H356 Z" />
          <path className="equipment-handle" d="M407 244 L454 253 Q461 257 456 263 L405 251 Z" />
          <path className="equipment-detail" d="M361 266 H390 M369 269 V276 M382 269 V276" />
        </g>
        <g className={partClass('prep')} data-equipment-part="prep">
          <path className="equipment-highlight" d="M346 249 H404 L397 265 H353 Z" />
          <path className="equipment-coffee" d="M352 252 H398 L395 260 H355 Z" />
          <path
            className="equipment-grains"
            d="M358 256 H360 M366 256 H368 M375 256 H377 M384 256 H386 M391 255 H393"
          />
        </g>
        <g className={partClass('stop')} data-equipment-part="stop">
          <rect className="equipment-highlight" x="329" y="283" width="100" height="66" rx="18" />
          <path className="equipment-water" d="M370 281 V290 M382 281 V290" />
          <path className="equipment-cup" d="M348 294 H403 L398 318 Q376 334 354 318 Z" />
          <path className="equipment-outline" d="M403 299 H410 Q422 310 400 317" />
          <ellipse className="equipment-coffee" cx="376" cy="295" rx="26" ry="4" />
          <rect className="equipment-metal" x="335" y="329" width="85" height="14" rx="5" />
          <path className="equipment-detail" d="M345 336 H353 M361 336 H369 M377 336 H385" />
          <text className="equipment-unit" x="401" y="340">
            g
          </text>
        </g>
        {PARTS.map((part) => (
          <g
            key={part.id}
            className={`equipment-leader${active === part.id ? ' is-active' : ''}`}
            data-equipment-leader={part.id}
          >
            <path d={part.leader} />
            <circle
              cx={
                part.id === 'bean'
                  ? 175
                  : part.id === 'grinder'
                    ? 182
                    : part.id === 'machine'
                      ? 414
                      : part.id === 'basket'
                        ? 397
                        : part.id === 'prep'
                          ? 370
                          : 380
              }
              cy={
                part.id === 'bean'
                  ? 108
                  : part.id === 'grinder'
                    ? 186
                    : part.id === 'machine'
                      ? 150
                      : part.id === 'basket'
                        ? 249
                        : part.id === 'prep'
                          ? 255
                          : 337
              }
              r="3.5"
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

export function EquipmentDiagram() {
  const { catalog, errors } = useEditorContext();
  const [active, setActive] = useState<PartId | null>(null);
  const buttons = useRef<Partial<Record<PartId, HTMLButtonElement | null>>>({});
  const selected = PARTS.find((part) => part.id === active);
  const close = () => {
    setActive(null);
    if (active) buttons.current[active]?.focus();
  };
  return (
    <section
      className="equipment-diagram"
      aria-labelledby="equipment-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && active) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="equipment-heading">
        <div>
          <p className="equipment-eyebrow">Build your shot</p>
          <h2 id="equipment-heading">Follow the coffee</h2>
        </div>
        <p>Choose a part to adjust it. Your full settings stay below.</p>
      </header>
      <div className="equipment-stage">
        <EquipmentDrawing active={active} />
        <div className="equipment-callouts" role="group" aria-label="Equipment settings">
          {PARTS.map((part, index) => {
            const count = Object.keys(errors).filter((path) =>
              path.startsWith(`${part.id}.`),
            ).length;
            return (
              <button
                key={part.id}
                ref={(element) => {
                  buttons.current[part.id] = element;
                }}
                type="button"
                className={`equipment-callout${active === part.id ? ' is-active' : ''}`}
                style={
                  {
                    '--callout-x': `${part.x / 6}%`,
                    '--callout-y': `${part.y / 4.5}%`,
                  } as CSSProperties
                }
                aria-label={`${index + 1} ${part.short} settings${count ? `, ${count} problem${count === 1 ? '' : 's'}` : ''}`}
                aria-expanded={active === part.id}
                aria-controls="equipment-settings"
                data-equipment-callout={part.id}
                onClick={() => setActive((current) => (current === part.id ? null : part.id))}
              >
                <span className="equipment-number" aria-hidden="true">
                  {index + 1}
                </span>{' '}
                <span className="equipment-callout-label">{part.short}</span>
                {count > 0 && (
                  <span className="equipment-problem" aria-hidden="true">
                    !
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <p className="equipment-caption">Beans → burrs → coffee bed → cup</p>
      <div id="equipment-settings" className="equipment-settings" hidden={!selected}>
        {selected && (
          <>
            <div className="equipment-panel-head">
              <h3>{selected.title}</h3>
              <button
                type="button"
                className="equipment-close"
                aria-label="Close equipment settings"
                onClick={close}
              >
                ×
              </button>
            </div>
            <p className="equipment-description">{selected.description}</p>
            <div className="equipment-fields">
              <QuickSettings part={selected.id} catalog={catalog} />
            </div>
            <button
              type="button"
              className="button button-quiet equipment-more"
              onClick={() => {
                setActive(null);
                useShotStore.getState().revealField(selected.path);
                focusSoon([fieldId(selected.path), `section-${selected.id}-summary`], 10, () =>
                  useShotStore.getState().clearReveal(),
                );
              }}
            >
              More {selected.title.toLowerCase()} settings <span aria-hidden="true">↓</span>
            </button>
          </>
        )}
      </div>
    </section>
  );
}
