// SPDX-License-Identifier: GPL-2.0-or-later
/** A cutaway whose editable parts share the recipe with the full machine editor. */
import { useId, useRef, useState } from 'react';
import type { PumpInput } from '../../engine/shotTypes';
import { InlineConstraintControl } from '../../setup/ConstraintContext';
import { findPreset, useEditorContext } from '../editor/context';
import { changePumpMode, type PumpMode } from '../recipeForm';
import { useShotStore } from '../shotStore';
import './MachineInternals.css';

const THERMAL = [
  {
    id: 'model.thermal.hardware_water_equivalent',
    label: 'Group thermal mass (water-equivalent g)',
  },
  { id: 'model.thermal.hardware_temperature', label: 'Group starting temperature (°C)' },
  { id: 'model.thermal.loss_time_constant', label: 'Group cooling time constant (s)' },
] as const;
const UNDO = 'Undo group assembly change';
const PARTS = [
  ['heating', 'Heating layout'],
  ['pump', 'Pump'],
  ['group', 'Group / valve'],
] as const;
type Part = (typeof PARTS)[number][0];

function InternalField({
  path,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  path: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field machine-internal-field">
      <label htmlFor={id}>{`Internal ${label}`}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
      />
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
      <InlineConstraintControl path={path} />
    </div>
  );
}

function pumpName(pump: PumpInput | undefined | null) {
  return pump?.type === 'vibratory' ? 'vibratory' : 'ideal';
}

export function MachineInternals() {
  const { catalog, errors } = useEditorContext();
  const form = useShotStore((state) => state.form);
  const patch = useShotStore((state) => state.patchForm);
  const setOverride = useShotStore((state) => state.setOverride);
  const undo = useShotStore((state) => state.undo);
  const undoLast = useShotStore((state) => state.undoLast);
  const [active, setActive] = useState<Part | null>('heating');
  const [layout, setLayout] = useState<'boiler' | 'thermoblock'>('boiler');
  const buttons = useRef<Partial<Record<Part, HTMLButtonElement | null>>>({});
  const id = useId();
  const machine = form.machine;
  const preset = findPreset(catalog.presets.machines, machine.preset);
  const brewTemperature =
    preset?.temperature_c ??
    catalog.registry.parameters.find((p) => p.id === 'shot.temperature')?.default;
  const pump = machine.pumpMode === 'preset' ? pumpName(preset?.pump) : machine.pumpMode;
  const vents =
    machine.vent_headspace === ''
      ? preset?.vent_headspace === true
      : machine.vent_headspace === 'yes';
  const customThermal = THERMAL.some(
    ({ id: parameter }) => form.overrides[parameter] !== undefined,
  );
  const pumpDefault = (key: string, parameter: string) => {
    const matching = preset?.pump?.type === machine.pumpMode ? preset.pump : undefined;
    const value = (matching as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'number'
      ? `Empty follows ${value} from the preset.`
      : `Empty follows ${catalog.registry.parameters.find((p) => p.id === parameter)?.default ?? 'the registry'} (registry default).`;
  };
  const resetGroup = () => {
    const current = useShotStore.getState().form;
    const overrides = { ...current.overrides };
    THERMAL.forEach(({ id: parameter }) => {
      delete overrides[parameter];
    });
    useShotStore.getState().loadForm({ ...current, overrides }, UNDO);
  };

  return (
    <section
      className="machine-internals"
      aria-label="Inside the espresso machine"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && active) {
          event.stopPropagation();
          buttons.current[active]?.focus();
          setActive(null);
        }
      }}
    >
      <div className="machine-internal-heading">
        <p className="machine-internal-eyebrow">Under the cover</p>
        <h3>Inside the machine</h3>
        <p>Follow the water. Select a part to see and tune its settings.</p>
      </div>
      <div className="machine-internal-stage">
        <svg
          viewBox="0 0 600 360"
          className="machine-internal-art"
          role="img"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-desc`}
        >
          <title id={`${id}-title`}>
            Machine cutaway with a {layout}, {pump} pump and {vents ? 'vented' : 'unvented'} group
          </title>
          <desc id={`${id}-desc`}>
            Water travels from the reservoir through the pump and heater to the group and
            portafilter. Heater layout is illustrative; pump, valve and group thermal settings
            affect the recipe.
          </desc>
          <path className="mi-shell" d="M64 55 Q64 34 85 34 H487 Q510 34 510 58 V286 H64Z" />
          <path className="mi-cover" d="M83 18 H488 L518 40 H60Z" />
          <path className="mi-dashed" d="M83 24 V49 M488 24 V49" />
          <rect className="mi-tray" x="54" y="285" width="476" height="19" rx="7" />
          <path d="M80 311 H500 M96 307 V320 M487 307 V320" />
          <g className="mi-reservoir">
            <rect x="88" y="86" width="61" height="144" rx="8" />
            <path className="mi-water-fill" d="M94 131 Q107 125 120 131 T143 131 V222 H94Z" />
            <path d="M99 102 H138 M100 152 H109 M100 177 H109 M100 202 H109" />
          </g>
          <path
            className="mi-water-path"
            d="M121 230 V258 H207 V230 M235 193 V119 H288 M369 119 H441 V219"
          />
          <g
            data-machine-internal-part="pump"
            className={`mi-part ${active === 'pump' ? 'is-active' : ''}`}
          >
            <rect className="mi-part-metal" x="175" y="181" width="94" height="52" rx="12" />
            {pump === 'vibratory' ? (
              <>
                <path d="M185 189 V223 M193 186 V227 M201 186 V227 M209 186 V227 M217 186 V227" />
                <rect x="229" y="193" width="29" height="27" rx="3" />
              </>
            ) : (
              <>
                <circle cx="208" cy="207" r="18" />
                <path d="M196 207 H220 M208 195 V219" />
                <path d="M238 191 V223 M247 191 V223" />
              </>
            )}
            <path d="M187 235 V246 H257 V235" />
            <text x="222" y="272">
              {pump === 'vibratory' ? 'VIBRATORY' : 'IDEAL PUMP'}
            </text>
          </g>
          <g
            data-machine-internal-part="heating"
            className={`mi-part ${active === 'heating' ? 'is-active' : ''}`}
          >
            {layout === 'boiler' ? (
              <>
                <rect className="mi-heater" x="281" y="74" width="93" height="126" rx="29" />
                <path
                  className="mi-water-fill"
                  d="M287 122 Q309 113 331 122 T368 122 V168 Q368 194 343 194 H312 Q287 194 287 168Z"
                />
                <path
                  className="mi-element"
                  d="M306 177 V137 Q306 128 314 128 Q322 128 322 137 V168 Q322 177 330 177 Q338 177 338 168 V137 Q338 128 346 128 Q354 128 354 137 V177"
                />
                <path d="M312 74 V61 H343 V74 M302 204 V212 M355 204 V212" />
              </>
            ) : (
              <>
                <rect className="mi-heater" x="278" y="77" width="100" height="120" rx="10" />
                <path
                  className="mi-block-channel"
                  d="M287 104 H362 V122 H294 V141 H362 V160 H294 V178 H367"
                />
                <path className="mi-element" d="M288 88 H367 M288 188 H367" />
                <circle cx="287" cy="86" r="2" />
                <circle cx="368" cy="188" r="2" />
              </>
            )}
            <text x="329" y="238">
              {layout === 'boiler' ? 'BOILER' : 'THERMOBLOCK'}
            </text>
          </g>
          <g
            data-machine-internal-part="group"
            className={`mi-part ${active === 'group' ? 'is-active' : ''}`}
          >
            <rect className="mi-part-metal" x="408" y="211" width="68" height="34" rx="7" />
            <path
              className="mi-part-metal"
              d="M400 244 H484 V258 H474 L463 279 H420 L409 258 H400Z"
            />
            <path d="M413 253 H470 M420 261 H464 M425 269 H460" />
            <path className="mi-handle" d="M477 251 H535 Q543 251 543 258 Q543 264 535 264 H474Z" />
            {vents ? (
              <>
                <rect className="mi-valve" x="465" y="170" width="28" height="30" rx="3" />
                <path className="mi-water-path" d="M441 202 H479 V211 M479 184 H493 V278" />
                <path d="M473 179 L485 191 M485 179 L473 191" />
              </>
            ) : (
              <>
                <path d="M429 180 H453 M441 169 V191" />
                <circle cx="441" cy="180" r="16" />
              </>
            )}
            <path className="mi-coffee" d="M434 279 V292 M448 279 V292" />
          </g>
          {PARTS.map(([part]) => (
            <path
              key={part}
              data-machine-internal-leader={part}
              className={`mi-leader ${active === part ? 'is-active' : ''}`}
              d={
                part === 'heating'
                  ? 'M329 74 V51 H300 V6'
                  : part === 'pump'
                    ? 'M180 207 H157 L91 328 V352'
                    : 'M472 235 H530 V329 H509 V352'
              }
            />
          ))}
        </svg>
        <div className="machine-internal-callouts" role="group" aria-label="Machine internal parts">
          {PARTS.map(([part, name], index) => (
            <button
              key={part}
              ref={(node) => {
                buttons.current[part] = node;
              }}
              type="button"
              data-machine-internal-callout={part}
              className={`button machine-internal-callout mi-callout-${part}`}
              aria-label={`${index + 1} ${name} internal settings`}
              aria-expanded={active === part}
              aria-controls={`${id}-panel`}
              onClick={() => setActive(active === part ? null : part)}
            >
              <span>{index + 1}</span> <span>{name}</span>
            </button>
          ))}
        </div>
      </div>
      <div id={`${id}-panel`} className="machine-internal-panel" hidden={active === null}>
        {active === 'heating' && (
          <>
            <h4>Heating layout comparison</h4>
            <div
              className="machine-internal-options"
              role="group"
              aria-label="Illustrative heating layout"
            >
              {(['boiler', 'thermoblock'] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  className="button"
                  aria-pressed={layout === kind}
                  onClick={() => setLayout(kind)}
                >
                  {kind === 'boiler' ? 'Boiler illustration' : 'Thermoblock illustration'}
                </button>
              ))}
            </div>
            <p className="machine-internal-note">
              Illustration only, not saved as equipment: the model uses fixed incoming-water
              temperature and one shared puck thermal node. Boiler recovery, thermoblock dynamics
              and PID control are not simulated.
            </p>
            <InternalField
              path="machine.temperature_c"
              label="Brew temperature (°C)"
              value={machine.temperature_c}
              onChange={(temperature_c) => patch('machine', { temperature_c })}
              error={errors['machine.temperature_c']}
              hint={
                brewTemperature === undefined
                  ? 'Empty follows the preset or registry.'
                  : `Empty follows ${brewTemperature} °C from the preset or registry.`
              }
            />
          </>
        )}
        {active === 'pump' && (
          <>
            <h4>Swap the pump model</h4>
            <div className="field">
              <label htmlFor={`${id}-pump`}>Internal pump model</label>
              <select
                id={`${id}-pump`}
                value={machine.pumpMode}
                onChange={(event) =>
                  patch(
                    'machine',
                    changePumpMode(machine, event.target.value as PumpMode, preset?.pump),
                  )
                }
              >
                <option value="preset">Follow preset ({pumpName(preset?.pump)})</option>
                <option value="ideal">Ideal / profiling</option>
                <option value="vibratory">Vibratory</option>
              </select>
            </div>
            <p className="machine-internal-note">
              The ideal pump follows the pressure/flow program. A vibratory pump follows a
              pressure–flow curve and optional over-pressure valve.
            </p>
            {(machine.pumpMode === 'ideal'
              ? ([
                  [
                    'max_flow_ml_s',
                    'Maximum pump flow (mL/s)',
                    'max_flow_ml_s',
                    'model.machine.ideal_max_flow',
                  ],
                  [
                    'max_pressure_bar',
                    'Maximum pump pressure (bar)',
                    'max_pressure_bar',
                    'model.machine.ideal_max_pressure',
                  ],
                ] as const)
              : machine.pumpMode === 'vibratory'
                ? ([
                    [
                      'free_flow_ml_s',
                      'Free pump flow (mL/s)',
                      'free_flow_ml_s',
                      'model.machine.vibratory_free_flow',
                    ],
                    [
                      'stall_pressure_bar',
                      'Stall pressure (bar)',
                      'stall_pressure_bar',
                      'model.machine.vibratory_stall_pressure',
                    ],
                    ['opv_bar', 'Over-pressure valve (bar)', 'opv_bar', ''],
                  ] as const)
                : []
            ).map(([key, label, path, parameter]) => (
              <InternalField
                key={key}
                path={`machine.pump.${path}`}
                label={label}
                value={machine[key]}
                onChange={(value) => patch('machine', { [key]: value })}
                error={errors[`machine.pump.${path}`]}
                hint={
                  parameter
                    ? pumpDefault(key, parameter)
                    : 'Empty keeps a matching preset valve; otherwise there is no over-pressure valve.'
                }
              />
            ))}
          </>
        )}
        {active === 'group' && (
          <>
            <h4>Tune group thermal settings</h4>
            <p className="machine-internal-note" role="status">
              {customThermal ? 'Custom group thermal settings.' : 'Using existing group defaults.'}
            </p>
            <button type="button" className="button" onClick={resetGroup}>
              Use existing group defaults
            </button>
            <p className="machine-internal-note">
              Estimated sandbox assumptions (evidence grade D). These values describe heat exchanged
              with the basket and portafilter, not the heater or boiler. Empty values follow the
              existing machine/registry defaults.
            </p>
            {undo?.label === UNDO && (
              <p className="machine-internal-undo" role="status">
                Group assumptions changed.{' '}
                <button type="button" className="button button-small" onClick={undoLast}>
                  {UNDO}
                </button>
              </p>
            )}
            {THERMAL.map(({ id: parameter, label }) => {
              const registry = catalog.registry.parameters.find((p) => p.id === parameter);
              return (
                <InternalField
                  key={parameter}
                  path={`overrides.${parameter}`}
                  label={label}
                  value={form.overrides[parameter] ?? ''}
                  onChange={(value) => setOverride(parameter, value.trim() === '' ? null : value)}
                  error={errors[`overrides.${parameter}`]}
                  hint={
                    parameter === 'model.thermal.hardware_temperature' &&
                    preset?.preheat_temp_c !== undefined
                      ? `Empty follows ${preset.preheat_temp_c} °C from the machine preset.`
                      : `Empty follows ${registry?.default ?? 'the registry'} ${registry?.units ?? ''}. Range ${registry?.range.min ?? 'unbounded'}–${registry?.range.max ?? 'unbounded'}.`
                  }
                />
              );
            })}
            <label className="machine-internal-check" htmlFor={`${id}-vent`}>
              <input
                id={`${id}-vent`}
                type="checkbox"
                checked={vents}
                onChange={(event) => {
                  const on = event.target.checked;
                  patch('machine', {
                    vent_headspace:
                      on === (preset?.vent_headspace === true) ? '' : on ? 'yes' : 'no',
                  });
                }}
              />
              Internal three-way valve: vent the group after stop
            </label>
            <InlineConstraintControl path="machine.vent_headspace" />
            <p className="machine-internal-note">
              A vented group releases stored water after the stop instead of continuing to drip
              through the puck.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
