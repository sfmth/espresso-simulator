// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The machine: a preset, or a pressure/flow program and a pump described from
 * scratch, plus temperature and group headspace.
 */
import type { Catalog, MachinePreset, PhaseInput } from '../../engine/shotTypes';
import { CheckField, fieldId, RadioGroup, SelectField, TextField } from '../fields';
import { BuildNotes, PresetInfo } from '../PresetInfo';
import { FIELDS, labelWithUnit, phaseFieldMeta, withUnit } from '../recipeFields';
import { focusSoon } from '../focus';
import {
  changeMachinePreset,
  changePumpMode,
  PHASE_FIELDS,
  phaseForm,
  type PhaseForm,
  type PumpMode,
  type RecipeForm,
} from '../recipeForm';
import { useShotStore } from '../shotStore';
import { findPreset, presetOptions, useEditorContext } from './context';

type Machine = RecipeForm['machine'];

/** Label of the undo after a machine change dropped a custom program or pump. */
const MACHINE_UNDO = 'Undo machine change';

const CONTROL_LABELS: Record<string, string> = {
  pressure: 'Hold a pressure',
  flow: 'Hold a flow',
  pump: 'Full pump power',
};

/** The registry's default for `id`, if the registry has it. */
export function registryDefault(catalog: Catalog, id: string): number | undefined {
  return catalog.registry.parameters.find((p) => p.id === id)?.default;
}

/** One phase in words: "Hold 9 bar (2 s ramp), at most 6 mL/s, until 8 s". */
export function describePhase(phase: PhaseInput): string {
  const parts: string[] = [];
  if (phase.control === 'pump') parts.push('Pump at full power');
  else {
    const unit = phase.control === 'flow' ? 'mL/s' : 'bar';
    parts.push(`Hold ${withUnit(phase.target ?? 0, unit)}`);
  }
  if (typeof phase.ramp_s === 'number') parts.push(`${phase.ramp_s} s ramp`);
  if (typeof phase.limit === 'number' && phase.control !== 'pump') {
    parts.push(`at most ${withUnit(phase.limit, phase.control === 'flow' ? 'bar' : 'mL/s')}`);
  }
  const exits = [
    typeof phase.until_time_s === 'number' && `${phase.until_time_s} s`,
    typeof phase.until_beverage_g === 'number' && `${phase.until_beverage_g} g in the cup`,
    typeof phase.until_pressure_bar === 'number' && `${phase.until_pressure_bar} bar`,
  ].filter(Boolean);
  if (exits.length > 0) parts.push(`until ${exits.join(' or ')}`);
  return parts.join(', ');
}

function phaseFromPreset(phase: PhaseInput): PhaseForm {
  const text = (v: number | null | undefined) => (typeof v === 'number' ? String(v) : '');
  return phaseForm({
    control: phase.control,
    target: text(phase.target),
    ramp_s: text(phase.ramp_s),
    limit: text(phase.limit),
    until_time_s: text(phase.until_time_s),
    until_beverage_g: text(phase.until_beverage_g),
    until_pressure_bar: text(phase.until_pressure_bar),
  });
}

function ProgramEditor({ machine, set }: { machine: Machine; set: (p: Partial<Machine>) => void }) {
  const { errors } = useEditorContext();
  const phases = machine.phases;
  const update = (index: number, patch: Partial<PhaseForm>) =>
    set({ phases: phases.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  const move = (index: number, delta: number) => {
    const next = [...phases];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    set({ phases: next });
  };
  return (
    <div className="program-editor">
      <p className="section-intro">
        Phases run in order. Each ends at its first end condition; the last runs until the stop
        rule.
      </p>
      <ol className="phase-list">
        {phases.map((phase, i) => {
          const rowError = errors[`machine.profile.${i}`];
          return (
            <li key={phase.key}>
              <fieldset className="phase">
                <legend>Phase {i + 1}</legend>
                <SelectField
                  path={`machine.profile.${i}.control`}
                  label="Control"
                  value={phase.control}
                  onChange={(control) => update(i, { control: control as PhaseForm['control'] })}
                  options={Object.entries(CONTROL_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
                <div className="field-grid">
                  {PHASE_FIELDS.filter(
                    (f) => phase.control !== 'pump' || (f !== 'target' && f !== 'limit'),
                  ).map((field) => {
                    const meta = phaseFieldMeta(field, phase.control);
                    const path = `machine.profile.${i}.${field}`;
                    return (
                      <TextField
                        key={field}
                        path={path}
                        label={labelWithUnit(meta)}
                        term={meta.term}
                        value={phase[field]}
                        onChange={(value) => update(i, { [field]: value })}
                        placeholder={field === 'ramp_s' ? '2 (default)' : undefined}
                        error={errors[path]}
                      />
                    );
                  })}
                </div>
                {rowError && (
                  <p className="field-error" id={`${fieldId(`machine.profile.${i}`)}-error`}>
                    {rowError}
                  </p>
                )}
                {/* aria-disabled rather than disabled, so the keyboard focus is never dropped. */}
                <div className="actions">
                  <button
                    id={`phase-${phase.key}-up`}
                    type="button"
                    className="button button-small"
                    aria-disabled={i === 0 ? true : undefined}
                    aria-label={`Move phase ${i + 1} up`}
                    onClick={() => {
                      if (i === 0) return;
                      move(i, -1);
                      focusSoon(`phase-${phase.key}-up`);
                    }}
                  >
                    Up
                  </button>
                  <button
                    id={`phase-${phase.key}-down`}
                    type="button"
                    className="button button-small"
                    aria-disabled={i === phases.length - 1 ? true : undefined}
                    aria-label={`Move phase ${i + 1} down`}
                    onClick={() => {
                      if (i === phases.length - 1) return;
                      move(i, 1);
                      focusSoon(`phase-${phase.key}-down`);
                    }}
                  >
                    Down
                  </button>
                  <button
                    id={`phase-${phase.key}-remove`}
                    type="button"
                    className="button button-quiet button-small"
                    aria-disabled={phases.length <= 1 ? true : undefined}
                    aria-label={`Remove phase ${i + 1}`}
                    onClick={() => {
                      if (phases.length <= 1) return;
                      const neighbour = phases[i + 1] ?? phases[i - 1];
                      set({ phases: phases.filter((_, k) => k !== i) });
                      focusSoon(
                        neighbour ? [`phase-${neighbour.key}-remove`, 'phase-add'] : 'phase-add',
                      );
                    }}
                  >
                    Remove
                  </button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      {errors['machine.profile'] && <p className="field-error">{errors['machine.profile']}</p>}
      <button
        id="phase-add"
        type="button"
        className="button button-small"
        onClick={() =>
          set({ phases: [...phases, phaseForm({ control: 'pressure', target: '9' })] })
        }
      >
        Add a phase
      </button>
    </div>
  );
}

function PumpEditor({
  machine,
  set,
  preset,
  catalog,
}: {
  machine: Machine;
  set: (p: Partial<Machine>) => void;
  preset: MachinePreset | undefined;
  catalog: Catalog;
}) {
  const { errors } = useEditorContext();
  const presetPump = preset?.pump;
  // Empty fields take the preset pump's value when it is of the same type, else
  // the registry default (crates/puckmodel/src/models/machine.rs).
  const sameType = presetPump?.type === machine.pumpMode ? presetPump : undefined;
  const placeholder = (field: string, registryId: string) => {
    const fromPreset = (sameType as Record<string, unknown> | undefined)?.[field];
    if (typeof fromPreset === 'number') return `${fromPreset} from the preset`;
    const d = registryDefault(catalog, registryId);
    return d !== undefined ? `${d} (registry default)` : undefined;
  };
  const opvPlaceholder =
    sameType?.type === 'vibratory'
      ? typeof sameType.opv_bar === 'number'
        ? `${sameType.opv_bar} from the preset`
        : 'none (the preset has no valve)'
      : 'none (no valve)';
  const hint = sameType
    ? 'Empty fields take the preset pump’s values.'
    : presetPump
      ? 'Empty fields take the registry defaults (the preset’s pump is of another type).'
      : 'Empty fields take the registry defaults.';
  // With a preset valve, an empty field keeps it; one at or above the stall
  // pressure never opens.
  const opvHint =
    sameType?.type === 'vibratory' && typeof sameType.opv_bar === 'number'
      ? 'Empty keeps the preset’s valve. A value at or above the stall pressure never opens, as if there were no valve.'
      : 'Leave empty for a machine without an over-pressure valve.';
  return (
    <>
      <RadioGroup<PumpMode>
        name="machine.pump.mode"
        legend="Pump"
        value={machine.pumpMode}
        onChange={(pumpMode) => set(changePumpMode(machine, pumpMode, presetPump))}
        options={[
          {
            value: 'preset',
            label: presetPump
              ? `The preset's (${presetPump.type})`
              : 'Default (an ideal pump that follows the program)',
          },
          { value: 'ideal', label: 'Ideal (profiling)' },
          { value: 'vibratory', label: 'Vibratory' },
        ]}
        term={machine.pumpMode === 'vibratory' ? 'vibratory' : 'ideal'}
      />
      {machine.pumpMode === 'ideal' && (
        <div className="field-grid">
          <TextField
            path="machine.pump.max_flow_ml_s"
            label={labelWithUnit(FIELDS['machine.pump.max_flow_ml_s'])}
            value={machine.max_flow_ml_s}
            onChange={(max_flow_ml_s) => set({ max_flow_ml_s })}
            placeholder={placeholder('max_flow_ml_s', 'model.machine.ideal_max_flow')}
            error={errors['machine.pump.max_flow_ml_s']}
            hint={hint}
          />
          <TextField
            path="machine.pump.max_pressure_bar"
            label={labelWithUnit(FIELDS['machine.pump.max_pressure_bar'])}
            value={machine.max_pressure_bar}
            onChange={(max_pressure_bar) => set({ max_pressure_bar })}
            placeholder={placeholder('max_pressure_bar', 'model.machine.ideal_max_pressure')}
            error={errors['machine.pump.max_pressure_bar']}
          />
        </div>
      )}
      {machine.pumpMode === 'vibratory' && (
        <div className="field-grid">
          <TextField
            path="machine.pump.free_flow_ml_s"
            label={labelWithUnit(FIELDS['machine.pump.free_flow_ml_s'])}
            term="vibratory"
            value={machine.free_flow_ml_s}
            onChange={(free_flow_ml_s) => set({ free_flow_ml_s })}
            placeholder={placeholder('free_flow_ml_s', 'model.machine.vibratory_free_flow')}
            error={errors['machine.pump.free_flow_ml_s']}
            hint={hint}
          />
          <TextField
            path="machine.pump.stall_pressure_bar"
            label={labelWithUnit(FIELDS['machine.pump.stall_pressure_bar'])}
            value={machine.stall_pressure_bar}
            onChange={(stall_pressure_bar) => set({ stall_pressure_bar })}
            placeholder={placeholder(
              'stall_pressure_bar',
              'model.machine.vibratory_stall_pressure',
            )}
            error={errors['machine.pump.stall_pressure_bar']}
          />
          <TextField
            path="machine.pump.opv_bar"
            label={labelWithUnit(FIELDS['machine.pump.opv_bar'])}
            term="opv"
            value={machine.opv_bar}
            onChange={(opv_bar) => set({ opv_bar })}
            placeholder={opvPlaceholder}
            error={errors['machine.pump.opv_bar']}
            hint={opvHint}
          />
        </div>
      )}
    </>
  );
}

/**
 * Venting after the shot: a checkbox whose default is the preset's value. Your
 * choice is kept only while it differs from the preset, so another preset
 * brings its own default.
 */
function VentField({
  machine,
  set,
  presetVent,
}: {
  machine: Machine;
  set: (p: Partial<Machine>) => void;
  presetVent: boolean | undefined;
}) {
  const fromPreset = presetVent === true;
  const checked = machine.vent_headspace === '' ? fromPreset : machine.vent_headspace === 'yes';
  return (
    <CheckField
      path="machine.vent_headspace"
      label="Vents the group after the shot (three-way valve)"
      term="vent"
      checked={checked}
      onChange={(on) => set({ vent_headspace: on === fromPreset ? '' : on ? 'yes' : 'no' })}
      hint={`No drip after the stop. ${
        presetVent === undefined
          ? 'The preset does not say; unticked means no valve.'
          : `From the preset: ${fromPreset ? 'yes' : 'no'}.`
      }`}
    />
  );
}

export function MachineSection() {
  const { catalog, errors, notes, notesStale } = useEditorContext();
  const machine = useShotStore((s) => s.form.machine);
  const patch = useShotStore((s) => s.patchForm);
  const set = (p: Partial<Machine>) => patch('machine', p);
  const loadForm = useShotStore((s) => s.loadForm);
  const undo = useShotStore((s) => s.undo);
  const undoLast = useShotStore((s) => s.undoLast);
  const preset = findPreset(catalog.presets.machines, machine.preset);
  const custom = machine.customProgram || !preset;
  const choosePreset = (id: string) => {
    const { machine: next, discarded } = changeMachinePreset(machine, id);
    if (discarded) {
      // The custom program or pump belonged to the old machine: keep an undo.
      loadForm({ ...useShotStore.getState().form, machine: next }, MACHINE_UNDO);
    } else set(next);
  };
  const temperatureDefault = registryDefault(catalog, 'shot.temperature');
  const headspaceDefault = registryDefault(catalog, 'model.machine.group_headspace');
  const range = preset?.temperature_range_c;

  return (
    <>
      <SelectField
        path="machine.preset"
        label="Machine preset"
        value={machine.preset}
        onChange={choosePreset}
        options={[
          { value: '', label: 'None: describe the program and pump here' },
          ...presetOptions(catalog.presets.machines),
        ]}
        error={errors['machine.preset']}
      />
      {undo?.label === MACHINE_UNDO && (
        <p className="build-notes" role="status">
          The program and the pump now follow the {preset?.name ?? 'new'} preset.{' '}
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              undoLast();
              focusSoon(fieldId('machine.preset'));
            }}
          >
            {MACHINE_UNDO}
          </button>
        </p>
      )}
      <PresetInfo preset={preset} />
      <div className="field-grid">
        <TextField
          path="machine.temperature_c"
          label={labelWithUnit(FIELDS['machine.temperature_c'])}
          value={machine.temperature_c}
          onChange={(temperature_c) => set({ temperature_c })}
          placeholder={
            preset?.temperature_c !== undefined
              ? `${preset.temperature_c} from the preset`
              : temperatureDefault !== undefined
                ? `${temperatureDefault} (registry default)`
                : undefined
          }
          error={errors['machine.temperature_c']}
          hint={range ? `This machine: ${range[0]}–${range[1]} °C.` : undefined}
        />
        <TextField
          path="machine.headspace_ml"
          label={labelWithUnit(FIELDS['machine.headspace_ml'])}
          term="headspace"
          value={machine.headspace_ml}
          onChange={(headspace_ml) => set({ headspace_ml })}
          placeholder={
            preset?.headspace_ml !== undefined
              ? `${preset.headspace_ml} from the preset`
              : headspaceDefault !== undefined
                ? `${headspaceDefault} (registry default)`
                : undefined
          }
          error={errors['machine.headspace_ml']}
          hint="Between the basket rim and the shower screen."
        />
      </div>
      <VentField machine={machine} set={set} presetVent={preset?.vent_headspace} />

      <h3 className="subheading">Program</h3>
      {preset && (
        <div className="field field-check">
          <div className="field-head">
            <input
              id={fieldId('machine.customProgram')}
              type="checkbox"
              checked={machine.customProgram}
              onChange={(event) => {
                const on = event.target.checked;
                // Start a custom program from the preset's, so it can be edited.
                set(
                  on && !machine.customProgram
                    ? { customProgram: true, phases: preset.program.map(phaseFromPreset) }
                    : { customProgram: on },
                );
              }}
            />
            <label htmlFor={fieldId('machine.customProgram')}>
              Use my own program (starts as a copy of the preset’s)
            </label>
          </div>
        </div>
      )}
      {custom ? (
        <ProgramEditor machine={machine} set={set} />
      ) : (
        <ol className="program-summary">
          {preset?.program.map((phase, i) => (
            <li key={i}>{describePhase(phase)}</li>
          ))}
        </ol>
      )}
      <h3 className="subheading">Pump</h3>
      <PumpEditor machine={machine} set={set} preset={preset} catalog={catalog} />
      {errors.machine && <p className="field-error">{errors.machine}</p>}
      <BuildNotes notes={notes.machine} stale={notesStale} />
    </>
  );
}
