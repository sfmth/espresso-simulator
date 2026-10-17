# SPDX-License-Identifier: GPL-2.0-or-later
"""Render the recorded pressure-event comparison without simulations."""
from pathlib import Path
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import NullLocator


def main():
    report = json.loads(Path("docs/validation/m11-pressure-events.json").read_text())
    with plt.rc_context({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False}):
        fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.2), layout="constrained")
        for key, label, style in (("baseline", "0.6.2", "--"), ("corrected", "0.6.3", "-")):
            rows = report[key]["rows"]
            row = next(r for r in rows if r["amplitude"] == .5 and r["max_dt_s"] == .05)
            line, = axes[0].plot(row["focus_series"]["t_s"], row["focus_series"]["pressure_bar"],
                                style, marker="o", markersize=4, label=label)
            start = row["reported"]["switch_s"] + 4
            axes[0].axvline(start, color=line.get_color(), ls=":", alpha=.8)
            for amplitude, color in ((.5, "#246699"), (.509, "#b56816")):
                selected = sorted((r for r in rows if r["amplitude"] == amplitude),
                                  key=lambda r: r["max_dt_s"])
                axes[1].plot([1000*r["max_dt_s"] for r in selected],
                             [r["reported"]["pour_peak_pressure_bar"] for r in selected],
                             style, marker="o", color=color, markersize=4,
                             label=f"{label}, A = {amplitude:g}")
        axes[0].set(xlabel="Time from pump start (s)", ylabel="Inlet pressure (bar)",
                    title="A = 0.5, max step 0.05 s\nDotted lines: reported pour start")
        axes[1].set(xlabel="Maximum timestep (ms)", ylabel="Reported pour peak (bar)",
                    xscale="log", title="Fixed v4 coefficients; experiment 13")
        axes[1].set_xticks([6.25, 12.5, 25, 50], labels=["6.25", "12.5", "25", "50"])
        axes[1].xaxis.set_minor_locator(NullLocator())
        for ax in axes:
            ax.grid(alpha=.2)
            ax.legend(fontsize=8)
        output = Path("docs/validation/m11-pressure-events.png")
        fig.savefig(output, dpi=160)
        plt.close(fig)
        print(output)


if __name__ == "__main__":
    main()
