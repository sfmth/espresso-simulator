# SPDX-License-Identifier: GPL-2.0-or-later
"""Render the recorded startup-identification diagnostics without running simulations."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LogNorm
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("docs/validation/m11-startup-identification.json"))
    parser.add_argument("--output", type=Path, default=Path("docs/validation/m11-startup-identification.png"))
    args = parser.parse_args()
    report = json.loads(args.input.read_text())
    grid = report["training_grid"]["grid"]
    amplitudes = sorted({row["amplitude"] for row in grid})
    exponents = sorted({row["exponent"] for row in grid})
    costs = np.array([[next(row["cost"] for row in grid if row["amplitude"] == a and row["exponent"] == n)
                       for a in amplitudes] for n in exponents])
    with plt.rc_context({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False}):
        fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.2), layout="constrained")
        heatmap = axes[0].imshow(costs, norm=LogNorm(vmin=costs.min(), vmax=costs.max()),
                                 cmap="viridis", aspect="auto", origin="lower")
        axes[0].set(xticks=range(len(amplitudes)), xticklabels=[f"{a:g}" for a in amplitudes],
                    yticks=range(len(exponents)), yticklabels=[f"{n:g}" for n in exponents],
                    xlabel="Pore-air amplitude A", ylabel="Exponent n",
                    title="Training cost; other v4 coefficients fixed")
        for i in range(len(exponents)):
            for j in range(len(amplitudes)):
                axes[0].text(j, i, f"{costs[i, j]:.0f}", ha="center", va="center",
                             color="black" if costs[i, j] > 3500 else "white", fontsize=9)
        fig.colorbar(heatmap, ax=axes[0], label="Cost (log color scale)", fraction=0.046)
        rows = report["amplitude_grid"]["grid"]
        for step in sorted({row["max_dt_s"] for row in rows}, reverse=True):
            group = [row for row in rows if row["max_dt_s"] == step]
            axes[1].plot([row["amplitude"] for row in group],
                         [row["pour_peak_pressure_bar"] for row in group],
                         marker="o", markersize=3, label=f"Max step {step:g} s")
        axes[1].axhline(12, color="0.5", ls=":", lw=1)
        axes[1].set(xlabel="Pore-air amplitude A (n = 3)", ylabel="Pour-phase peak pressure (bar)",
                    title="Schmieder experiment 13: numerical probe")
        axes[1].legend(loc="upper left", fontsize=8)
        axes[1].grid(alpha=0.2)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(args.output, dpi=160)
        plt.close(fig)
    print(args.output)


if __name__ == "__main__":
    main()
