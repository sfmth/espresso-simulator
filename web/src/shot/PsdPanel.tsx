// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Particle sizes: the volume-weighted size distribution the grinder model (or
 * a measured PSD) gives, on a logarithmic diameter axis, with the size classes
 * the solver was handed drawn as a histogram of the same density; its
 * statistics; and the extraction yield of each size class at the end of the
 * shot. Pinned runs overlay their distributions and class yields.
 */
import { useMemo } from 'react';
import type uPlot from 'uplot';
import { LineChart, type ChartSeriesSpec } from '../components/LineChart';
import type { SizeClass } from '../engine/shotTypes';
import { HelpButton } from '../help/HelpButton';
import { formatTick } from '../lab/format';
import { fixed, percent, sig } from './format';
import { HelpHeading } from './fields';
import type { ChartRun } from './shotChartData';
import type { ShotOutcome } from './shotStore';

export interface PsdRun extends Omit<ChartRun, 'result'> {
  outcome: ShotOutcome;
}

/** Bin edges (µm) of classes taken as contiguous in ln d, edges at geometric midpoints. */
export function classEdges(diameters: readonly number[]): number[] {
  const n = diameters.length;
  if (n === 0) return [];
  if (n === 1) return [diameters[0] / 1.25, diameters[0] * 1.25];
  const edges = [diameters[0] / Math.sqrt(diameters[1] / diameters[0])];
  for (let i = 1; i < n; i++) edges.push(Math.sqrt(diameters[i - 1] * diameters[i]));
  edges.push(diameters[n - 1] * Math.sqrt(diameters[n - 1] / diameters[n - 2]));
  return edges;
}

/** The classes as a histogram of volume density per unit ln d: step x and y values. */
export function classHistogram(classes: readonly SizeClass[]): { x: number[]; y: number[] } {
  const sorted = [...classes].sort((a, b) => a.radius_m - b.radius_m);
  const d = sorted.map((c) => c.radius_m * 2e6);
  const edges = classEdges(d);
  const y = sorted.map((c, i) => c.volume_fraction / Math.log(edges[i + 1] / edges[i]));
  return { x: edges, y: [...y, y.at(-1) ?? 0] };
}

/** Outer join of [x, y] tables on x (sorted); missing values are null. */
export function joinTables(
  tables: readonly { x: ArrayLike<number>; y: ArrayLike<number> }[],
): uPlot.AlignedData {
  const all = new Set<number>();
  for (const t of tables) for (let i = 0; i < t.x.length; i++) all.add(t.x[i]);
  const x = [...all].sort((a, b) => a - b);
  const index = new Map(x.map((v, i) => [v, i]));
  const columns = tables.map((t) => {
    const column = new Array<number | null>(x.length).fill(null);
    for (let i = 0; i < t.x.length; i++) column[index.get(t.x[i]) as number] = t.y[i];
    return column;
  });
  return [Float64Array.from(x), ...columns] as uPlot.AlignedData;
}

const formatDiameter = (d: number) => `${sig(d, 3)} µm`;
const formatDensity = (v: number) => sig(v, 3);
const formatPercent = (v: number) => `${fixed(v, 1)}%`;

export function PsdPanel({ runs }: { runs: readonly PsdRun[] }) {
  const current = runs[0]?.outcome;
  const psdChart = useMemo(() => {
    const tables: { x: ArrayLike<number>; y: ArrayLike<number> }[] = [];
    const series: ChartSeriesSpec[] = [];
    runs.forEach((run, i) => {
      const curve = run.outcome.build.derived.psd_curve;
      if (curve.diameter_um.length > 0) {
        tables.push({ x: curve.diameter_um, y: curve.volume_density });
        series.push({ label: `${run.label} · distribution`, slot: run.slot, spanGaps: true });
      }
      if (i === 0) {
        const h = classHistogram(run.outcome.build.spec.bed.size_classes);
        if (h.x.length > 0) {
          tables.push(h);
          series.push({
            label: `${run.label} · solver size classes`,
            slot: run.slot,
            stepped: true,
            dash: [3, 3],
            width: 1.5,
            spanGaps: true,
          });
        }
      }
    });
    return { data: joinTables(tables), series };
  }, [runs]);

  const classChart = useMemo(() => {
    const tables: { x: number[]; y: number[] }[] = [];
    const series: ChartSeriesSpec[] = [];
    for (const run of runs) {
      const classes = [...(run.outcome.result.spatial.class_ey ?? [])].sort(
        (a, b) => a.radius_m - b.radius_m,
      );
      if (classes.length === 0) continue;
      tables.push({ x: classes.map((c) => c.radius_m * 2e6), y: classes.map((c) => c.ey * 100) });
      // Many classes make a smooth curve; markers only for a few (tier 0 merges into two).
      series.push({
        label: run.label,
        slot: run.slot,
        points: classes.length <= 8,
        spanGaps: true,
      });
    }
    return { data: joinTables(tables), series };
  }, [runs]);

  if (!current) return <p className="note">The particle sizes appear after the first run.</p>;
  const psd = current.build.derived.psd;
  const classes = [...current.build.spec.bed.size_classes].sort((a, b) => a.radius_m - b.radius_m);
  const classEy = [...(current.result.spatial.class_ey ?? [])].sort(
    (a, b) => a.radius_m - b.radius_m,
  );

  return (
    <div className="panel-stack">
      <figure className="chart">
        <figcaption>
          Particle-size distribution
          <HelpButton term="output.psd.distribution" />
        </figcaption>
        <LineChart
          data={psdChart.data}
          series={psdChart.series}
          xLabel="Diameter (µm)"
          yLabel="Volume density"
          xLog
          yFromZero
          formatX={formatDiameter}
          formatY={formatDensity}
          formatTick={formatTick}
          summary={
            psd
              ? `Volume-weighted particle sizes: median X50 ${sig(psd.x50_um, 3)} µm, ${percent(psd.fines_fraction)} below 100 µm, handed to the solver as ${classes.length} size classes.`
              : 'Volume-weighted particle sizes.'
          }
        />
      </figure>
      {psd && (
        <>
          <HelpHeading id="psd-stats" term="output.psd.distribution" level={4}>
            Distribution statistics
          </HelpHeading>
          <dl className="tiles tiles-compact" aria-labelledby="psd-stats">
            <div className="tile">
              <dt>
                X50 (median)
                <HelpButton term="output.psd.x50" />
              </dt>
              <dd>
                <span className="tile-value">{sig(psd.x50_um, 3)} µm</span>
              </dd>
            </div>
            <div className="tile">
              <dt>
                Fines below 100 µm
                <HelpButton term="output.psd.fines" />
              </dt>
              <dd>
                <span className="tile-value">{percent(psd.fines_fraction)}</span>
              </dd>
            </div>
            <div className="tile">
              <dt>
                D[3,2] (Sauter)
                <HelpButton term="output.psd.d32" />
              </dt>
              <dd>
                <span className="tile-value">{sig(psd.d32_um, 3)} µm</span>
              </dd>
            </div>
            <div className="tile">
              <dt>
                D[4,3]
                <HelpButton term="output.psd.d43" />
              </dt>
              <dd>
                <span className="tile-value">{sig(psd.d43_um, 3)} µm</span>
              </dd>
            </div>
            <div className="tile">
              <dt>
                Source
                <HelpButton term="output.psd.source" />
              </dt>
              <dd>
                <span className="tile-value">
                  {psd.source === 'measured' ? 'Measured' : 'Model'}
                </span>
                <span className="tile-hint">
                  {psd.gap_um !== null ? `gap ${sig(psd.gap_um, 4)} µm` : ''}
                  {psd.setting !== null ? `, setting ${psd.setting}` : ''}
                </span>
              </dd>
            </div>
            <div className="tile">
              <dt>
                Size classes
                <HelpButton term="output.psd.classes" />
              </dt>
              <dd>
                <span className="tile-value">{psd.classes}</span>
              </dd>
            </div>
          </dl>
          {psd.mixture.length > 0 && (
            <div className="table-wrap">
              <table>
                <caption>
                  The log-normal components of the model distribution
                  <HelpButton term="output.psd.mixture" />
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Component</th>
                    <th scope="col">
                      Volume share
                      <HelpButton term="output.psd.mixture" label="Component volume share" />
                    </th>
                    <th scope="col">
                      Mode (µm)
                      <HelpButton term="output.psd.mixture" label="Component mode" />
                    </th>
                    <th scope="col">
                      Width (σ of ln d)
                      <HelpButton term="output.psd.mixture" label="Component log width" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {psd.mixture.map((m) => (
                    <tr key={m.component}>
                      <th scope="row">{m.component}</th>
                      <td>{percent(m.weight)}</td>
                      <td>{sig(m.mode_um, 3)}</td>
                      <td>{fixed(m.log_width, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <figure className="chart">
        <figcaption>
          Extraction yield by particle size at the end of the shot
          <HelpButton term="output.psd.class-ey" />
        </figcaption>
        <LineChart
          data={classChart.data}
          series={classChart.series}
          xLabel="Diameter (µm)"
          yLabel="EY (%)"
          xLog
          yFromZero
          formatX={formatDiameter}
          formatY={formatPercent}
          formatTick={formatTick}
          summary={`Extraction yield of each size class: from ${fixed((classEy[0]?.ey ?? 0) * 100, 1)}% for the finest to ${fixed((classEy.at(-1)?.ey ?? 0) * 100, 1)}% for the coarsest.`}
        />
      </figure>
      <details className="table-view">
        <summary>Table view ({classes.length} size classes)</summary>
        <div className="table-wrap">
          <table>
            <caption>
              Particle sizes used in the calculation
              {classEy.length !== classes.length
                ? ` (this calculation combines them into ${classEy.length} groups; their yields are listed below)`
                : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  Diameter (µm)
                  <HelpButton term="output.psd.distribution" label="Size-class diameter" />
                </th>
                <th scope="col">
                  Volume share
                  <HelpButton term="output.psd.distribution" label="Size-class volume share" />
                </th>
                {classEy.length === classes.length && (
                  <th scope="col">
                    EY at the end
                    <HelpButton term="output.psd.class-ey" label="Size-class extraction yield" />
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {classes.map((c, i) => (
                <tr key={i}>
                  <td>{sig(c.radius_m * 2e6, 4)}</td>
                  <td>{percent(c.volume_fraction, 2)}</td>
                  {classEy.length === classes.length && <td>{percent(classEy[i]?.ey, 2)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {classEy.length !== classes.length && classEy.length > 0 && (
            <table>
              <caption>Merged classes reported by the solver</caption>
              <thead>
                <tr>
                  <th scope="col">
                    Diameter (µm)
                    <HelpButton term="output.psd.classes" label="Merged size-class diameter" />
                  </th>
                  <th scope="col">
                    EY at the end
                    <HelpButton
                      term="output.psd.class-ey"
                      label="Merged size-class extraction yield"
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {classEy.map((c, i) => (
                  <tr key={i}>
                    <td>{sig(c.radius_m * 2e6, 4)}</td>
                    <td>{percent(c.ey, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </details>
    </div>
  );
}
