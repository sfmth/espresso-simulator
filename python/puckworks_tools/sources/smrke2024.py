# SPDX-License-Identifier: GPL-2.0-or-later
"""Smrke, Eiermann & Yeretzian (2024), Sci. Rep. 14:5612 (CC BY 4.0): fines and espresso extraction.

The data are available only on request, so Figures 2 and 3 are digitised from
the published images (``raster``). Source files expected in SOURCE_DIR (the
"full size" PNGs of the article page, https://www.nature.com/articles/s41598-024-55831-x):

- ``fig2.png``: median particle size X50 versus share of fines Q100µm (black: no
  fines added; red: 1, 2 or 4 g of sieved fines added);
- ``fig3.png``: extraction yield versus extraction time, coloured by added fines.

Figure 3 does not label grinder settings. Within each fines group the points fall
into well-separated time clusters, one per grinder setting, in the order the
settings were ground (finer setting → longer time); Figure 7, which labels every
point with its setting, confirms the assignment (cluster ranges below).
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from scipy import ndimage

from .common import fmt, importer_parser, report_sources, write_csv
from .raster import Axis, darkness, find_markers, load_rgb, run_centres

FIG2 = "fig2.png"
FIG3 = "fig3.png"

FIG2_X_LABELS = [240.0, 260.0, 280.0, 300.0, 320.0, 340.0, 360.0]
FIG2_Y_LABELS = [30.0, 25.0, 20.0, 15.0]  # top to bottom
FIG3_X_LABELS = [0.0, 20.0, 40.0, 60.0, 80.0]
FIG3_Y_LABELS = [24.0, 22.0, 20.0, 18.0, 16.0]  # top to bottom

#: Figure 2: grinder setting (burr gap, µm) of the six black points, in order of X50.
FIG2_SETTINGS = [160, 170, 180, 190, 210, 250]
#: Figure 2: (base setting, added fines in g) of the nine red points, in order of X50. Each
#: red point lies on the dotted line through its base setting's black point.
FIG2_RED = [(190, 4), (190, 2), (210, 4), (190, 1), (210, 2), (210, 1), (250, 4), (250, 2), (250, 1)]

#: Figure 3: per fines group, grinder settings and the extraction-time breakpoints (s) between
#: their clusters, from fastest (coarsest) to slowest (finest).
FIG3_CLUSTERS = {
    0: ([250, 210, 190, 180, 170, 160], [13.0, 21.0, 35.0, 50.0, 60.0]),
    1: ([250, 210, 190], [17.0, 30.0]),
    2: ([250, 210, 190], [25.0, 45.0]),
    4: ([250, 210, 190], [45.0, 70.0]),
}

MARKER_AREA_FIG2 = 150.0
MARKER_AREA_FIG3 = 148.0


def axes(rgb: np.ndarray, x_labels: list[float], y_labels: list[float]) -> tuple[Axis, Axis, int, int]:
    """Pixel → data axes from the tick marks next to the axis lines; also the axis row and column."""
    dark = darkness(rgb)
    h, w = dark.shape
    rows = (dark > 150).sum(axis=1)
    cols = (dark > 150).sum(axis=0)
    x_row = int(np.argmax(rows[int(0.6 * h):]) + int(0.6 * h))
    y_col = int(np.argmax(cols[: int(0.3 * w)]))
    # the axis lines are 2 px wide: use the outermost line of each
    while x_row + 1 < h and rows[x_row + 1] > 0.5 * rows[x_row]:
        x_row += 1
    while y_col - 1 >= 0 and cols[y_col - 1] > 0.5 * cols[y_col]:
        y_col -= 1
    x_ticks = run_centres(dark[x_row + 2 : x_row + 9, y_col + 6 :].sum(axis=0), 300.0)
    y_ticks = run_centres(dark[: x_row - 6, y_col - 11 : y_col - 2].sum(axis=1), 300.0)
    x_axis = Axis.fit([t + y_col + 6 for t in x_ticks], x_labels)
    y_axis = Axis.fit(y_ticks, y_labels)
    return x_axis, y_axis, x_row, y_col


def figure2(path: Path) -> list[tuple[int, int, float, float]]:
    """(setting, added fines g, X50 µm, Q100µm %) for the 15 samples."""
    rgb = load_rgb(path)
    x_axis, y_axis, x_row, y_col = axes(rgb, FIG2_X_LABELS, FIG2_Y_LABELS)
    inner = np.zeros(rgb.shape[:2], bool)
    inner[5 : x_row - 3, y_col + 5 :] = True
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    opened = {}
    for name, mask in (("black", rgb.max(axis=2) < 90), ("red", (r > 180) & (g < 90) & (b < 90))):
        # open with a 5x5 square to drop the dotted fit lines that touch the markers
        opened[name] = ndimage.binary_opening(mask & inner, structure=np.ones((5, 5)))
    nothing = np.zeros_like(inner)
    black = sorted(find_markers(opened["black"], nothing, MARKER_AREA_FIG2), key=lambda m: m.x)
    red = sorted(find_markers(opened["red"], nothing, MARKER_AREA_FIG2), key=lambda m: m.x)
    if len(black) != len(FIG2_SETTINGS) or len(red) != len(FIG2_RED):
        raise RuntimeError(f"figure 2: found {len(black)} black and {len(red)} red markers")
    out = [(s, 0, x_axis(m.x), y_axis(m.y)) for s, m in zip(FIG2_SETTINGS, black)]
    base = {s: q for s, _, _, q in out}
    for (setting, grams), m in zip(FIG2_RED, red):
        q = y_axis(m.y)
        # mass balance check: the sieved fines must be about 50-80 % below 100 µm
        share = (q * 20.0 - base[setting] * (20.0 - grams)) / grams
        if not 45.0 < share < 85.0:
            raise RuntimeError(f"figure 2: point {setting}/{grams} g gives a fines share of {share:.0f} %")
        out.append((setting, grams, x_axis(m.x), q))
    print(f"figure 2: axis residuals x {x_axis.residual:.3f} µm, y {y_axis.residual:.4f} %")
    return sorted(out, key=lambda row: (row[0], row[1]))


def figure3(path: Path) -> list[tuple[int, int, float, float, bool]]:
    """(setting, added fines g, extraction time s, extraction yield %, marker overlapped)."""
    rgb = load_rgb(path)
    x_axis, y_axis, x_row, y_col = axes(rgb, FIG3_X_LABELS, FIG3_Y_LABELS)
    h, w = rgb.shape[:2]
    inner = np.zeros((h, w), bool)
    inner[5 : x_row - 3, y_col + 5 :] = True
    inner[int(0.75 * h) :, int(0.75 * w) :] = False  # the legend box
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    masks = {
        0: rgb.max(axis=2) < 100,
        1: (b > 200) & (r < 150) & (g < 150),
        2: (r > 170) & (r < 230) & (g < 130) & (b > 120) & (b < 200),
        4: (r > 220) & (g < 130) & (b > 80) & (b < 150),
    }
    any_marker = np.zeros((h, w), bool)
    for mask in masks.values():
        any_marker |= mask & inner
    out = []
    for grams, mask in masks.items():
        settings, breaks = FIG3_CLUSTERS[grams]
        for m in find_markers(mask & inner, any_marker, MARKER_AREA_FIG3):
            t, ey = x_axis(m.x), y_axis(m.y)
            setting = settings[int(np.searchsorted(breaks, t))]
            out.append((setting, grams, t, ey, m.overlapping))
    print(f"figure 3: axis residuals x {x_axis.residual:.3f} s, y {y_axis.residual:.4f} %")
    return sorted(out, key=lambda row: (row[0], row[1], row[2]))


def build(source: Path, out: Path) -> list[Path]:
    report_sources([source / FIG2, source / FIG3])
    psd = [[str(s), str(gm), fmt(x50, 1), fmt(q, 2)] for s, gm, x50, q in figure2(source / FIG2)]
    shots = [[str(s), str(gm), fmt(t, 2), fmt(ey, 3), "true" if overlapped else "false"]
             for s, gm, t, ey, overlapped in figure3(source / FIG3)]
    return [
        write_csv(out / "smrke2024-psd" / "psd.csv", ("grinder_setting_um", "fines_added_g", "x50_um", "q100_percent"),
                  psd),
        write_csv(out / "smrke2024-shots" / "shots.csv",
                  ("grinder_setting_um", "fines_added_g", "extraction_time_s", "ey_percent", "overlapping"), shots),
    ]


def main(argv: Sequence[str] | None = None) -> int:
    args = importer_parser(__doc__.splitlines()[0]).parse_args(argv)
    for path in build(args.source, args.out):
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
