# SPDX-License-Identifier: GPL-2.0-or-later
"""Cameron et al. (2020), Matter 2:631–648: extraction yield and shot time versus EK43 grind setting.

Source files expected in SOURCE_DIR:

- ``cameron2020-osti-1973594.pdf``: the accepted manuscript from
  https://www.osti.gov/biblio/1973594 (DOE public access; its figures are vector graphics);
- ``cameron2020-si.pdf``: the Supplemental Information (mmc1.pdf, Cell Press).

Figure 4 (shot time and EY versus grind setting, mean and error bars) and
Figure 2B (volume particle-size distributions at GS 1.0, 1.5, 2.0 and 2.5) are
read from the PDF's vector paths (``pdfvector``; needs qpdf): marker centres,
error-bar ends and curve outlines are converted with the axis ticks, which are
also vector paths. The supplement's Tables S2 (two-class bed description) and
S3 (shot times) are transcribed below. The article's figures are copyrighted,
so these are cited facts (licence ``facts-cited``).
"""

from __future__ import annotations

import math
import sys
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from .common import fmt, importer_parser, report_sources, write_csv
from .pdfvector import Path2D, page_paths

MANUSCRIPT = "cameron2020-osti-1973594.pdf"
SUPPLEMENT = "cameron2020-si.pdf"

GRIND_SETTINGS = (1.1, 1.3, 1.5, 1.7, 1.9, 2.1, 2.3)

#: Table S3 of the supplement: shot times (s) of Figure 4A, as printed.
SHOT_TIME_TABLE_S3 = (37.6, 35.7, 33.9, 30.5, 28.5, 26.6, 24.0)

#: Table S2 of the supplement: grind setting → (fines volume fraction φs1, boulder volume
#: fraction φs2 (of the bed), boulder "radius" a2 in µm). Fines radius a1 = 12 µm for all.
TWO_CLASS_TABLE_S2 = {
    1.0: (0.1689, 0.6583, 273.86),
    1.5: (0.1343, 0.6929, 335.41),
    2.0: (0.1200, 0.7072, 335.41),
    2.5: (0.0780, 0.7492, 410.79),
}
FINES_RADIUS_UM = 12.0

# Figure 4 (page 11): the two panels are found by their frames (stroked rectangles); the
# values of their left-axis ticks (bottom to top, frame bottom first) are read off the figure.
FIG4_PAGE = 11
FIG4_TICK_VALUES = {"time": (20.0, 25.0, 30.0, 35.0, 40.0), "ey": (20.0, 21.0, 22.0, 23.0)}

# Figure 2B (page 7): axis ticks (left axis: 0, 5, 10, 15, 20 %; top axis of panel A: 1, 10,
# 100, 1000 µm, which panel B shares) and the paths of the four curves in content order,
# identified by their label leader lines (GS 2.5 is a stroked outline; the others are
# outlined strokes, i.e. thin filled bands whose centre line is the curve).
FIG2_PAGE = 7
FIG2_X_TICKS = ((128.91, 1.0), (190.53, 10.0), (252.40, 100.0), (314.02, 1000.0))
FIG2_Y_TICKS = ((409.76, 0.0), (453.40, 5.0), (497.05, 10.0), (540.69, 15.0), (584.34, 20.0))
FIG2_CURVES = {2.5: (54, "stroke"), 2.0: (27, "band"), 1.5: (13, "band"), 1.0: (14, "band")}
PSD_GRID_PER_DECADE = 40
PSD_RANGE_UM = (5.0, 2000.0)


def _frames(paths: list[Path2D]) -> list[tuple[float, float, float, float]]:
    """Bounding boxes of stroked rectangles wider than 150 pt (plot frames), top panel first."""
    boxes = [p.bbox() for p in paths if p.op == "S" and len(p.segments) == 1 and p.segments[0][0] == "re"]
    return sorted((b for b in boxes if b[2] - b[0] > 150.0), key=lambda b: -b[1])


def _short_strokes(paths: list[Path2D]) -> list[tuple[float, float, float, float]]:
    """Bounding boxes of single straight strokes 3–6 pt long (axis ticks)."""
    out = []
    for p in paths:
        if p.op == "S" and len(p.segments) == 2 and p.count("l") == 1:
            x0, y0, x1, y1 = p.bbox()
            if 3.0 < max(x1 - x0, y1 - y0) < 6.0 and min(x1 - x0, y1 - y0) < 1e-6:
                out.append((x0, y0, x1, y1))
    return out


def _left_ticks(strokes, frame) -> list[float]:
    """y of the horizontal ticks that start on the frame's left edge, frame bottom included."""
    fx0, fy0, _, fy1 = frame
    ys = [y0 for x0, y0, x1, y1 in strokes if y1 == y0 and abs(x0 - fx0) < 0.05 and fy0 < y0 < fy1]
    return [fy0, *sorted(ys)]


def _bottom_ticks(strokes, frame) -> list[float]:
    """x of the vertical ticks that start on the frame's bottom edge."""
    fx0, fy0, fx1, _ = frame
    return sorted(x0 for x0, y0, x1, y1 in strokes if x1 == x0 and abs(y0 - fy0) < 0.05 and fx0 < x0 < fx1)


def _axis(pixels: Sequence[float], values: Sequence[float]) -> tuple[float, float, float]:
    """Least-squares line value = a·position + b, and the largest residual (in value units)."""
    a, b = np.polyfit(pixels, values, 1)
    residual = float(np.max(np.abs(np.asarray(values) - (a * np.asarray(pixels) + b))))
    return float(a), float(b), residual


def figure4(pdf: Path) -> dict[str, list]:
    """Marker centres and error bars of Figure 4, converted to grind setting, time and EY.

    Returns, per panel ("time", "ey"), rows (grind setting, value at the marker centre, half
    the error-bar length, value at the error bar's midpoint), and the largest residual of each
    axis calibration ("<panel>_axis_residual", in value units; "grind_axis_residual").
    """
    paths = page_paths(pdf, FIG4_PAGE)
    frames = _frames(paths)
    if len(frames) != 2:
        raise RuntimeError(f"figure 4: expected two panel frames, found {len(frames)}")
    strokes = _short_strokes(paths)
    circles = []
    for p in paths:
        if p.op == "f" and p.count("c") >= 4:
            x0, y0, x1, y1 = p.bbox()
            if 5.0 < x1 - x0 < 15.0 and abs((x1 - x0) - (y1 - y0)) < 0.5:
                circles.append(((x0 + x1) / 2, (y0 + y1) / 2))
    bars = []
    for p in paths:
        if p.op == "S" and p.count("l") == 2 and len(p.segments) == 3:
            x0, y0, x1, y1 = p.bbox()
            if x1 - x0 < 1e-6:
                bars.append((x0, y0, y1))
    xs = _bottom_ticks(strokes, frames[1])
    if len(xs) != len(GRIND_SETTINGS):
        raise RuntimeError(f"figure 4: found x ticks at {xs}")
    gx = _axis(xs, GRIND_SETTINGS)
    out: dict[str, list] = {"grind_axis_residual": [gx[2]]}
    for name, frame in (("time", frames[0]), ("ey", frames[1])):
        ticks = _left_ticks(strokes, frame)
        if len(ticks) != len(FIG4_TICK_VALUES[name]):
            raise RuntimeError(f"figure 4 {name}: found ticks at {ticks}")
        a, b, residual = _axis(ticks, FIG4_TICK_VALUES[name])
        points = sorted((c for c in circles if frame[1] < c[1] < frame[3]), key=lambda c: c[0])
        rows = []
        for cx, cy in points:
            bar = min(bars, key=lambda bb: abs(bb[0] - cx) + (0.0 if bb[1] <= cy <= bb[2] else 1e3))
            rows.append((gx[0] * cx + gx[1], a * cy + b, 0.5 * (bar[2] - bar[1]) * a, a * 0.5 * (bar[1] + bar[2]) + b))
        out[name] = rows
        out[f"{name}_axis_residual"] = [residual]
    return out


def figure2b(pdf: Path) -> dict[float, list[tuple[float, float]]]:
    """The four volume distributions of Figure 2B on a log-spaced diameter grid."""
    paths = page_paths(pdf, FIG2_PAGE)
    ax, bx, _ = _axis([p for p, _ in FIG2_X_TICKS], [math.log10(v) for _, v in FIG2_X_TICKS])
    ay, by, _ = _axis([p for p, _ in FIG2_Y_TICKS], [v for _, v in FIG2_Y_TICKS])
    lo, hi = (math.log10(v) for v in PSD_RANGE_UM)
    n = int(round((hi - lo) * PSD_GRID_PER_DECADE)) + 1
    grid = np.linspace(lo, hi, n)
    curves: dict[float, list[tuple[float, float]]] = {}
    for gs, (index, kind) in FIG2_CURVES.items():
        path = paths[index]
        x0, _, x1, _ = path.bbox()
        rows = []
        for logd in grid:
            x = (logd - bx) / ax
            if not x0 < x < x1:
                rows.append((10**logd, 0.0))
                continue
            ys = path.crossings_at_x(x, samples=200)
            if kind == "stroke":
                y = ys[-1] if ys else None
            else:
                y = 0.5 * (ys[-1] + ys[-2]) if len(ys) >= 2 else None
            value = 0.0 if y is None else max(0.0, ay * y + by)
            rows.append((10**logd, value))
        curves[gs] = rows
    return curves


def build(source: Path, out: Path) -> list[Path]:
    pdf = source / MANUSCRIPT
    report_sources([pdf, source / SUPPLEMENT])
    fig4 = figure4(pdf)
    rows = []
    for (gs, t, t_half, _), (gs2, ey, ey_half, _), t_table in zip(fig4["time"], fig4["ey"], SHOT_TIME_TABLE_S3):
        if abs(gs - gs2) > 0.01:
            raise RuntimeError("figure 4 panels are not aligned")
        rows.append([fmt(round(gs, 2)), fmt(t_table), fmt(t, 2), fmt(t_half, 2), fmt(ey, 3), fmt(ey_half, 3)])
    files = [write_csv(out / "cameron2020-ey-grind" / "ey_grind.csv",
                       ("grind_setting", "shot_time_s", "shot_time_figure_s", "shot_time_bar_s", "ey_percent",
                        "ey_bar_percent"), rows)]
    psd_rows = []
    for gs, curve in sorted(figure2b(pdf).items()):
        psd_rows += [[fmt(gs), fmt(d, 2), fmt(v, 3)] for d, v in curve]
    files.append(write_csv(out / "cameron2020-psd" / "psd.csv", ("grind_setting", "diameter_um", "volume_percent"),
                           psd_rows))
    two_class = [[fmt(gs), fmt(f), fmt(b), fmt(FINES_RADIUS_UM), fmt(a2)]
                 for gs, (f, b, a2) in sorted(TWO_CLASS_TABLE_S2.items())]
    files.append(write_csv(out / "cameron2020-two-class" / "two_class.csv",
                           ("grind_setting", "fines_volume_fraction", "boulder_volume_fraction", "fines_radius_um",
                            "boulder_size_um"), two_class))
    for name in ("grind", "time", "ey"):
        print(f"figure 4 {name} axis: largest calibration residual {fig4[name + '_axis_residual'][0]:.2e}")
    return files


def main(argv: Sequence[str] | None = None) -> int:
    args = importer_parser(__doc__.splitlines()[0]).parse_args(argv)
    for path in build(args.source, args.out):
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
