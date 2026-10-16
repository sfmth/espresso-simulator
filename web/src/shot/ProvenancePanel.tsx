// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Provenance of the built spec: every field the builder set, and where its
 * value came from (registry records with tag, grade and sources, presets,
 * your recipe, model rules); what the builder derived about the bean and the
 * bed; and the complete ShotSpec as JSON, to read or download.
 */
import { useDeferredValue, useMemo, useState } from 'react';
import type { Catalog, RegistryParameter } from '../engine/shotTypes';
import { datedName, downloadJson } from './download';
import { HelpHeading } from './fields';
import { fixed, percent, scientific, sig } from './format';
import { FlagBadges } from './PresetInfo';
import { parseProvenance } from './provenance';
import { TokenView } from './RegistryBits';
import type { ShotOutcome } from './shotStore';

export function ProvenancePanel({
  outcome,
  registry,
  catalog,
}: {
  outcome: ShotOutcome | null;
  registry: Map<string, RegistryParameter>;
  catalog: Catalog | null;
}) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const entries = useMemo(() => Object.entries(outcome?.build.derived.provenance ?? {}), [outcome]);
  const shown = entries.filter(
    ([path, value]) =>
      !deferred || path.toLowerCase().includes(deferred) || value.toLowerCase().includes(deferred),
  );
  const specJson = useMemo(
    () => (outcome ? JSON.stringify(outcome.build.spec, null, 2) : ''),
    [outcome],
  );
  if (!outcome) return <p className="note">The provenance appears after the first run.</p>;
  const { bean, bed, flags, presets } = outcome.build.derived;

  return (
    <div className="panel-stack">
      <HelpHeading id="provenance-title" term="provenance" level={4}>
        Where every number comes from
      </HelpHeading>
      {flags && flags.length > 0 && (
        <p className="badges">
          Presets used ({Object.values(presets ?? {}).join(', ')}): <FlagBadges flags={flags} />
        </p>
      )}
      {(bean || bed) && (
        <dl className="derived-list">
          {bean && (
            <>
              <dt>Bean as modelled</dt>
              <dd>
                {percent(bean.arabica_fraction, 0)} Arabica, roast {fixed(bean.roast_level, 2)} (
                {fixed(bean.roast_colorette_pt, 0)} Pt Colorette), {fixed(bean.days_off_roast, 0)}{' '}
                days off roast, beans at {fixed(bean.bean_temp_c, 1)} °C; CO₂{' '}
                {fixed(bean.co2_puck_mg_g, 2)} mg/g left in the puck.
              </dd>
            </>
          )}
          {bed && (
            <>
              <dt>Bed in the basket</dt>
              <dd>
                {fixed(bed.height_mm, 1)} mm tall, bulk density {fixed(bed.bulk_density_kg_m3, 0)}{' '}
                kg/m³, porosity {percent(bed.total_porosity)}, basket{' '}
                {fixed(bed.basket_volume_ml, 1)} mL, headspace {fixed(bed.headspace_ml, 1)} mL,
                Sauter diameter {sig(bed.sauter_diameter_um, 3)} µm, base permeability κ₀{' '}
                {scientific(bed.permeability_m2)} m².
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="field">
        <label htmlFor="provenance-search">Filter spec fields</label>
        <input
          id="provenance-search"
          type="search"
          autoComplete="off"
          value={query}
          placeholder="e.g. permeability, species, preset"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className="note" aria-live="polite">
        {shown.length} of {entries.length} spec fields.
      </p>
      <div className="table-wrap">
        <table className="provenance-table">
          <thead>
            <tr>
              <th scope="col">Spec field</th>
              <th scope="col">Comes from</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(([path, value]) => (
              <tr key={path}>
                <th scope="row">
                  <code>{path}</code>
                </th>
                <td>
                  <ul className="token-list">
                    {parseProvenance(value).map((token) => (
                      <li key={token.raw}>
                        <TokenView
                          token={token}
                          registry={registry}
                          catalog={catalog}
                          overrides={outcome.recipe.overrides}
                        />
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="spec-json">
        <summary>The built ShotSpec (JSON, SI units)</summary>
        <div className="actions">
          <button
            type="button"
            className="button button-small"
            onClick={() => downloadJson(datedName('spec', 'json'), outcome.build.spec)}
          >
            Download the spec
          </button>
        </div>
        <pre tabIndex={0} aria-label="The built ShotSpec as JSON">
          {specJson}
        </pre>
      </details>
    </div>
  );
}
