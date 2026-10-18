// SPDX-License-Identifier: GPL-2.0-or-later
import { useState } from 'react';
import { GUIDED_SCENARIOS, type ScenarioId } from './scenarios';

export function GuidedScenarios({
  onLoad,
  disabled = false,
}: {
  onLoad: (id: ScenarioId) => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<ScenarioId>('reference');
  const scenario = GUIDED_SCENARIOS.find((s) => s.id === selected)!;
  return (
    <section
      className="panel panel-stack guided-scenarios"
      aria-labelledby="explore-scenarios-title"
    >
      <h3 id="explore-scenarios-title">Guided scenarios</h3>
      <label>
        Teaching scenario
        <select value={selected} onChange={(e) => setSelected(e.target.value as ScenarioId)}>
          {GUIDED_SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      <p>
        <strong>{scenario.question}</strong>
      </p>
      <ul>
        {scenario.changes.map((change) => (
          <li key={change}>{change}</li>
        ))}
      </ul>
      <button type="button" className="button" disabled={disabled} onClick={() => onLoad(selected)}>
        Load scenario
      </button>
      <p className="note">
        Loading replaces the recipe shared with Lab and Dial-in. Use Undo to restore it. Run Explore
        to compute particle data.
      </p>
      <h4>What to inspect</h4>
      <ul>
        {scenario.watchFor.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <details>
        <summary>Assumptions and limits</summary>
        <ul>
          {scenario.assumptions.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
