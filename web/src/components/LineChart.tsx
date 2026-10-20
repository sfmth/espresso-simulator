// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * A uPlot line chart that follows its container's width and the colour scheme.
 * uPlot's live legend doubles as the hover read-out: it lists every series at
 * the cursor's x, and clicking a legend entry hides or shows that series.
 * Charts are drawn on a canvas, so each one carries a text summary (`summary`)
 * and the panels offer a table view of the same data. One y axis per chart:
 * quantities with different units go in separate charts (small multiples).
 */
import { useEffect, useId, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useChartTheme, type ChartTheme } from './chartTheme';

export interface ChartSeriesSpec {
  label: string;
  /** Categorical colour slot (chartTheme.ts): 0 = blue (the current run), 1 = orange, … 6. */
  slot: number;
  /** Dash pattern in CSS pixels, e.g. for a reference solution or a second quantity. */
  dash?: number[];
  /** Line width in CSS pixels (default 2). */
  width?: number;
  /** Draw a marker at every point (sparse data such as sweeps). */
  points?: boolean;
  /** Draw as steps (a histogram outline); the step holds each value until the next x. */
  stepped?: boolean;
  /** Connect across missing (null) values, e.g. when several runs share one x axis. */
  spanGaps?: boolean;
}

export interface LineChartProps {
  /** [x, ...y] arrays of equal length; y values may be null where a series has no point. */
  data: uPlot.AlignedData;
  /** Must be a stable value (a constant or memoised): a new array rebuilds the chart. */
  series: readonly ChartSeriesSpec[];
  /** One-based series indices: upper and lower bounds of a shaded interval. */
  bands?: readonly { upper: number; lower: number }[];
  xLabel: string;
  yLabel: string;
  /** Fixed y range; otherwise the range follows the data. */
  yRange?: readonly [number, number];
  /** Start the y axis at 0 (for quantities that cannot be negative). */
  yFromZero?: boolean;
  /** Logarithmic x axis (e.g. particle diameter). */
  xLog?: boolean;
  /** Draws a baseline at this y value, e.g. 0 for an error curve. */
  baseline?: number;
  formatX: (value: number) => string;
  formatY: (value: number) => string;
  formatTick: (value: number) => string;
  /** Text alternative for the canvas. */
  summary: string;
  height?: number;
  /** Charts with the same key share the cursor position. */
  syncKey?: string;
}

const FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const LABEL_FONT = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function buildOptions(
  props: Omit<LineChartProps, 'data' | 'summary'>,
  theme: ChartTheme,
  width: number,
): uPlot.Options {
  const { series, xLabel, yLabel, yRange, yFromZero, xLog, baseline } = props;
  const { formatX, formatY, formatTick } = props;
  const colorOf = (slot: number | undefined) =>
    theme.series[(slot ?? 0) % theme.series.length] ?? theme.series[0];
  const axis: uPlot.Axis = {
    stroke: theme.text,
    font: FONT,
    labelFont: LABEL_FONT,
    grid: { stroke: theme.grid, width: 1 },
    ticks: { stroke: theme.axis, width: 1, size: 5 },
  };
  const drawBaseline = (u: uPlot) => {
    if (baseline === undefined) return;
    const y = Math.round(u.valToPos(baseline, 'y', true));
    if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
    const ctx = u.ctx;
    ctx.save();
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = Math.max(1, uPlot.pxRatio);
    ctx.beginPath();
    ctx.moveTo(u.bbox.left, y);
    ctx.lineTo(u.bbox.left + u.bbox.width, y);
    ctx.stroke();
    ctx.restore();
  };
  // uPlot.paths is absent from test stand-ins; the default linear path is used then.
  const stepped = uPlot.paths?.stepped?.({ align: 1 });
  let yScale: uPlot.Scale = {};
  if (yRange) yScale = { range: (): uPlot.Range.MinMax => [yRange[0], yRange[1]] };
  else if (yFromZero) {
    yScale = {
      range: (_u, _min, max): uPlot.Range.MinMax => {
        const top = Number.isFinite(max) && max > 0 ? max : 1;
        return [0, uPlot.rangeNum(0, top, 0.1, true)[1] ?? top];
      },
    };
  }
  return {
    width,
    height: props.height ?? 240,
    series: [
      { label: xLabel, value: (_u, v) => (v == null ? '—' : formatX(v)) },
      ...series.map((s): uPlot.Series => ({
        label: s.label,
        stroke: colorOf(s.slot),
        width: s.width ?? 2,
        dash: s.dash,
        spanGaps: s.spanGaps ?? false,
        ...(s.stepped && stepped ? { paths: stepped } : {}),
        points: s.points
          ? { show: true, size: 8, width: 2, stroke: theme.surface, fill: colorOf(s.slot) }
          : { show: false },
        value: (_u, v) => (v == null ? '—' : formatY(v)),
      })),
    ],
    axes: [
      // Log axes leave some splits unlabelled (null).
      {
        ...axis,
        label: xLabel,
        values: (_u, splits) => splits.map((v) => (v == null ? '' : formatTick(v))),
      },
      {
        ...axis,
        label: yLabel,
        size: 64,
        values: (_u, splits) => splits.map((v) => (v == null ? '' : formatTick(v))),
      },
    ],
    scales: {
      x: xLog ? { time: false, distr: 3, log: 10 } : { time: false },
      y: yScale,
    },
    bands: props.bands?.map((band) => ({
      series: [band.upper, band.lower],
      fill: theme.dark ? 'rgba(57, 135, 229, 0.20)' : 'rgba(42, 120, 214, 0.15)',
    })),
    cursor: {
      // A vertical crosshair finds the x; charts sharing a sync key move together.
      y: false,
      // An 8 px dot in the series colour inside a 2 px ring of the surface colour.
      points: {
        size: 12,
        width: 2,
        stroke: theme.surface,
        fill: (_u, i) => colorOf(series[i - 1]?.slot),
      },
      drag: { x: true, y: false },
      ...(props.syncKey ? { sync: { key: props.syncKey } } : {}),
    },
    legend: {
      live: true,
      // Keys mirror the lines, including dashes (see styles.css).
      markers: { dash: (_u, i) => (series[i - 1]?.dash ? 'dashed' : 'solid') },
    },
    hooks: {
      drawAxes: [drawBaseline],
      // Keep the keyboard toggles' state in step with clicks on the legend.
      setSeries: [
        (u, i) => {
          if (i === null) return;
          const row = u.root.querySelectorAll('.u-legend .u-series')[i];
          row
            ?.querySelector('.u-label')
            ?.setAttribute('aria-pressed', String(u.series[i]?.show !== false));
        },
      ],
    },
  };
}

/** The same array while its contents are unchanged, so a new result does not rebuild the chart. */
function useStableSeries(series: readonly ChartSeriesSpec[]): readonly ChartSeriesSpec[] {
  const key = JSON.stringify(series);
  const [kept, setKept] = useState({ key, series });
  if (kept.key !== key) {
    setKept({ key, series });
    return series;
  }
  return kept.series;
}

/**
 * Makes uPlot's legend entries keyboard-operable: each series label becomes a
 * focusable toggle (Enter or Space shows or hides the series, as a click does)
 * whose state screen readers hear through aria-pressed.
 */
function enhanceLegend(u: uPlot, specs: readonly ChartSeriesSpec[]): void {
  const rows = u.root?.querySelectorAll?.<HTMLElement>('.u-legend .u-series') ?? [];
  rows.forEach((row, i) => {
    if (i === 0) return; // the x value
    const label = row.querySelector<HTMLElement>('.u-label');
    if (!label) return;
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    label.setAttribute('aria-pressed', String(u.series[i]?.show !== false));
    label.title = `Show or hide ${specs[i - 1]?.label ?? 'this series'}`;
    label.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        u.setSeries(i, { show: u.series[i]?.show === false });
      }
    });
  });
}

export function LineChart({ data, summary, ...config }: LineChartProps) {
  const sampleId = useId();
  const [selectedSample, setSelectedSample] = useState(0);
  const sampleCount = data[0].length;
  const sample = Math.min(selectedSample, Math.max(0, sampleCount - 1));
  const theme = useChartTheme();
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);
  const latestData = useRef(data);
  /** Data that arrived while the chart was hidden (a tab not shown). */
  const dirty = useRef(false);
  /** The element that carries role="img" and the text summary. */
  const described = useRef<HTMLElement | null>(null);
  const latestSummary = useRef(summary);
  const { xLabel, yLabel, yRange, yFromZero, xLog, baseline } = config;
  const { formatX, formatY, formatTick, height, syncKey } = config;
  const bands = config.bands;
  const series = useStableSeries(config.series);

  // (Re)build the chart when its configuration or the theme changes.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const width = element.clientWidth || 600;
    const options = buildOptions(
      {
        series,
        xLabel,
        yLabel,
        yRange,
        yFromZero,
        xLog,
        baseline,
        formatX,
        formatY,
        formatTick,
        height,
        syncKey,
        bands,
      },
      theme,
      width,
    );
    const instance = new uPlot(options, latestData.current, element);
    chart.current = instance;
    dirty.current = false;
    // The plot is an image with a text summary; the legend outside it stays readable.
    const target = instance.root?.querySelector?.<HTMLElement>('.u-wrap') ?? element;
    target.setAttribute('role', 'img');
    target.setAttribute('aria-label', latestSummary.current);
    described.current = target;
    enhanceLegend(instance, series);
    return () => {
      instance.destroy();
      if (chart.current === instance) chart.current = null;
    };
  }, [
    theme,
    series,
    xLabel,
    yLabel,
    yRange,
    yFromZero,
    xLog,
    baseline,
    formatX,
    formatY,
    formatTick,
    height,
    syncKey,
    bands,
  ]);

  useEffect(() => {
    latestSummary.current = summary;
    described.current?.setAttribute('aria-label', summary);
  }, [summary]);

  useEffect(() => {
    latestData.current = data;
    if (!chart.current) return;
    // A chart in a hidden tab is updated when it is shown again.
    if ((container.current?.clientWidth ?? 0) === 0) {
      dirty.current = true;
      return;
    }
    chart.current.setData(data);
  }, [data]);

  // Follow the container's width (also when a hidden tab becomes visible).
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (width > 0 && chart.current) {
        chart.current.setSize({ width, height: height ?? 240 });
        if (dirty.current) {
          dirty.current = false;
          chart.current.setData(latestData.current);
        }
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);

  return (
    <>
      <div ref={container} className="chart-canvas" />
      <details className="chart-readout">
        <summary>Read chart values</summary>
        {sampleCount > 0 ? (
          <>
            <label htmlFor={sampleId}>
              {xLabel}: sample {sample + 1} of {sampleCount}
            </label>
            <input
              id={sampleId}
              type="range"
              min={0}
              max={sampleCount - 1}
              step={1}
              value={sample}
              aria-label={`${xLabel} sample`}
              aria-valuetext={`${formatX(data[0][sample])}, sample ${sample + 1} of ${sampleCount}`}
              aria-describedby={`${sampleId}-values`}
              onChange={(event) => setSelectedSample(Number(event.target.value))}
            />
            <div id={`${sampleId}-values`} aria-live="polite" aria-atomic="true">
              <p>{formatX(data[0][sample])}</p>
              <dl>
                {series.map((spec, i) => {
                  const value = data[i + 1]?.[sample];
                  return (
                    <div key={`${i}-${spec.label}`}>
                      <dt>{spec.label}</dt>
                      <dd>{value == null ? 'No value at this sample' : formatY(value)}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </>
        ) : (
          <p>No samples available.</p>
        )}
      </details>
    </>
  );
}
