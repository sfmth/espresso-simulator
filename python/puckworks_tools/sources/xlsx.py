# SPDX-License-Identifier: GPL-2.0-or-later
"""A minimal reader for .xlsx workbooks (Office Open XML), standard library only.

It returns the stored cell values of every sheet: numbers as floats, shared and
inline strings as str, booleans as bool. Formulas are not evaluated; the cached
value saved by the spreadsheet program is returned, which is what the program
displayed. Styles, merged cells and number formats are ignored.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

_NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
_CELL_REF = re.compile(r"^([A-Z]+)([0-9]+)$")

#: A sheet: row number (1-based) → {column index (0-based) → value}.
Sheet = dict[int, dict[int, Any]]


def column_index(letters: str) -> int:
    """0-based column index of a column name ("A" → 0, "AA" → 26)."""
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _text(node: ElementTree.Element) -> str:
    return "".join(t.text or "" for t in node.iter(f"{{{_NS['m']}}}t"))


def read_workbook(path: Path | str) -> dict[str, Sheet]:
    """All sheets of the workbook at ``path``, by sheet name."""
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [_text(si) for si in root.findall("m:si", _NS)]
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        sheets: dict[str, Sheet] = {}
        listing = workbook.find("m:sheets", _NS)
        for sheet in listing if listing is not None else []:
            target = targets[sheet.get(f"{{{_NS['r']}}}id")]
            member = target[1:] if target.startswith("/") else f"xl/{target}"
            root = ElementTree.fromstring(archive.read(member))
            rows: Sheet = {}
            for row in root.iter(f"{{{_NS['m']}}}row"):
                cells: dict[int, Any] = {}
                for cell in row.findall("m:c", _NS):
                    match = _CELL_REF.match(cell.get("r", ""))
                    if not match:
                        continue
                    kind = cell.get("t")
                    value_node = cell.find("m:v", _NS)
                    raw = value_node.text if value_node is not None else None
                    if kind == "s":
                        value: Any = shared[int(raw)] if raw is not None else None
                    elif kind == "inlineStr":
                        value = _text(cell)
                    elif kind == "b":
                        value = bool(int(raw)) if raw is not None else None
                    elif kind in ("str", "e"):
                        value = raw
                    else:
                        value = float(raw) if raw not in (None, "") else None
                    cells[column_index(match.group(1))] = value
                rows[int(row.get("r"))] = cells
            sheets[sheet.get("name")] = rows
    return sheets
