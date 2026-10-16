# SPDX-License-Identifier: GPL-2.0-or-later
"""Importers that turn published source files into the CSV files of data/datasets/.

Each dataset folder in ``data/datasets/`` holds CSV files plus a hand-written
``dataset.yaml`` sidecar (licence, provenance, digitisation method and
uncertainty; docs/PLAN.md §11). The modules here regenerate the CSV files from
the original downloads, so every number can be traced back to its source:

- ``schmieder2023``: supplementary Tables S1 and S3 (xlsx) and the article's
  Tables 1, 2 and A1 (PMC HTML), CC BY 4.0;
- ``waszkiewicz2026``: the authors' Zenodo archive (CC BY 4.0);
- ``cameron2020``: Figures 2B and 4 of the accepted manuscript, read from the
  PDF's vector graphics, and the supplement's Tables S2 and S3 (facts, cited);
- ``smrke2024``: Figures 2 and 3 of the article, digitised from the published
  raster images (CC BY 4.0);
- ``de1`` and ``gagne2021``: safe literal-data parsing and qualification of
  locally downloaded community logs; outputs stay outside tracked source data
  until their measurement provenance and reuse basis support formal intake.

The Corrochano 2017 and Vaca Guerra 2024 datasets are short tables of numbers
transcribed by hand (cited facts); their sidecars say how they were checked.

Helpers: ``xlsx`` (a minimal reader for .xlsx workbooks), ``pdfvector``
(vector paths and text from a PDF page) and ``raster`` (axis calibration and
marker fitting on figure images). None of this runs in CI: the source files
are not redistributed. Usage::

    python -m puckworks_tools.sources.schmieder2023 SOURCE_DIR [--out data/datasets]

Every importer prints the SHA-256 of the files it read; the sidecars record them.
"""
