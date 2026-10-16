# 03 — Grinding (burr geometry → PSD), puck preparation, and data sources

*Research note for the browser espresso simulator (planning phase). Compiled 2026-10-13.*

**Scope.** (1) The particle-size distribution (PSD) of espresso grounds: shape, measurement, parameterization; (2) grinder, burr and bean effects on it; (3) whether any comminution model predicts it; (4) puck-prep and basket inputs; (5) public datasets; (6) prior machine-learning (ML) and optimization work. Flow and extraction physics are in note 01 and appear here only as constraints.

**Evidence key** (same as note 01): **A** = peer-reviewed primary measurement; **B** = peer-reviewed model, fit or indirect inference; **C** = thesis, book, preprint or review; **D** = community, manufacturer or retailer material (single operator, informal replication). **[unverified]** = I could not confirm the claim against a readable primary source. **[derived]** = my calculation from cited numbers (inputs stated). **[abstract]** = only the abstract was read.

**Conventions.** Sizes are particle diameters in µm. PSD weighting is labelled **N** (number), **S** (surface) or **V** (volume ≈ mass). X50/Dv50 = volume median. D[3,2] (written D32) = Sauter mean, D[4,3] (D43) = volume mean. "Fines" = particles < 100 µm unless stated (see §1.3). LD = laser diffraction. EY = extraction yield, TDS = total dissolved solids.

---

## 0. Key findings

1. **Every dataset found shows a bimodal PSD** in volume weighting. A fines peak sits at ~40–50 µm, about the size of a coffee cell pocket (25–40 µm). A coarse ("boulder") peak sits at ~250–500 µm in most datasets (100–200 µm in one), with a trough near 100 µm. By number, about 99% of particles are < 70–100 µm.
2. **The "espresso median" depends on grinder and method.** X50 ranges ~190–380 µm. Fines (< 100 µm, V) are 15–36% by dry methods but 30–49% by wet LD on the same grinds. Pooling sources needs a model of the measurement method.
3. **Dialing in mostly changes the fines fraction.** Fines set permeability and shot time (Smrke 2024; Gagné 2023); at a given time they add little EY.
4. **Fines fall ~0.09–0.10 percentage points per µm of X50** (two grinders, two methods) [derived]. On a µm-calibrated flat grinder, X50 ≈ 1.4 × nominal gap [derived].
5. **Burr geometry beats burr size.** Conicals are on average less unimodal and uniform, with wide overlap. The RPM effect is grinder-specific. Popcorning is negligible at 10 g. Alignment is unquantified.
6. **Bean state shifts the PSD.** Cold beans: number mode −31% from 20 °C to −196 °C, and a narrower PSD. Dark roast: ~100 µm finer mean at the same EK43 setting. Moisture < 2%: strong charging and clumping. Adding 5–20 µL g⁻¹ water suppresses the charge; in a fixed-recipe test, water-added grinding gave ~50% longer shots and TDS 8.2 → 8.9% (water dose for that test not stated in the text read).
7. **No validated model maps burr geometry to PSD.** Only generic population-balance and DEM machinery exists, plus sparse fracture data. Every usable relationship is empirical.
8. **Tamping force above ~10 kgf does not matter** (three independent datasets). The large levers act on flow distribution: bottom paper (+3 EY points), puck screen (+0.4 to +3, basket-dependent), less headspace (+3.4, one dataset). This evidence is mostly community (D) grade.
9. **Data.** Visualizer.coffee is the largest shot corpus ("millions of shots"; public shots via a rate-limited API; no explicit data licence). It has no PSD, and TDS/EY are sparse with unknown protocol. Openly licensed lab datasets are small but well controlled.
10. **Little espresso-specific ML exists.** Published work: association rules on café telemetry, deep-network inverse maps trained on synthetic multiphysics output, PINN abstracts, and Bayesian optimization (BO) for cappuccino foam. There is no public neural forward surrogate and no BO-with-taste study for espresso, an opening for this project.

---

## 1. PSD of espresso grinds

### 1.1 Shape and characteristic scales

| Feature | Typical value | Weighting / method | Source (grade) |
|---|---|---|---|
| Fines peak | 40–50 µm for all eight grinds (Turkish to coarse); trough/inflection at ~100 µm | V; dry LD (Sympatec HELOS/RODOS) | Roman Corrochano 2017 [R8] (C) |
| Fines-peak shift between grinders | ≤ 8 µm, "about 20% of the typical fines size", which implies ≈ 40 µm [derived] | V; Camsizer X2 (dynamic image analysis) | Gagné 2023 [R19] (D, on ZHAW data) |
| Fines peak, other instruments | ~20–30 µm (dry), plus a large ~1–2 µm peak when measured wet (Mahlkönig E65S) | V; Sympatec dry/wet, read from figure A1 | Schmieder et al. 2023 [R4] (A) |
| Fines modes, N vs S weighting | N mode 13–14 µm; S mode ≈ 27 µm | dry LD (Beckman LS13 320 MW) | Uman et al. 2016 [R1] (A) |
| Number fraction of small particles | 99% of particles ≤ 70 µm [R1]; 99% < 100 µm, carrying 80% of the surface area (EK43, GS 2.5) [R2] | N | Uman 2016 (A); Cameron 2020 (A) |
| "Fine-particulate cutoff" (trough) | 61–73 µm, varying with bean temperature | LD | Uman 2016 (A) |
| Coarse peak, espresso range | 257–282 µm (S modes, EK43 Turkish burrs); 329–393 µm (disc-grinder grinds B–C, dry LD); ~400–500 µm (E65S, dry, figure); 100–200 µm (Fiorenzato F64 EVO, Mastersizer 2000) | various | [R1], [R8], [R4], Waszkiewicz 2025/26 [R31] (C) |
| Sub-cellular debris | 1–10 µm fragments on particle surfaces (SEM); detected by wet LD | SEM; wet LD | [R8] (C) |
| Cell pockets / intraparticle pores | cell pockets 25–40 µm; micropores ~40 µm plus nanopores 10–20 nm (Hg porosimetry) | microscopy; porosimetry | Schenker 2000 [R14] via [R8]/[R9] (A/C) |
| Particle shape | sphericity ≈ 0.75 | QICPIC imaging | [R8] (C) |
| Particle porosity | 0.50–0.65 (He pycnometry + Hg); 0.47 assumed in a model; solid matrix density 1304 kg m⁻³ | — | [R8] (C); Vaca Guerra 2024 [R10] (A) |
| Swelling on wetting | ~15% diameter increase; 60–80% reached within 30 s; complete within 4 min | LD + microscopy | Hargarten et al. 2020 [R13] (A) |

**Relation to cell size.** Moroney et al. define fines as "broken cell fragments produced during grinding" and treat grains > 50 µm as "larger" [R11, R12]. Large grains carry broken cells on the surface and intact cells inside, which gives the fast "surface" and slow "kernel" pools of note 01. The fines volume peak (40–50 µm) spans one to two cell pockets; the number mode (13–14 µm) is sub-cellular.

### 1.2 Published espresso-range PSD statistics for named grinders

| Grinder (burrs) | Setting(s) | Method | Statistics | Source |
|---|---|---|---|---|
| Mahlkönig E65S (65 mm flat; 1400/1700 rpm; 4–7 g s⁻¹) | GL 1.4 / 1.7 / 2.0 | Sympatec HELOS/BR, dry (RODOS) and wet (QUIXEL) | wet D43 273 / 277 / 295 µm (SD 7.6 / 17 / 18); wet D32 28.3 / 26.9 / 29.2 µm; authors: dry and wet PSDs "showed high similarity", though the wet curve adds a ~1–2 µm peak (figure A1) | Schmieder 2023 [R4] (A); brochure [R42] |
| Bentwood Vertical 63 (63 mm flat; dial calibrated in µm of burr spacing) | 160, 170, 180, 190, 210, 250 µm | Camsizer X2; V from projected area | X50 ≈ 232 → 352 µm; Q100 ≈ 25.6 → 15.0% (§2.2) [digitized] | Smrke 2024 [R3] (A) |
| Mahlkönig EK43 (98 mm, Turkish burrs, 1480 rpm) | 2.7 | LS13 320 MW, dry | N mode 13–14 µm; S modes ≈ 27 and 257–282 µm | Uman 2016 [R1] (A) |
| Mahlkönig EK43 (coffee burrs) | GS 1.0–2.5 (espresso typically 1.3–2.3) | LS13 320 MW | bimodal; fines size constant; finer GS raises the fines proportion and shrinks boulders | Cameron 2020 [R2] (A) |
| Mahlkönig EK43 (stock coffee burrs, aligned) | 1.0–6.0 | Mastersizer 2000 + Scirocco, dry, 2 bar; refractive index 1.59, absorption 0.1 | darkest roast ≈ 100 µm finer mean than lightest at the same setting; light at 2.0 matches dark at 2.3; raw data public | Méndez Harper 2024 [R7] (A) |
| Dalla Corte disc grinder (grinds B–E) | 4 levels | dry: Sympatec HELOS/RODOS; wet: Mastersizer 2000 | dry X50 190 / 265 / 336 / 383 µm; dry fines 35.9 / 26.6 / 20.1 / 16.7%; wet fines 49.1 / 40.3 / 32.9 / 29.7%; dry D32 80–131 µm vs wet 22–39 µm | Roman Corrochano 2017 [R8] (C) |
| Fiorenzato F64 EVO | 1.9 (dialed for 18.5 g → 37 g in 32 s) | Mastersizer 2000 | boulder maximum 100–200 µm; fines ~50 µm | Waszkiewicz 2025/26 [R31] (C) |
| Not specified (TU Hamburg / Nestlé), PSDs A–D | — | not stated in the text I read | overall D32 105–134 µm; coarse-fraction D32 272–438 µm; D43 325–611 µm | Vaca Guerra 2024 [R10] (A) |
| Commercial "fine grade" | — | Mastersizer 3000 + Aero S, dry | Dv10 33–35, Dv50 234–239, Dv90 485–500 µm (n = 15; RSD < 1.5%) | Malvern app note [R37] (D) |
| Industry target | — | Sympatec, dry | espresso x50 ≈ 212 µm, all < 1 mm (filter x50 ≈ 342 µm) | Sympatec [R38] (D) |
| 24 home/prosumer grinders, flat and conical (Baratza Forté … Tchibo) | ristretto / espresso / allongé dial-ins | Camsizer X2 (ZHAW) | espresso x50 typically 150–350 µm; > 300 PSDs | Kaffeemacher protocol [R25]; Gagné 2023 [R19] (D) |
| LAGOM Casa (65 mm conical); Timemore Sculptor 078 (SSP flat) | 6 settings each, filter range | phone images + Fiji; Feret ≥ 0.1 mm | area-weighted KDE peaks ≈ 0.55–1.8 mm | Oec 2026 [R46] (C, preprint) |

**Not usable as PSD data:**
- Coffee Review's Horiba LA-960 tests of four budget grinders publish results only inside individual reviews [R45].
- Compiled grind charts have no measurement protocol (Honest Coffee Guide: espresso "180–380 µm" [R44]).
- Barista Hustle's Mastersizer comparisons (e.g., EK43 fines peak "around 80 µm") are behind a paywall **[unverified]**.

### 1.3 Fines definitions in use

| Definition | Used by | Comment |
|---|---|---|
| < 100 µm, volume share | Cameron 2020; Smrke 2024 ("Q100µm"); Kaffeemacher ("Qf < 100 µm"); Gagné 2023 (integral 0–100 µm, read off at a reference median of 340 µm); Corrochano 2017 (inflection); Vaca Guerra 2024; Sympatec ("dust < 100 µm") | De-facto standard; recommended here |
| < 50 µm | Moroney 2015/2017 [R11, R12] | Tied to the cell-fragment concept |
| Trough position (61–73 µm) | Uman 2016 | Data-driven, so it moves between samples |
| 0–90 µm | Barista Hustle **[unverified]** | Sieve-like cut |
| < 120 µm sieve fraction (to make "fines" for adding back) | Smrke 2024 | Preparation cut, not a metric |

### 1.4 Measurement methods and their biases

| Method | Weighting | Practical range | Biases specific to coffee | Sources |
|---|---|---|---|---|
| Dry LD (Sympatec HELOS/RODOS; Malvern Mastersizer + Scirocco/Aero; Beckman LS13 320) | V, as equivalent spheres | up to ~3.5 mm (instrument-dependent) | Assumes spheres. Aligned elongated particles can show false bimodality, and an ellipsoid reads smaller than its major axis [R40]. Dispersion pressure trades clumps against breakage, so titrate [R39]. Refractive index is a free choice (1.59 / 0.1 in [R7]). | [R40], [R39], [R7] |
| Wet LD (Mastersizer Hydro; Sympatec QUIXEL) | V | same | Adds a 1–10 µm population (debris, colloids, oil). Same grinds: D32 22–39 µm wet vs 80–131 µm dry; fines 30–49% vs 17–36% [R8]. Solubles dissolve; particles swell ~15% [R13]. | [R8], [R4], [R13] |
| Sieving (Retsch, Kruve) | mass | discrete cuts (e.g., a 120 µm sieve to isolate fines [R3]) | Passage depends on the second-largest dimension. Fines cake and stick; mass loss (~0.7 g of 10 g, user report [R20]). Best for *preparing* fractions. | [R20], [R3] |
| Static image analysis (phone + coffeegrindsize / Fiji) | N by projected area; S and V need shape assumptions | phones miss ~50 µm fines [R20]; [R46] filtered < 0.1 mm | Touching particles merge. Poisson noise: 138–662 particles per sample [R46] vs ~15,000 [R22]. | [R20], [R46] |
| Dynamic image analysis (Camsizer X2, QICPIC, Microtrac SYNC) | N, converted to V via projected-area size (x_area) or width (x_c,min) | camera-dependent (SYNC: 4.6–2000 and 50–4000 µm) | The size definition changes X50. Gives shape. ~10⁶ particles per minute [R38]. | [R3], [R25], [R38], [R39] |
| SEM, µCT | N, morphology | µm–mm | Small samples; resolves fragments and puck structure | [R8], [R33] |

**Why the weighting matters.** Abbott's example [R41]: 99 particles of diameter 1 and one of diameter 100 are 99% fines by number but almost all large particle by mass. Uman's N mode (13 µm) and S mode (27 µm) differ by 2×, and both sit an order of magnitude below the coarse peak (~260–500 µm). Each process needs its own moment: permeability the specific surface (D32), fast extraction the fines surface, slow extraction the boulder V distribution. A small image-analysis study found the **area-weighted** KDE peak predicted TDS best (pooled Spearman ρ = −0.949, n = 12, immersion brewing) [R46] (C).

### 1.5 Parameterizations and published values

| Model | Form | Used by | Published numbers |
|---|---|---|---|
| Three-component log-normal mixture, fitted to the cumulative distribution by Levenberg–Marquardt | $q_3(\ln x)=\sum_{k=1}^{3} w_k\,\mathcal N(\ln x;\ln m_k,s_k)$ | Gagné 2023 on ZHAW Camsizer data | "Usually quite well reproduced" from 10 µm to > 1200 µm. Parameter trends against median are shown graphically; no table. |
| Two discrete classes (fines ≤ 100 µm; coarse) | two radii plus two specific surfaces | Moroney 2015; Cameron 2020; Corrochano 2017; Vaca Guerra 2024 | Corrochano: fines class mean ≈ 40 µm, coarse ≈ D43 (dry table in §1.2). Vaca Guerra: overall D32 105–134 µm, coarse D32 272–438 µm. Cameron's radii are in the Supplemental Information (not accessed). Moroney 2015 Sauter diameters were not accessed. |
| Rosin–Rammler (Weibull) on the coarse fraction only (> 100 µm) | $Q_3(x)=1-\exp[-(x/\eta)^{\gamma}]$ | Vaca Guerra 2025 dissertation (TU Hamburg) [R10] | Values not in the accessible preview **[not accessed]** |
| RRSB characteristic size x′ (63.2% passing) | specification only | roller-mill patent US8690087B2 (granite rolls, gap 0.03–0.05 mm) [R63] | x′ ≤ 100 µm, preferably ≤ 70 µm, for fine powders (D) |
| Kernel density estimate (KDE) | non-parametric | Oec 2026; commercial phone apps | Area-weighted peak; see §1.4 |
| Descriptor sets | X50 + Q100 (+ width) | Smrke 2024; Kaffeemacher (x50, Qf < 100 µm, "60% coarse-peak width"; widths > ~300 µm flagged as tasting "scattered") | §1.2, §2.2 |

**Takeaway.** Single-component Rosin–Rammler or log-normal fits cannot represent the bimodality. A 2–3-component log-normal mixture in V is the most defensible generative form, and a 2-class discretization suits the extraction solver (note 01).

---

## 2. Grinder and bean effects on the PSD

### 2.1 Factors

| Factor | What is known | Grade | Sources |
|---|---|---|---|
| Flat vs conical | On average conicals are less unimodal (more fines at a given median) and less uniform (more boulders), and run at lower rpm. Overlap is large: many flat burrs are worse than many conicals. | D (24 grinders, one unit each, alignment unknown) | Gagné 2023 [R19] |
| Burr diameter | No systematic gain from 50 to 70 mm flat burrs. "Most larger flat burrs produce less unimodal" PSDs; the single 83 mm unit (Ceado E37) was more unimodal than average. Tooth geometry and coating dominate. | D | [R19] |
| Burr families | EK43 Turkish vs coffee burrs differ in their finishing teeth ("flat triangular ends … polish") [R1]. SSP families (Multipurpose/"unimodal", High Uniformity, Lab Sweet, Ultra Low Fines) are described by retailers through taste only, and sources disagree on whether HU is "unimodal". EG-1 with SSP ULF burrs: near-absence of fines, so it must grind much finer; EY 26.8% vs 24.8% for a Niche Zero at the same recipe (unfiltered TDS; 24.1% vs 22.7% filtered). | A; D | [R1], [R64], [R23] |
| Unimodality vs dial-in | More unimodal grinders need a *much finer* median at espresso dial-in and end up with slightly more fines per gram. "We are dialling in the amount of fines more so than … the average size of coarse particles." | D | [R19] |
| RPM | "No obvious trend with rpm" across grinders; the effect is grinder- and burr-specific and often only shifts the grind size | D | [R19]; [R22] |
| Alignment | Needed for SSP ULF burrs to reach espresso fineness. Checked by "chirp" pitch or a marker rub test. No published before/after PSD data. | D | [R1]; [R7]; [R19] |
| Seasoning and wear | EG-1 with SSP ULF burrs, 24 lb of seasoning: PSD coarser and more uniform ("Q-factor" 1.59 → 1.76), most change in the first 12–16 lb. Wear is trackable by sieving + LD [R49] or by phone-image classification into three levels (> 96%) [R48]. | D; A | [R22], [R49], [R48] |
| Feed rate / single dosing ("popcorning") | Baratza Forté, 10 g: full-hopper and empty-hopper PSDs indistinguishable; bean-by-bean feeding ≈ 5 clicks coarser | D | Gagné 2019 [R21] |
| Retention | Kaffeemacher scale: 0–2 g "very good" to > 9 g "very high". Measured 0.18 ± 0.04 g (Niche) and 0.23 ± 0.02 g (EG-1). | D | [R25]; [R23] |
| Heating of grounds | Kaffeemacher logs ground-coffee temperature from < 30 °C (best) to > 39 °C (worst); no PSD link reported | D | [R25] |
| Bean temperature | At −196, −79, −19 and 20 °C, colder beans give a smaller N mode (−31% from room temperature to −196 °C) and a narrower PSD, with most narrowing between 20 and −19 °C. Four origins and processes (light-medium, Agtron 59–68) gave PSDs independent of origin. | A | Uman 2016 [R1] |
| Roast degree | Roasting makes beans brittle (water loss, pyrolysis, lower density) [R15]. At a fixed EK43 setting the darkest coffee had a ≈ 100 µm finer mean than the lightest [R7]. Density falls from 1000–1200 to 400–600 kg m⁻³ and volume grows up to +100% [R18]. | A; A; D (poster) | Pittia 2001 [R15]; [R7]; Navarini 2025 [R18] |
| Internal moisture | Whole-bean moisture < 2% causes negative tribocharging; moisture predicts charge slightly better than roast colour; finer settings charge more | A | Méndez Harper 2024 [R7] |
| Added water ("Ross droplet technique", RDT) | 5–20 µL g⁻¹ cuts electrostatic aggregation; charge → ~0 at 20 µL g⁻¹. Espresso at a fixed setting (18 → 45 g, 7 bar, 94 °C; water dose not stated in the text read): shot time ~50% longer, TDS 8.2 → 8.9%; flow fits used means of three shots per arm. | A (small n) | [R7] |
| Days since roast | The same coffee ground finer and wider after 23 days (single observation) | D | [R22] |

### 2.2 Grind setting ↔ burr gap ↔ PSD

**Manufacturer adjustment specifications** (these give axial burr movement, not a PSD):

| Grinder | Specification | Source |
|---|---|---|
| Mahlkönig E65S | 80-indicator scale covering a "bandwidth of 180 to 580 µm", ≈ 5 µm per indicator if linear [derived]. **Source conflict (noted 2026-10-14):** Schmieder et al. 2023 describe this 180–580 µm range as a particle-size (volume-mean diameter) bandwidth, not burr movement. If they are right, the 5 µm figure is not a burr-gap step; 65 mm steel burrs; 1400 / 1700 rpm (50 / 60 Hz); 4–7 g s⁻¹ | brochure [R42] |
| Bentwood Vertical 63 | dial "calibrated to the grinder burr spacing in µm" | [R3] |
| 1Zpresso J-Max | 8.8 µm per click; 90 clicks per rotation; 48 mm burr | [R43] |
| 1Zpresso JX-Pro / JE-Plus | 12.5 µm per click; 40 clicks per rotation | [R43] |
| 1Zpresso J-Ultra | 8 µm per click | [R43] |
| Mahlkönig EK43 | arbitrary dial; zero set where the burrs "chirp" | [R7] |

**Measured mapping on a µm-calibrated grinder.** Bentwood Vertical 63, Camsizer X2, coffee with no added fines. Values digitized from Smrke et al. 2024, Fig. 2, read to about ±3 µm and ±0.3 points. Pairing the points with settings assumes X50 increases monotonically with spacing.

| Burr spacing (µm) | X50 (µm) | Q100 (%) | X50 / spacing [derived] |
|---|---|---|---|
| 160 | ≈ 232 | ≈ 25.6 | 1.45 |
| 170 | ≈ 245 | ≈ 23.9 | 1.44 |
| 180 | ≈ 257 | ≈ 22.4 | 1.43 |
| 190 | ≈ 267 | ≈ 21.7 | 1.41 |
| 210 | ≈ 295 | ≈ 18.8 | 1.40 |
| 250 | ≈ 352 | ≈ 15.0 | 1.41 |

X50 above the gap is plausible for two reasons: the size metric is the projected-area diameter (elongated particles can pass a gap narrower than their length), and the dial reads a *nominal* spacing.

**Fines vs median across sources [derived].** Smrke (Camsizer): ΔQ100/ΔX50 = (15.0 − 25.6)/(352 − 232) ≈ −0.088 points per µm. Corrochano (dry LD, disc grinder, X50 190 → 383 µm): (16.7 − 35.9)/(383 − 190) ≈ −0.099 points per µm. Two grinders and two methods give similar slopes; intercepts differ by grinder ("unimodality").

**Dial resolution vs PSD resolution.** On the E65S, GL 1.4 → 2.0 is 7.5% of the scale, ≈ 30 µm nominal [derived]. Wet D43 moved only 273 → 295 µm, with SDs of 8–18 µm, yet pressure and component masses still changed [R4]. Espresso-relevant dial steps are near the repeatability limit of PSD measurement. The simulator must therefore respond to small changes in the fines fraction, not only to X50.

**Other mappings.** EK43 at 6 bar and 98 N: shot time falls steadily as the setting coarsens, and EY peaks near GS 1.7 [R2]. Matching PSDs across roasts needs a correction: dark at 2.3 ≈ light at 2.0 [R7].

### 2.3 Access to grinder-specific PSDs

Machine-readable PSDs exist only in Harper's Figshare CSVs (EK43, CC BY 4.0) and in Corrochano's thesis tables. The Kaffeemacher/ZHAW set (24 grinders, > 300 PSDs) is published as figures only. Most other sources offer figures, or data on request (§5.2). Community sieve data (Kruve) are mostly for filter grinders (D).

---

## 3. Comminution modelling: is anything predictive?

| Approach | Coffee-specific status | Predicts a PSD from burr geometry? |
|---|---|---|
| Population balance (selection function × breakage function, linear or non-linear) | Generic theory is mature (e.g., Bilgili & Scarlett 2005 [R61]). A 1991 ASIC paper by Petracco & Marega on "coffee grinding dynamics" by computer simulation is cited in the community **[unverified]**. I found no modern coffee population-balance model with fitted breakage parameters. | No |
| DEM with breakage (bonded-particle, fast-breakage or replacement models) | An industrial "digital twin" project (Coffee Technology S.r.l. with MADE-CC and Politecnico di Milano) used FEM + DEM plus bean mechanical testing to target PSD and flow rate; no publications found [R62]. No peer-reviewed DEM of burr grinding of roasted coffee found. | Not demonstrated |
| Fracture data for roasted beans | Quasi-static compression (20 mm min⁻¹) of light-roast arabica: breaking force 30.2–51.6 N (SD 12–20 N), strain at fracture 5.2–8.4%, absorbed energy 4.6–11.9 N·mm, independent of bean size and mass [R16]. Dynamic loading raises fracture force [R17]. Roasting lowers deformability [R15]. Uman discusses glass or shatter transitions as a possible but unmeasured cause of the cold-grinding effect [R1]. | Inputs only |
| Phenomenology | Cameron 2020: boulders are set by burr aperture, while fines form at fracture interfaces, so fines size stays constant and their share rises as the gap closes [R2]. Uman 2016: "accurate first principles modeling [is] a daunting prospect, and so fracturing is best studied experimentally" [R1]. | Qualitative |
| Empirical / statistical | Mixture parameters vs median per grinder [R19]; second-order polynomial of Q100 vs burr spacing, and PLS regression from PSD to extraction time [R3]; Kaffeemacher metrics [R25]; image-based deep-learning wear classifiers [R48] | Within one grinder only |

**Verdict.** Nothing in the open literature predicts a PSD from tooth geometry, rpm and bean mechanics. Fracture data exist only for light roasts, with large variance, and are not coupled to any grinder model. For the simulator, grinder → PSD must be **empirical and hierarchical**: a family prior plus per-grinder calibration. Physics should enter only as constraints: a fines mode that does not move, boulders scaling with the gap, and roast/temperature brittleness modifiers.

---

## 4. Puck preparation and basket

Physical framing [derived]: at 9 bar, the hydraulic load on a 58 mm bed (area 2.64 × 10⁻³ m²) is ≈ 2.4 kN, about 240 kgf. Typical tamps are 10–30 kgf (0.1–0.3 kN). Water pressure therefore recompacts the bed regardless of the tamp, consistent with the null tamping results below. The poroelastic picture is developed in note 01.

| Variable | Evidence and effect size | Grade | Sources | Simulator treatment |
|---|---|---|---|---|
| Dose (fixed basket) | Model and café data: lower dose at the same ratio raises EY. 15 g ground much coarser matched the EY of 20 g with high reproducibility [R2]. At constant cup volume, 14 → 12 g lowered bioactives by only ~9% [R35, R36]. | A/B | Cameron 2020; Khamitova 2020a/b | bed depth ∝ dose; headspace follows |
| Tamping force | No detectable effect on caffeine and trigonelline kinetics [R6, abstract]. "A range of tamp pressures" gave "no appreciable variation in shot time or EY", so tamping was standardized at 98 N [R2]. 150 shots at 10 / 15 / 20 kg: mean time 24.24 / 23.54 / 24.20 s and TDS 8.05 / 8.00 / 7.98%, ANOVA not significant [R26]. | A; A; D | Kuhn 2017; Cameron 2020; Kaffeemacher | ignore above ~10 kgf; below ~5 kgf, a "loose bed" risk flag (community claim) **[unverified]** |
| Distribution / WDT | Standard in modern protocols: needle WDT plus leveling in Ribes, Waszkiewicz (acupuncture-needle tool, 20 kg auto-tamp) and Lance Hedrick's videos as cited by [R31]. **No controlled, quantified study** of WDT effect size found. | D | [R27], [R31] | prior on reduced heterogeneity variance only |
| Basket design | Precision baskets: retailers state VST inspects every hole to ±20–30 µm **[unverified at manufacturer]**. Shower water and basket holes that stop short of the wall leave the edge under-extracted [R24]. A Reneka basket with a 33% smaller perforated area (40 vs 49 mm diameter) was linked to a ~3-point EY loss (hypothesis) [R27]. Basket type and perforated-disc height (4–7 mm) change bioactive extraction [R35, R36]. | D; A | Ribes; Gagné; Khamitova | open area and perforated diameter set the radial flow-weight profile |
| Bottom paper filter | Without paper, the outer ¼ of the dose extracted about half as much as the centre (13% vs 25% EY); shot EY 21%. With a V60 paper underneath, 22–25% across the radius and shot EY 24%. Setup: 12 g in a VST 15 g basket, EK43 with SSP HU burrs, 1:2.5. | D | Ribes 2020 [R27] | raise outlet/edge permeability (holes not blocked by fines) |
| Paper filter on top | Does not "contribute meaningfully" to resistance or "significantly affect" EY (Hedrick 2023, as summarized by Gagné) | D (second-hand) | [R24] | ignore |
| Puck / contact screen | Traditional VST and Pullman baskets: edge EY 16–17% → 22–23% with the screen; shot EY 22 → 24% (VST) and 21 → 24% (Pullman). Modern baskets: +0.4% EY (95% CI 0.2–0.6) (Hedrick 2023 via Gagné). | D | Ribes 2021 [R28]; [R24] | inlet redistribution; effect is basket-dependent |
| Headspace | Less headspace on a DE1: +3.4% EY (95% CI 3.0–3.8) over ten shots, dark roast, 1:1 ristretto; repeatability unchanged. Mechanism: uneven pre-wetting while the headspace fills with water. | D (second-hand: Buckman 2023 via Gagné) | [R24] | headspace volume and fill time set a wetting-uniformity parameter |
| Tamper base shape | A convex ("US curve") base raises centre flow, worsens radial uniformity, and lowered EY from 21% to 20% | D | [R27] | radial bed-density perturbation |
| Pre-infusion and bloom | DE1 pre-infusion flow of 2.4–8.0 mL s⁻¹ left EY flat at 19.5–20.0%. Peak pressure was U-shaped: 4.6–4.8 bar at 3–4 mL s⁻¹ vs 8.7–8.8 bar at 6–8 mL s⁻¹ [R29]. At fine settings, 9 bar clogged, so Cameron used 6 bar [R2]. Controlled peer-reviewed pre-infusion studies are scarce. | D; A | Ribes 2020; Cameron 2020 | explicit wetting and swelling stage (note 01) |
| Fines (added back) | Adding sieved fines lowers permeability and lengthens shots; EY follows time. Shots under 10–15 s still reached 17–18% EY. No sensory penalty at +1–2 g (one Q-grader, not a blinded panel). | A | Smrke 2024 [R3] | fines fraction → permeability |
| Flow rate (with puck prep fixed) | 1.5 vs 2.5 mL s⁻¹ with coarser grind and gentler ramps: EY 19.4–20.1% vs 19.4–19.9% [R30]. In a central-composite design, flow had the strongest effect on component masses, more so at finer grind and higher temperature [R4]. | D; A | Ribes 2020; Schmieder 2023 | — |

---

## 5. Public datasets for ML and calibration

### 5.1 Shot-logging ecosystems

| Source | Per-shot content | Format and access | Scale | Licence / terms | Usefulness |
|---|---|---|---|---|---|
| **Visualizer.coffee** [R56] | Time series: pressure, flow, weight, flow-by-weight, basket and mix temperature, targets, water dispensed, state changes. Metadata: profile (title and JSON), dose (`bean_weight`), drink weight, TDS, EY, enjoyment, grinder model and setting (free text), bean brand and type, roast level and date, notes, barista, tasting attributes (fragrance, aroma, flavor, aftertaste, acidity, bitterness, sweetness, mouthfeel), tags. | Uploads from Decent (Tcl `.shot` and JSON v2), Beanconqueror, Gaggiuino, GaggiMate, Meticulous, Smart Espresso Profiler CSV and Pressensor. REST API: `GET /api/shots`, `/api/shots/:id`, `/api/shots/:id/download`, `/api/shots/:id/profile`, `/api/shots/shared`, `POST /api/shots/upload`; OAuth (Doorkeeper) or HTTP basic auth. Without auth, the index lists only public shots (`where(public: true)`) and returns `id`, `clock` and `updated_at`. Rate limits: 50 per minute and 200 per 10 minutes per IP (plus 200 per 10 minutes per user). | "Home for millions of shots"; "over 10,000 coffee people" (homepage). Public share unknown. Started Nov 2020. | Code MIT. **No explicit data licence or terms of use found.** Privacy policy: accounts private by default; uploaded files discarded after parsing; data "never" sold; GDPR rights listed. | Hydraulics and dial-in priors (grinder model + setting → flow/time); profile diversity. Weak for PSD (none) and taste (subjective enjoyment; TDS/EY sparse, protocol unknown). |
| **Decent DE1 (de1app)** [R57] | Series: elapsed, pressure (+ goal), flow (+ goal, by weight), basket and mix temperature (+ goals), weight, water dispensed, resistance, state change. Meta: bean brand, type, notes, roast level and date; enjoyment, notes, TDS, EY; grinder model and setting; dose in, yield out, time; full profile and app settings. | Local history in Tcl `.shot` and JSON v2 (built in `shot.tcl`); the DYE plugin captures metadata; Visualizer uploader. Sampling about 4 per second per a third-party description **[unverified]**. | per machine | de1app code GPL-3.0; DYE plugin GPL-3.0 | Best instrumented rig for in-house calibration |
| Decaid (new Decent control app) | as above plus per-point targets and phase markers; local REST/WebSocket API | — | — | **[unverified]**: seen only in a third-party MCP-server description | possible richer logging |
| Gaggiuino (Gaggia Classic mod) [R58] | `timeInShot`, pressure, pump flow, weight flow, temperature, shot weight, water pumped; target pressure, flow, temperature; profile name | JSON export (Visualizer-compatible) | community | CC BY-NC 4.0 (project) | cheap second rig; non-commercial licence |
| GaggiMate | `t`, `cp` (pressure), `fl` (flow), `tp`/`tf` (targets), `tt`/`ct` (temperature), `v`/`ev` (measured / estimated weight), `vf`/`pf` (flow) | JSON export; WebSocket API | community | CC BY-NC-SA 4.0 | as above |
| Meticulous | pressure, flow, weight, gravimetric flow, set-points, tube temperature, status | machine API (pyMeticulous, GPL-3.0); JSON export | — | — | lever-style profiles |
| Beanconqueror app | grinder ("mill") name, grind size, dose, beverage weight, TDS, EY, roaster, bean name, roast, roast date, aromatics; flow series | JSON export; Visualizer upload | — | GPL-3.0 | manual logs rich in metadata |

**Visualizer caveats for ML.** Grinder names and settings are free text and not comparable across grinder models. TDS/EY protocols are unknown, which matters because unfiltered TDS read 2.1–2.7 EY points above filtered TDS in Gagné's data [R23]. Enjoyment is a single personal score. Public shots are self-selected. At the published rate limit, metadata-only crawling reaches at most ~28,800 requests per day [derived]. A bulk dataset needs the maintainer's cooperation (Implications, E).

### 5.2 Academic datasets with open access or open licences

| Dataset | Content | Size | Licence | Use here |
|---|---|---|---|---|
| Schmieder et al. 2023 supplement (MDPI) [R4] | Central composite design, 15 conditions: flow 1–3 mL s⁻¹; E65S GL 1.4–2.0; 80–98 °C. Ten fractions per shot; TDS, caffeine, trigonelline, 5-CQA. DE1 Pro, IMS precision basket, 20 g, Sahdia distribution tool, 25 kg tamp. | 45+ shots | article CC BY 4.0; supplement presumably the same **[verify]** | compound-level kinetics vs flow, temperature and grind |
| Pannusch et al. 2023, Mendeley Data doi:10.17632/y2tz67f6ry.1 [R5] | experimental data, MATLAB code and the "Espresso Brewing Control App" | small | **CC BY-NC 3.0** | kinetic baseline; non-commercial |
| Méndez Harper et al. 2023, Figshare doi:10.6084/m9.figshare.23277320.v2 [R7] | LD PSDs at 0/5/10/15/20 µL g⁻¹ water; twice-ground sample; 12 Ikawa roast curves; Fig. 7 flow-rate data | ~1 MB | CC BY 4.0 | roast, moisture and RDT effects on PSD and aggregation; flow curves |
| Roman Corrochano 2017 EngD thesis [R8] | dry and wet PSD tables (8 grinds + flakes), sphericity, porosity, tortuosity, permeability, extraction kinetics | thesis | open-access thesis (copyright retained) | measurement-method model; PSD ↔ permeability |
| Ristenpart, Cotter & Guinard 2023, Dryad doi:10.25338/B8993H [R60] | 118 consumers × 27 drip coffees (3,186 tastings); TDS 1.0–1.5%, EY 16–24%, 87–93 °C; pH, titratable acidity; liking, just-about-right, purchase intent | 550 KB | **CC0** | pretraining a preference model (drip, not espresso) |
| Smrke et al. 2024 [R3] | PSD (X50, Q100), EY, time, PTR-MS aroma, sensory | — | on request | fines → permeability; aroma vs EY |
| Kaffeemacher / ZHAW test [R19, R25] | 24 grinders, > 300 PSDs, recipes, blind tasting | — | not public | best grinder prior if it can be licensed |
| Cameron et al. 2020 [R2] | EY vs grind setting, dose, pressure; PSD | — | no public data found **[unverified]** | — |
| Apiletti & Pastor 2020 [R50] | IoT telemetry from professional machines | — | proprietary | — |

**Searched without result.** I found no other espresso TDS/EY/sensory datasets on Zenodo, Mendeley Data, Figshare or Dryad. A Zenodo record titled "Base CLIP model for Espresso" is unrelated to coffee.

**Community sources.** Robert McKeon Aloe's "Coffee Data Science" posts report hundreds of single-operator experiments, but I found no shared raw data. Café survey reports of TDS/EY from specialtykava.si (2025–26) appeared in search, but the site failed to load **[unverified]**.

### 5.3 Green-coffee and cupping datasets

| Dataset | Content | Licence / caveat | Use |
|---|---|---|---|
| CQI scrape, github.com/jldbc/coffee-quality-database (Jan 2018) [R59] | 1,340 reviews (1,312 arabica, 28 robusta); aroma … sweetness, total score; moisture, defects, altitude, variety, processing, origin | repo MIT; data scraped from CQI pages behind a login, so redistribution rights are unclear | bean-attribute priors (moisture, processing) |
| Kaggle "Coffee Quality Data (CQI May-2023)" (fatihb) | arabica, scraped May 2023; nine attributes plus defects | licence "Other"; 113 KB | same |
| Kaggle "CQI Arabica Reviews May2023" (erwinhmtang) | five CSVs (certification, cupping, green analysis, sample), from Jan 2018 | listed ODbL / DbCL (uploader's claim) | same |

CQI total score is the sum of the attribute scores, so models that predict it from the attributes are trivially leaky. Treat these datasets as bean-quality covariates, not extraction data.

---

## 6. Prior ML and optimization work (to 2026)

| Work | Task | Data | Method | Result / caveat | Relevance |
|---|---|---|---|---|---|
| Apiletti & Pastor 2020 [R50] | link machine parameters (grinder setting, dose, time) to espresso quality metrics | real-world IoT logs from professional machines | association rules (a time-series feature paper at an EDBT 2020 workshop is also cited **[unverified title]**) | human-readable rules | value of fleet telemetry |
| Smrke et al. 2024 [R3] | PSD → extraction time; (X50, Q100, time) → EY | 6 settings × fines additions, triplicates | PLS regression, multiple linear regression | fines (< 150 µm) lengthen time; > 250 µm shortens it | template for PSD → hydraulics learning |
| Schmieder 2023 [R4]; Pannusch 2024 [R5]; Barroso 2022 [R65] | response surfaces; model-based control chart | central composite designs | RSM plus "two-grain" kinetic model, app | coefficients qualitative; brew ratio dominates | classical baseline |
| Barletta et al. 2025 [R51] | inverse map: target cup chemistry → (temperature, grind size, powder composition) | synthetic, from a multiphysics percolation model | deep network plus constant-rank theorem | accurate off-grid reconstruction (synthetic data only) | closest to a neural surrogate |
| Barletta & Cuomo 2025 [R52] | PINN for advection–diffusion–reaction extraction | — | PINN | abstract only; notes training difficulty "without additional information to anchor the solution space" | PINN feasibility |
| Giacomini 2025 [R53] | "inverse problem of coffee customisation" | extraction campaign plus expert panel | "simple ML" plus CFD | abstract only; "promising" | taste inverse design |
| Grudeva, Moroney & Foster 2026 [R34] | asymptotically reduced multiscale model | — | asymptotics | reduced model accurate and much cheaper (note 01) | physics-based surrogate |
| Szymańska & Hughes 2025 [R54] | robotic optimization of powdered cappuccino foam | ~100 exploratory runs + 50 BO iterations | Gaussian-process BO (Matérn kernel, UCB with β = 2.576) plus vision | bubble area ~11% vs ~12% for humans | BO in beverages, not espresso |
| Bramantoro et al. 2025 [R55] | pour-over variable optimization | not detailed in abstract | reinforcement learning vs kNN, decision tree, SVM | "90% accuracy" (classification framing) | weak |
| Putra & Rifai 2024 [R47] | grind-size class from photos | phone and microscope images | CNNs (VGG-19, MobileNet, InceptionV3) | accuracy 0.80 (phone) / 0.58 (microscope) | image → PSD feasibility |
| Chen et al. 2024 [R48] | burr-wear level from granule photos | phone images | image processing + deep learning | > 96% accuracy on 3 classes | grinder-state covariate |
| Oec 2026 [R46] (preprint) | best PSD descriptor for TDS | 12 samples, 2 grinders | Spearman correlation | area-weighted KDE peak ρ = −0.949 | descriptor choice |
| Kaggle CQI notebooks; a LightGBM "total cup points" paper **[unverified]** | cupping-score prediction | CQI | gradient boosting etc. | target leakage | low |

**Gaps.** I found no peer-reviewed Bayesian optimization of espresso recipes using human taste feedback, no public neural *forward* surrogate of an espresso extraction model, and PINNs for percolation only at the conference-abstract stage. The optimization literature is dominated by classical response-surface designs.

---

## Implications for the simulator design

### A. Grinder → PSD module

**Generative form** (V-weighted, size x in µm):

$$q_3(\ln x)=w_f\,\mathcal N(\ln x;\ln\mu_f,\sigma_f)+w_c\,\mathcal N(\ln x;\ln\mu_c,\sigma_c)+w_b\,\mathcal N(\ln x;\ln\mu_b,\sigma_b),\qquad w_f+w_c+w_b=1$$

| Element | Proposed relation | Prior / evidence |
|---|---|---|
| Setting → gap | $g=g_0+\Delta\,(s-s_0)$; Δ from the manufacturer (≈ 5 µm per indicator E65S [derived; disputed, see §2.2]; 8–12.5 µm per click 1Zpresso); per-unit offset $g_0$ learned (chirp-point variability) | [R42], [R43], [R7] |
| Coarse mode | $\mu_c=\kappa_G\, g\, f_{\text{roast}}\, f_T$; κ_G ≈ 1.4 for Bentwood V63 with Camsizer x_area [derived]; learn per grinder **and** per size definition | [R3] |
| Fines mode | μ_f ≈ 40 µm (method-dependent: 20–50 µm), nearly invariant with gap | [R2], [R8], [R19] |
| Fines weight | $w_f=u_G-\beta\,(X_{50}-340)$, with β ≈ 0.09–0.10 points per µm [derived] and $u_G$ the grinder's "unimodality" (fines % at 340 µm median, Gagné's metric) | [R3], [R8], [R19] |
| Boulder tail | $w_b$ and $\sigma_b$ from Gagné's right-half-width "uniformity" or Kaffeemacher's 60% peak width; μ_b ≈ 1.5–2 × μ_c (assumption to be fitted) | [R19], [R25] |
| Roast | darker → finer (Δmean up to ≈ −100 µm at fixed EK43 setting) and more brittle; parameterize by Agtron colour and moisture | [R7], [R15] |
| Bean temperature | monotone factor on modes: N mode × 0.69 at −196 °C vs 20 °C; most narrowing by −19 °C | [R1] |
| Moisture / RDT | **not a PSD change**: an aggregation state $a$ (0–1) that cuts effective fines mobility and raises bed porosity. Calibrate to the reported ~50% longer shots and TDS 8.2 → 8.9% with added water (confirm the dose from the paper's methods or Supplemental Information). Keep "dispersed PSD" and "in-puck effective PSD" separate. | [R7] |
| Measurement model $M_m$ | dry LD, wet LD (adds a 1–10 µm population: D32 roughly ÷3–4, fines +13–14 points on the same grinds [R8]), Camsizer (x_area vs x_c,min), phone (lower cutoff ~50–100 µm, N weighting). Needed to fit heterogeneous literature data and user photos. | §1.4 |
| Outputs to flow and extraction | D32 with sphericity ≈ 0.75 for Kozeny–Carman-type closures (note 01); fines fraction for permeability and migration; 2–5 size classes for the extraction solver (fines class mean ≈ 40 µm; coarse ≈ D43) | [R8] |

**ML layer.** Use a hierarchical model (Gaussian process or small network) mapping grinder embedding, burr family, burr diameter, flat/conical, rpm, gap, roast colour, moisture, bean temperature and days since roast to the mixture parameters θ. Use family-level priors from §1–2. Train on (i) in-house PSD sweeps, (ii) licensed Kaffeemacher/ZHAW PSDs if obtainable, and (iii) digitized literature values passed through $M_m$.

**Per-user calibration by inversion.** Fines dominate puck resistance [R3], so 2–3 logged shots (pressure, flow, time) identify $w_f$ and D32 and hence $g_0$ and κ_G. EY weakly identifies μ_c. Neural surrogates should take θ (about 9 numbers) as input rather than binned PSDs: this keeps the input low-dimensional and smooth.

### B. Puck-prep module

- **Tamp.** Threshold model: no effect above ~10 kgf; below ~5 kgf, flag a loose bed (community claim; low priority).
- **Radial heterogeneity.** Use three annuli (centre / middle / edge, edge ≈ 25–30% of dose) with an edge flow multiplier. Calibrate to Ribes: EY_edge / EY_centre ≈ 0.52–0.68 with stock screens and baskets, and ≈ 0.85–0.92 with a bottom paper or contact screen [derived from [R27], [R28]]. The basket's open area and perforated diameter set the multiplier.
- **Wetting uniformity.** Combine headspace volume, pre-infusion flow and machine levelness into a pre-wetting non-uniformity parameter. Bound its effect by the ≈ +3.4-point headspace result.
- **Channeling.** Represent it as a stochastic permeability perturbation amplified by the extraction–permeability feedback (Lee et al. [R32]; note 01). Its amplitude falls with WDT and screens and rises with fines fraction and clumping (low moisture). Calibrate on shot-to-shot EY variance at fine settings (variance rises below EK43 GS ≈ 1.7 [R2]).
- **Paper and screens.** A bottom paper removes outlet blocking (edge and outlet permeability up). A top paper does nothing. A puck screen redistributes inlet flow, with a basket-dependent effect.

### C. Data to collect (in-house)

| Block | Measurements | Design | Purpose |
|---|---|---|---|
| PSD sweeps | dry LD (with pressure titration) and/or Camsizer, plus a phone-image protocol; record size definition and dispersion settings | ≥ 3 grinders (flat SSP-type, flat stock, conical); 6–8 espresso settings; 3 replicates; 2–3 roasts; beans at room temperature vs frozen; RDT 0 / 10 / 20 µL g⁻¹ | learn θ(setting, bean) and $M_m$ |
| Shot logs | pressure, flow, weight, temperature at ≥ 4 Hz plus targets (DE1 or Gaggiuino/GaggiMate); full puck-prep metadata | 5 shots per PSD condition | hydraulics calibration |
| Extraction | TDS **both** filtered (0.45 µm) and unfiltered; EY; 5–10 fractionated cups for a subset; optional HPLC (caffeine, trigonelline, 5-CQA) | subset of the conditions above | kinetics and TDS-protocol mapping |
| Radial EY | Ribes-style coring (centre / middle / edge) | A/B tests: bottom paper, screen, headspace, WDT, tamp | heterogeneity module |
| Sensory | descriptors plus hedonic score, blinded | ≥ 10 shots per cell | taste model |

Sample size [derived]: detecting ΔEY = 0.5 points with σ ≈ 0.5 points (α = 0.05, power 0.8) needs n ≈ 16 shots per arm.

### D. Which dataset for what

| Need | Dataset(s) |
|---|---|
| Grinder → PSD priors | Kaffeemacher/ZHAW (license), Harper Figshare, Corrochano thesis tables, Smrke Fig. 2 (digitized), Schmieder Fig. A1, Uman/Cameron figures |
| Measurement-method model | Corrochano dry vs wet tables; Schmieder dry vs wet figure |
| Hydraulics and dial-in behaviour | own DE1/Gaggiuino logs; Visualizer public shots (with permission) |
| Compound kinetics | Schmieder supplement; Pannusch Mendeley (non-commercial) |
| Fines → permeability | Smrke (request); Corrochano thesis |
| Taste / preference pretraining | Dryad drip consumer data (CC0); then espresso-specific in-house panels |
| Bean-quality covariates | CQI-derived datasets (caveats) |

### E. Legal and terms-of-use caveats

| Source | Caveat |
|---|---|
| Visualizer | Code is MIT, but shots are users' content. No data licence or terms of use found. Accounts are private by default. Personal data (names, barista field) falls under GDPR. EU database right (Directive 96/9/EC) may protect substantial extraction. Rate limits apply. **Recommended:** contact the maintainer (Miha Rekar) for a data-sharing or opt-in arrangement; keep derived features; strip personal data; honour deletions. |
| Gaggiuino / GaggiMate | CC BY-NC(-SA) licences cover the projects' code and hardware; reading their file formats is fine, but reusing their code commercially is not |
| Pannusch Mendeley data | CC BY-NC 3.0: no commercial use without permission |
| Figshare (Harper), MDPI (Schmieder), Smrke (Sci Rep article) | CC BY 4.0: attribution required |
| Dryad (Ristenpart) | CC0 |
| CQI-derived Kaggle data | scraped from a login-gated site; uploader licences may be invalid; research use only, after review |
| Barista Hustle, Coffee ad Astra, Kaffeemacher | copyrighted; cite numbers, do not scrape; request raw data |

---

## Open questions / data gaps

1. **No public paired dataset** links grinder setting, measured PSD and shot outcome (hydraulics + EY/TDS + sensory) across many grinders. Kaffeemacher/ZHAW has the closest thing, but it is not public.
2. **No burr-geometry → PSD physics.** There is no DEM or population-balance model calibrated for roasted coffee. Fracture data cover only light roasts, with large variance, and nothing on fatigue, temperature or moisture dependence at grinding strain rates.
3. **Alignment, RPM and burr wear** are quantified only anecdotally, as are feed rate beyond 10 g doses and grind heating.
4. **Puck prep** (WDT, distribution tools, screens, headspace) rests mostly on single-operator community data. Radial heterogeneity data come essentially from one experimenter (Ribes), and the headspace and screen effects reach this note second-hand through Gagné's book.
5. **Espresso sensory data** with controlled TDS/EY are scarce. Large open preference data exist only for drip, and Visualizer's "enjoyment" is a weak label.
6. **Measurement standards differ.** PSD (wet vs dry LD vs imaging; size definitions) and TDS (filtered vs unfiltered; refractometer calibration) vary between sources, so pooling needs explicit measurement models.
7. **Clumping and fines migration in the puck** are inferred from flow, not observed in situ. Time-resolved micro-CT (note 01) has only begun.
8. **Visualizer scale and representativeness** (number of public shots, grinder coverage, share with TDS/EY) are unknown without maintainer data.
9. **Several cited items were not fully readable:** Cameron Supplemental Information (model radii), Moroney 2015 PSD parameters, the Vaca Guerra dissertation (Rosin–Rammler values), Barista Hustle grinder articles, and the 1991 Petracco & Marega paper.

---

## References

Grades in brackets; accessed 2026-10-13. "via" = number taken from the source named.

- **[R1]** Uman E. et al. (2016). The effect of bean origin and temperature on grinding roasted coffee. *Sci. Rep.* 6:24483. doi:10.1038/srep24483 [A]
- **[R2]** Cameron M.I. et al. (2020). Systematically improving espresso: insights from mathematical modeling and experiment. *Matter* 2(3):631–648. doi:10.1016/j.matt.2019.12.019 [A/B]
- **[R3]** Smrke S., Eiermann A., Yeretzian C. (2024). The role of fines in espresso extraction dynamics. *Sci. Rep.* 14:5612. doi:10.1038/s41598-024-55831-x [A]
- **[R4]** Schmieder B.K.L. et al. (2023). Influence of flow rate, particle size, and temperature on espresso extraction kinetics. *Foods* 12(15):2871. doi:10.3390/foods12152871 [A]
- **[R5]** Pannusch V.B. et al. (2024). Model-based kinetic espresso brewing control chart for representative taste components. *J. Food Eng.* 367:111887. doi:10.1016/j.jfoodeng.2023.111887. Data/code: doi:10.17632/y2tz67f6ry.1 [B]
- **[R6]** Kuhn M. et al. (2017). Time-resolved extraction of caffeine and trigonelline from finely-ground espresso coffee with varying particle sizes and tamping pressures. *J. Food Eng.* 206:37–47. doi:10.1016/j.jfoodeng.2017.03.002 [A, abstract]
- **[R7]** Méndez Harper J. et al. (2024; online 2023). Moisture-controlled triboelectrification during coffee grinding. *Matter* 7:1–18. doi:10.1016/j.matt.2023.11.005. Data: doi:10.6084/m9.figshare.23277320.v2 [A]
- **[R8]** Roman Corrochano B. (2017). *Advancing the engineering understanding of coffee extraction.* EngD thesis, Univ. Birmingham. https://etheses.bham.ac.uk/id/eprint/7176/ [C]
- **[R9]** Corrochano B.R. et al. (2015). A new methodology to estimate the steady-state permeability of roast and ground coffee in packed beds. *J. Food Eng.* 150:106–116 [A, abstract]
- **[R10]** Vaca Guerra M. et al. (2024). Modeling the extraction of espresso components as dispersed flow through a packed bed. *J. Food Eng.* 368:111913. doi:10.1016/j.jfoodeng.2023.111913 [A]; Vaca Guerra M. (2025), dissertation, TU Hamburg (ISBN 9783689526887) [C, preview]
- **[R11]** Moroney K.M. et al. (2015). Modelling of coffee extraction during brewing using multiscale methods: an experimentally validated model. *Chem. Eng. Sci.* 137:216–234. doi:10.1016/j.ces.2015.06.003 [B]
- **[R12]** Moroney K.M. et al. (2017). Coffee extraction kinetics in a well mixed system. *J. Math. Ind.* 7:3. doi:10.1186/s13362-016-0024-6 [B]
- **[R13]** Hargarten V.B., Kuhn M., Briesen H. (2020). Swelling properties of roasted coffee particles. *J. Sci. Food Agric.* 100:3960–3970. doi:10.1002/jsfa.10440 [A, abstract]
- **[R14]** Schenker S. et al. (2000). Pore structure of coffee beans affected by roasting conditions. *J. Food Sci.* 65:452–457. doi:10.1111/j.1365-2621.2000.tb16026.x [A, via R8/R9]
- **[R15]** Pittia P., Dalla Rosa M., Lerici C.R. (2001). Textural changes of coffee beans as affected by roasting conditions. *LWT* 34:168–175. doi:10.1006/fstl.2000.0749 [A, abstract]
- **[R16]** Nedomová Š. (2010). Crushing of roasted Arabica coffee beans. *Acta Univ. Agric. Silvic. Mendel. Brun.* 58(4):177–182. doi:10.11118/actaun201058040177 [A]
- **[R17]** Nedomová Š. et al. (2013). Strength of coffee beans under static and dynamic loading. *Acta Univ. Agric. Silvic. Mendel. Brun.* 61(3):743–749. doi:10.11118/actaun201361030743 [A, abstract]
- **[R18]** Navarini L. et al. (2025). Morphological analysis of *C. arabica* beans roasted by different industrial processes using synchrotron microtomography. ASIC 2025 e-poster. https://www.alphavisa.com/asic/2025/documents/eposters/S7/S7_NAVARINI.pdf [D]
- **[R19]** Gagné J. (2023). What I learned from analyzing 300 particle size distributions for 24 espresso grinders. https://coffeeadastra.com/2023/09/21/what-i-learned-from-analyzing-300-particle-size-distributions-for-24-espresso-grinders/ [D]
- **[R20]** Gagné J. (2019). An app to measure your coffee grind size distribution. https://coffeeadastra.com/2019/04/07/an-app-to-measure-your-coffee-grind-size-distribution-2/ ; https://github.com/jgagneastro/coffeegrindsize [D]
- **[R21]** Gagné J. (2019). Grind quality and the popcorning effect. https://coffeeadastra.com/2019/04/12/grind-quality-and-the-popcorning-effect/ [D]
- **[R22]** Gagné J. (2019). Seasoning grinder burrs and grind quality. https://coffeeadastra.com/2019/05/27/seasoning-grinder-burrs-and-grind-quality-2/ [D]
- **[R23]** Gagné J. (2021). A comparison between standard and low-fines espresso shots. https://coffeeadastra.com/2021/05/10/a-comparison-between-standard-and-low-fines-espresso-shots/ [D]
- **[R24]** Gagné J. (2025). *The Physics of Espresso.* Scott Rao Coffee Books, ISBN 9798350747737; extract "Shower screens and headspace": https://decentespresso.com/img/f/gagne_espresso_shower_screens.pdf [C; cites Buckman 2023, Hedrick 2023f, Ribes 2020/2021]
- **[R25]** Kaffeemacher. Test protocol espresso grinders: https://kaffeemacher.de/en/blogs/kaffeewissen/test-protocol-espresso-grinders ; particle distribution: https://kaffeemacher.de/blogs/kaffeewissen/kaffee-partikelverteilung [D]
- **[R26]** Kaffeemacher. Tamping-pressure experiment (150 shots): https://kaffeemacher.de/en/blogs/kaffeewissen/anpressdruck-tampen [D]
- **[R27]** Ribes S. (2020). Radial uniformity of espresso extractions (paper below puck; tamper base). Decent public Basecamp: https://public.3.basecamp.com/p/9vnWSmKqDokidAMuEcUvKYf8 [D]
- **[R28]** Ribes S. (2021). Effects of a puck screen on extraction. https://www.decentespresso.com/docs/effects_of_a_puck_screen_on_extraction [D]
- **[R29]** Ribes S. (2020). The impact of the preinfusion flow rate on espresso extraction. https://decentespresso.com/docs/the_impact_of_the_preinfusion_flow_rate_on_espresso_extraction [D]
- **[R30]** Ribes S. (2020). Higher extraction flow rates without channeling? https://www.decentespresso.com/docs/higher_extraction_flow_rates_without_channeling [D]
- **[R31]** Waszkiewicz R. et al. (2025/26). Under pressure: poroelastic regulation of flow in espresso brewing. arXiv:2512.21528v2 [C]
- **[R32]** Lee W.T., Smith A., Arshad A. (2023). Uneven extraction in coffee brewing. *Phys. Fluids* 35. doi:10.1063/5.0138998 ; arXiv:2206.12373 [B]
- **[R33]** Mo C. et al. (2023). Exploring the link between coffee matrix microstructure and flow properties using combined X-ray microtomography and SPH simulations. *Sci. Rep.* 13:16374. doi:10.1038/s41598-023-42380-y [A/B]
- **[R34]** Grudeva Y., Moroney K.M., Foster J.M. (2026). A multiscale model for espresso brewing: asymptotic analysis and numerical simulation. *Eur. J. Appl. Math.* 37:496–519. doi:10.1017/S095679252500018X [B]
- **[R35]** Khamitova G. et al. (2020). The impact of different filter baskets, heights of perforated disc and amount of ground coffee on the extraction of organic acids and the main bioactive compounds in espresso coffee. *Food Res. Int.* 133:109220. doi:10.1016/j.foodres.2020.109220 [A, abstract]
- **[R36]** Khamitova G. et al. (2020). Optimization of espresso coffee extraction through variation of particle sizes, perforated disk height and filter basket aimed at lowering the amount of ground coffee used. *Food Chem.* 314:126220. doi:10.1016/j.foodchem.2020.126220 [A, abstract]
- **[R37]** Malvern Panalytical. App notes AN121220 and AN150601 (coffee grounds by laser diffraction). https://www.malvernpanalytical.com/en/learn/knowledge-center/application-notes/an150601rapidmeasurementofcoffeepsd [D]
- **[R38]** Sympatec. Coffee particle size analysis. https://www.sympatec.com/en/applications/coffee-particle-size-analysis [D]
- **[R39]** Microtrac. SYNC application note on coffee grounds. https://www.microtrac.com/files/443019/coffee-grounds-particle-size-and-image-analysis-for-quality-control.pdf [D]
- **[R40]** HORIBA. Interpreting laser diffraction results for non-spherical particles. https://www.horiba.com/ind/particlewebinars/interpreting-laser-diffraction-results-for-non-spherical-particles/ [D]
- **[R41]** Abbott S. Grind Size Analysis app. https://www.stevenabbott.co.uk/practical-mechanical/Grind.php [D]
- **[R42]** Mahlkönig/Hemro. E65S product brochure (DE). https://downloads.mahlkoenig.de/Products/Mahlkoenig_E65S_Espresso_Grinder_Product_Brochure_DE.pdf [D]
- **[R43]** 1Zpresso. J-series specifications. https://1zpresso.coffee/j/ [D]
- **[R44]** Honest Coffee Guide. Grind size chart. https://honestcoffeeguide.com/coffee-grind-size-chart/ [D]
- **[R45]** Coffee Review. Minding the grinds (Horiba method). https://www.coffeereview.com/minding-the-grinds-our-approach-to-sampling-and-judging-grind-consistency/ [D]
- **[R46]** Oec N. (2026). An area-weighted particle-size peak from image analysis predicts total dissolved solids across grinder types. engrXiv 7507. https://engrxiv.org/preprint/view/7507 [C]
- **[R47]** Putra D.Z.A., Rifai A.P. (2024). Convolutional neural network for ground coffee particle size classification. *J. Mutu Pangan* 11(1):36–51. doi:10.29244/jmpi.2024.11.1.36 [A]
- **[R48]** Chen C.-Y. et al. (2024). Coffee grinder burr wear level assessment based on imaging granule analysis and deep learning. *Appl. Sci.* 14(3):1315. doi:10.3390/app14031315 [A]
- **[R49]** Griffiths C., Adams G.C., Rees A. (2018). Wear monitoring of coffee grind-on-demand burrs using precision sieving and laser diffraction. *Int. J. Food Biosci.* (Swansea Cronfa 45569) [A, abstract]
- **[R50]** Apiletti D., Pastor E. (2020). Correlating espresso quality with coffee-machine parameters by means of association rule mining. *Electronics* 9(1):100. doi:10.3390/electronics9010100 [A, abstract]
- **[R51]** Barletta A. et al. (2025). Inverse modeling of porous flow through deep neural networks: the case of coffee percolation. arXiv:2511.11194 [C, abstract]
- **[R52]** Barletta A., Cuomo S. (2025). PINNs for modeling coffee extraction. SIMAI 2025 abstract. https://simai2025.cimne.com/event/contribution/e384637e-3345-11f0-a5f6-000c29ddfc0c [C]
- **[R53]** Giacomini J. (2025). A simple ML approach to the inverse problem of coffee customisation. SIMAI 2025 abstract. https://simai2025.cimne.com/event/contribution/24e2039f-34d0-11f0-a5f6-000c29ddfc0c [C]
- **[R54]** Szymańska E., Hughes J. (2025). Robotic optimization of powdered beverages leveraging computer vision and Bayesian optimization. *Front. Robot. AI* 12:1603729. doi:10.3389/frobt.2025.1603729 [A]
- **[R55]** Bramantoro A. et al. (2025). Optimization of pour-over coffee extraction variables using reinforcement learning. *PeerJ Comput. Sci.* 11:e3219. doi:10.7717/peerj-cs.3219 [A, abstract]
- **[R56]** Visualizer: https://visualizer.coffee ; code/API (MIT): https://github.com/miharekar/visualizer ; privacy: https://visualizer.coffee/privacy [D]
- **[R57]** Decent de1app (GPL-3.0), shot JSON v2 in `de1plus/shot.tcl`: https://github.com/decentespresso/de1app ; DYE plugin: https://github.com/hsyhsw/de1app_plugin_DYE [D]
- **[R58]** Gaggiuino (CC BY-NC 4.0) https://github.com/Zer0-bit/gaggiuino ; GaggiMate (CC BY-NC-SA 4.0) https://github.com/jniebuhr/gaggimate ; pyMeticulous (GPL-3.0) https://github.com/MeticulousHome/pyMeticulous ; Beanconqueror (GPL-3.0) https://github.com/graphefruit/Beanconqueror [D]
- **[R59]** CQI data: https://github.com/jldbc/coffee-quality-database ; https://www.kaggle.com/datasets/fatihb/coffee-quality-data-cqi ; https://www.kaggle.com/datasets/erwinhmtang/Coffee-Quality-Institute-Reviews-May2023 [D]
- **[R60]** Ristenpart W., Cotter A.R., Guinard J.-X. (2023). Consumer preference data for black coffee. Dryad doi:10.25338/B8993H (CC0); related: doi:10.1111/1750-3841.15561, doi:10.1038/s41598-022-23904-4 [A]
- **[R61]** Bilgili E., Scarlett B. (2005). Population balance modeling of non-linear effects in milling processes. *Powder Technol.* 153:59–71. doi:10.1016/j.powtec.2005.02.005 [B]
- **[R62]** MADE Competence Center. Coffee grinding technologies project (FEM/DEM digital twin). https://www.made-cc.eu/en/case_study/coffee-grinding-technologies-project/ [D]
- **[R63]** Holl W., Simon G. Roller mill for coffee. US 8,690,087 B2 (2014) [D]
- **[R64]** Sigma Coffee. SSP burr set guide 2024. https://sigmacoffee.co.uk/pages/ssp-burr-set-guide-2024 [D, retailer]
- **[R65]** Barroso et al. (2022). Optimization of the brewing parameters on coffee extraction using a central composite rotatable design. *JSFA Reports.* doi:10.1002/jsf2.33 [A, title only]
