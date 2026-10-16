# SPDX-License-Identifier: GPL-2.0-or-later
"""Index of research-note sections, for references such as ``"01 §4.3"``.

A reference names a note by its two-digit number (docs/research/NN-*.md) and
one of its headings:

- ``"NN §X.Y"``: a numbered heading such as ``### 4.3 Measured …`` or
  ``## 8. Parameter table``;
- ``"NN Implications"`` or ``"NN Implications A"``: the "Implications for the
  simulator design" section, or its lettered subsection;
- ``"NN Open questions"``: the open-questions section.
"""

from __future__ import annotations

import re
from pathlib import Path

REF_PATTERN = re.compile(
    r"^(?P<note>[0-9]{2}) (?P<section>§[0-9]+(?:\.[0-9]+)*|Implications(?: [A-Z])?|Open questions)$"
)
_HEADING = re.compile(r"^(#{2,6})\s+(.*?)\s*$")
_NUMBERED = re.compile(r"^([0-9]+(?:\.[0-9]+)*)\.?(?:\s|$)")
_LETTERED = re.compile(r"^([A-Z])\.\s")


def section_keys(markdown: str) -> set[str]:
    """Section keys (``"§4.3"``, ``"Implications A"``, …) defined by the headings."""
    keys: set[str] = set()
    in_implications = False
    in_fence = False
    for line in markdown.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = _HEADING.match(line)
        if match is None:
            continue
        level, title = len(match[1]), match[2]
        if level == 2:
            in_implications = title.startswith("Implications")
        numbered = _NUMBERED.match(title)
        if numbered:
            keys.add("§" + numbered[1])
        elif title.startswith("Implications"):
            keys.add("Implications")
        elif title.startswith("Open questions"):
            keys.add("Open questions")
        if level >= 3 and in_implications:
            lettered = _LETTERED.match(title)
            if lettered:
                keys.add("Implications " + lettered[1])
    return keys


class NoteIndex:
    """The research notes of one directory and the sections they define."""

    def __init__(self, notes_dir: Path) -> None:
        self.notes_dir = Path(notes_dir)
        self._notes: dict[str, list[tuple[Path, set[str]]]] = {}
        for path in sorted(self.notes_dir.glob("[0-9][0-9]-*.md")):
            keys = section_keys(path.read_text(encoding="utf-8"))
            self._notes.setdefault(path.name[:2], []).append((path, keys))

    @property
    def notes(self) -> list[Path]:
        return [path for entries in self._notes.values() for path, _ in entries]

    def check(self, ref: str) -> str | None:
        """None if ``ref`` resolves to a heading; otherwise the reason it does not."""
        match = REF_PATTERN.match(ref)
        if match is None:
            return (
                f"research_note_ref {ref!r} is not of the form 'NN §X.Y', "
                "'NN Implications', 'NN Implications A' or 'NN Open questions'"
            )
        entries = self._notes.get(match["note"])
        if not entries:
            return f"research_note_ref {ref!r}: there is no research note docs/research/{match['note']}-*.md"
        if len(entries) > 1:
            names = ", ".join(path.name for path, _ in entries)
            return f"research_note_ref {ref!r}: note number {match['note']} is ambiguous ({names})"
        path, keys = entries[0]
        if match["section"] not in keys:
            return f"research_note_ref {ref!r}: {path.name} has no heading for {match['section']}"
        return None
