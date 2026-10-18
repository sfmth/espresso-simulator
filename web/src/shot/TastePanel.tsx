// SPDX-License-Identifier: GPL-2.0-or-later
/** Displays the shared Rust taste model; no sensory calculations live in the UI. */
import type { UncertaintyResult } from '../engine/m3Types';
import { fixed, sig } from './format';
import type { ShotOutcome } from './shotStore';
import { bandText } from './UncertaintyPanel';

export function TastePanel({
  outcome,
  stale,
  uncertainty,
}: {
  outcome: ShotOutcome | null;
  stale: boolean;
  uncertainty: UncertaintyResult | null;
}) {
  const taste = outcome?.taste;
  return (
    <div
      id="taste-panel"
      className="panel-stack taste-panel"
      aria-label="Explainable taste estimates"
      data-stale={stale ? 'true' : undefined}
    >
      <div>
        <h4>Explainable taste estimates</h4>
        <p className="run-warning">
          <strong>Low trust: unvalidated relative indices.</strong> The chemistry suggests acidity,
          bitterness, astringency and body through explicit heuristic weights. These 0–100 indices
          are not sensory ratings, a quality score or a preference prediction.
        </p>
        <p className="note">
          Compare the same attribute between recipes under this model. Values across different
          attributes cannot be compared or added. Input scenario bands exclude uncertainty in the
          taste mapping itself.
        </p>
      </div>
      {!taste ? (
        <p className="note">
          {outcome
            ? 'This engine result has no taste estimates. Run the recipe with the M3 engine.'
            : 'Run a shot to see its taste estimates and their drivers.'}
        </p>
      ) : (
        <>
          <p className="result-badges">
            {stale && <span className="stale-badge">Taste for earlier inputs</span>}
            <span className={outcome.kind === 'preview' ? 'stale-badge' : 'tier-badge'}>
              {outcome.kind === 'preview'
                ? 'Central preview, Tier 0'
                : `Central shot, Tier ${outcome.tier}`}
            </span>
            <span className="note">{taste.status.replaceAll('_', ' ')}</span>
          </p>
          {taste.attributes.length === 0 && (
            <p className="note">
              Taste indices are unavailable for this result. Missing chemistry or beverage is not
              treated as zero taste.
            </p>
          )}
          {taste.attributes.map((attribute) => {
            const interval = uncertainty?.bands[`/taste/${attribute.id}_index`];
            return (
              <section
                className="taste-attribute"
                key={attribute.id}
                aria-labelledby={`taste-${attribute.id}-title`}
              >
                <div className="taste-attribute-heading">
                  <h4 id={`taste-${attribute.id}-title`}>{attribute.label}</h4>
                  <p>
                    <strong className="taste-index">
                      {attribute.index === null ? 'Unavailable' : fixed(attribute.index, 1)}
                    </strong>
                    {attribute.index !== null && (
                      <span className="note"> / 100 relative index</span>
                    )}
                  </p>
                  <span className="stale-badge">{attribute.trust.replaceAll('_', ' ')} trust</span>
                </div>
                {interval && (
                  <p className="scenario-interval">
                    Tier-0 input scenarios: p05–p95 {bandText(interval, (v) => fixed(v, 1))}; median{' '}
                    {fixed(interval.p50, 1)} ({interval.n} members). These are not confidence limits
                    for the central taste estimate.
                  </p>
                )}
                <ul className="taste-assumptions">
                  {attribute.assumptions.map((assumption, i) => (
                    <li key={i}>{assumption}</li>
                  ))}
                </ul>
                <details className="table-view">
                  <summary>Why this estimate? ({attribute.drivers.length} drivers)</summary>
                  <p className="note">
                    The driver term is a dimensionless contribution before the model’s 0–100
                    compression. It is not a share of perceived taste or a number of sensory points.
                  </p>
                  <div className="table-wrap">
                    <table aria-label={`${attribute.label} drivers`}>
                      <thead>
                        <tr>
                          <th scope="col">Driver</th>
                          <th scope="col">Model value</th>
                          <th scope="col">Driver term</th>
                          <th scope="col">Evidence and parameters</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attribute.drivers.map((driver) => (
                          <tr key={driver.id}>
                            <th scope="row">{driver.label}</th>
                            <td>
                              {sig(driver.value, 4)} {driver.units}
                            </td>
                            <td>{sig(driver.contribution, 4)}</td>
                            <td>
                              <ul className="compact-list">
                                {driver.source_refs.map((ref) => (
                                  <li key={ref}>
                                    <a href={`#taste-source-${ref}`}>{ref}</a>
                                  </li>
                                ))}
                                {driver.registry_refs.map((ref) => (
                                  <li key={ref}>
                                    <code>{ref}</code>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </section>
            );
          })}
          {!uncertainty && (
            <p className="note">
              Run uncertainty with the current inputs and settings to see Tier-0 input-scenario
              ranges for these indices.
            </p>
          )}
          <details className="model-notes">
            <summary>Taste assumptions and observation conditions</summary>
            <p>{taste.score_semantics}</p>
            <p className="note">
              For each available attribute the model sums its dimensionless driver terms into L,
              then displays 100 × L / (1 + L). This compression is a grade D display convention; it
              has not been fitted to a sensory panel.
            </p>
            <ul>
              {taste.assumptions.map((assumption, i) => (
                <li key={i}>{assumption}</li>
              ))}
            </ul>
            <dl className="chemistry-accounting">
              <div>
                <dt>Chemistry reference temperature</dt>
                <dd>
                  {taste.conditions.chemistry_reference_temperature_c === null
                    ? 'Unavailable'
                    : `${fixed(taste.conditions.chemistry_reference_temperature_c, 0)} °C`}
                </dd>
              </div>
              <div>
                <dt>Serving temperature correction</dt>
                <dd>Not modelled</dd>
              </div>
              <div>
                <dt>Added dilution water</dt>
                <dd>{fixed(taste.conditions.dilution_water_g, 1)} g</dd>
              </div>
              <div>
                <dt>Time in cup</dt>
                <dd>
                  {taste.conditions.aroma_age_s === null
                    ? 'Unavailable'
                    : `${fixed(taste.conditions.aroma_age_s, 0)} s`}
                </dd>
              </div>
            </dl>
          </details>
          <details className="model-notes">
            <summary>Science and evidence ({taste.sources.length} sources)</summary>
            <p className="note">
              Published evidence supports particular chemical mechanisms. All coefficients and the
              display scale in this taste mapping remain grade D estimates.
            </p>
            <ul className="taste-sources">
              {taste.sources.map((source) => (
                <li id={`taste-source-${source.id}`} key={source.id}>
                  <a href={source.url}>{source.citation}</a> · evidence grade{' '}
                  {source.evidence_grade}
                  <p>{source.scope}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
