# SPDX-License-Identifier: GPL-2.0-or-later
"""Digitise the resolved wet Q3 curves in Schmieder 2023, Fig. A1(b).

Run with the published ``schmieder2023.pdf`` in SOURCE_DIR. The PDF is CC BY
4.0; its SHA-256 is pinned because the pixel coordinates depend on this edition.
``pdftoppm`` and the optional ``sources`` Python dependencies are needed only
when importing. No source download or simulation occurs here.

The sub-3 µm cumulative curves cannot be separated reliably from the axis and
overlapping colours. They are deliberately omitted. The case builder uses the
first resolved cumulative share and the independently reported D32 to represent
this unresolved head; these CSV rows are not raw instrument measurements.
"""

from __future__ import annotations

import subprocess
import tempfile
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from .common import importer_parser, report_sources, sha256, write_csv
from .raster import load_rgb

PDF = "schmieder2023.pdf"
PDF_SHA256 = "e7ff3e581fb3c5fc3e0148124929748aa153ab0990d8372079c02bd33a0e2a75"
DATASET = "schmieder2023-psd"
HEADER = (
    "grind_level", "diameter_um", "cumulative_volume_fraction", "reported_d32_um",
    "reported_d32_sd_um", "reported_d43_um", "reported_d43_sd_um",
    "raw_cumulative_volume_fraction",
)
# Article §2.4: wet laser-diffraction means and their reported standard deviations.
MOMENTS = {1.4: (28.3, 1.6, 273.0, 7.6), 1.7: (26.9, 3.2, 277.0, 17.0),
           2.0: (29.2, 1.4, 295.0, 18.0)}
# Axes in the 600 dpi crop (x=2540, y=4020, width=1710, height=1260).
# Log diameter: 0.1, 1, 10, 100, 1000 µm at x≈216,532,846,1161,1476.
# The 315 px/decade mapping misses the intermediate ticks by at most 1 px.
X_ORIGIN = 216.0
PX_PER_DECADE = 315.0
Y_ZERO = 1099.0
Y_HUNDRED = 130.0
# Errorbar columns. Omit x=1044,1067,1092 where q3 and Q3 overlap, and the
# unresolved head. No points are invented in these gaps.
COLUMNS = (683, 706, 731, 754, 778, 802, 826, 850, 873, 898, 922, 947,
           970, 995, 1019, 1116, 1140, 1164, 1188, 1213, 1236, 1261,
           1286, 1310, 1334, 1359, 1383, 1407, 1432, 1457)
# Loose guide to separate Q3 from q3 and the legend, not the digitised values.
GUIDE_X = (683, 731, 778, 826, 873, 922, 970, 1019, 1116, 1164, 1213,
           1261, 1310, 1334, 1359, 1383, 1407, 1432, 1457)
GUIDE_Q = (.021, .028, .037, .048, .063, .087, .125, .17, .30, .34, .38,
           .43, .53, .62, .74, .85, .93, .97, .995)


def monotone_cdf(values: Sequence[float]) -> np.ndarray:
    """Equal-weight least-squares isotonic projection (pooled adjacent violators)."""
    blocks: list[tuple[float, int]] = []
    for value in values:
        blocks.append((float(value), 1))
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            right, nr = blocks.pop()
            left, nl = blocks.pop()
            blocks.append(((nl * left + nr * right) / (nl + nr), nl + nr))
    return np.asarray([mean for mean, count in blocks for _ in range(count)])


def visible_span_midpoint(mask: np.ndarray, x: int, expected_y: float, half: int) -> float:
    """Full coloured errorbar span, including gaps occluded by another curve.

    Taking the longest *connected* run mistakes a half-hidden errorbar for its
    entirety. In the source this displaced some blue means by 25–27 pixels.
    Search neighbouring columns to include the full bar and its end caps.
    """
    lo, hi = max(0, int(expected_y - half)), min(1098, int(expected_y + half) + 1)
    ys = np.arange(lo, hi)
    best: tuple[int, float] | None = None
    for column in range(x - 4, x + 5):
        visible = ys[mask[ys, column - 1:column + 2].any(axis=1)]
        if visible.size:
            span = int(visible[-1] - visible[0])
            if best is None or span > best[0]:
                best = span, float((visible[0] + visible[-1]) / 2)
    if best is None:
        raise ValueError(f"no resolved Q3 pixels at x={x}")
    return best[1]


def figure_rows(rgb: np.ndarray) -> tuple[list[tuple[float, ...]], dict[float, list[tuple[int, float]]]]:
    """CSV rows and the selected pixel centres for visual review."""
    if rgb.shape != (1260, 1710, 3):
        raise ValueError("expected the pinned 1710×1260 pixel figure crop")
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    masks = {1.4: (r > 170) & (g > 55) & (g < 190) & (b < 100),
             1.7: (b > 150) & (r < 110) & (g < 130),
             2.0: rgb.max(axis=2) < 90}
    rows, selected = [], {}
    guide_y = Y_ZERO - (Y_ZERO - Y_HUNDRED) * np.asarray(GUIDE_Q)
    for grind, mask in masks.items():
        points, raw = [], []
        for x in COLUMNS:
            expected = float(np.interp(x, GUIDE_X, guide_y))
            half = 10 if x < 700 else (18 if x < 1000 else (35 if x < 1100 else 95))
            y = visible_span_midpoint(mask, x, expected, half)
            q = (Y_ZERO - y) / (Y_ZERO - Y_HUNDRED)
            if not 0 <= q <= 1:
                raise ValueError(f"out-of-range Q3 for GL {grind} at x={x}: {q}")
            points.append((x, y))
            raw.append(q)
        # Overlaid colours can leave small local reversals. Project to the nearest
        # nondecreasing CDF (equal-weight least squares), retaining the raw values.
        # This is a digitisation correction, not a fit to extraction outcomes.
        monotone = monotone_cdf(raw)
        correction = float(np.max(np.abs(monotone - raw)))
        if correction > 0.01:
            raise ValueError(f"GL {grind}: CDF correction {correction:g} exceeds one percentage point")
        print(f"GL {grind}: largest monotonicity correction {correction:.6g} volume fraction")
        for x, q, raw_q in zip(COLUMNS, monotone, raw):
            diameter = 10 ** (-1 + (x - X_ORIGIN) / PX_PER_DECADE)
            rows.append((grind, diameter, float(q), *MOMENTS[grind], raw_q))
        # Explicit support assumption at the visible plot endpoint; not another measurement.
        rows.append((grind, 1000.0, 1.0, *MOMENTS[grind], 1.0))
        selected[grind] = points
    return rows, selected


def import_source(source: Path, out: Path, review_dir: Path | None = None) -> Path:
    pdf = source / PDF
    if sha256(pdf) != PDF_SHA256:
        raise ValueError("the source PDF differs from the edition used for this digitisation")
    with tempfile.TemporaryDirectory(prefix="puckworks-schmieder-psd-") as tmp:
        prefix = Path(tmp) / "wet"
        subprocess.run(["pdftoppm", "-f", "15", "-l", "15", "-r", "600", "-x", "2540",
                        "-y", "4020", "-W", "1710", "-H", "1260", "-singlefile", "-png",
                        str(pdf), str(prefix)], check=True, capture_output=True)
        rgb = load_rgb(prefix.with_suffix(".png"))
        rows, selected = figure_rows(rgb)
        if review_dir is not None:
            import matplotlib.pyplot as plt

            review_dir.mkdir(parents=True, exist_ok=True)
            fig, axes = plt.subplots(3, 1, figsize=(10, 12))
            for ax, (grind, points) in zip(axes, selected.items()):
                ax.imshow(rgb.astype(np.uint8))
                x, y = zip(*points)
                ax.plot(x, y, "o", markersize=5, markerfacecolor="none", color="#16859a")
                ax.set(xlim=(660, 1490), ylim=(1110, 110), title=f"GL {grind}: selected Q3 centres")
                ax.axis("off")
            fig.suptitle("Schmieder et al. (2023), Fig. A1(b), CC BY 4.0 — Puckworks digitisation")
            fig.tight_layout()
            fig.savefig(review_dir / "schmieder-wet-cdf-review.png", dpi=150)
            plt.close(fig)
    report_sources([pdf])
    return write_csv(out / DATASET / "psd.csv", HEADER, rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = importer_parser(__doc__)
    parser.add_argument("--review-dir", type=Path, help="write a visual overlay of the selected centres")
    args = parser.parse_args(argv)
    print(import_source(args.source, args.out, args.review_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
