# SPDX-License-Identifier: GPL-2.0-or-later
"""Render a compact, reproducible mesh-refinement artifact, tables and figures.

  .venv/bin/python python/scripts/m11-mesh-report.py \
    --input .local/mesh-refinement/mesh-refinement.json

The compact JSON retains every input, summary and scored observation. Large
snapshot matrices are reduced to area-weighted profiles for the plotted cases;
unplotted time series and redundant per-fraction V1 observations are omitted.
The companion JSON can be passed as --input to regenerate the tables and plots.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


LABELS = {"baseline": "30 layers", "depth_5x": "150 layers (5×)", "depth_10x": "300 layers (10×)",
          "baseline_half_dt": "30 layers, half timestep", "depth_10x_half_dt": "300 layers, half timestep",
          "columns_5x": "40 columns (5×)", "columns_8x": "64 columns (8×)",
          "shells_5x": "40 shells (5×)", "shells_8x": "64 shells (8×)", "joint": "150 layers, 16 columns, 16 shells"}
DEPTH = ("baseline", "depth_5x", "depth_10x")
COLORS = ("#334155", "#0284c7", "#e16b19", "#8b5cf6")


def row(variant, group, case=None):
    return next(r for r in variant["rows"] if r["group"] == group and (case is None or r["case"] == case))


def compact(report, source_hash):
    out = copy.deepcopy(report)
    out.setdefault("full_record_sha256", source_hash)
    out["compact_record"] = True
    for name, variant in out["variants"].items():
        for r in variant["rows"]:
            if r.get("observations"):
                r["observations"].pop("fractions", None)
                if r["group"] == "V4":
                    for field in ("flow_t_s", "flow_g_s", "transient_t_s", "transient_flow_g_s"):
                        if name not in DEPTH:
                            r["observations"].pop(field, None)
            keep = r["group"] == "generic" and name in DEPTH
            if "series" in r:
                if keep:
                    r["series"] = {k: v for k, v in r["series"].items()
                                   if k in ("t_s", "ey", "tds_outlet", "beverage_mass_kg")}
                else:
                    r.pop("series")
            if "spatial" in r:
                spatial = r.pop("spatial")
                if keep:
                    weights = [c["area_fraction"] for c in spatial["columns"]]
                    r["final_profile"] = {"depth_m": spatial["depth_m"],
                        "local_ey": np.average(spatial["snapshots"][-1]["local_ey"], axis=0, weights=weights).tolist()}
    return out


def extrema(variant, metric, relative=False, group=None):
    field = "relative_difference" if relative else "difference"
    values = [d for d in variant["comparison"] if (d["metric"] == metric or d["metric"].startswith(metric + "/"))
              and (group is None or d["group"] == group) and d[field] is not None]
    return max(values, key=lambda d: abs(d[field])) if values else None


def pairwise(before, after):
    old = {(d["case"], d["metric"]): d for d in before["comparison"]}
    maxima = {}
    for d in after["comparison"]:
        previous = old[d["case"], d["metric"]]
        a, b = previous["refined"], d["refined"]
        if a is None or b is None:
            continue
        key = d["metric"].split("/")[0]
        item = {"case": d["case"], "metric": d["metric"], "before": a, "after": b,
                "absolute_difference": abs(b - a), "relative_difference": (b / a - 1) if a else None}
        if key not in maxima or item["absolute_difference"] > maxima[key]["absolute_difference"]:
            maxima[key] = item
    return maxima


def figures(report, prefix):
    variants = report["variants"]
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "figure.facecolor": "white", "savefig.facecolor": "white"})
    fig, axes = plt.subplots(2, 2, figsize=(11, 7.5), constrained_layout=True)
    for name, color in zip(DEPTH, COLORS):
        r = row(variants[name], "generic")
        series, profile = r["series"], r["final_profile"]
        axes[0, 0].plot(series["t_s"], np.array(series["ey"]) * 100, label=LABELS[name], color=color)
        axes[0, 1].plot(np.array(series["beverage_mass_kg"]) * 1e3,
                        np.array(series["tds_outlet"]) * 100, color=color)
        axes[1, 0].plot(np.array(profile["local_ey"]) * 100, np.array(profile["depth_m"]) * 1e3, color=color)
    axes[0, 0].set(xlabel="Time from pump start (s)", ylabel="Cup extraction yield (%)",
                   title="18 g → 36 g recipe, including subsequent drip")
    axes[0, 0].legend(frameon=False)
    axes[0, 1].set(xlabel="Beverage mass (g)", ylabel="Outlet TDS (%)", title="Instantaneous outlet concentration")
    axes[1, 0].set(xlabel="Local extraction yield (%)", ylabel="Depth below puck top (mm)",
                   title="Final bed profile, averaged across flow paths")
    axes[1, 0].invert_yaxis()
    axes[1, 1].bar([LABELS[n] for n in DEPTH], [row(variants[n], "generic")["wall_s"] for n in DEPTH], color=COLORS[:3])
    axes[1, 1].set(ylabel="Native Python/Rust call (s)", title="Measured compute time; one run per mesh")
    fig.suptitle("Depth refinement: extraction changes modestly", fontsize=16)
    fig.savefig(prefix.with_suffix(".png"), dpi=180)
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), constrained_layout=True)
    for name, color in zip((*DEPTH, "depth_10x_half_dt"), COLORS):
        rows = [r for r in variants[name]["rows"] if r["group"] == "V1"]
        axes[0].plot([r["experiment"] for r in rows],
                     [r["observations"]["pour_peak_pressure_bar"] for r in rows],
                     marker="o", markersize=3, color=color, label=LABELS[name])
    axes[0].set(xlabel="Schmieder experiment", ylabel="Pour peak pressure (bar)",
                title="Pressure is more sensitive to resolution", xticks=range(1, 16, 2))
    axes[0].legend(frameon=False, fontsize=8)
    data = report["inputs"]["waszkiewicz2026/p9"]["info"]["transient"]
    axes[1].plot([r["time_s"] for r in data], [r["flow_g_s"] for r in data],
                 color="#64748b", linestyle="--", label="Measured")
    for name, color in zip(DEPTH, COLORS):
        r = row(variants[name], "V4")
        obs = r["observations"]
        axes[1].plot(np.array(obs["flow_t_s"]) - obs["offset_s"], obs["flow_g_s"], color=color, label=LABELS[name])
    axes[1].set(xlabel="Time after pressure rise (s)", ylabel="Beverage mass flow (g/s)", xlim=(0, 45),
                title="Finer depth grid versus the held-out startup transient")
    axes[1].legend(frameon=False, fontsize=8)
    fig.savefig(prefix.with_name(prefix.name + "-pressure").with_suffix(".png"), dpi=180)
    plt.close(fig)
    if report.get("pressure_windows"):
        fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), constrained_layout=True)
        selected = ((30, .05, "30 layers, 50 ms"), (150, .05, "150 layers, 50 ms"),
                    (300, .05, "300 layers, 50 ms"), (300, .003125, "300 layers, 3.125 ms"),
                    (600, .00625, "600 layers, 6.25 ms"))
        for ax, experiment in zip(axes, (2, 13)):
            for (depth, dt, label), color in zip(selected, (*COLORS, "#059669")):
                r = next(r for r in report["pressure_windows"]["rows"] if r["experiment"] == experiment
                         and r["depth_cells"] == depth and r["max_dt_s"] == dt)
                ax.plot(r["series"]["t_s"], np.array(r["series"]["pressure_pa"]) / 1e5, label=label, color=color)
            ax.axhline(12, color="#94a3b8", linestyle="--", linewidth=.8)
            ax.axvline(r["ramp_end_s"], color="#94a3b8", linestyle=":", linewidth=1)
            ax.set(xlabel="Time from pump start (s)", ylabel="Inlet pressure (bar)", xlim=(8.8, 10.5),
                   title=f"Experiment {experiment}: end of the ramp (dotted)")
        axes[0].legend(frameon=False, fontsize=8)
        fig.savefig(prefix.with_name(prefix.name + "-pressure-window").with_suffix(".png"), dpi=180)
        plt.close(fig)


def verify(report):
    assert report["complete"] and report["identity_unchanged"]
    assert len(report["variants"]) == 10
    baseline = report["variants"]["baseline"]
    assert baseline["v1"]["score"]["lambda_within"] == 51
    assert baseline["v1"]["score"]["cup_within"] == 174
    assert abs(baseline["v1"]["cost"] - 478.5197889009374) < 1e-6
    for name, variant in report["variants"].items():
        assert variant["completed"] == variant["required"] == 24
        assert variant["v1"]["score"]["lambda_missing"] == variant["v1"]["score"]["cup_missing"] == 0
        definition = report["variant_definitions"][name]
        for r in variant["rows"]:
            assert r["actual_bed_cells"] == definition["depth_cells"] * definition["columns"]
            assert abs(r["diagnostics"]["mass_balance_error"]) < 1e-9
            assert abs(r["diagnostics"]["hydraulic_volume_balance_error"]) < 1e-9
            assert r["diagnostics"]["min_concentration_kg_m3"] >= -1e-12
            base = report["inputs"][r["case"]]["spec"]
            assert r["numerics"]["output_interval_s"] == base["numerics"]["output_interval_s"]
            assert r["size_classes"] == len(base["bed"]["size_classes"])
    return {"completed_shots": 240, "baseline_reproduces_v5": True, "requested_meshes_verified": True,
            "all_observations_available": True, "mass_and_volume_residuals_below_1e_9": True,
            "concentrations_nonnegative": True}


def markdown(report, prefix):
    variants = report["variants"]
    pairs = report["pairwise_maxima"]
    depth = pairs["150_to_300_layers"]
    timestep = pairs["300_layers_half_timestep"]
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->", "# Fixed-v5 mesh refinement", "",
        f"The recorded solver is puckcore {report['identity']['solver']['puckcore_version']}. "
        "All 240 runs complete: 24 conditions on each of ten grids/timestep combinations. "
        "The conditions are all 15 Schmieder calibration shots, seven held-out Cameron grind settings, "
        "the Waszkiewicz 9-bar long shot (whose startup transient is held out), and one generic EK43 "
        "18 g → 36 g recipe. The v5 parameters and physical inputs stay fixed; there is no refit.", "",
        "## Findings", "",
        f"The 10× depth grid changes final cup extraction by at most "
        f"{100*abs(extrema(variants['depth_10x'], 'ey')['difference']):.4f} percentage points across the 24 conditions. "
        f"The additional change from 150 to 300 layers is at most {100*depth['ey']['absolute_difference']:.4f} points "
        f"and {depth['shot_time_s']['absolute_difference']:.4f} s of shot time. "
        "Bulk extraction is comparatively insensitive in this tested range.", "",
        "Pressure is materially grid-sensitive. Experiment 13's pour peak moves from "
        f"{row(variants['baseline'], 'V1', 'schmieder2023/exp13')['observations']['pour_peak_pressure_bar']:.3f} bar "
        "to the 12-bar pump cap on both finer depth grids. Halving the 300-layer timestep retains that cap; "
        f"across all conditions it changes EY by at most {100*timestep['ey']['absolute_difference']:.4f} points "
        f"and shot time by {timestep['shot_time_s']['absolute_difference']:.4f} s. "
        f"Its largest pour-peak change elsewhere is {timestep['pour_peak_pressure_bar']['absolute_difference']:.4f} bar. "
        "The frozen fit's pressure residuals therefore need reevaluation on a chosen refined grid.", "",
        "Finer depth resolution moves the held-out startup transient toward the measurements, but leaves "
        "a large timing discrepancy. It also leaves the Cameron extraction maximum at the finest tested "
        "grind rather than the observed interior peak. These experiments do not close the scientific "
        "validation gates or select new fitted parameters. The application default remains unchanged; "
        "the finer grids are reproducible through the study script and raw shot numerical settings.", "",
        "## Resolution and overall changes", "",
        "Differences below are maxima over the same 24 conditions, relative to the 30-layer baseline. "
        "EY and TDS changes are percentage points, not relative percentages. Runtime ratios are medians "
        "of paired serial native Python/Rust calls, including JSON conversion; these are single-run "
        "measurements, not browser benchmarks.", "",
        "| Variant | Layers × columns | Particle shells | Max timestep (s) | Max absolute ΔEY (pp) | Max absolute ΔTDS (pp) | Max absolute Δshot time (s) | Max absolute Δfirst drops (s) | Runtime ratio |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for name, v in variants.items():
        d = report["variant_definitions"][name]
        errors = [abs(extrema(v, metric)["difference"]) * scale for metric, scale in
                  (("ey", 100), ("tds", 100), ("shot_time_s", 1), ("first_drops_s", 1))]
        lines.append(f"| {LABELS[name]} | {d['depth_cells']} × {d['columns']} | {d['kernel_shells']} | {d['max_dt_s']:g} | "
                     + " | ".join(f"{x:.4f}" for x in errors) + f" | {v['median_runtime_ratio']:.2f}× |")
    lines += ["", "The exact 5× and 10× refinements increase depth from 30 to 150 and 300 layers "
              "(240 → 1,200 → 2,400 bed cells). Column and particle-shell counts are separately tested "
              "at 40 and 64, the latter being the existing solver limit. Particle-size quadrature remains "
              "16 groups for the datasets and 30 for the generic recipe. Increasing columns samples the "
              "permeability distribution more finely; it does not introduce lateral flow or resolved pores.", "",
              "## Generic 18 g → 36 g shot", "",
              "| Depth layers | Cell height (mm) | Pump-stop time (s) | First drops (s) | Final cup EY (%) | Final cup TDS (%) | Native call (s) |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for name in DEPTH:
        r = row(variants[name], "generic")
        s, n = r["summary"], r["numerics"]["depth_cells"]
        lines.append(f"| {n} | {s['bed_height_m'] * 1e3 / n:.4f} | {s['shot_time_s']:.4f} | {s['first_drops_s']:.4f} | "
                     f"{100*s['ey']:.4f} | {100*s['tds']:.4f} | {r['wall_s']:.3f} |")
    lines += ["", "Final EY/TDS include the modeled drip; the 36 g stop applies at pump stop.", "",
              f"![Depth refinement]({prefix.name}.png)", "", "## Calibration observables", "",
              "| Variant | Rates within ±10% | Eq.3 cups within ±10% | V1 data cost | Largest relative rate change | Largest relative Eq.3 cup change | Largest pour-peak change (bar) |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for name, v in variants.items():
        score = v["v1"]["score"]
        rate = abs(extrema(v, "lambda", relative=True)["relative_difference"]) * 100
        cup = abs(extrema(v, "cup_eq3", relative=True)["relative_difference"]) * 100
        pressure = abs(extrema(v, "pour_peak_pressure_bar")["difference"])
        lines.append(f"| {LABELS[name]} | {score['lambda_within']}/60 | {score['cup_within']}/180 | {v['v1']['cost']:.3f} | "
                     f"{rate:.3f}% | {cup:.3f}% | {pressure:.4f} |")
    lines += ["", "These are fixed-coefficient sensitivity scores on calibration data. They are not "
              "new leave-one-out results or evidence that a particular grid is more physically accurate.", "",
              "## Pressure and startup", "",
              "| Variant | Experiment 13 pour peak (bar) | V4 first drops after pressure rise (s) | V4 rise to 90% after drops (s) | V4 long-time flow (g/s) | Cameron peak setting | Cameron peak EY (%) |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for name, v in variants.items():
        p = row(v, "V1", "schmieder2023/exp13")["observations"]["pour_peak_pressure_bar"]
        t = row(v, "V4")["transient_metrics"]
        peak = max((r for r in v["rows"] if r["group"] == "V3"), key=lambda r: r["observations"]["ey_percent"])
        gs = report["inputs"][peak["case"]]["info"]["grind_setting"]
        lines.append(f"| {LABELS[name]} | {p:.4f} | {t['drops_model_s']:.4f} | {t['rise_model']['t90_s']:.4f} | "
                     f"{t['long_time_model_g_s']:.4f} | {gs:g} | {peak['observations']['ey_percent']:.4f} |")
    t = row(variants["baseline"], "V4")["transient_metrics"]
    lines += ["", f"V4 measured values: first drops {t['drops_data_s']:.4f} s after the pressure rise, "
              f"then {t['rise_data']['t90_s']:.4f} s to 90% flow; long-time flow {t['long_time_data_g_s']:.4f} g/s. "
              "The Cameron peak target is GS 1.5–1.9 and EY 22–24%.", "",
              f"![Pressure and startup]({prefix.name}-pressure.png)", ""]
    if report.get("pressure_windows"):
        lines += ["## Focused pressure-window refinement", "",
                  "Experiments 2 and 13 receive 16 additional runs of their first 15 s, with the full "
                  "species set retained. The stop is moved to 15 s and post-stop drip disabled to keep "
                  "the finer timesteps inside the existing work bound. Eight comparisons against the "
                  "available full-shot grids require exact equality of time, pressure, outlet flow, "
                  "beverage mass and EY samples before 14.8 s. Those eight reference windows also reproduce "
                  "their full-shot pour peaks. These short runs are pressure diagnostics only.", "",
                  "| Experiment | Layers | Timestep (ms) | Pour peak (bar) | Maximum trace difference from 300 layers / 3.125 ms (bar) |",
                  "|---|---:|---:|---:|---:|"]
        for r in report["pressure_windows"]["rows"]:
            lines.append(f"| {r['experiment']} | {r['depth_cells']} | {r['max_dt_s']*1e3:g} | "
                         f"{r['pour_peak_pressure_bar']:.6f} | {r['max_pressure_trace_difference_bar']:.6f} |")
        spatial = report["pressure_spatial_check"]
        lines += ["", f"At the same 6.25 ms timestep, increasing 300 → 600 layers changes the reported "
                  f"pressure trace by up to {spatial['2']:.4f} bar in experiment 2 and {spatial['13']:.4f} bar "
                  "in experiment 13. The capped peak is stable while the transient shape still changes.", "",
                  "Trace differences use linear interpolation of the same 0.1 s output cadence, "
                  "including event-boundary samples, on a common absolute-time grid from 8.5 to 12.5 s. "
                  "They describe those reported curves; unsampled narrow transients remain outside this check. "
                  "The 600-layer case is an additional spatial check at 6.25 ms, not a claim of "
                  "asymptotic convergence.", "", f"![Pressure window]({prefix.name}-pressure-window.png)", ""]
    lines += ["## Reproduction and interpretation", "",
              "```bash", ".venv/bin/python python/scripts/m11-mesh-refinement.py --calibration data/calibration/v5.yaml --output-dir .local/mesh-refinement",
              ".venv/bin/python python/scripts/m11-mesh-pressure.py --study .local/mesh-refinement/mesh-refinement.json",
              ".venv/bin/python python/scripts/m11-mesh-report.py --input .local/mesh-refinement/mesh-refinement.json --pressure-input .local/mesh-refinement/mesh-pressure-window.json", "```", "",
              "The study first runs every original baseline, then reduces unused hard-stop headroom "
              "uniformly across all variants of each case to stay inside the solver's existing work bound. "
              "It requires the baseline's numerical results and diagnostics to be identical after that change "
              "(only size-related warning strings may differ). Every refined shot must reach its requested "
              "mass/time stop; a truncated run cannot count as completed. The actual output mesh is checked.", "",
              "The JSON preserves original and revised numerical settings, complete base specs, case metadata, "
              "variant patches, all scored predictions, differences, timings and build/input hashes. "
              "Complete raw solver results are cached as compressed JSON by exact input/build hash in the "
              "local output directory. The compact JSON regenerates these tables and figures without rerunning shots.", "",
              "Refinement measures numerical sensitivity within the current model. It does not add "
              "cross-flow, explicit particles, a saturation field or new experimental evidence. "
              "The 12-bar pump limit can conceal changes in a pressure demand above the cap; equal capped "
              "peaks alone do not demonstrate pressure convergence. Column refinement changes the fastest "
              "permeability stratum and therefore the mathematical first-drop time.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--pressure-input", type=Path)
    parser.add_argument("--prefix", type=Path, default=Path("docs/validation/m11-mesh-refinement"))
    args = parser.parse_args()
    source = args.input.read_bytes()
    report = compact(json.loads(source), hashlib.sha256(source).hexdigest())
    if args.pressure_input:
        report["pressure_windows"] = json.loads(args.pressure_input.read_bytes())
        assert report["pressure_windows"]["complete"]
        assert report["pressure_windows"]["full_study_sha256"] == report["full_record_sha256"]
    if report.get("pressure_windows"):
        pressure = report["pressure_windows"]
        assert len(pressure["rows"]) == 16
        assert pressure["identity"]["solver"] == report["identity"]["solver"]
        assert sum(bool(r["prefix_check"]) for r in pressure["rows"]) == 8
        for r in pressure["rows"]:
            assert r["summary"]["stop_reason"] == "time" and r["summary"]["shot_time_s"] == 15
            assert abs(r["diagnostics"]["mass_balance_error"]) < 1e-9
            assert abs(r["diagnostics"]["hydraulic_volume_balance_error"]) < 1e-9
        report["pressure_spatial_check"] = {}
        for experiment in (2, 13):
            traces = []
            for depth in (300, 600):
                r = next(r for r in pressure["rows"] if r["experiment"] == experiment
                         and r["depth_cells"] == depth and r["max_dt_s"] == .00625)
                traces.append(np.interp(np.arange(8.5, 12.50001, .001),
                                        r["series"]["t_s"], r["series"]["pressure_pa"]) / 1e5)
            report["pressure_spatial_check"][str(experiment)] = float(np.max(np.abs(traces[0] - traces[1])))
    report["verification"] = verify(report)
    if report.get("pressure_windows"):
        report["verification"].update(pressure_window_runs=16, exact_full_shot_prefix_checks=8)
    report["pairwise_maxima"] = {
        name: pairwise(report["variants"][a], report["variants"][b]) for name, a, b in (
            ("150_to_300_layers", "depth_5x", "depth_10x"),
            ("300_layers_half_timestep", "depth_10x", "depth_10x_half_dt"),
            ("40_to_64_columns", "columns_5x", "columns_8x"),
            ("40_to_64_shells", "shells_5x", "shells_8x"))}
    args.prefix.parent.mkdir(parents=True, exist_ok=True)
    figures(report, args.prefix)
    args.prefix.with_suffix(".json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    args.prefix.with_suffix(".md").write_text(markdown(report, args.prefix))
    print(json.dumps(report["verification"]))
    print(args.prefix.with_suffix(".md"))


if __name__ == "__main__":
    main()
