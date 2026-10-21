// SPDX-License-Identifier: GPL-2.0-or-later
/** A searchable inventory of known facts and the values equipment inference may explore. */
import { useEffect, useId, useRef, useState } from 'react';
import type { SetupConstraint, SetupParameter, SetupValue } from './inferenceTypes';
import {
  constraintForMode,
  setupValueText,
  updateSetupConstraint,
  useSetupConstraints,
} from './ConstraintContext';
import './ConstraintEditor.css';

const PAGE_SIZE = 18;

function ConstraintNumber({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        step="any"
        value={value === undefined || !Number.isFinite(value) ? '' : value}
        aria-invalid={
          required && (value === undefined || !Number.isFinite(value)) ? true : undefined
        }
        onChange={(event) => {
          const number = event.target.valueAsNumber;
          onChange(Number.isFinite(number) ? number : undefined);
        }}
      />
    </div>
  );
}

function constraintIssue(parameter: SetupParameter, constraint?: SetupConstraint): string | null {
  if (!constraint) return null;
  if (!parameter.modeled)
    return parameter.reason ?? 'This setting is inactive in the current recipe.';
  if (
    constraint.mode === 'unknown' &&
    parameter.kind === 'number' &&
    (parameter.min === undefined ||
      parameter.max === undefined ||
      !Number.isFinite(parameter.min) ||
      !Number.isFinite(parameter.max))
  )
    return 'This parameter has no finite default search range. Choose Known range and supply both bounds.';
  if (constraint.mode === 'locked') {
    if (constraint.value === undefined) return 'Enter the exact known value.';
    if (parameter.kind === 'number') {
      if (typeof constraint.value !== 'number' || !Number.isFinite(constraint.value)) {
        return 'Enter a finite number.';
      }
      if (
        (parameter.min !== undefined && constraint.value < parameter.min) ||
        (parameter.max !== undefined && constraint.value > parameter.max)
      )
        return 'The locked value is outside this parameter’s supported bounds.';
    } else if (parameter.choices && !parameter.choices.includes(constraint.value)) {
      return 'Choose a supported value for this setting.';
    }
    return null;
  }
  if (constraint.mode === 'range') {
    if (parameter.kind !== 'number') {
      return constraint.choices?.length ? null : 'Select at least one allowed choice.';
    }
    if (
      constraint.min === undefined ||
      constraint.max === undefined ||
      !Number.isFinite(constraint.min) ||
      !Number.isFinite(constraint.max)
    )
      return 'Enter a finite lower and upper bound.';
    if (constraint.min > constraint.max) return 'The lower bound must not exceed the upper bound.';
    if (
      (parameter.min !== undefined && constraint.min < parameter.min) ||
      (parameter.max !== undefined && constraint.max > parameter.max)
    )
      return 'Keep the range within this parameter’s supported bounds.';
    if (
      constraint.step !== undefined &&
      (!Number.isFinite(constraint.step) || constraint.step <= 0)
    ) {
      return 'The step must be positive, or leave it empty for a continuous value.';
    }
  }
  return null;
}

function ParameterConstraint({
  parameter,
  constraint,
  onChange,
  onReveal,
}: {
  parameter: SetupParameter;
  constraint?: SetupConstraint;
  onChange: (constraint: SetupConstraint | null) => void;
  onReveal?: (path: string) => void;
}) {
  const id = useId();
  const issue = constraintIssue(parameter, constraint);
  const unit = parameter.unit ? ` (${parameter.unit})` : '';
  const choices = parameter.choices ?? (parameter.kind === 'boolean' ? [false, true] : []);
  const setValue = (value: SetupValue | undefined) =>
    onChange({ path: parameter.path, mode: 'locked', value });
  const patch = (patchValue: Partial<SetupConstraint>) => {
    if (constraint) onChange({ ...constraint, ...patchValue });
  };
  return (
    <section className="constraint-card" aria-labelledby={`${id}-heading`}>
      <div className="constraint-card-heading">
        <h4 id={`${id}-heading`}>
          {parameter.label}
          {unit}
        </h4>
        <span className={`constraint-badge constraint-badge-${constraint?.mode ?? 'assumed'}`}>
          {constraint?.mode === 'locked'
            ? 'Known / locked'
            : constraint?.mode === 'range'
              ? 'Bounded search'
              : constraint?.mode === 'unknown'
                ? 'Unknown'
                : 'Assumption'}
        </span>
      </div>
      <p className="note">Current setting: {setupValueText(parameter.value, parameter.unit)}</p>
      {parameter.reason && <p className="note">{parameter.reason}</p>}
      <div className="field">
        <label htmlFor={`${id}-mode`}>What is known about {parameter.label}?</label>
        <select
          id={`${id}-mode`}
          value={constraint?.mode ?? 'assumed'}
          disabled={!parameter.modeled}
          onChange={(event) =>
            onChange(
              event.target.value === 'assumed'
                ? null
                : constraintForMode(parameter, event.target.value as SetupConstraint['mode']),
            )
          }
        >
          <option value="assumed">Assumed — keep current value</option>
          <option value="locked">Known — lock exactly</option>
          <option value="range">
            {parameter.kind === 'number' ? 'Known range' : 'Allowed choices'}
          </option>
          <option value="unknown">Unknown — find a value</option>
        </select>
      </div>
      {constraint?.mode === 'locked' && parameter.kind === 'number' && (
        <ConstraintNumber
          label={`Locked ${parameter.label}${unit}`}
          value={typeof constraint.value === 'number' ? constraint.value : undefined}
          onChange={setValue}
          required
        />
      )}
      {constraint?.mode === 'locked' && parameter.kind !== 'number' && (
        <div className="field">
          <label htmlFor={`${id}-value`}>Locked {parameter.label}</label>
          <select
            id={`${id}-value`}
            value={choices.findIndex((value) => value === constraint.value)}
            onChange={(event) => setValue(choices[Number(event.target.value)])}
          >
            <option value={-1} disabled>
              Select a known value
            </option>
            {choices.map((value, index) => (
              <option key={index} value={index}>
                {setupValueText(value)}
              </option>
            ))}
          </select>
        </div>
      )}
      {constraint?.mode === 'range' && parameter.kind === 'number' && (
        <div className="constraint-range">
          <ConstraintNumber
            label={`Minimum ${parameter.label}${unit}`}
            value={constraint.min}
            onChange={(min) => patch({ min })}
            required
          />
          <ConstraintNumber
            label={`Maximum ${parameter.label}${unit}`}
            value={constraint.max}
            onChange={(max) => patch({ max })}
            required
          />
          <ConstraintNumber
            label={`Step for ${parameter.label} (optional)`}
            value={constraint.step}
            onChange={(step) => patch({ step })}
          />
        </div>
      )}
      {constraint?.mode === 'range' && parameter.kind !== 'number' && (
        <fieldset className="constraint-choices">
          <legend>Allowed {parameter.label} choices</legend>
          {choices.map((value, index) => (
            <label key={index}>
              <input
                type="checkbox"
                checked={constraint.choices?.includes(value) ?? false}
                onChange={(event) =>
                  patch({
                    choices: event.target.checked
                      ? [...(constraint.choices ?? []), value]
                      : (constraint.choices?.filter((choice) => choice !== value) ?? []),
                  })
                }
              />
              {setupValueText(value)}
            </label>
          ))}
        </fieldset>
      )}
      {parameter.kind === 'number' && parameter.modeled && (
        <p className="note">
          Supported bounds: {setupValueText(parameter.min)} to{' '}
          {setupValueText(parameter.max, parameter.unit)}.
          {constraint?.mode === 'unknown' ? ' The search may explore this entire range.' : ''}
        </p>
      )}
      {constraint?.mode === 'unknown' && parameter.kind !== 'number' && (
        <p className="note">
          Search choices: {choices.map((value) => setupValueText(value)).join(', ')}.
        </p>
      )}
      {constraint?.mode === 'locked' && constraint.value !== parameter.value && (
        <p className="note">
          The solver will use this locked value instead of the current editor value.
        </p>
      )}
      {issue && (
        <p className="field-error" role="status">
          {issue}
        </p>
      )}
      <div className="constraint-card-actions">
        {onReveal && (
          <button
            type="button"
            className="button button-small button-quiet"
            onClick={() => onReveal(parameter.path)}
          >
            Show setting in equipment editor
          </button>
        )}
        {constraint && (
          <button
            type="button"
            className="button button-small button-quiet"
            aria-label={`Use as an assumption: ${parameter.label}`}
            onClick={() => onChange(null)}
          >
            Use as an assumption
          </button>
        )}
      </div>
    </section>
  );
}

export function ConstraintEditor({
  parameters,
  constraints,
  onChange,
  onReveal,
}: {
  parameters: readonly SetupParameter[];
  constraints: readonly SetupConstraint[];
  onChange: (constraints: SetupConstraint[]) => void;
  onReveal?: (path: string) => void;
}) {
  const id = useId();
  const context = useSetupConstraints();
  const requested = context?.request;
  const requestedParameter = parameters.find((parameter) => parameter.path === requested?.path);
  const requestedRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [filter, setFilter] = useState('selected');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [lastAction, setLastAction] = useState('');
  useEffect(() => {
    if (requested) requestedRef.current?.focus();
  }, [requested]);
  const byPath = new Map(constraints.map((constraint) => [constraint.path, constraint]));
  const knownCount = constraints.filter((constraint) => constraint.mode === 'locked').length;
  const varyingCount = constraints.length - knownCount;
  const stale = constraints.filter(
    (constraint) => !parameters.some((parameter) => parameter.path === constraint.path),
  );
  const selected = parameters.filter((parameter) => byPath.has(parameter.path));
  const baseList = filter === 'selected' && selected.length > 0 ? selected : parameters;
  const matching = baseList.filter(
    (parameter) =>
      parameter.path !== requestedParameter?.path &&
      (group === 'all' || parameter.group === group) &&
      (!query.trim() ||
        `${parameter.label} ${parameter.path} ${parameter.group}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())) &&
      (filter !== 'search' ||
        (byPath.has(parameter.path) && byPath.get(parameter.path)?.mode !== 'locked')),
  );
  const sorted = [...matching].sort(
    (a, b) => Number(byPath.has(b.path)) - Number(byPath.has(a.path)),
  );
  const changeOne = (path: string, constraint: SetupConstraint | null) => {
    onChange(updateSetupConstraint(constraints, path, constraint));
  };
  return (
    <section className="constraint-editor" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>What do you know about your equipment?</h3>
      <p className="note">
        Lock facts you know, set a range or allowed choices, and mark the remaining values you want
        the solver to find as unknown. Settings left as assumptions stay fixed during this search;
        they are not confirmed facts.
      </p>
      <p className="constraint-summary" aria-live="polite">
        {knownCount} locked · {varyingCount} to find ·{' '}
        {parameters.filter((parameter) => parameter.modeled && !byPath.has(parameter.path)).length}{' '}
        fixed assumptions
      </p>
      <div className="constraint-toolbar">
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            const locks = parameters
              .filter((parameter) => parameter.modeled && parameter.value !== undefined)
              .map((parameter) => constraintForMode(parameter, 'locked'));
            onChange(locks);
            setLastAction(
              `Locked ${locks.length} current physical settings. Unlock any settings you want to infer.`,
            );
          }}
        >
          Lock all current physical settings
        </button>
        <button
          type="button"
          className="button button-small button-quiet"
          disabled={constraints.length === 0}
          onClick={() => {
            onChange([]);
            setLastAction('All settings are fixed assumptions again.');
          }}
        >
          Clear locks and search choices
        </button>
      </div>
      {lastAction && (
        <p role="status" className="note">
          {lastAction}
        </p>
      )}
      {stale.length > 0 && (
        <div className="run-error">
          <p>
            These constraints are no longer available for the current equipment. Remove them or
            restore the matching equipment before searching.
          </p>
          {stale.map((constraint) => (
            <p key={constraint.path}>
              <code>{constraint.path}</code>{' '}
              <button
                type="button"
                className="button button-small"
                onClick={() => changeOne(constraint.path, null)}
                aria-label={`Remove unavailable constraint ${constraint.path}`}
              >
                Remove
              </button>
            </p>
          ))}
        </div>
      )}
      {requestedParameter && (
        <div
          className="constraint-requested"
          tabIndex={-1}
          ref={requestedRef}
          aria-label={`Constraint for ${requestedParameter.label}`}
        >
          <ParameterConstraint
            parameter={requestedParameter}
            constraint={byPath.get(requestedParameter.path)}
            onChange={(constraint) => changeOne(requestedParameter.path, constraint)}
            onReveal={onReveal}
          />
        </div>
      )}
      <div className="constraint-filters">
        <div className="field">
          <label htmlFor={`${id}-search`}>Find an equipment parameter</label>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            placeholder="e.g. WDT, temperature, permeability"
            onChange={(event) => {
              setQuery(event.target.value);
              setFilter('all');
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-group`}>Parameter group</label>
          <select
            id={`${id}-group`}
            value={group}
            onChange={(event) => {
              setGroup(event.target.value);
              setFilter('all');
              setLimit(PAGE_SIZE);
            }}
          >
            <option value="all">All equipment and model groups</option>
            {[...new Set(parameters.map((parameter) => parameter.group))].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-filter`}>Show parameters</label>
          <select
            id={`${id}-filter`}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          >
            <option value="selected">
              My locks and search choices{selected.length === 0 ? ' (none yet — showing all)' : ''}
            </option>
            <option value="search">Values to find</option>
            <option value="all">All parameters, including assumptions</option>
          </select>
        </div>
      </div>
      <p className="note">
        {Math.min(limit, sorted.length)} of {sorted.length} matching parameters shown. Numerical
        accuracy controls are managed by the solver.
      </p>
      <div className="constraint-list">
        {sorted.slice(0, limit).map((parameter) => (
          <ParameterConstraint
            key={parameter.path}
            parameter={parameter}
            constraint={byPath.get(parameter.path)}
            onChange={(constraint) => changeOne(parameter.path, constraint)}
            onReveal={onReveal}
          />
        ))}
      </div>
      {sorted.length === 0 && <p className="note">No parameters match these filters.</p>}
      {sorted.length > limit && (
        <button
          type="button"
          className="button"
          onClick={() => setLimit((value) => value + PAGE_SIZE)}
        >
          Show more parameters
        </button>
      )}
    </section>
  );
}
