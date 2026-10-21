// SPDX-License-Identifier: GPL-2.0-or-later
import type { SetupCandidate, SetupParameter } from './inferenceTypes';

export function CandidateChecks({ candidate }: { candidate: SetupCandidate }) {
  return (
    <div className="setup-table-scroll">
      <table className="setup-checks">
        <caption>Full-simulation checks against each recorded shot</caption>
        <thead>
          <tr>
            <th>Shot</th>
            <th>Observed</th>
            <th>Simulated</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          {candidate.checks.map((check) => (
            <tr key={check.observationId}>
              <th scope="row">
                {check.label}
                <small>{check.matches ? 'Within tolerances' : 'Outside tolerances'}</small>
              </th>
              <td>
                {check.observed.yieldG.toFixed(2)} g<br />
                {check.observed.timeS.toFixed(1)} s
                {check.observed.tdsPercent !== undefined && (
                  <>
                    <br />
                    {check.observed.tdsPercent.toFixed(2)}% TDS
                  </>
                )}
              </td>
              <td>
                {check.predicted.yieldG.toFixed(2)} g<br />
                {check.predicted.timeS.toFixed(1)} s replay
                {check.observed.tdsPercent !== undefined && (
                  <>
                    <br />
                    {check.predicted.tdsPercent.toFixed(2)}% TDS
                  </>
                )}
              </td>
              <td>
                {check.residuals.yieldG.toFixed(2)} g (±{check.tolerances.yieldG})<br />
                {check.residuals.timeS.toFixed(2)} s (±{check.tolerances.timeS})
                {check.residuals.tdsPercent !== undefined && (
                  <>
                    <br />
                    {check.residuals.tdsPercent.toFixed(2)} TDS points (±
                    {check.tolerances.tdsPercent})
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function SetupCandidates({
  candidates,
  parameters,
  stale,
  onSave,
  savedIds,
  matched = true,
}: {
  candidates: SetupCandidate[];
  parameters: SetupParameter[];
  stale: boolean;
  onSave: (candidate: SetupCandidate, index: number) => void;
  savedIds: string[];
  matched?: boolean;
}) {
  return (
    <div className="setup-candidates">
      {candidates.map((candidate, index) => (
        <article className="setup-candidate" key={candidate.id}>
          <div className="setup-candidate-heading">
            <h4>
              {matched ? 'Possible setup' : 'Closest result'} {index + 1}
            </h4>
            <span className={`badge ${matched ? '' : 'badge-caution'}`}>
              {matched ? 'Matches recorded shots' : 'Does not match all shots'}
            </span>
          </div>
          <dl className="setup-values">
            {Object.entries(candidate.values).map(([path, value]) => {
              const parameter = parameters.find((p) => p.path === path);
              return (
                <div key={path}>
                  <dt>{parameter?.label ?? path}</dt>
                  <dd>
                    {typeof value === 'number'
                      ? Number(value.toPrecision(6)).toString()
                      : String(value)}{' '}
                    {parameter?.unit}
                  </dd>
                </div>
              );
            })}
          </dl>
          <CandidateChecks candidate={candidate} />
          {!!candidate.notes.length && (
            <details>
              <summary>What this match can tell you</summary>
              <ul>
                {candidate.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </details>
          )}
          {matched && (
            <button
              type="button"
              className="button button-primary"
              disabled={stale || savedIds.includes(candidate.id)}
              onClick={() => onSave(candidate, index)}
            >
              {savedIds.includes(candidate.id)
                ? `Possible setup ${index + 1} kept`
                : `Keep possible setup ${index + 1}`}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
