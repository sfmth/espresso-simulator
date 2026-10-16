# SPDX-License-Identifier: GPL-2.0-or-later
"""Digitising scatter plots from raster figure images.

The method, used for figures that are only available as images:

1. **Axes.** Tick marks are short dark runs just outside the axis line; their
   intensity-weighted centres give pixel positions, and a straight-line fit
   against the tick labels gives the pixel → data mapping (the largest residual
   of that fit is reported as the calibration error).
2. **Markers.** Pixels of each marker colour are labelled into connected blobs.
   Each blob is fitted with k discs of the marker radius (k from the blob area
   divided by one marker's area), minimising the mismatch between the union of
   soft-edged discs and the blob; pixels covered by markers of other colours
   are ignored, so partly hidden markers keep unbiased centres.

Needs Pillow (installed with matplotlib) and SciPy.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.cluster.vq import kmeans2
from scipy.optimize import minimize


def load_rgb(path: Path) -> np.ndarray:
    """The image as a float array of shape (height, width, 3), values 0–255."""
    from PIL import Image  # imported lazily: only the importers need Pillow

    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=float)


def darkness(rgb: np.ndarray) -> np.ndarray:
    return 255.0 - rgb.mean(axis=2)


def run_centres(profile: np.ndarray, threshold: float) -> list[float]:
    """Intensity-weighted centres of the runs where ``profile`` exceeds ``threshold``."""
    idx = np.where(profile > threshold)[0]
    if idx.size == 0:
        return []
    out = []
    for run in np.split(idx, np.where(np.diff(idx) > 1)[0] + 1):
        lo, hi = max(int(run[0]) - 2, 0), min(int(run[-1]) + 3, profile.size)
        weights = profile[lo:hi]
        out.append(float((np.arange(lo, hi) * weights).sum() / weights.sum()))
    return out


@dataclass(frozen=True)
class Axis:
    """Linear mapping value = slope·pixel + intercept, with its largest calibration residual."""

    slope: float
    intercept: float
    residual: float

    @classmethod
    def fit(cls, pixels: list[float], values: list[float]) -> "Axis":
        if len(pixels) != len(values):
            raise ValueError(f"{len(pixels)} ticks found for {len(values)} labels")
        slope, intercept = np.polyfit(pixels, values, 1)
        resid = np.asarray(values) - (slope * np.asarray(pixels) + intercept)
        return cls(float(slope), float(intercept), float(np.max(np.abs(resid))))

    def __call__(self, pixel: float) -> float:
        return self.slope * pixel + self.intercept


@dataclass(frozen=True)
class Marker:
    x: float
    y: float
    #: Fitted together with overlapping markers of the same colour, or partly hidden by a marker
    #: of another colour (blob smaller than 80 % of one marker): its centre is less certain.
    overlapping: bool


def _fit_discs(blob: np.ndarray, ignore: np.ndarray, k: int, radius: float, init: list[tuple[float, float]]):
    ys, xs = np.where(blob)
    pad = int(radius) + 4
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, blob.shape[0] - 1)
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, blob.shape[1] - 1)
    gy, gx = np.mgrid[y0 : y1 + 1, x0 : x1 + 1]
    target = blob[y0 : y1 + 1, x0 : x1 + 1].astype(float)
    weight = (~ignore[y0 : y1 + 1, x0 : x1 + 1]).astype(float)

    def objective(p: np.ndarray) -> float:
        union = np.zeros_like(target)
        for j in range(k):
            dist = np.hypot(gx - p[2 * j], gy - p[2 * j + 1])
            union = 1.0 - (1.0 - union) * (1.0 - 1.0 / (1.0 + np.exp((dist - radius) / 0.5)))
        return float((weight * (union - target) ** 2).sum())

    p = np.array([c for xy in init for c in xy], dtype=float)
    for _ in range(3):
        p = minimize(objective, p, method="Nelder-Mead",
                     options={"xatol": 0.01, "fatol": 1e-4, "maxiter": 20000, "maxfev": 40000}).x
    return [(float(p[2 * j]), float(p[2 * j + 1])) for j in range(k)]


def find_markers(mask: np.ndarray, others: np.ndarray, marker_area: float, min_area: int = 40) -> list[Marker]:
    """Centres of disc markers in ``mask``; ``others`` marks pixels drawn over by other markers."""
    radius = float(np.sqrt(marker_area / np.pi))
    labels, count = ndimage.label(mask)
    markers: list[Marker] = []
    for label in range(1, count + 1):
        blob = labels == label
        area = int(blob.sum())
        if area < min_area:
            continue
        k = max(1, int(round(area / marker_area)))
        ys, xs = np.where(blob)
        if k == 1:
            init = [(float(xs.mean()), float(ys.mean()))]
        else:
            centres, _ = kmeans2(np.c_[xs, ys].astype(float), k, seed=1, minit="++")
            init = [(float(cx), float(cy)) for cx, cy in centres]
        partial = k == 1 and area < 0.8 * marker_area
        for cx, cy in _fit_discs(blob, others & ~blob, k, radius, init):
            markers.append(Marker(cx, cy, k > 1 or partial))
    return markers
