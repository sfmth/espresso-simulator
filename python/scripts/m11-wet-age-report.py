# SPDX-License-Identifier: GPL-2.0-or-later
"""Publish the frozen-parameter wet-age diagnosis; no simulations or fitting.

The JSON companion includes complete recorded specifications and sampled
hydraulic curves, so its figures can be reproduced independently of a build.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--from-json", type=Path)
    parser.add_argument("--output-prefix", type=Path, default=Path("docs/validation/m11-wet-age"))
    args = parser.parse_args()
    if args.from_json:
        report = json.loads(args.from_json.read_text())
    else:
        if not args.before or not args.after:
            parser.error("provide --before and --after, or --from-json")
        report = {"schema": "puckworks.wet-age-diagnosis/1",
                  "before": json.loads(args.before.read_text()), "after": json.loads(args.after.read_text()),
                  "source_sha256": {name: hashlib.sha256(path.read_bytes()).hexdigest()
                                    for name, path in (("before", args.before), ("after", args.after))}}
    assert all(report[version]["complete"] and len(report[version]["rows"]) == 24
               for version in ("before", "after"))
    prefix = args.output_prefix
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_suffix(".json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    fig, axes = plt.subplots(2, 2, figsize=(11.5, 7), sharex=True, layout="constrained")
    colors = {30: "#34445b", 150: "#087f9b", 300: "#bd4e13"}
    for column, experiment in enumerate((2, 13)):
        for version in ("before", "after"):
            for row in report[version]["rows"]:
                depth = row["spec"]["numerics"]["depth_cells"]
                if row["experiment"] != experiment or row["mechanism"] != "original":
                    continue
                if version == "before" and depth != 30:
                    continue
                series, diagnostics = row["series"], row["hydraulic_diagnostics"]
                label = f"{depth} layers" + (", old wet-age rule" if version == "before" else ", corrected")
                style = "--" if version == "before" else "-"
                axes[0, column].plot(series["t_s"], np.array(series["pressure_pa"])/1e5,
                                      style, color=colors[depth], label=label)
                axes[1, column].plot(series["t_s"],
                    np.asarray(diagnostics["capacity_at_cap_m3_s"], dtype=float)*1e6,
                    style, color=colors[depth], label=label)
                if version == "after" and depth == 300:
                    axes[1, column].plot(series["t_s"], np.array(diagnostics["command_m3_s"])*1e6,
                                        color="#6b6173", linestyle=":", label="Commanded flow")
        axes[0, column].set_title(f"Schmieder experiment {experiment}")
        axes[0, column].set_ylabel("Inlet pressure (bar)")
        axes[1, column].set_ylabel("Flow available at 12 bar (mL/s)")
        axes[1, column].set_xlabel("Time from pump start (s)")
        for ax in axes[:, column]:
            ax.set_xlim(8.8, 10.5)
            ax.grid(alpha=.2)
        axes[0, column].set_ylim(3.5, 12.5)
        axes[1, column].set_ylim(2.2, 3.4)
    axes[0, 0].legend(fontsize=8)
    axes[1, 0].legend(fontsize=8)
    fig.savefig(prefix.with_suffix(".png"), dpi=180, metadata={"Software": "Puckworks"})
    plt.close(fig)
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->",
        "# Wet-age resistance integration and model tuning", "",
        "The mesh experiment exposed a spatial averaging bias in the existing wetting closure. "
        "A cell used the arrival time at its top for all its wetted material. That made the "
        "younger material near its bottom artificially old and its hydraulic resistance too low.", "",
        "These **48 frozen-v5 pressure windows** isolate that numerical effect before refitting. "
        "The original and corrected builds each run experiments 2 and 13 on 30, 150 and 300 layers, "
        "with four mechanism settings. Timesteps are 6.25, 12.5 and 6.25 ms respectively; all use "
        "the complete species set, a 15 s time stop, no drip, and 0.1 s output spacing. "
        "The ablations disabling viscosity feedback or pore-air relaxation are diagnostics, "
        "not proposed parameter values or new calibration candidates.", "",
        "## Diagnosis", "",
        "Maximum differences below compare interpolated sampled curves at identical pump times "
        "from 8.5 to 12.5 s. Conductance is reconstructed from the recorded inlet/outlet flows "
        "with the exact existing poroelastic and outlet laws; no compliance is present.", "",
        "| Build | Experiment | Mesh compared with 300 | Max pressure difference (bar) | Max relative conductance difference |",
        "|---|---:|---:|---:|---:|"]
    for version in ("before", "after"):
        for row in report[version]["comparisons"]:
            if row["mechanism"] == "original":
                metrics = row["metrics"]
                lines.append(f"| {version} | {row['experiment']} | {row['depth_cells']} | "
                    f"{metrics['pressure_pa']['max_absolute_difference']/1e5:.4f} | "
                    f"{100*metrics['conductance_m3_pa_s']['max_relative_difference']:.4f}% |")
    lines += ["", "With the old rule, disabling pore-air relaxation reduces the 30-to-300-layer "
        "conductance discrepancy from 7.15–7.51% to 0.18%. Disabling concentration-dependent "
        "viscosity alone leaves 3.81–4.41%. This identifies wet-age averaging as the dominant "
        "spatial error in these cases, with viscosity feedback and the poroelastic plateau amplifying it.", "",
        "The inverse pressure problem is ill-conditioned near its capacity: "
        r"$Q=G\Phi(P)$ has $\Phi'(P)=(1-P/P_c)^3$ below $P_c$. Thus small conductance errors "
        "can produce multi-bar pressure changes. A stable 12 bar capped peak is not a convergence test.", "",
        "![Pressure and available flow](" + prefix.name + ".png)", "",
        "## Numerical correction", "",
        "The solver records cell entry and exit times and interpolates arrival time in bed-volume "
        "coordinates. It integrates **inverse mobility** over the wetted depth using positive "
        "Gaussian weights, normalized against the exact geometric Darcy integral. Steep "
        "relaxations trigger adaptive subdivision with a relative comparison tolerance of $10^{-8}$; "
        "an endpoint variation bound also prevents both rules from missing the same narrow layer. "
        "Exhausting 40 subdivision levels produces a diagnostic warning.", "",
        "Partial cells retain their actual last-advance time during a soak. Explicit arrival-time "
        "breakpoints preserve material wetted before a pause when flow resumes, including in the "
        "hydraulic predictor. All timing history is restored when a step is retried. "
        "Arrival time within each uninterrupted segment is still reconstructed linearly; "
        "transport still mixes each wetted cell and uses its existing exchange discretization.", "",
        "Independent tests cover the analytic constant-speed-front resistance integral, a paused "
        "partial cell, continuity under an infinitesimal restart, subsequent breakthrough, "
        "rollback, and steep $A=0.9,n=5$ and $A=0.95,n=10$ closures, including a 0.1 ms "
        "relaxation. A separate sub-resolution case verifies the warning. All 48 diagnostic shots "
        "complete with nonnegative concentrations and conserved water/solute. None reaches "
        "the adaptive quadrature limit.", "",
        "## Calibration protocol", "",
        "The subsequent tuning retains v5's effective 22-parameter configuration, observations, "
        "weights and physical bounds. It first profiles a common V1 permeability shift using "
        "training data, then uses a 30-layer optimization only as a warm start for a 150-layer "
        "fit. Finer-grid and timestep checks are required before promotion. "
        "V3, V4 startup and V5 remain outside the training objective; previously inspected "
        "holdouts are not newly independent validation.", "",
        "Optimizer coordinates are normalized to each parameter's bounds. This removes the "
        "dependence of the step termination test on mixed physical/log units; returned parameters "
        "and uncertainty Jacobians retain their original units. Incomplete source fractions "
        "or failure to reach a requested stop now produce failure residuals.", "",
        "This diagnosis alone does not establish a new calibrated model, a converged pressure "
        "waveform at every input, or a resolution of the held-out startup and extraction-peak failures.", "",
        "## Reproduction", "", "```bash",
        ".venv/bin/python python/scripts/m11-wet-age-report.py \\",
        f"  --from-json {prefix.with_suffix('.json')}", "```", "",
        "The [JSON companion](" + prefix.name + ".json) retains exact specifications, solver identities, "
        "sampled curves, diagnostics and source hashes. Original full solver records remain in the "
        "ablation run caches. Native timings were collected during development and are not "
        "controlled performance benchmarks.", ""]
    prefix.with_suffix(".md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
