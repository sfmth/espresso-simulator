# SPDX-License-Identifier: GPL-2.0-or-later
"""YAML loading for the registry: YAML 1.2 floats and no duplicate keys."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml


class StrictLoader(yaml.SafeLoader):
    """A SafeLoader that

    - reads YAML 1.2 floats such as ``1e-10`` and ``2.5E+4`` (PyYAML follows
      YAML 1.1, which needs a decimal point and a signed exponent, so ``1e-10``
      would otherwise load silently as a string);
    - rejects duplicate keys in a mapping (PyYAML otherwise keeps the last one).
    """

    def construct_mapping(self, node: yaml.Node, deep: bool = False) -> dict[Any, Any]:
        if isinstance(node, yaml.MappingNode):
            seen: set[Any] = set()
            for key_node, _ in node.value:
                if key_node.tag == "tag:yaml.org,2002:merge":
                    continue
                key = self.construct_object(key_node, deep=deep)
                try:
                    duplicate = key in seen
                except TypeError:  # unhashable key: let the base class report it
                    break
                if duplicate:
                    raise yaml.constructor.ConstructorError(
                        "while constructing a mapping",
                        node.start_mark,
                        f"found duplicate key {key!r}",
                        key_node.start_mark,
                    )
                seen.add(key)
        return super().construct_mapping(node, deep=deep)


StrictLoader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(r"^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?[eE][-+]?[0-9]+$"),
    list("-+0123456789"),
)


def load_yaml(path: Path | str) -> Any:
    """Loads one YAML document from ``path``."""
    with open(path, encoding="utf-8") as handle:
        return yaml.load(handle, Loader=StrictLoader)  # noqa: S506 (StrictLoader is a SafeLoader)


def loads_yaml(text: str) -> Any:
    """Loads one YAML document from a string."""
    return yaml.load(text, Loader=StrictLoader)  # noqa: S506
