# SPDX-License-Identifier: GPL-2.0-or-later
"""Vector paths of a PDF page, in page coordinates (points, origin at the bottom left).

Figures exported from plotting software are often embedded as vector graphics.
Their markers, error bars and curves can then be read exactly from the page's
content stream instead of being digitised from pixels. This module

1. decompresses the PDF with ``qpdf --qdf --object-streams=disable`` (qpdf must
   be installed; it is only needed when importing sources, never in CI);
2. interprets the path-construction and painting operators of one page's
   content stream (``m l c v y h re``, ``S s f F f* B B* b b* n``) under the
   current transformation matrix (``q Q cm``);
3. returns each painted path with its segments, painting operator and line width.

Text operators are skipped (pdftotext -bbox gives text positions). Form
XObjects and inline images are not followed, which is enough for figures drawn
directly on the page.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

Point = tuple[float, float]

_TOKEN = re.compile(
    rb"(\((?:\\.|[^\\)])*\))|(<[0-9A-Fa-f\s]*>)|(\[)|(\])|(/[^\s/\[\]()<>{}%]+)"
    rb"|([-+]?(?:\d+\.?\d*|\.\d+))|([A-Za-z'\"*][A-Za-z0-9'\"*]*)|(%[^\n]*)",
    re.S,
)
_PAINT = {b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"n"}


@dataclass
class Path2D:
    """One painted path. ``segments`` holds ('m', p), ('l', p0, p1), ('c', p0, p1, p2, p3),
    ('h',) and ('re', [4 corners])."""

    op: str
    segments: list[tuple] = field(default_factory=list)
    line_width: float = 1.0

    def bbox(self) -> tuple[float, float, float, float]:
        xs: list[float] = []
        ys: list[float] = []
        for seg in self.segments:
            for item in seg[1:]:
                points = item if isinstance(item, list) else [item]
                for p in points:
                    xs.append(p[0])
                    ys.append(p[1])
        return min(xs), min(ys), max(xs), max(ys)

    def count(self, kind: str) -> int:
        return sum(1 for seg in self.segments if seg[0] == kind)

    def polylines(self, samples: int = 32) -> list[list[Point]]:
        """Subpaths as point lists; each Bézier segment sampled at ``samples`` points."""
        subs: list[list[Point]] = []
        cur: list[Point] = []
        for seg in self.segments:
            kind = seg[0]
            if kind == "m":
                if cur:
                    subs.append(cur)
                cur = [seg[1]]
            elif kind == "l":
                cur = cur or [seg[1]]
                cur.append(seg[2])
            elif kind == "c":
                p0, p1, p2, p3 = seg[1:]
                cur = cur or [p0]
                for k in range(1, samples + 1):
                    t = k / samples
                    u = 1.0 - t
                    cur.append((
                        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
                    ))
            elif kind == "h" and cur:
                cur.append(cur[0])
            elif kind == "re":
                if cur:
                    subs.append(cur)
                subs.append([*seg[1], seg[1][0]])
                cur = []
        if cur:
            subs.append(cur)
        return subs

    def crossings_at_x(self, x: float, samples: int = 64) -> list[float]:
        """Sorted y values where the path's outline crosses the vertical line at ``x``."""
        ys = []
        for sub in self.polylines(samples):
            for (x0, y0), (x1, y1) in zip(sub[:-1], sub[1:]):
                if (x0 - x) * (x1 - x) < 0 or (x0 == x and x1 != x):
                    ys.append(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
        return sorted(ys)


def _multiply(a: list[float], b: list[float]) -> list[float]:
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]


def _apply(m: list[float], x: float, y: float) -> Point:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def parse_content(content: bytes) -> list[Path2D]:
    """Painted paths of a decompressed content stream."""
    ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    stack: list[tuple[list[float], float]] = []
    operands: list = []
    paths: list[Path2D] = []
    segs: list[tuple] = []
    start: Point | None = None
    point: Point | None = None
    width = 1.0
    in_array = False
    for match in _TOKEN.finditer(content):
        string, hexstr, lbr, rbr, name, number, op, comment = match.groups()
        if comment:
            continue
        if lbr:
            in_array = True
            continue
        if rbr:
            in_array = False
            operands.append(None)
            continue
        if in_array:
            continue
        if number:
            operands.append(float(number))
            continue
        if string or hexstr or name:
            operands.append(None)
            continue
        if op == b"q":
            stack.append((ctm[:], width))
        elif op == b"Q":
            ctm, width = stack.pop()
        elif op == b"cm":
            ctm = _multiply(operands[-6:], ctm)
        elif op == b"w":
            width = operands[-1]
        elif op == b"m":
            point = start = _apply(ctm, *operands[-2:])
            segs.append(("m", point))
        elif op == b"l":
            new = _apply(ctm, *operands[-2:])
            segs.append(("l", point, new))
            point = new
        elif op == b"c":
            v = operands[-6:]
            p1, p2, p3 = _apply(ctm, v[0], v[1]), _apply(ctm, v[2], v[3]), _apply(ctm, v[4], v[5])
            segs.append(("c", point, p1, p2, p3))
            point = p3
        elif op in (b"v", b"y"):
            v = operands[-4:]
            p2, p3 = _apply(ctm, v[0], v[1]), _apply(ctm, v[2], v[3])
            segs.append(("c", point, point if op == b"v" else p2, p2, p3))
            point = p3
        elif op == b"h":
            if start is not None:
                segs.append(("h",))
                point = start
        elif op == b"re":
            x, y, w, h = operands[-4:]
            segs.append(("re", [_apply(ctm, x, y), _apply(ctm, x + w, y), _apply(ctm, x + w, y + h),
                                _apply(ctm, x, y + h)]))
        elif op in _PAINT:
            if segs:
                scale = abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) ** 0.5
                paths.append(Path2D(op.decode(), segs, width * scale))
            segs, start = [], None
        operands = []
    return paths


def decompress(pdf: Path) -> bytes:
    """The PDF rewritten by qpdf with uncompressed streams and no object streams."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "qdf.pdf"
        subprocess.run(["qpdf", "--qdf", "--object-streams=disable", str(pdf), str(out)], check=True)
        return out.read_bytes()


def page_content(qdf: bytes, page: int) -> bytes:
    """Concatenated content streams of a 1-based page of a qpdf --qdf file."""
    match = re.search(rb"%% Page " + str(page).encode() + rb"\n%% Original object ID: [^\n]*\n(\d+) 0 obj", qdf)
    if not match:
        raise ValueError(f"page {page} not found")
    page_obj = _object(qdf, int(match.group(1)))
    refs = re.search(rb"/Contents\s+(\[[^\]]*\]|\d+ 0 R)", page_obj)
    if not refs:
        raise ValueError(f"page {page} has no /Contents")
    numbers = [int(n) for n in re.findall(rb"(\d+) 0 R", refs.group(1))]
    out = b""
    for number in numbers:
        body = _object(qdf, number)
        stream = re.search(rb"stream\n(.*)\nendstream", body, re.S)
        if stream:
            out += stream.group(1) + b"\n"
    return out


def _object(qdf: bytes, number: int) -> bytes:
    match = re.search(rb"\n" + str(number).encode() + rb" 0 obj\n(.*?)\nendobj", qdf, re.S)
    if not match:
        raise ValueError(f"object {number} not found")
    return match.group(1)


def page_paths(pdf: Path, page: int) -> list[Path2D]:
    """All painted paths of a page of ``pdf`` (needs qpdf)."""
    return parse_content(page_content(decompress(pdf), page))
