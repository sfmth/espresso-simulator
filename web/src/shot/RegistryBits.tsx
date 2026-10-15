// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Small views of provenance: a registry parameter's tag and evidence grade,
 * its sources, and one provenance token (registry record, preset, recipe field
 * or model rule). Links to sources only open when followed; the page itself
 * requests nothing from other sites.
 */
import type { Catalog, RegistryParameter, Source } from '../engine/shotTypes';
import { registryUnit, sig } from './format';
import { FlagBadges } from './PresetInfo';
import { presetOf, TOKEN_KIND_LABELS, type ProvenanceToken } from './provenance';

const DEFAULT_FROM: Record<string, string> = {
  value: 'value',
  prior: 'centre of the prior',
  calibration: 'calibrated',
};

export function EvidenceBadges({ p }: { p: Pick<RegistryParameter, 'tag' | 'evidence_grade'> }) {
  return (
    <>
      <span className={`badge badge-tag-${p.tag}`}>{p.tag}</span>
      <span className="badge">Grade {p.evidence_grade}</span>
    </>
  );
}

export function SourceList({ sources }: { sources: readonly Source[] }) {
  if (sources.length === 0) return <p className="note">No source recorded.</p>;
  return (
    <ul className="sources">
      {sources.map((s, i) => (
        <li key={i}>
          {s.citation}
          {s.locator ? ` (${s.locator})` : ''}
          {s.doi && (
            <>
              {' '}
              <a href={`https://doi.org/${s.doi}`} target="_blank" rel="noopener noreferrer">
                doi:{s.doi}
              </a>
            </>
          )}
          {!s.doi && s.url && (
            <>
              {' '}
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                link
              </a>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "8.4e-15 m² (centre of the prior)". */
export function parameterValue(p: RegistryParameter): string {
  const unit = registryUnit(p.units);
  return `${sig(p.default, 4)}${unit ? ` ${unit}` : ''} (${DEFAULT_FROM[p.default_from] ?? p.default_from})`;
}

export function TokenView({
  token,
  registry,
  catalog,
  overrides,
}: {
  token: ProvenanceToken;
  registry: Map<string, RegistryParameter>;
  catalog: Catalog | null;
  overrides?: Record<string, number>;
}) {
  const kind = TOKEN_KIND_LABELS[token.kind];
  if (token.kind === 'registry' || token.kind === 'calibration' || token.kind === 'override') {
    const p = registry.get(token.id);
    if (!p) {
      return (
        <span className="token">
          {kind}: <code>{token.id}</code>
        </span>
      );
    }
    const override = overrides?.[token.id];
    return (
      <details className="token token-registry">
        <summary>
          {p.name} <EvidenceBadges p={p} />
          {token.kind === 'override' && <span className="badge badge-caution">overridden</span>}
        </summary>
        <p className="note">
          <code>{p.id}</code>:{' '}
          {override !== undefined
            ? `your value ${sig(override, 4)} ${registryUnit(p.units)}; default ${parameterValue(p)}`
            : parameterValue(p)}
        </p>
        <p className="note">{p.description}</p>
        <SourceList sources={p.sources} />
      </details>
    );
  }
  if (token.kind === 'preset') {
    const preset = presetOf(catalog, token);
    return (
      <span className="token">
        {kind}: {preset?.name ?? token.id} {preset && <FlagBadges flags={preset.flags} />}
        {preset && <span className="badge">Grade {preset.evidence_grade}</span>}
      </span>
    );
  }
  return (
    <span className="token">
      {kind}: {token.kind === 'recipe' ? <code>{token.id}</code> : token.id}
    </span>
  );
}
