# SPDX-License-Identifier: GPL-2.0-or-later
"""Helpers of the dataset importers: xlsx reading, PDF vector paths, raster markers, CSV formatting."""

from __future__ import annotations

import zipfile

import numpy as np
import pytest

from puckworks_tools.sources import common, pdfvector, raster, xlsx


def make_xlsx(path):
    """A minimal workbook: one sheet with a shared string, numbers, an inline string and a gap."""
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel_ns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook {ns} {rel_ns}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/>'
                                      "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}><si><t>Exp. #</t></si><si><r><t>Mass</t></r><r><t> (g)</t></r></si></sst>")
        z.writestr("xl/worksheets/sheet1.xml",
                   f'<worksheet {ns}><sheetData>'
                   '<row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c></row>'
                   '<row r="3"><c r="B3"><v>7</v></c><c r="C3"><v>5.8529</v></c><c r="E3" t="inlineStr"><is><t>ok</t></is></c></row>'
                   "</sheetData></worksheet>")


def test_xlsx_reader(tmp_path):
    path = tmp_path / "t.xlsx"
    make_xlsx(path)
    sheets = xlsx.read_workbook(path)
    assert list(sheets) == ["Data"]
    rows = sheets["Data"]
    assert rows[2] == {1: "Exp. #", 2: "Mass (g)"}
    assert rows[3] == {1: 7.0, 2: 5.8529, 4: "ok"}
    assert xlsx.column_index("A") == 0 and xlsx.column_index("AA") == 26


def test_pdf_paths_follow_the_transformation_matrix():
    content = (b"q 2 0 0 2 10 20 cm 1 w 0 0 m 5 0 l S Q "
               b"q 1 0 0 1 100 100 cm 0 0 m 1 1 2 1 3 0 c h f Q "
               b"BT /F1 9 Tf (ignored) Tj ET 0 0 4 3 re n")
    paths = pdfvector.parse_content(content)
    assert [p.op for p in paths] == ["S", "f", "n"]
    line = paths[0]
    assert line.segments[1] == ("l", (10.0, 20.0), (20.0, 20.0))
    assert line.line_width == pytest.approx(2.0)
    assert paths[1].bbox() == pytest.approx((100.0, 100.0, 103.0, 101.0))
    assert paths[2].segments[0][0] == "re"
    ys = paths[1].crossings_at_x(101.5)
    assert len(ys) == 2 and ys[0] == pytest.approx(100.0)


def test_raster_markers_and_axes():
    image = np.full((200, 300, 3), 255.0)
    yy, xx = np.mgrid[0:200, 0:300]
    centres = [(50.3, 60.7), (150.0, 140.2), (158.0, 145.0)]  # the last two overlap
    for cx, cy in centres:
        image[(xx - cx) ** 2 + (yy - cy) ** 2 <= 7.0**2] = 0.0
    mask = image.max(axis=2) < 100
    found = sorted(raster.find_markers(mask, np.zeros_like(mask), marker_area=np.pi * 7.0**2), key=lambda m: m.x)
    assert len(found) == 3
    for marker, (cx, cy) in zip(found, sorted(centres)):
        assert marker.x == pytest.approx(cx, abs=0.6) and marker.y == pytest.approx(cy, abs=0.6)
    assert not found[0].overlapping and found[1].overlapping and found[2].overlapping
    axis = raster.Axis.fit([10.0, 110.0, 210.0], [0.0, 20.0, 40.0])
    assert axis(60.0) == pytest.approx(10.0) and axis.residual == pytest.approx(0.0, abs=1e-12)
    profile = np.zeros(50)
    profile[[10, 11, 30]] = [100.0, 100.0, 300.0]
    assert raster.run_centres(profile, 50.0) == pytest.approx([10.5, 30.0])


def test_number_formatting():
    assert common.fmt(None) == "" and common.fmt(3) == "3" and common.fmt(True) == "true"
    assert common.fmt(0.1) == "0.1" and common.fmt(2.5e-05) == "2.5e-05"
    assert common.fmt(21.33349, 3) == "21.333" and common.fmt(24.0, 2) == "24" and common.fmt(-0.0001, 2) == "0"
    with pytest.raises(ValueError):
        common.fmt(float("nan"))
