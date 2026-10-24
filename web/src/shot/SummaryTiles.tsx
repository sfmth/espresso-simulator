// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The headline numbers of a shot as tiles. Each tile's raw value (SI, as the
 * core returned it) is kept in a data attribute, so tests can compare it with
 * the engine bit for bit.
 */
import type { ShotOutcome } from './shotStore';
import type { UncertaintyResult } from '../engine/m3Types';
import { bandText } from './UncertaintyPanel';
import {
  bar,
  brewRatio,
  fixed,
  grams,
  millilitres,
  millimetres,
  percent,
  points,
  scientific,
  seconds,
  stopReasonText,
} from './format';
import { GLOSSARY } from './glossary';
import { ModelStatusNote } from './ModelStatusNote';
import { HelpButton } from '../help/HelpButton';

function Tile({
  label,
  value,
  hint,
  raw,
  name,
  interval,
}: {
  label: string;
  value: string;
  hint?: string;
  raw?: number | null;
  /** Stable name for tests: data-tile. */
  name: string;
  interval?: string;
}) {
  return (
    <div className="tile" data-tile={name}>
      <dt>
        {label}
        <HelpButton term={name} label={label} />
      </dt>
      <dd>
        <span
          className="tile-value"
          data-value={raw === undefined || raw === null ? undefined : String(raw)}
        >
          {value}
        </span>
        {hint && <span className="tile-hint">{hint}</span>}
        {interval && (
          <span className="tile-hint scenario-interval">Scenario range: {interval}</span>
        )}
      </dd>
    </div>
  );
}

const TERMS = [
  'ey',
  'tds',
  'ratio',
  'first-drops',
  'headspace',
  'uniformity',
  'mass-balance',
  'outflow',
];

export function SummaryTiles({
  outcome,
  uncertainty,
}: {
  outcome: ShotOutcome | null;
  uncertainty?: UncertaintyResult | null;
}) {
  const s = outcome?.result.summary;
  const d = outcome?.result.diagnostics;
  const dose = outcome?.build.spec.bed.dose_kg ?? null;
  const u = s?.uniformity;
  return (
    <>
      <dl className="tiles shot-tiles" aria-label="Shot summary">
        <Tile
          name="shot-time"
          label="Shot time"
          value={seconds(s?.shot_time_s)}
          raw={s?.shot_time_s}
          hint={s ? stopReasonText(s.stop_reason) : undefined}
          interval={bandText(uncertainty?.bands['/summary/shot_time_s'], seconds)}
        />
        <Tile
          name="first-drops"
          label="First drops"
          value={s?.first_drops_s === null ? 'none' : seconds(s?.first_drops_s)}
          raw={s?.first_drops_s}
        />
        <Tile
          name="beverage"
          label="Beverage"
          value={grams(s?.beverage_mass_kg)}
          raw={s?.beverage_mass_kg}
          hint={s?.drip_mass_kg !== undefined ? `incl. ${grams(s.drip_mass_kg)} drip` : undefined}
          interval={bandText(uncertainty?.bands['/summary/beverage_mass_kg'], grams)}
        />
        <Tile
          name="ratio"
          label="Ratio"
          value={s && dose ? brewRatio(dose, s.beverage_mass_kg) : '—'}
          hint={dose ? `${grams(dose)} dose` : undefined}
        />
        <Tile
          name="tds"
          label="TDS"
          value={percent(s?.tds)}
          raw={s?.tds}
          hint="cup strength"
          interval={bandText(uncertainty?.bands['/summary/tds'], percent)}
        />
        <Tile
          name="ey"
          label="EY"
          value={percent(s?.ey)}
          raw={s?.ey}
          hint="extraction yield"
          interval={bandText(uncertainty?.bands['/summary/ey'], percent)}
        />
        <Tile
          name="max-pressure"
          label="Max pressure"
          value={bar(s?.max_pressure_pa)}
          raw={s?.max_pressure_pa}
          interval={bandText(uncertainty?.bands['/summary/max_pressure_pa'], bar)}
        />
        <Tile
          name="bed-height"
          label="Bed height"
          value={millimetres(s?.bed_height_m)}
          raw={s?.bed_height_m}
        />
        <Tile
          name="headspace"
          label="Headspace"
          value={millilitres(s?.headspace_m3)}
          raw={s?.headspace_m3}
          hint="water above the bed"
        />
        <Tile
          name="uniformity"
          label="Local EY spread (SD)"
          value={u ? points(u.ey_std) : '—'}
          raw={u?.ey_std}
          hint={
            u
              ? `range ${fixed(u.ey_min * 100, 1)}–${fixed(u.ey_max * 100, 1)}%${u.ey_mean !== undefined ? `, mean ${percent(u.ey_mean)}` : ''}`
              : undefined
          }
        />
      </dl>
      <details className="calculation-details">
        <summary>Calculation diagnostics</summary>
        <dl className="tiles shot-tiles" aria-label="Calculation diagnostics">
          <Tile
            name="mass-balance"
            label="Mass balance error"
            value={d ? scientific(d.mass_balance_error) : '—'}
            raw={d?.mass_balance_error}
            hint={d ? `${d.steps.toLocaleString('en-US')} steps` : undefined}
          />
          {d?.outflow_integral_error !== undefined && (
            <Tile
              name="outflow-check"
              label="Outflow check"
              value={scientific(d.outflow_integral_error)}
              raw={d.outflow_integral_error}
              hint="cup solute vs ∫ flow × concentration"
            />
          )}
          <Tile
            name="runtime"
            label="Runtime"
            value={outcome ? `${fixed(outcome.coreMs, outcome.coreMs < 10 ? 1 : 0)} ms` : '—'}
            raw={outcome?.coreMs}
            hint={outcome ? `tier ${outcome.tier}, in the worker` : undefined}
          />
        </dl>
      </details>
      {uncertainty && (
        <p className="note scenario-interval">
          Ranges show separate input scenarios. They exclude model error and the difference between
          fast and standard calculations. See Uncertainty for the baseline comparison.
          <HelpButton term="output.scenarios" label="Scenario ranges" />
        </p>
      )}
      <details className="calculation-details">
        <summary>Model scope and evidence</summary>
        <ModelStatusNote />
      </details>
      <details className="glossary">
        <summary>What do these mean?</summary>
        <dl>
          {TERMS.map((t) => (
            <div key={t}>
              <dt>{GLOSSARY[t]?.title}</dt>
              <dd>{GLOSSARY[t]?.text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
