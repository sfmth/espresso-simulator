// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * What reached the cup, compound by compound: each tracked species' mass, the
 * share of its extractable content that left the puck, its content in the
 * dose, and where every number behind it comes from (registry records with
 * their tag, evidence grade and sources; presets; your recipe). Total
 * dissolved solids come first, from the same run.
 */
import { useState } from 'react';
import type {
  Catalog,
  CompoundMeta,
  RegistryParameter,
  SpeciesSpec,
  SpeciesTotal,
} from '../engine/shotTypes';
import { HelpHeading } from './fields';
import { grams, milligrams, percent, sig } from './format';
import { speciesName } from './format';
import { tokensFor, type ProvenanceToken } from './provenance';
import { EvidenceBadges, TokenView } from './RegistryBits';
import type { ShotOutcome } from './shotStore';

const PROPERTY_LABELS: Record<string, string> = {
  mass_fraction: 'Content in the beans',
  kernel_diffusivity_m2_s: 'Diffusivity in the particles',
  partition_coefficient: 'Partition coefficient',
  surface_fraction_scale: 'Fast surface pool',
  extractable_fraction: 'Extractable solubles (maximum EY)',
  kernel_diffusivity: 'Diffusivity in the particles',
  saturation_kg_m3: 'Saturation',
};

/** Keep trace aroma inventories visible instead of rounding every trace to 0 mg. */
function compoundMass(kg: number | null): string {
  if (kg === null) return '—';
  if (kg === 0 || Math.abs(kg) >= 1e-7) return milligrams(kg);
  return Math.abs(kg) >= 1e-10 ? `${sig(kg * 1e9)} µg` : `${sig(kg * 1e12)} ng`;
}

/** Broad browsing groups; preserve the catalogue's more specific family in each row. */
function compoundGroup(meta?: CompoundMeta): string {
  if (!meta) return 'Tracked species';
  if (meta.family.startsWith('odorant:')) return 'Aroma compounds';
  const groups: Record<string, string> = {
    alkaloid: 'Alkaloids',
    'chlorogenic acid': 'Chlorogenic acids and roast products',
    'bitter lactone': 'Chlorogenic acids and roast products',
    'retained bitter': 'Chlorogenic acids and roast products',
    'organic acid': 'Acids',
    'mineral acid': 'Acids',
    sugar: 'Other dissolved compounds',
    mineral: 'Other dissolved compounds',
    'browning polymer': 'Other dissolved compounds',
    carbohydrate: 'Other dissolved compounds',
    'bitter peptide': 'Other dissolved compounds',
    'bitter glycoside': 'Other dissolved compounds',
    'diagnostic aggregate': 'Diagnostics and unassigned solubles',
    'unresolved soluble inventory': 'Diagnostics and unassigned solubles',
    lipid: 'Lipids and diterpenes',
    diterpene: 'Lipids and diterpenes',
    gas: 'Gas inventory',
  };
  return groups[meta.family] ?? meta.family;
}

/** The weakest evidence among the registry records behind some tokens: "D" beats "A". */
function weakest(
  tokens: readonly ProvenanceToken[],
  registry: Map<string, RegistryParameter>,
): RegistryParameter | undefined {
  let worst: RegistryParameter | undefined;
  for (const t of tokens) {
    const p = registry.get(t.id);
    if (p && (!worst || p.evidence_grade > worst.evidence_grade)) worst = p;
  }
  return worst;
}

function ProvenanceCell({
  properties,
  outcome,
  registry,
  catalog,
}: {
  properties: { label: string; path: string }[];
  outcome: ShotOutcome;
  registry: Map<string, RegistryParameter>;
  catalog: Catalog | null;
}) {
  const provenance = outcome.build.derived.provenance;
  const all = properties.flatMap((p) => tokensFor(provenance, p.path));
  const registryTokens = all.filter((t) => registry.has(t.id));
  const worst = weakest(registryTokens, registry);
  return (
    <details className="provenance-cell">
      <summary>
        {worst ? (
          <>
            weakest: <EvidenceBadges p={worst} />
          </>
        ) : (
          'details'
        )}{' '}
        <span className="note">({registryTokens.length} records)</span>
      </summary>
      <dl className="provenance-list">
        {properties.map((p) => {
          const tokens = tokensFor(provenance, p.path);
          if (tokens.length === 0) return null;
          return (
            <div key={p.path}>
              <dt>{p.label}</dt>
              <dd>
                <ul>
                  {tokens.map((t) => (
                    <li key={t.raw}>
                      <TokenView
                        token={t}
                        registry={registry}
                        catalog={catalog}
                        overrides={outcome.recipe.overrides}
                      />
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}

function CompoundMetadata({
  meta,
  registry,
  catalog,
  outcome,
}: {
  meta: CompoundMeta;
  registry: Map<string, RegistryParameter>;
  catalog: Catalog | null;
  outcome: ShotOutcome;
}) {
  return (
    <details className="compound-metadata">
      <summary>Composition and transport evidence</summary>
      <dl className="provenance-list">
        <div>
          <dt>Transport</dt>
          <dd>{meta.transport_evidence}</dd>
        </div>
        <div>
          <dt>Composition</dt>
          <dd>{meta.composition_evidence}</dd>
        </div>
        <div>
          <dt>TDS accounting</dt>
          <dd>
            {meta.counts_toward_tds
              ? 'Dissolved species; compared with lumped coffee solubles.'
              : 'Separate phase or diagnostic; excluded from the dissolved-species total.'}
          </dd>
        </div>
      </dl>
      {meta.notes.length > 0 && (
        <ul>
          {meta.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {meta.registry_refs.length > 0 && (
        <ul>
          {meta.registry_refs.map((id) => (
            <li key={id}>
              <TokenView
                token={{ kind: 'registry', id, raw: `registry:${id}` }}
                registry={registry}
                catalog={catalog}
                overrides={outcome.recipe.overrides}
              />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function CompoundTable({
  outcome,
  registry,
  catalog,
}: {
  outcome: ShotOutcome | null;
  registry: Map<string, RegistryParameter>;
  catalog: Catalog | null;
}) {
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filteredExpansion, setFilteredExpansion] = useState<{
    key: string;
    groups: Record<string, boolean>;
  }>({ key: '', groups: {} });
  if (!outcome) return <p className="note">The compound table appears after the first run.</p>;
  const summary = outcome.result.summary;
  const spec = outcome.build.spec;
  const dose = spec.bed.dose_kg;
  const specIndex = new Map<string, [number, SpeciesSpec]>(
    spec.solubles.species.map((s, i) => [s.id, [i, s]]),
  );
  const solubles = summary.beverage_mass_kg * summary.tds;
  const extractable = spec.solubles.extractable_fraction;
  const metadata = new Map((outcome.build.derived.compounds ?? []).map((m) => [m.id, m]));
  const phaseIndex = new Map((outcome.result.chemistry?.phases ?? []).map((p) => [p.id, p]));
  const displayed: SpeciesTotal[] = [...summary.species];
  for (const phase of phaseIndex.values()) {
    if (!displayed.some((s) => s.id === phase.id))
      displayed.push({
        id: phase.id,
        mass_kg: phase.cup_mass_kg,
        extracted_fraction:
          phase.available_mass_kg > 0 ? phase.cup_mass_kg / phase.available_mass_kg : 0,
      });
  }
  const families = [...new Set(displayed.map((s) => compoundGroup(metadata.get(s.id))))];
  const activeFamily = families.includes(family) ? family : '';
  const search = query.trim().toLocaleLowerCase();
  const filtered = Boolean(search || activeFamily);
  const filterKey = JSON.stringify([search, activeFamily]);
  // A changed filter starts a fresh browsing context, even if the user later
  // returns to an earlier query without toggling any intervening groups.
  if (filteredExpansion.key !== filterKey) {
    setFilteredExpansion({ key: filterKey, groups: {} });
  }
  const visible = displayed.filter((s) => {
    const meta = metadata.get(s.id);
    return (
      (!activeFamily || compoundGroup(meta) === activeFamily) &&
      (!search ||
        [
          s.id,
          speciesName(s.id, outcome.build.derived.compounds),
          meta?.family,
          meta?.kinetic_class,
          meta?.phase,
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search))
    );
  });
  const speciesProps = (i: number) =>
    [
      'mass_fraction',
      'kernel_diffusivity_m2_s',
      'partition_coefficient',
      'surface_fraction_scale',
    ].map((key) => ({ label: PROPERTY_LABELS[key] ?? key, path: `solubles.species[${i}].${key}` }));
  const speciesRow = (s: SpeciesTotal) => {
    const entry = specIndex.get(s.id);
    const meta = metadata.get(s.id);
    const content = entry
      ? entry[1].mass_fraction * dose
      : (phaseIndex.get(s.id)?.available_mass_kg ?? null);
    return (
      <tr key={s.id} data-species={s.id}>
        <th scope="row">
          {speciesName(s.id, outcome.build.derived.compounds)}
          {meta && (
            <span className="compound-tags">
              <span className="badge">{meta.kinetic_class}</span>
              <span className="badge">{meta.phase}</span>
            </span>
          )}
          {meta && (
            <span className="note compound-family-label">Catalogue family: {meta.family}</span>
          )}
        </th>
        <td className="num" data-value={String(s.mass_kg)}>
          {compoundMass(s.mass_kg)}
        </td>
        <td className="num" data-value={String(s.extracted_fraction)}>
          {percent(s.extracted_fraction)}
        </td>
        <td className="num">{compoundMass(content)}</td>
        <td>
          {entry ? (
            <ProvenanceCell
              properties={speciesProps(entry[0])}
              outcome={outcome}
              registry={registry}
              catalog={catalog}
            />
          ) : (
            <span className="note">
              {phaseIndex.has(s.id)
                ? 'Separate phase inventory; recovery prior, not dissolved extraction.'
                : 'not in the spec'}
            </span>
          )}
          {meta && (
            <CompoundMetadata meta={meta} registry={registry} catalog={catalog} outcome={outcome} />
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="panel-stack">
      <HelpHeading id="compounds-title" term="provenance" level={4}>
        Compounds in the cup, with provenance
      </HelpHeading>
      <div className="compound-filters field-grid">
        <label className="field">
          Search compounds
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, family, K1–K6 or phase"
          />
        </label>
        <label className="field">
          Compound family
          <select value={activeFamily} onChange={(event) => setFamily(event.target.value)}>
            <option value="">All families</option>
            {families.map((name) => (
              <option key={name} value={name}>
                {name.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="note" role="status">
        {visible.length} of {displayed.length} tracked compounds. Open a family to inspect its
        species; searching opens matching families.
      </p>
      <div className="table-wrap">
        <table className="compound-table" aria-labelledby="compounds-title">
          <thead>
            <tr>
              <th scope="col">Compound</th>
              <th scope="col">In the cup</th>
              <th scope="col">Extracted / recovered</th>
              <th scope="col">Content in the dose</th>
              <th scope="col">Provenance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="compound-total">
              <th scope="row">Total dissolved solids</th>
              <td className="num">{grams(solubles, 2)}</td>
              <td>
                {percent(extractable > 0 ? summary.ey / extractable : null)}{' '}
                <span className="note">of extractable (EY {percent(summary.ey)})</span>
              </td>
              <td className="num">{grams(extractable * dose, 2)}</td>
              <td>
                <ProvenanceCell
                  properties={[
                    {
                      label: PROPERTY_LABELS.extractable_fraction,
                      path: 'solubles.extractable_fraction',
                    },
                    {
                      label: 'Diffusivity in the particles',
                      path: 'solubles.kernel_diffusivity_m2_s',
                    },
                    {
                      label: PROPERTY_LABELS.partition_coefficient,
                      path: 'solubles.partition_coefficient',
                    },
                    { label: PROPERTY_LABELS.saturation_kg_m3, path: 'solubles.saturation_kg_m3' },
                  ]}
                  outcome={outcome}
                  registry={registry}
                  catalog={catalog}
                />
              </td>
            </tr>
            {displayed.length <= 4 && visible.map(speciesRow)}
          </tbody>
          {displayed.length > 4 &&
            families.map((name) => {
              const rows = visible.filter((s) => compoundGroup(metadata.get(s.id)) === name);
              if (rows.length === 0) return null;
              const open = filtered
                ? ((filteredExpansion.key === filterKey
                    ? filteredExpansion.groups[name]
                    : undefined) ?? true)
                : Boolean(expanded[name]);
              return (
                <tbody key={name}>
                  <tr className="compound-family">
                    <th colSpan={5} scope="rowgroup">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => {
                          if (filtered) {
                            setFilteredExpansion((old) => ({
                              key: filterKey,
                              groups: {
                                ...(old.key === filterKey ? old.groups : {}),
                                [name]: !open,
                              },
                            }));
                          } else setExpanded((old) => ({ ...old, [name]: !open }));
                        }}
                      >
                        {open ? '−' : '+'} {name.replaceAll('_', ' ')}{' '}
                        <span className="note">({rows.length})</span>
                      </button>
                    </th>
                  </tr>
                  {open && rows.map(speciesRow)}
                </tbody>
              );
            })}
        </table>
      </div>
      {visible.length === 0 && <p className="note">No compounds match these filters.</p>}
      <p className="note">
        K1–K6 identify transport-model classes, not taste categories. Most compounds use estimated
        kinetics; open the evidence details for each species. Species are tracked beside the lumped
        solubles and are not added to total TDS a second time. Lipid, gas and diagnostic inventories
        have separate accounting in cup chemistry.
      </p>
    </div>
  );
}
