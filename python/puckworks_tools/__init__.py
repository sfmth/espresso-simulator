# SPDX-License-Identifier: GPL-2.0-or-later
"""Offline tools for Puckworks.

- ``registry``: parameter registry validation (docs/PLAN.md §7.3, module R);
- ``datasets``: dataset sidecar validation (docs/PLAN.md §11);
- ``units``: the machine-checked unit vocabulary;
- ``fixtures``: the golden sphere-release fixture shared with the web tests;
- ``shotfixtures``: the golden shot fixture (recipes → spec and result) shared with the web tests;
- ``verify``: the kernel verification report against Crank's solution;
- ``cases``: case builders, the validation datasets' conditions as shot specs;
- ``calibrate``: the M1 calibration harness;
- ``validate``: the M1 validation report;
- ``community``: exploratory comparisons against locally supplied community shot logs;
- ``sources``: importers that regenerate dataset CSV files from the original downloads;
- ``export``: presets and registry JSON for the model crate (workstream D);
- ``versions``: the version-consistency check.

The command-line entry point is ``puckworks-tools`` (see ``cli``).
"""

from importlib import metadata as _metadata

try:
    __version__ = _metadata.version("puckworks-tools")
except _metadata.PackageNotFoundError:  # running from a source tree without installing
    __version__ = "0+unknown"

__all__ = ["__version__"]
