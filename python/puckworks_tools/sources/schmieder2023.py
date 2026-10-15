# SPDX-License-Identifier: GPL-2.0-or-later
"""Schmieder et al. (2023), Foods 12:2871 (CC BY 4.0): fraction kinetics of a 15-run design.

Source files expected in SOURCE_DIR:

- ``TableS1_ExperimentRawData.xlsx`` and
  ``TableS3_ComponentMassInCup_SingleExperiments.xlsx``: from the supplementary
  archive ``foods-12-02871-s001.zip`` (obtained through the Europe PMC
  supplementary-files service for PMC10418593);
- ``article.html``: the article page https://pmc.ncbi.nlm.nih.gov/articles/PMC10418593/
  (Tables 1, 2 and A1 are parsed from its HTML).

Writes four dataset folders: ``schmieder2023-fractions`` (Table S1),
``schmieder2023-replicates`` (Table S3), ``schmieder2023-design`` (Tables 1
and 2) and ``schmieder2023-kinetics`` (Table A1). Values are copied as stored,
without rounding.
"""

from __future__ import annotations

import html
import re
import sys
from collections.abc import Sequence
from pathlib import Path

from .common import fmt, importer_parser, report_sources, write_csv
from .xlsx import read_workbook

S1 = "TableS1_ExperimentRawData.xlsx"
S3 = "TableS3_ComponentMassInCup_SingleExperiments.xlsx"
ARTICLE = "article.html"

ANALYTES = ("trigonelline", "caffeine", "cqa5", "tds")


def _num(text: str) -> float | None:
    """Number in a table cell; handles '2.47 × 10 −2', '(7.5)' and Unicode minus signs."""
    text = text.replace("−", "-").replace("(", "").replace(")", "").strip()
    match = re.fullmatch(r"(-?[0-9.]+)\s*×\s*10\s*(-?\s*[0-9]+)", text)
    if match:  # parse as decimal text so that 2.68 × 10⁻⁵ becomes exactly 2.68e-05
        return float(f"{match.group(1)}e{match.group(2).replace(' ', '')}")
    try:
        return float(text)
    except ValueError:
        return None


def html_tables(page: str) -> dict[str, list[list[str]]]:
    """Tables of a PMC article page, by table id: rows of cell texts."""
    tables: dict[str, list[list[str]]] = {}
    for match in re.finditer(r'<section class="tw xbox[^"]*"[^>]*id="([^"]+)"[^>]*>(.*?)</section>', page, re.S):
        rows = []
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", match.group(2), re.S):
            cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
            rows.append([re.sub(r"\s+", " ", html.unescape(re.sub("<[^>]+>", " ", c))).strip() for c in cells])
        tables[match.group(1)] = rows
    return tables


def fractions_rows(source: Path) -> list[list[str]]:
    """Table S1: one row per analysed fraction (6 per shot, 48 shots)."""
    sheet = next(iter(read_workbook(source / S1).values()))
    rows, exp, rep = [], None, None
    for r in sorted(sheet):
        cells = sheet[r]
        fraction = cells.get(6)
        if not isinstance(fraction, float):
            continue
        if isinstance(cells.get(1), float):
            exp = int(cells[1])
        if isinstance(cells.get(5), float):
            rep = int(cells[5])
        values = [cells.get(c) for c in (9, 10, 11, 12)]
        rows.append([exp, rep, int(fraction), cells[7], cells[8], *values])
    return [[fmt(v) for v in row] for row in rows]


def replicates_rows(source: Path) -> list[list[str]]:
    """Table S3: measured conditions and component masses in the cup, one row per shot."""
    sheet = next(iter(read_workbook(source / S3).values()))
    rows, exp = [], None
    for r in sorted(sheet):
        cells = sheet[r]
        # shot rows have a replicate number, a set flow, a grinding level, a pressure and cup masses
        if not all(isinstance(cells.get(c), float) for c in (3, 4, 6, 9, 10)):
            continue
        if isinstance(cells.get(2), float):
            exp = int(cells[2])
        masses = [cells.get(c) for c in range(10, 22)]
        rows.append([exp, int(cells[3]), cells[4], cells[5], cells[6], cells[7], cells[8], cells[9], *masses])
    return [[fmt(v) for v in row] for row in rows]


def design_rows(tables: dict[str, list[list[str]]]) -> list[list[str]]:
    """Tables 1 and 2: set and measured conditions per experiment."""
    design = {}
    point = ""
    for row in tables["foods-12-02871-t001"]:
        cells = [c for c in row]
        if cells and cells[0].startswith("DoE"):
            point = {"DoE Axis Points": "axis", "DoE CP": "centre", "DoE Corner Points": "corner"}[cells[0]]
            cells = cells[1:]
        nums = [_num(c) for c in cells]
        if len(nums) == 5 and all(n is not None for n in nums):
            exp, reps, flow, grind, temp = nums
            design[int(exp)] = [point, int(reps), flow, grind, temp]
    measured: dict[int, list[float]] = {}
    pending: int | None = None
    for row in tables["foods-12-02871-t002"]:
        if not row:
            continue
        values = [n for n in (_num(c) for c in row) if n is not None]
        if row[0].startswith("("):
            # RSD row under a values row: flow, temperature, 12 cup masses, pressure (in %)
            if pending is not None:
                measured[pending] += [values[0], values[1], values[-1]]
                pending = None
            continue
        if len(values) >= 18:
            # values row: experiment, flow, grinding level, temperature, replicates, 12 masses, pressure
            values = values[-18:]
            pending = int(values[0])
            measured[pending] = [values[1], values[3], values[-1]]
    out = []
    for exp in sorted(design):
        point, reps, flow, grind, temp = design[exp]
        m_flow, m_temp, m_pres, r_flow, r_temp, r_pres = measured[exp]
        out.append([exp, point, reps, flow, grind, temp, m_flow, r_flow, m_temp, r_temp, m_pres, r_pres])
    return [[fmt(v) for v in row] for row in out]


def kinetics_rows(tables: dict[str, list[list[str]]]) -> list[list[str]]:
    """Table A1: c0 and λ of c = c0 exp(−m/λ) fitted to each experiment's mean kinetics."""
    rows = tables["foods-12-02871-t0A1"]
    parts: list[tuple[str, str]] = [("trigonelline", "caffeine"), ("cqa5", "tds")]
    out, part = [], -1
    for row in rows:
        if row and row[0] == "Experiment":
            part += 1
            continue
        nums = [_num(c) for c in row]
        if len(nums) == 13 and all(n is not None for n in nums):
            exp = int(nums[0])
            for k, analyte in enumerate(parts[part]):
                # the reduced chi-square (squared concentration units) is not copied
                c0, c0_se, lam, lam_se, _chi2, r2 = nums[1 + 6 * k : 7 + 6 * k]
                unit = "g/g" if analyte == "tds" else "mg/g"
                out.append([exp, analyte, c0, c0_se, unit, lam, lam_se, r2])
    out.sort(key=lambda r: (r[0], ANALYTES.index(r[1])))
    return [[fmt(v) for v in row] for row in out]


FRACTIONS_HEADER = (
    "experiment", "replicate", "fraction", "fraction_mass_g", "cumulative_mass_g",
    "trigonelline_mg_g", "caffeine_mg_g", "cqa5_mg_g", "tds_g_g",
)
REPLICATES_HEADER = (
    "experiment", "replicate", "flow_set_ml_s", "flow_measured_ml_s", "grind_level", "temp_set_c",
    "temp_measured_c", "pressure_max_bar",
    *(f"{a}_{m}_{n}g" for a, m in (("trigonelline", "mg"), ("caffeine", "mg"), ("cqa5", "mg"), ("tds", "g"))
      for n in (20, 40, 60)),
)
DESIGN_HEADER = (
    "experiment", "design_point", "replicates", "flow_set_ml_s", "grind_level", "temp_set_c",
    "flow_measured_ml_s", "flow_rsd_percent", "temp_measured_c", "temp_rsd_percent",
    "pressure_bar", "pressure_rsd_percent",
)
KINETICS_HEADER = ("experiment", "analyte", "c0", "c0_se", "c0_unit", "lambda_g", "lambda_se_g", "adj_r2")


def build(source: Path, out: Path) -> list[Path]:
    """Writes the four CSV files and returns their paths."""
    page = (source / ARTICLE).read_text(encoding="utf-8")
    tables = html_tables(page)
    report_sources([source / S1, source / S3, source / ARTICLE])
    return [
        write_csv(out / "schmieder2023-fractions" / "fractions.csv", FRACTIONS_HEADER, fractions_rows(source)),
        write_csv(out / "schmieder2023-replicates" / "replicates.csv", REPLICATES_HEADER, replicates_rows(source)),
        write_csv(out / "schmieder2023-design" / "design.csv", DESIGN_HEADER, design_rows(tables)),
        write_csv(out / "schmieder2023-kinetics" / "kinetics.csv", KINETICS_HEADER, kinetics_rows(tables)),
    ]


def main(argv: Sequence[str] | None = None) -> int:
    args = importer_parser(__doc__.splitlines()[0]).parse_args(argv)
    for path in build(args.source, args.out):
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
