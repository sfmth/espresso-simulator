# SPDX-License-Identifier: GPL-2.0-or-later
"""Import selected espresso/lungo chemistry from Gloess et al. (2013).

Download the official supplement as ``supplement.docx`` into SOURCE_DIR:
https://media.springernature.com/original/springer-static/esm/art%3A10.1007%2Fs00217-013-1917-x/MediaObjects/217_2013_1917_MOESM1_ESM.docx

Only DE, SE, DL and SL are admitted. Measurements are copied from Supplementary
Tables 2--4; Table 4's TA columns are excluded because they repeat Table 3's
per-cup values despite the per-gram caption. No parameters are fitted here.
The manually audited setup records are from main-article Table 1, p. 609.
The published cup volumes are not relabelled as measured beverage masses.
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from collections.abc import Sequence

from .common import importer_parser, report_sources, sha256, write_csv

SUPPLEMENT_SHA256 = "536e391a7345cb0b6199ad0ee5a8333893d99e4d371e8aee6a9b41d80efd478f"
METHODS = ("DE", "SE", "DL", "SL")
HEADER = ("method", "source_table", "basis", "quantity", "value", "uncertainty", "units")

# Source-table column positions, not an assumed chemical inventory. All values
# remain in their original printed units. A 'per_10_ml' basis does not turn a
# weight percentage or a pH into an extensive quantity; see dataset notes.
FIELDS = {
    1: ((1, "total_solids", "%"), (2, "brix", "1"), (3, "ph", "1"),
        (4, "naoh_to_ph6_6", "mL"), (5, "naoh_to_ph8", "mL"),
        (7, "esterified_fatty_acids", "%"), (8, "caffeine", "mg"),
        (9, "cqa3", "mg"), (10, "cqa5", "mg")),
    2: ((1, "total_solids", "g"), (2, "naoh_to_ph6_6", "mL"),
        (3, "naoh_to_ph8", "mL"), (4, "esterified_fatty_acids", "g"),
        (5, "caffeine", "mg"), (6, "cqa3", "mg"), (7, "cqa5", "mg")),
    3: ((1, "total_solids", "%"), (4, "esterified_fatty_acids", "%"),
        (6, "caffeine", "%"), (7, "cqa3", "%"), (8, "cqa5", "%")),
}
BASES = {1: "per_10_ml", 2: "per_cup", 3: "per_dose"}

# Table 1 reports double extractions. Dose uncertainty for SE/SL is an estimate;
# their 90 C is a boiler setting, not a measured extraction temperature.
# Table 1's SE/SL time uncertainty differs from the prose; preserve Table 1.
SETUPS = {
    "DE": (16.01, 0.01, 30, 28.7, 0.2, 92, 9, 80),
    "SE": (16.0, 0.6, 30, 25.3, 0.3, 90, 8.25, 80),
    "DL": (16.01, 0.01, 120, 37.2, 0.3, 92, 9, 86),
    "SL": (16.0, 0.6, 120, 35.3, 0.1, 90, 7.5, 86),
}


def read_tables(path: Path) -> list[list[list[str]]]:
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
    return [
        [["".join(t.text or "" for t in cell.findall(".//w:t", ns))
          for cell in row.findall("w:tc", ns)] for row in table.findall("w:tr", ns)]
        for table in document.findall(".//w:tbl", ns)
    ]


def measurements(path: Path) -> list[list[object]]:
    if sha256(path) != SUPPLEMENT_SHA256:
        raise ValueError("Supplement changed: audit its contents and metadata before importing")
    tables = read_tables(path)
    if len(tables) != 4:
        raise ValueError("Expected four tables in the audited supplement")
    output: list[list[object]] = []
    for method in METHODS:
        dose, dose_error, cup, duration, time_error, temperature, pressure, roast = SETUPS[method]
        for quantity, value, error, unit, basis in (
            ("dry_dose", dose, dose_error, "g", "per_extraction"),
            ("cup_volume", cup, None, "mL", "per_cup"),
            ("cups_per_extraction", 2, None, "1", "per_extraction"),
            ("extraction_time", duration, time_error, "s", "per_extraction"),
            ("temperature", temperature, None, "degC", "per_extraction"),
            ("pressure", pressure, None, "bar", "per_extraction"),
            ("roast_pt", roast, None, "1", "per_extraction"),
        ):
            output.append([method, "Table1", basis, quantity, value, error, unit])
        for index, fields in FIELDS.items():
            row = next(r for r in tables[index] if r[0] == method)
            for column, quantity, unit in fields:
                match = re.fullmatch(r"\s*([\d.]+)\s*±\s*([\d.]+)\s*", row[column])
                if not match:
                    raise ValueError(f"Unexpected measurement {method}, table {index + 1}: {row[column]!r}")
                # Keep the original decimal strings, including printed precision.
                output.append([method, f"SuppTable{index + 1}", BASES[index], quantity,
                               match.group(1), match.group(2), unit])
    return output


def build(source: Path, out: Path) -> list[Path]:
    path = source / "supplement.docx"
    report_sources([path])
    return [write_csv(out / "gloess2013-espresso-chemistry" / "measurements.csv", HEADER,
                      measurements(path))]


def main(argv: Sequence[str] | None = None) -> int:
    args = importer_parser(__doc__.splitlines()[0]).parse_args(argv)
    for path in build(args.source, args.out):
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
