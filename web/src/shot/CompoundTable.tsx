// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * What reached the cup, compound by compound: each tracked species' mass, the
 * share of its extractable content that left the puck, its content in the
 * dose, and where every number behind it comes from (registry records with
 * their tag, evidence grade and sources; presets; your recipe). Total
 * dissolved solids come first, from the same run.
 */
import type { Catalog, RegistryParameter, SpeciesSpec } from '../engine/shotTypes';
import { HelpHeading } from './fields';
import { grams, milligrams, percent } from './format';
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

export function CompoundTable({
  outcome,
  registry,
  catalog,
}: {
  outcome: ShotOutcome | null;
  registry: Map<string, RegistryParameter>;
  catalog: Catalog | null;
}) {
  if (!outcome) return <p className="note">The compound table appears after the first run.</p>;
  const summary = outcome.result.summary;
  const spec = outcome.build.spec;
  const dose = spec.bed.dose_kg;
  const specIndex = new Map<string, [number, SpeciesSpec]>(
    spec.solubles.species.map((s, i) => [s.id, [i, s]]),
  );
  const solubles = summary.beverage_mass_kg * summary.tds;
  const extractable = spec.solubles.extractable_fraction;
  const speciesProps = (i: number) =>
    [
      'mass_fraction',
      'kernel_diffusivity_m2_s',
      'partition_coefficient',
      'surface_fraction_scale',
    ].map((key) => ({ label: PROPERTY_LABELS[key] ?? key, path: `solubles.species[${i}].${key}` }));
  return (
    <div className="panel-stack">
      <HelpHeading id="compounds-title" term="provenance" level={4}>
        Compounds in the cup, with provenance
      </HelpHeading>
      <div className="table-wrap">
        <table className="compound-table" aria-labelledby="compounds-title">
          <thead>
            <tr>
              <th scope="col">Compound</th>
              <th scope="col">In the cup</th>
              <th scope="col">Extracted</th>
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
            {summary.species.map((s) => {
              const entry = specIndex.get(s.id);
              const content = entry ? entry[1].mass_fraction * dose : null;
              return (
                <tr key={s.id} data-species={s.id}>
                  <th scope="row">{speciesName(s.id)}</th>
                  <td className="num" data-value={String(s.mass_kg)}>
                    {milligrams(s.mass_kg)}
                  </td>
                  <td className="num" data-value={String(s.extracted_fraction)}>
                    {percent(s.extracted_fraction)}
                  </td>
                  <td className="num">{milligrams(content)}</td>
                  <td>
                    {entry ? (
                      <ProvenanceCell
                        properties={speciesProps(entry[0])}
                        outcome={outcome}
                        registry={registry}
                        catalog={catalog}
                      />
                    ) : (
                      <span className="note">not in the spec</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        M1 tracks four species next to the lumped solubles; the full set of about 55 arrives in M2.
        Species other than caffeine, trigonelline and 5-CQA have no measured espresso kinetics, so
        their parameters are estimates; the provenance says which.
      </p>
    </div>
  );
}
