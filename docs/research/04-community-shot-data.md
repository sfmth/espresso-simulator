<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 04 — Online community shot data

*Source audit, 2026-10-15. This records discovery and source qualification, not a new calibration result.*

The owner has directed core calibration to use online measurements, including hobbyist experiments and community archives. Academic publication is not required, and the owner's equipment is not a calibration prerequisite ([D15](../PLAN.md#2-locked-decisions-2026-10-13)). Measurement quality determines what a source can support.

**SproFiler is the closest match to the proposed Gaggiuino database. Gagné's 11-shot experiment is the strongest controlled community candidate inspected here.** Their different strengths matter: a large archive offers varied conditions, while a small experiment with known dose, preparation and repeat measurements can better constrain a model. The [18 accepted datasets](../../data/datasets/README.md) and their existing calibration/validation roles remain unchanged.

## Sources inspected

Counts describe files or service statistics, not accepted independent experiments. Inspection was limited to public documentation and representative files; no bulk service collection or outreach occurred.

| Source | What was verified | Potential use and remaining gaps |
|---|---|---|
| [SproFiler](https://sprofiler.io/) / [statistics](https://sprofiler.io/statistics) | An indexed statistics snapshot reported **172,476 shots** and **408 active machines in 30 days**. The snapshot was about a week old; a fresh statistics fetch timed out. Public shot pages offer replays, machine/profile information and targets. | Strong Gaggiuino discovery source. A documented public raw-shot export, measured-scale provenance and sufficient recipe metadata were not established. Profile downloads are control programs, not shot observations. |
| [Visualizer](https://visualizer.coffee/) | A community archive supporting Decent, Gaggiuino, GaggiMate and other instruments, with shot charts, exports and APIs. | Broad observational coverage. The project's existing [source policy](../../data/datasets/README.md#licensing-rules) requires maintainer permission before collecting its shot data. No shot harvesting was performed. |
| [Gagné: standard versus low-fines shots](https://coffeeadastra.com/2021/05/10/a-comparison-between-standard-and-low-fines-espresso-shots/) | **11 real DE1 traces**, with a matching 11-row measurement log: six EG-1/SSP and five Niche shots in one alternating experiment. Original downloads were inspected. | Best controlled lead for bloom drainage, hydraulic response and final extraction. Missing measured PSD and unresolved clock/yield conventions limit absolute calibration. See below. |
| [Peter Lada's DE1 history](https://github.com/peterlada/decent_history/tree/2cfd012b8ee46c7b66f6ca68d81b785d6fc70ae3/history) | **974 `.shot` files** at the pinned revision; one sample inspected. It has pressure, estimated inlet flow, scale channels, temperature and recipe metadata. | Useful observational lead. One inspected file does not establish whole-corpus quality or controlled repeats. Its zero TDS/EY fields are missing data; annotated yield differs from final trace weight. No reuse licence found. |
| [Quantitative Café: extraction experiment](https://quantitativecafe.com/2022/02/26/a-simple-model-of-extraction/) / [original files](https://github.com/quantitativecafe/blog/tree/22ac2548865670f7ff5b4f708010eb414e978bd7/ey-vs-ratio) | **176 split-shot observations across 20 configurations**, from Gaggia Classic Pro experiments: dose, split mass, Brix and preparation notes. | Relevant to extraction versus brew ratio after a documented Brix conversion. No startup time series. Posterior-sampling CSV rows are not additional coffee measurements. No reuse licence found. |
| [Gaggiuino MCP fixtures](https://github.com/ljcl/gaggiuino-mcp/tree/3525ff8e0cf8899d2d2af9cce52acc18821277ae) / [Decent MCP fixtures](https://github.com/The-Walker443/decentespresso-mcp/tree/7f70e129d7c173c9d807275181ddb0fb64f2612e/tests/fixtures/decaid) | The first repository identifies **two real Gaggiuino captures** alongside synthetic examples; the second identifies **two coffee traces** alongside water-only/flush traces. Software licences are MIT and GPL-3.0-or-later, respectively. | Useful parser/replay examples with attribution and applicable licence terms. Missing coffee metadata, unconfirmed scale mode or anonymized equipment prevent matched physics validation. A repository's software licence is not a licence for an unrelated user database. |

SproFiler's [privacy policy](https://sprofiler.io/privacy-policy) says shared shots are public by default. No explicit downstream open-data grant was found. Its promise not to share data with third parties concerns the service's own disclosure practices; it is **not itself a demonstrated ban on visitors' research use**. Public visibility and permission to redistribute a corpus are separate questions. Record uncertain terms as uncertain, not as a blanket prohibition.

## Why the recorded channels need checking

The [official Gaggiuino manual](https://github.com/GAGGIUINO/gaggiuino.github.io/blob/master/docs/learning/user-manual-gen3.md) describes pump flow calculated from a pump model and flow-per-pulse calibration. Cup weight can come from a physical scale or predictive mode, including a setting that overrides a connected scale. Boiler temperature is not direct puck-inlet temperature. Thus a field named `shotWeight` or `pumpFlow` is not, by itself, independent experimental truth.

[GaggiMate's log format](https://github.com/jniebuhr/gaggimate/blob/master/src/display/models/shot_log_format.h) distinguishes scale channels from estimated weight; its inspected v8 status bits can identify an active, healthy scale. That makes it a promising format, but no usable public raw-shot archive was established in this search. Format documentation and profile collections do not supply experimental observations.

For DE1 traces, also keep estimated inlet flow separate from scale-derived outlet flow. A recipe setpoint, measured pressure, filtered scale reading and manually entered final yield are different quantities. Synthetic pressure/flow logs exist in public controller repositories too; for example, [espresso-software](https://github.com/bgkatz/espresso-software/tree/73668029575ec904eb24d21a351fb82e948dca08) includes a simulated machine. Its CSV filenames alone cannot establish experimental provenance.

## Gagné experiment: reproducible source identification

The author's [original ZIP](https://www.dropbox.com/s/l0v4a5d3h98kasn/shotfiles_Mar2_2021.zip?raw=1) contains 11 real shot files, excluding macOS resource forks. The linked [measurement spreadsheet](https://docs.google.com/spreadsheets/d/1r33CI6lczJhuYcNjy8z3jABagZoxO8Z0kkd6h5Ppos0/edit?usp=sharing) joins to them by exact filename. This is much stronger provenance than an unlabelled chart or a downstream mirror.

| Original download | SHA-256 of inspected bytes |
|---|---|
| `shotfiles_Mar2_2021.zip` (127,410 bytes) | `a41f92b755cf028e310d0d4de2cc24051d75f719fe65dbc3d022a215d469c73b` |
| [Measurement log CSV export](https://docs.google.com/spreadsheets/d/1r33CI6lczJhuYcNjy8z3jABagZoxO8Z0kkd6h5Ppos0/export?format=csv) (2,693 bytes) | `490c691d06920f2c3d9cba18398d8d2193acefe037530cabcab8488cbdeb2e6d` |

The traces contain 378–395 aligned samples at about 0.224 s spacing. They span roughly 78–82 s and include a 30 s bloom; their full duration is not a standard uninterrupted 18 → 36 g shot time. The log supplies actual doses, beverage masses, bloom drainage and filtered/unfiltered TDS. It also exposes uncertainty and preparation details that a general archive may omit.

**Derived source check.** Joining the spreadsheet's `File` and `Grinder` fields to archive basenames gives the following observed ranges. These are minima–maxima across shots, not confidence intervals or simulator predictions.

| Observable on each file's logged elapsed clock | EG-1, six shots | Niche, five shots |
|---|---:|---:|
| First upward crossing of 0.5 g | 19.3–22.2 s | 14.1–15.9 s |
| First upward crossing of 1.0 g | 21.9–25.4 s | 15.7–18.5 s |

For reproducibility, read only the literal numeric lists `espresso_elapsed` and `espresso_weight`; never execute a `.shot` file as Tcl. Check equal lengths, finite values and strictly increasing time. For each threshold `m`, take the first pair with `w[i-1] < m <= w[i]`, then interpolate `t[i-1] + (m-w[i-1])/(w[i]-w[i-1]) * (t[i]-t[i-1])`. All 4,246 samples were retained, including 69 negative weights and six decreases. No smoothing, clipping or clock shift was applied; both thresholds occur in every trace. The largest sample gap is 0.317 s, and interpolation does not establish sub-sample timing accuracy.

These clock-relative mass crossings are useful qualification observables. They do not establish pump-start time, first physical emergence, a causal grinder effect, or a replacement for the existing V4 first-drop definition. Scale latency and synchronization still need qualification.

Several qualifications must survive any import:

- Treat the whole experiment as one operator/session; 11 shots are not 11 independent laboratories. Flag thermal drift and the reported pressure outliers. One Niche setting annotation conflicts with the article's stated fixed setting.
- Final trace weights span **68.7–69.92 g**, while spreadsheet beverage masses span **74.5–75.5 g**. Keep both; do not assume their difference is all post-stop drainage. The spreadsheet's `drip` field describes bloom drainage.
- No measured PSD is supplied. A grinder dial does not determine D32, and pressure/flow alone cannot separately identify permeability, viscosity and particle-water uptake.
- The article's concentration curves inferred from hydraulic resistance are model-derived, not independent time-resolved TDS measurements. Final filtered refractometry is a distinct observation.

The author provides public downloads, but no explicit raw-data reuse licence was found. Raw files are not committed here, and a downstream mirror's licence does not establish the original data's terms. This note cites sources and limited numerical facts; it does not add the archive to formal calibration or redistribute its tables/curves.

## Next numerical work

1. **Continue startup-model development with the existing eligible online datasets.** Keep the current calibration groups and held-out tests. Community source qualification does not justify fitting the V4 transient that was held out, or weakening a failed acceptance target.
2. **Prioritize the controlled Gagné experiment for community intake**, and SproFiler/Visualizer for wider generalization once raw access, reuse basis and measurement metadata are established. No measurements or equipment purchase from the owner are needed.
3. **Admit observations by intended role.** Startup timing needs a documented clock and independently measured cup mass, plus recipe/machine inputs. Extraction needs measured TDS and its protocol. Parser fixtures can test formats without becoming physics evidence. Missing metadata stays missing; nuisance assumptions must be stated and their uncertainty propagated.
4. **Freeze evaluation groups before fitting.** Group by experiment/session and, where possible, contributor, machine and bean batch. Deduplicate exports and mirrors across services. Samples from one trace stay together. Sources already examined during model selection are exploratory evidence, not a pristine final holdout.

An admitted source needs a metadata sidecar under the [dataset rules](../../data/datasets/README.md#adding-a-dataset), including source revision/checksum, channel definitions and units, clock origin, stop/drainage convention, missingness, uncertainty and reuse basis. No new numerical parameter values, calibration claims or solver release result from this source audit.
