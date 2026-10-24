// SPDX-License-Identifier: GPL-2.0-or-later
/** Optional setup controls shared by the illustrated and full recipe editors. */
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import type { SetupConstraint, SetupParameter, SetupValue } from './inferenceTypes';
import './ConstraintEditor.css';
import { roastAssumptionName } from '../coffee/roast';
import { useShotStore } from '../shot/shotStore';
import { useEquipmentStore } from './inferenceStorage';

export function setupValueText(value: SetupValue | undefined, unit = '', path = ''): string {
  if (value === undefined) return 'Not specified';
  if (path.endsWith('.roast_level') && typeof value === 'number')
    return `${roastAssumptionName(value)} (estimate)`;
  if (path.endsWith('.arabica_fraction') && typeof value === 'number')
    return value === 1
      ? 'Arabica'
      : value === 0
        ? 'Robusta / Canephora'
        : `${Number((value * 100).toFixed(3))}% Arabica`;
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  return `${text}${unit ? ` ${unit}` : ''}`;
}

export function updateSetupConstraint(
  constraints: readonly SetupConstraint[],
  path: string,
  constraint: SetupConstraint | null,
): SetupConstraint[] {
  const others = constraints.filter((item) => item.path !== path);
  return constraint ? [...others, constraint] : others;
}

export function constraintForMode(
  parameter: SetupParameter,
  mode: SetupConstraint['mode'],
): SetupConstraint {
  if (mode === 'locked') return { path: parameter.path, mode, value: parameter.value };
  if (mode === 'unknown') return { path: parameter.path, mode };
  if (parameter.kind !== 'number') {
    return { path: parameter.path, mode, choices: [...(parameter.choices ?? [])] };
  }
  return {
    path: parameter.path,
    mode,
    min: parameter.min,
    max: parameter.max,
    ...(parameter.step === undefined ? {} : { step: parameter.step }),
  };
}

interface ConstraintContextValue {
  parameters: readonly SetupParameter[];
  constraints: readonly SetupConstraint[];
  onChange: (constraints: SetupConstraint[]) => void;
  request: { path: string; serial: number } | null;
  editConstraint: (path: string) => void;
}

const ConstraintContext = createContext<ConstraintContextValue | null>(null);

export function useSetupConstraints() {
  return useContext(ConstraintContext);
}

export function ConstraintContextProvider({
  parameters,
  constraints,
  onChange,
  children,
}: {
  parameters: readonly SetupParameter[];
  constraints: readonly SetupConstraint[];
  onChange: (constraints: SetupConstraint[]) => void;
  children: ReactNode;
}) {
  const [request, setRequest] = useState<ConstraintContextValue['request']>(null);
  return (
    <ConstraintContext.Provider
      value={{
        parameters,
        constraints,
        onChange: (next) => {
          onChange(next);
          useShotStore.setState({ undo: null });
        },
        request,
        editConstraint: (path) =>
          setRequest((previous) => ({ path, serial: (previous?.serial ?? 0) + 1 })),
      }}
    >
      {children}
    </ConstraintContext.Provider>
  );
}

/** Access current knowledge for a user-initiated structural edit, including in Lab.
 * Call before changing constraints, then install the paired form Undo afterward.
 */
export function equipmentKnowledge(
  context: ReturnType<typeof useSetupConstraints>,
): Pick<ConstraintContextValue, 'constraints' | 'onChange'> {
  if (context) return context;
  useEquipmentStore.getState().hydrate();
  return {
    constraints: structuredClone(useEquipmentStore.getState().document.constraints),
    onChange: (constraints) => {
      useEquipmentStore.getState().update((document) => ({ ...document, constraints }));
      useShotStore.setState({ undo: null });
    },
  };
}

/** Absent outside the setup screen; all existing Lab controls remain reusable. */
export function InlineConstraintControl({ path }: { path: string }) {
  const context = useSetupConstraints();
  const physicalPath = path.replace(/\.roast-description$/, '.roast_level');
  const id = useId();
  const parameter = context?.parameters.find((item) => item.path === physicalPath);
  if (!context || !parameter) return null;
  if (!parameter.modeled) {
    return (
      <p className="constraint-inline-note">{parameter.reason ?? 'Not inferred by this model.'}</p>
    );
  }
  const constraint = context.constraints.find((item) => item.path === physicalPath);
  const mode = constraint?.mode ?? 'assumed';
  const actionLabel =
    constraint?.mode === 'locked'
      ? `Locked: ${setupValueText(constraint.value, parameter.unit, parameter.path)}`
      : 'Edit search limits';
  return (
    <div className="constraint-inline">
      <label htmlFor={id}>Knowledge of {parameter.label}</label>
      <select
        id={id}
        value={mode}
        onChange={(event) => {
          const selected = event.target.value;
          context.onChange(
            updateSetupConstraint(
              context.constraints,
              physicalPath,
              selected === 'assumed'
                ? null
                : constraintForMode(parameter, selected as SetupConstraint['mode']),
            ),
          );
          if (selected === 'range') context.editConstraint(physicalPath);
        }}
      >
        <option value="assumed">Assumed — keep current value</option>
        <option value="locked" disabled={parameter.value === undefined}>
          Known — lock current value
        </option>
        <option value="range">
          {parameter.kind === 'number' ? 'Known range' : 'Allowed choices'}
        </option>
        <option value="unknown">Unknown — find a value</option>
      </select>
      {constraint && (
        <button
          type="button"
          className="button button-small button-quiet"
          onClick={() => context.editConstraint(physicalPath)}
          aria-label={`${actionLabel}. Edit constraint for ${parameter.label}`}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
