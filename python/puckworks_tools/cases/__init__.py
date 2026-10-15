# SPDX-License-Identifier: GPL-2.0-or-later
"""Case builders: the experimental conditions of each validation dataset as ShotSpecs.

Each module covers one source and provides

- ``KEY`` and ``DATASETS`` (the dataset folders it reads);
- ``load(paths)``: the dataset tables;
- ``build_cases(data, *, tier, n_classes, overrides, module, ...)``: a list of ``Case``
  (``common.Case``: dataset, name, ShotSpec, nuisance group, info);
- ``observe(case, result)``: the model observables comparable with the data (a module whose
  observables depend on the simulated spec takes it as a third argument);
- optionally ``CASE_PARAMETERS``: parameter ids that the cases' ``finalize`` applies itself
  rather than passing them to the builder as recipe overrides.

The mappings and their assumptions are documented in docs/validation/case-builders.md.
"""

from types import ModuleType

from . import cameron2020, corrochano2017, schmieder2023, smrke2024, vacaguerra2024, waszkiewicz2026
from .common import Case

#: Case-builder modules by key.
MODULES: dict[str, ModuleType] = {
    module.KEY: module
    for module in (schmieder2023, vacaguerra2024, waszkiewicz2026, corrochano2017, cameron2020, smrke2024)
}

__all__ = ["MODULES", "Case"]
