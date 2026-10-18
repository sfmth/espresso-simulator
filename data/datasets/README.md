<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Datasets

Published research and community measurements admitted to calibrate and validate Puckworks. Each dataset lives in its own folder with
the data files and a metadata sidecar, `dataset.yaml`, which records where the data come from, under
what licence, how they were obtained or digitised, and how uncertain they are.

Validation roles are those of [PLAN §10](../../docs/PLAN.md#10-verification-and-validation); the case builders
that turn each dataset into shot specs are described in
[docs/validation/case-builders.md](../../docs/validation/case-builders.md).

Academic publication is not required. The owner has directed core development to use online measurements
without relying on their own equipment. The [community-source audit](../../docs/research/04-community-shot-data.md)
lists discovered archives, measurement limitations and admission status separately from the datasets
already accepted below. Public visibility, a file format, and a project's code licence are not by
themselves evidence that a collection contains usable, licensed experimental measurements.

The [community comparison command](../../python/README.md#reproduce-the-community-comparison) reads
local original files and writes detailed exploratory results under `.local/` (ignored by Git).
Its [aggregate report](../../docs/validation/community-shot-comparison.md) does not add those raw logs
to the accepted inventory or change the fitting/held-out split below.

| Folder | Content | Licence | Role |
|---|---|---|---|
| [`schmieder2023-centre-point/`](schmieder2023-centre-point/) | λ and c₀ of trigonelline, caffeine, 5-CQA and TDS at the centre point of the Schmieder 2023 design, the λ and c₀ extremes across the design, and cup masses at 20/40/60 g | CC BY 4.0 | registry (kinetics) |
| [`schmieder2023-design/`](schmieder2023-design/) | the 15 experiments: set and measured flow, grinding level, temperature, peak pressure (Tables 1–2) | CC BY 4.0 | V1 |
| [`schmieder2023-fractions/`](schmieder2023-fractions/) | trigonelline, caffeine, 5-CQA and TDS in the 6 analysed fractions of all 48 shots (Table S1) | CC BY 4.0 | V1 |
| [`schmieder2023-kinetics/`](schmieder2023-kinetics/) | c₀ and λ of the exponential kinetics, all experiments and analytes (Table A1) | CC BY 4.0 | V1 |
| [`schmieder2023-replicates/`](schmieder2023-replicates/) | per shot: measured flow, temperature, peak pressure, cup masses at 20/40/60 g (Table S3) | CC BY 4.0 | V1 |
| [`waszkiewicz2026-flow-transient/`](waszkiewicz2026-flow-transient/) | pump and basket pressure, cup mass and flow versus time at 11 pressures (authors' archive) | CC BY 4.0 | V4 transient (held out) |
| [`waszkiewicz2026-flow-pressure/`](waszkiewicz2026-flow-pressure/) | long-time flow versus basket pressure, 11 pressures | CC BY 4.0 | V4 Q(P) |
| [`waszkiewicz2026-tds/`](waszkiewicz2026-tds/) | TDS of 5 s fractions, three replicates | CC BY 4.0 | V4 TDS (held out) |
| [`waszkiewicz2026-psd/`](waszkiewicz2026-psd/) | laser-diffraction PSD of the grind, three samples | CC BY 4.0 | V4 cases |
| [`cameron2020-ey-grind/`](cameron2020-ey-grind/) | EY and shot time versus EK43 grind setting at 6 bar (Fig. 4, read from vectors; Table S3) | facts cited | V3 (held out) |
| [`cameron2020-psd/`](cameron2020-psd/) | volume PSDs at grind settings 1.0–2.5 (Fig. 2B, read from vectors) | facts cited | V3 cases |
| [`cameron2020-two-class/`](cameron2020-two-class/) | the paper's two-class bed description (Table S2) | facts cited | V3 option |
| [`vacaguerra2024-rtd/`](vacaguerra2024-rtd/) | the 25 values the V2 case uses: Bodenstein numbers, flow rates, doses, Sauter diameters, bed size, temperature | facts cited (article CC BY-NC-ND) | V2 |
| [`corrochano2017-permeability/`](corrochano2017-permeability/) | permeability of extracted beds, 4 grinds × 3 bed densities (Table 6.1) | facts cited | V6 |
| [`corrochano2017-psd/`](corrochano2017-psd/) | dry and wet PSD parameters of 11 grinds (Tables 4.1–4.2) | facts cited | V6 cases |
| [`corrochano2017-properties/`](corrochano2017-properties/) | tapped bed porosity, solid density, particle porosity, partition coefficient, permeameter geometry | facts cited | V6 cases |
| [`smrke2024-psd/`](smrke2024-psd/) | X50 and share of fines for 15 Bentwood V63 samples, with and without added fines (Fig. 2, digitised) | CC BY 4.0 | V5 cases |
| [`smrke2024-shots/`](smrke2024-shots/) | shot time and EY of 46 shots (Fig. 3, digitised; settings from Fig. 7) | CC BY 4.0 | V5 (held out) |
| [`gloess2013-espresso-chemistry/`](gloess2013-espresso-chemistry/) | 112 setup and chemistry values for four espresso/lungo preparations, retaining per-cup, per-10 mL and per-dose bases (Tables 1, S2-S4) | CC BY 2.0 | V7 held-out evidence; incompletely specified inputs |

The CSV files of the converted and digitised datasets can be regenerated from the original downloads with
the importers in [`python/puckworks_tools/sources/`](../../python/puckworks_tools/sources/); each sidecar
records the SHA-256 of its source files.

### Not obtained

| Wanted | Why not |
|---|---|
| Schmieder 2023 time-resolved pressure, flow and temperature logs | not in the supplement as tables (only inside the authors' OriginPro project, a proprietary binary format); Tables 2 and S3 give each shot's peak pressure, mean flow and temperature |
| Vaca Guerra 2024 outlet-concentration curves (TDS, caffeine, trigonelline, 5-CQA, three PSDs) | the article is CC BY-NC-ND (no non-commercial material is bundled, PLAN §11) and the curves come from an earlier paper that is not open access (Vaca Guerra 2023, J. Food Eng. 340:111301); only cited scalars are kept. Needs the authors' permission |
| Smrke 2024 raw data | "available from the corresponding author on reasonable request"; the published figures were digitised instead |
| Corrochano 2017 full particle-size distributions | given only as figures; the tabulated summary parameters are used |
| Schmieder 2023 particle-size distributions (Fig. A1) | not digitised in this version; the case builder reconstructs a PSD from the reported D[4,3] |

## Licensing rules

These rules come from [docs/PLAN.md §11](../../docs/PLAN.md#11-data-and-licensing-rules) and decision
D9 (no user data, ever).

| Source | Terms | Rule |
|---|---|---|
| Schmieder 2023 and its supplement | CC BY 4.0 | bundle derived parameters with attribution |
| Méndez Harper 2024 (Figshare) | CC BY 4.0 | bundle with attribution |
| Ristenpart 2023 (Dryad) | CC0 | free to bundle |
| Corrochano 2017 EngD thesis | open access, copyright retained | use published values with citation; do not redistribute the thesis |
| Pannusch 2023 data and app (Mendeley) | CC BY-NC 3.0 | do not bundle or port; use only values published in the papers |
| Visualizer.coffee | no data licence; rate-limited API | only with the maintainer's permission; strip personal data; honour deletions |
| Kaffeemacher/ZHAW grinder PSDs | not public | request a licence; meanwhile cite published numbers |
| Coffee ad Astra, Barista Hustle | copyrighted | cite numbers; no scraping |
| DE1 app and Beanconqueror (GPL-3.0); Gaggiuino and GaggiMate (CC BY-NC) | shot-file formats | write parsers from the format documentation; GPL-3.0 code may be combined (under "or later"); never copy NC-licensed code |
| CQI-derived datasets | unclear redistribution rights | research use only, after review; do not bundle |

In short:

- **Never bundle non-commercial (NC) material.** A sidecar with an NC licence must say
  `redistribution: forbidden` and list no data files.
- **Facts from copyrighted sources** may be used as cited numbers: set `licence: facts-cited` and
  `redistribution: cite-only`, and do not copy tables, figures or text wholesale.
- **Attribution:** for CC BY data, the sidecar's `citation` (and `doi` or `url`) is the attribution;
  keep it with the data wherever they are redistributed.
- **No personal data.** Strip names and other personal fields from anything derived from shot logs,
  and never add data obtained from the app's users (D9).

## Adding a dataset

1. Check the licence against the rules above. If redistribution is not clearly allowed, ask the
   maintainer before adding anything.
2. Create a folder named `<first author><year>-<slug>`, lower case, e.g. `smrke2024-fines`.
3. Add the data as CSV with a header row: one value per cell, units in a fixed column or in a unit
   column, no merged cells. Units must be listed in [`data/schema/units.yaml`](../schema/units.yaml).
4. Write `dataset.yaml` following [`data/schema/dataset.schema.json`](../schema/dataset.schema.json):
   - `id` (equal to the folder name), `title`, `citation`, `doi` and/or `url`;
   - `licence` (an SPDX identifier such as `CC-BY-4.0` or `CC0-1.0`, or `facts-cited`) and
     `redistribution` (`allowed`, `cite-only` or `forbidden`);
   - `obtained`: copied from a table, digitised from a figure (tool and resolution), or received from
     the authors;
   - `uncertainty`: the transcription or digitisation uncertainty, and the statistical uncertainty
     the source reports;
   - `columns` (name, type, units or `units_column`, description) and `files`;
   - optional `retrieved` date, `research_note_ref` and `notes`.
5. Run `puckworks-tools validate-registry`. It checks the sidecar, the licensing rules above, and
   every CSV file against the declared columns and units.
6. Add the dataset to the table at the top of this file, and record it in the CHANGELOG.

Values that enter the model also need a record in the parameter registry (`data/params/`), with the
dataset as a source.
