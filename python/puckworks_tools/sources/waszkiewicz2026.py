# SPDX-License-Identifier: GPL-2.0-or-later
"""Waszkiewicz et al. (2026), Phys. Fluids 38:063113: flow and TDS under constant pressure.

Source: the authors' Zenodo archive (doi:10.5281/zenodo.18046315, v1.0.1,
CC BY 4.0; the same files as https://github.com/RadostW/espresso at v1.0.1).
SOURCE_DIR is the unpacked archive (the folder holding ``formatted_measurements``).

Writes four dataset folders:

- ``waszkiewicz2026-flow-transient``: the authors' per-pressure means (and
  standard errors) of pump pressure, basket pressure, cup mass and mass flow
  rate on their common time grid, every 5th point (0.5 s spacing);
- ``waszkiewicz2026-flow-pressure``: the long-time values (last grid point,
  t = 100 s), which the authors fitted with Q = Q_c·P̂(4 − 6P̂ + 4P̂² − P̂³);
- ``waszkiewicz2026-tds``: TDS of 5 s fractions, three replicates;
- ``waszkiewicz2026-psd``: laser-diffraction volume distribution, three samples.

Values are copied as stored in the archive's CSV files (no rounding).
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from collections.abc import Sequence
from pathlib import Path

from .common import fmt, importer_parser, report_sources, write_csv

TIME_DEPENDENT = Path("formatted_measurements/time_dependent.csv")
DEBUG = Path("formatted_measurements/debug_time_dependent.csv")
TDS_RAW = Path("measurements_tds_calibration/tds.csv")
TDS_MEAN = Path("formatted_measurements/tds.csv")
PSD = Path("measurements_mastersizer/mastersizer.csv")

#: Keep every n-th point of the 1000-point common time grid (0.1001 s spacing).
STRIDE = 5

FLOW_HEADER = (
    "pressure_group_bar", "time_s", "pump_pressure_bar", "pump_pressure_sem_bar",
    "basket_pressure_bar", "basket_pressure_sem_bar", "mass_g", "mass_sem_g",
    "flow_g_s", "flow_sem_g_s", "n_runs",
)
LONGTIME_HEADER = (
    "pressure_group_bar", "n_runs", "time_s", "pump_pressure_bar", "basket_pressure_bar",
    "basket_pressure_sem_bar", "flow_g_s", "flow_sem_g_s",
)
TDS_HEADER = ("time_mid_s", "tds_percent", "tds_sem_percent", "tds_rep1_percent", "tds_rep2_percent",
              "tds_rep3_percent")
PSD_HEADER = ("bin_lower_um", "bin_upper_um", "volume_percent_1", "volume_percent_2", "volume_percent_3")


def _strip(text: str) -> str:
    """The stored number without trailing zeros ('1.000000' → '1.0'), unchanged otherwise."""
    if text == "":
        return ""
    return fmt(float(text))


def run_counts(source: Path) -> dict[str, int]:
    """Number of runs averaged in each pressure group (from the authors' per-run export)."""
    files: dict[str, set[str]] = defaultdict(set)
    with open(source / DEBUG, encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            files[_strip(row["reference_pressure_round__bar"])].add(row["filename"])
    return {group: len(names) for group, names in files.items()}


def flow_rows(source: Path, counts: dict[str, int]) -> tuple[list[list[str]], list[list[str]]]:
    """Transient rows (every STRIDE-th point) and the long-time row of each pressure group."""
    groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    with open(source / TIME_DEPENDENT, encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            groups[_strip(row["reference_pressure_round__bar"])].append(row)
    transient, longtime = [], []
    for group in sorted(groups, key=float):
        rows = sorted(groups[group], key=lambda r: float(r["time__s"]))
        for index, row in enumerate(rows):
            if index % STRIDE == 0 or index == len(rows) - 1:
                transient.append([
                    group, _strip(row["time__s"]), _strip(row["pressure__bar"]), _strip(row["pressure_std__bar"]),
                    _strip(row["basket_pressure__bar"]), _strip(row["basket_pressure_std__bar"]),
                    _strip(row["mass__g"]), _strip(row["mass_std__g"]),
                    _strip(row["mass_flow_rate__g_per_s"]), _strip(row["mass_flow_rate_std__g_per_s"]),
                    str(counts[group]),
                ])
        last = rows[-1]
        longtime.append([
            group, str(counts[group]), _strip(last["time__s"]), _strip(last["pressure__bar"]),
            _strip(last["basket_pressure__bar"]), _strip(last["basket_pressure_std__bar"]),
            _strip(last["mass_flow_rate__g_per_s"]), _strip(last["mass_flow_rate_std__g_per_s"]),
        ])
    return transient, longtime


def tds_rows(source: Path) -> list[list[str]]:
    """TDS of each 5 s fraction: the authors' mean and standard error, and the three replicates."""
    with open(source / TDS_MEAN, encoding="utf-8") as handle:
        means = {_strip(r["time__s"]): r for r in csv.DictReader(handle)}
    rows = []
    with open(source / TDS_RAW, encoding="utf-8") as handle:
        for raw in csv.DictReader(handle):
            t = _strip(raw["time_s"])
            mean = means[t]
            rows.append([t, _strip(mean["tds__percent"]), _strip(mean["tds_std__percent"]),
                         _strip(raw["tds_percent_1"]), _strip(raw["tds_percent_2"]), _strip(raw["tds_percent_3"])])
    return rows


def psd_rows(source: Path) -> list[list[str]]:
    """Volume percent in each size bin; the first line of the file holds the 48 bin edges."""
    lines = (source / PSD).read_text(encoding="utf-8-sig").strip().splitlines()
    edges = [float(x) for x in lines[0].split(";")]
    samples = [[float(x) for x in line.split(";")[1:]] for line in lines[1:4]]
    rows = []
    for i in range(1, len(edges)):
        rows.append([fmt(edges[i - 1]), fmt(edges[i]), *(fmt(s[i - 1]) for s in samples)])
    return rows


def build(source: Path, out: Path) -> list[Path]:
    report_sources([source / p for p in (TIME_DEPENDENT, DEBUG, TDS_RAW, TDS_MEAN, PSD)])
    counts = run_counts(source)
    transient, longtime = flow_rows(source, counts)
    return [
        write_csv(out / "waszkiewicz2026-flow-transient" / "flow.csv", FLOW_HEADER, transient),
        write_csv(out / "waszkiewicz2026-flow-pressure" / "longtime.csv", LONGTIME_HEADER, longtime),
        write_csv(out / "waszkiewicz2026-tds" / "tds.csv", TDS_HEADER, tds_rows(source)),
        write_csv(out / "waszkiewicz2026-psd" / "psd.csv", PSD_HEADER, psd_rows(source)),
    ]


def main(argv: Sequence[str] | None = None) -> int:
    args = importer_parser(__doc__.splitlines()[0]).parse_args(argv)
    for path in build(args.source, args.out):
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
