// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Sandbox overrides: a searchable browser of the parameter registry (id,
 * value, unit, range, tag, grade, source) where any parameter can be given
 * your own value (`recipe.overrides`). Overridden parameters are marked and
 * can be reset one by one or all at once.
 */
import { useDeferredValue, useMemo, useState } from 'react';
import type { RegistryParameter } from '../../engine/shotTypes';
import { fieldId, TextField, useHelp } from '../fields';
import { focusSoon } from '../focus';
import { registryUnit, sig } from '../format';
import { BuildNotes } from '../PresetInfo';
import { registryIdsUsed } from '../provenance';
import { EvidenceBadges, parameterValue, SourceList } from '../RegistryBits';
import { useShotStore } from '../shotStore';
import { useEditorContext } from './context';

const PAGE = 25;

function rangeText(p: RegistryParameter): string {
  const unit = registryUnit(p.units);
  const lo = p.range.min !== undefined ? sig(p.range.min, 4) : '−∞';
  const hi = p.range.max !== undefined ? sig(p.range.max, 4) : '∞';
  return `${lo} to ${hi}${unit ? ` ${unit}` : ''}`;
}

function matches(p: RegistryParameter, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [p.id, p.name, p.description, p.symbol ?? ''].some((s) => s.toLowerCase().includes(q));
}

function ParameterCard({ p, value }: { p: RegistryParameter; value: string | undefined }) {
  const { errors } = useEditorContext();
  const setOverride = useShotStore((s) => s.setOverride);
  const path = `overrides.${p.id}`;
  const unit = registryUnit(p.units);
  const overridden = value !== undefined && value.trim() !== '';
  const headingId = `${fieldId(path)}-name`;
  return (
    <li className={`param-card${overridden ? ' param-card-overridden' : ''}`}>
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className="param-name">
          {p.name}
          {p.symbol ? ` (${p.symbol})` : ''}
          {overridden && <span className="badge badge-caution">Overridden</span>}
        </h3>
        <p className="param-meta">
          <code>{p.id}</code> · {parameterValue(p)} · range {rangeText(p)} ·{' '}
          <EvidenceBadges p={p} />
        </p>
        <p className="note">{p.description}</p>
        <details className="param-sources">
          <summary>
            Source{p.sources.length === 1 ? '' : 's'} ({p.sources.length})
          </summary>
          <SourceList sources={p.sources} />
          {p.licence_note && <p className="note">Licence: {p.licence_note}</p>}
        </details>
        <div className="param-override">
          <TextField
            path={path}
            label={`Override ${p.name}${unit ? ` (${unit})` : ''}`}
            value={value ?? ''}
            onChange={(text) => setOverride(p.id, text)}
            placeholder={sig(p.default, 6)}
            error={errors[path]}
          />
          {overridden && (
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setOverride(p.id, null);
                focusSoon(fieldId(path)); // the button goes; the field stays
              }}
              aria-label={`Reset ${p.name} to its default`}
            >
              Reset
            </button>
          )}
        </div>
      </section>
    </li>
  );
}

export function OverridesSection() {
  const { catalog, notes, notesStale, build } = useEditorContext();
  const { errors } = useEditorContext();
  const overrides = useShotStore((s) => s.form.overrides);
  const setOverride = useShotStore((s) => s.setOverride);
  const clearOverrides = useShotStore((s) => s.clearOverrides);
  const reveal = useShotStore((s) => s.reveal);
  const parameters = catalog.registry.parameters;
  const known = useMemo(() => new Set(parameters.map((p) => p.id)), [parameters]);
  /** The known registry id a reveal request points at, if any. */
  const revealedId = (r: typeof reveal) => {
    const id = r?.path.startsWith('overrides.') ? r.path.slice('overrides.'.length) : null;
    return id !== null && known.has(id) ? id : null;
  };
  // A field to reveal: show its card whatever the filters say.
  const [query, setQuery] = useState(() => revealedId(reveal) ?? '');
  const [usedOnly, setUsedOnly] = useState(() => revealedId(reveal) === null);
  const [seenReveal, setSeenReveal] = useState(reveal?.nonce ?? 0);
  if (reveal && reveal.nonce !== seenReveal) {
    setSeenReveal(reveal.nonce);
    const id = revealedId(reveal);
    if (id !== null) {
      setQuery(id);
      setUsedOnly(false);
    }
  }
  const [limit, setLimit] = useState(PAGE);
  const deferredQuery = useDeferredValue(query.trim());
  const help = useHelp('overrides-help', 'overrides');
  const used = useMemo(() => registryIdsUsed(build?.derived.provenance), [build]);
  const active = parameters.filter((p) => (overrides[p.id] ?? '').trim() !== '');
  // Overrides of ids this registry lacks (an old file or draft): listed so they can be removed.
  const unknown = Object.keys(overrides).filter((id) => !known.has(id));
  const resetOne = (id: string, index: number, ids: readonly string[]) => {
    setOverride(id, null);
    const next = ids[index + 1] ?? ids[index - 1];
    focusSoon(next ? [`override-reset-${next}`, 'registry-search'] : 'registry-search');
  };
  const list = useMemo(
    () =>
      parameters.filter(
        (p) =>
          matches(p, deferredQuery) &&
          (!usedOnly || used.size === 0 || used.has(p.id) || (overrides[p.id] ?? '') !== ''),
      ),
    [parameters, deferredQuery, usedOnly, used, overrides],
  );
  const shown = list.slice(0, limit);

  return (
    <>
      <div className="field-head">
        <p className="section-intro">
          Every number the models use comes from the parameter registry, with its source, evidence
          grade and tag. Give any of them your own value to see what it changes.
        </p>
        {help.button}
      </div>
      {help.text}
      {unknown.length > 0 && (
        <div className="run-error" role="group" aria-label="Overrides of unknown parameters">
          <p className="build-notes-title">
            Overrides of parameters this version’s registry does not have (remove them to run):
          </p>
          <ul>
            {unknown.map((id, i) => (
              <li key={id}>
                <code>{id}</code> = {overrides[id]}{' '}
                <button
                  id={`override-reset-${id}`}
                  type="button"
                  className="button button-small"
                  onClick={() => resetOne(id, i, unknown)}
                  aria-label={`Remove the override of ${id}`}
                >
                  Remove
                </button>
                {errors[`overrides.${id}`] && (
                  <span className="field-error"> {errors[`overrides.${id}`]}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {active.length > 0 && (
        <div className="active-overrides">
          <p className="build-notes-title">Your overrides:</p>
          <ul>
            {active.map((p, i) => (
              <li key={p.id}>
                <code>{p.id}</code> = {overrides[p.id]} {registryUnit(p.units)}{' '}
                <button
                  id={`override-reset-${p.id}`}
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() =>
                    resetOne(
                      p.id,
                      i,
                      active.map((a) => a.id),
                    )
                  }
                  aria-label={`Reset ${p.name}`}
                >
                  Reset
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              clearOverrides();
              focusSoon('registry-search');
            }}
          >
            Reset all overrides
          </button>
        </div>
      )}
      <div className="field">
        <label htmlFor="registry-search">Search the registry</label>
        <input
          id="registry-search"
          type="search"
          autoComplete="off"
          value={query}
          placeholder="e.g. permeability, porosity, caffeine"
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(PAGE);
          }}
          // Enter searches; it must not submit (run) the recipe form around it.
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
      </div>
      <div className="field field-check">
        <div className="field-head">
          <input
            id="registry-used-only"
            type="checkbox"
            checked={usedOnly}
            onChange={(event) => setUsedOnly(event.target.checked)}
          />
          <label htmlFor="registry-used-only">Only parameters this recipe uses</label>
        </div>
      </div>
      <p className="note" aria-live="polite">
        {list.length} of {parameters.length} parameters
        {usedOnly && used.size > 0 ? ' used by the last build' : ''}
        {deferredQuery ? ` matching “${deferredQuery}”` : ''}.
      </p>
      <ul className="param-list">
        {shown.map((p) => (
          <ParameterCard key={p.id} p={p} value={overrides[p.id]} />
        ))}
      </ul>
      {list.length > shown.length && (
        <button
          type="button"
          className="button button-small"
          onClick={() => setLimit(limit + PAGE)}
        >
          Show {Math.min(PAGE, list.length - shown.length)} more
        </button>
      )}
      <BuildNotes notes={notes.overrides} stale={notesStale} />
    </>
  );
}
