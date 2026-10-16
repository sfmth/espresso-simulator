# 02 — Chemistry of roasted coffee, its extraction into espresso, and the evidence for predicting taste

*Research note for the browser espresso simulator (planning phase). Compiled 2026-10-13; two Schmieder 2023 labels corrected 2026-10-14 after a cross-check against the paper.*

**Scope.** This note covers what roasted coffee contains (bulk constituents, taste-active compounds, key odorants), how bean properties set that composition (species, growing conditions, processing, roast, age since roast), how individual compounds move into an espresso during a shot, how water chemistry acts, and how far composition can predict taste. Flow, intra-particle transport models and grinding are covered in notes 01 and 03.

**Evidence key** (same as note 01): **A** = peer-reviewed primary measurement; **B** = peer-reviewed model, fit or indirect inference; **C** = book, thesis or review; **D** = grey literature or industry practice. **[unverified]** = I could not confirm the claim against a readable source. **[D]** = derived in this note from cited inputs (the calculation is shown). The reference list states for each entry whether I read the full text (FT), page images (Img), only the abstract (Abs), or relied on a secondary source (Sec).

**Conventions.** % db = g per 100 g dry matter. Espresso concentrations in mg/mL and mg/g are interchangeable to within about 2%. EY = extraction yield (dissolved solids in the cup ÷ dry dose). TDS = total dissolved solids (% w/w). λ = characteristic beverage mass of an exponential decay in outlet concentration [Schmieder 2023]. OAV = concentration ÷ odor threshold. DoT (dose over threshold) = concentration ÷ taste threshold. Roast colour scales: Colorette "Pt" and Agtron (both higher = lighter); Colortest Neuhaus "CTN" (150 = light brown, 50 = almost black). I found no validated conversion between scales, so each source's scale is kept.

---

## 0. Key findings

1. **Composition priors exist for every major class.** Medium-roast Arabica (Robusta in brackets), % db [Farah 2012]: caffeine 1.1–1.3 (2.4–2.5); trigonelline 0.2–1.2 (0.3–0.7); chlorogenic acids (CGA) 1.9–2.5 (3.3–3.8); aliphatic acids 1.6 (1.6); quinic acid 0.8 (1.0); polysaccharides 31–33 (37); melanoidins about 25 (about 25); lipids 17 (11); minerals 4.5 (4.7). Sucrose runs from 4.2% to trace as roast darkens (1.6% to trace). Lot-to-lot spread is large: caffeine across 67 Amazonian canephoras spans 1.6–3.6% [Viencz 2023].
2. **Caffeine is a minor part of coffee bitterness.** Its estimated share is ≤10% [Farah 2012], about 15% [Hofmann group, Sec] or 10–20% [Poisson 2017]. About 80% of the bitterness of decaffeinated brew was attributed to ten chlorogenic acid lactones (CGLs) [Frank 2006, via Poisson 2017]. CGLs peak at light-to-medium roast. At dark roast, harsh 4-vinylcatechol oligomers (phenylindanes) take over, and the grounds retain them strongly [Blumberg 2010].
3. **Espresso extraction order follows polarity, not volatility.** Polar compounds leave first: trigonelline, organic acids, monoester CQAs and CGLs, 2,3-butanedione. Less polar compounds lag: diCQAs, diCGLs, β-damascenone, vinyl- and ethylguaiacol [Mestdagh 2014; Sánchez-López 2016; Ludwig 2012; Blumberg 2010]. Lipids reach the cup as an emulsion. Phenylindanes and thiols are bound or retained, so diffusion alone does not describe them.
4. **Rate data usable in a model exist for four species.** With a 20 g puck, outlet concentration decays as c = c₀·exp(−m/λ). The fitted λ is 16.1 g (trigonelline), 17.5 g (TDS), 20.8 g (5-CQA) and 23.1 g (caffeine) [Schmieder 2023]. Varying flow (1–3 mL/s), grind and temperature (80–98 °C) changes cup masses by only about ±10%. Brew ratio matters more.
5. **The key odorants are known, but espresso concentrations of them are not.** About 25–30 odorants carry coffee aroma [Blank 1992; Czerny 1999]. Bean and filter-brew concentrations exist from stable-isotope dilution assays (SIDA) [Semmelroch 1995; Mayer 2000]. I found no absolute quantification of these odorants in espresso. Odor thresholds for some furanones differ by up to 10⁴× between compilations (sotolon: 0.001–20 µg/L).
6. **Cup aroma changes within minutes.** About 60% of 2-furfurylthiol reacts with hydroxyhydroquinone within 10 min [Müller & Hofmann 2007]. Melanoidins also bind thiols [Hofmann 2001]. Headspace aldehydes and diketones fall by about 50% within 15 min of grinding [Mayer & Grosch 2001, via Yeretzian 2017].
7. **Roast degree is the main lever on composition after species.** CGA is lost by first-order Arrhenius kinetics [Perrone 2010]. CGLs peak near 14% weight loss [Farah 2005]. Trigonelline converts partly to nicotinic acid (4–6% of the initial trigonelline) [Lang 2008] and to N-methylpyridinium (NMP; up to 0.25% in dark roasts) [Stadler 2002b]. Roasting degrades 12–24% of polysaccharides at light roast and 35–40% at dark [Poisson 2017]. Releasable CO₂ in whole beans is about 3.5 mg/g for light roasts and 10–13 mg/g for dark [Smrke 2018].
8. **Water-chemistry evidence for espresso is thin.** The much-cited Mg²⁺ advantage [Hendon 2014] comes from gas-phase DFT calculations. Measurements show drinking-water levels of Ca²⁺ and Mg²⁺ barely change extraction of the main organic acids [Bratthäll 2024]. Alkalinity neutralises acid: SCA-target water cancels about 7% of an espresso's titratable acidity but about 26% of a filter coffee's [D, §5].
9. **Models linking composition to taste are small and mostly not espresso-specific.** The best espresso example predicted 9 aroma and 2 taste attributes from PTR-MS headspace data on 11 + 8 espressos [Lindinger 2008]. Response surfaces mapping TDS and EY to sensory attributes exist only for drip coffee [Frost 2020; Batali 2020a; Guinard 2023], and their authors call for an espresso version.

---

## 1. Compound table: bulk and taste-active constituents

### 1.1 Content in roasted coffee and properties

**Table 1.** Roasted composition (% db, medium roast unless stated). Ar = Arabica; Rob = Robusta (*C. canephora*).

| Compound / class | Ar | Rob | Effect of roasting | MW (g/mol) | Water solubility | Sources |
|---|---|---|---|---|---|---|
| Caffeine | 1.1–1.3 | 2.4–2.5 (1.63–3.57 in 67 canephoras at Agtron 55–65) | stable | 194.2 | 21.6 g/L at 25 °C; ≈180 g/L at 80 °C; ≈670 g/L at 100 °C | Farah 2012; Viencz 2023; PubChem |
| Trigonelline | 1.2 → 0.2 as roast darkens | 0.7 → 0.3 (0.60–1.15) | degraded to nicotinic acid, NMP, pyridines | 137.1 | high [value unverified] | Farah 2012; Viencz 2023 |
| Nicotinic acid | 0.016–0.026 | 0.014–0.025 | increases (4–6% of initial trigonelline) | 123.1 | 18 g/L at 20 °C | Farah 2012; Lang 2008 |
| N-methylpyridinium (NMP) | ≤0.25 (dark roast) | — | increases | 94.1 | ionic, high | Stadler 2002b |
| Total CGA | 1.9–2.5 (green 4.1–7.9) | 3.3–3.8 (green 6.1–11.3) | first-order Arrhenius loss; about −50% at 230 °C/12 min, trace left at 250 °C/21 min | 354.3 (5-CQA) | 40 g/L at 25 °C | Farah 2012; Perrone 2010; Moon 2009 |
| — 3-, 4-, 5-CQA | 0.50, 0.62, 1.14 (mean of 12 commercial roasts) | — | isomerisation away from 5-CQA | 354.3 | — | Schrader 1996 |
| — FQAs, diCQAs | 4-FQA 0.07, 5-FQA 0.14; each diCQA 0.04–0.08 | — | lost | 368.3; 516.4 | lower [unverified] | Schrader 1996 |
| CGLs (3- and 4-CQL, FQLs, diCQLs) | peak 3-CQL 0.23, 4-CQL 0.12 at ≈14% weight loss | peak 0.25 / 0.14 | rise, then fall; maximum ≈30% of precursor CGA | 336.3 | [unverified] | Farah 2005 |
| Phenylindanes (4-vinylcatechol oligomers) | not quantified in sources read | — | rise steeply at dark roast | — | low [unverified] | Frank 2007; Poisson 2017 |
| Caffeic acid | minor | minor | released from CGA | 180.2 | <1 g/L cold; freely soluble hot | PubChem |
| Quinic acid | 0.8 (green 0.4) | 1.0 (0.4) | increases; also increases on hot holding | 192.2 | high | Farah 2012; Rune 2023 |
| Aliphatic acids, total | 1.6 (green 1.1) | 1.6 (green 1.2) | formic, acetic, glycolic, lactic form early; citric, malic fall | — | — | Farah 2012; Poisson 2017 |
| — citric / malic | fall with roast | — | — | 192.1 / 134.1 | 59% w/w at 20 °C, 84% at 100 °C / 558 g per kg water | Rune 2023; PubChem |
| — acetic / formic / lactic / phosphoric | rise with roast (formic: no trend in light roasts) | Robusta has 2–5× more total organic acids, mainly formic and acetic | — | 60.1 / 46.0 / 90.1 / 98.0 | miscible | Rune 2023; Yeager 2023 |
| Sucrose | 4.2 → trace (green 6–9) | 1.6 → trace (green 0.9–4 or 3–7) | degraded early in the roast | 342.3 | ≈2000 g/L | Farah 2012; Poisson 2017 |
| Reducing sugars | 0.3 | 0.3 | transient | 180.2 | very high | Farah 2012 |
| Polysaccharides (arabinogalactan AG, galactomannan GM, cellulose) | 31–33 (38 in the Illy & Viani table) | 37 (42) | 12–24% degraded at light roast, 35–40% at dark; AG up to −60%, mannans −36%, cellulose ≈0; solubility rises | polymer | soluble fraction only | Farah 2012; Poisson 2017; Redgwell 2002 |
| Melanoidins | ≈25 (25.4 "condensation products" by difference) | ≈25 (25.9); 10–17.9 measured | increase (literature range 7.7–25) | ~1.5 to >60 kDa | soluble part is up to 25% of brew dry matter | Farah 2012; Viencz 2023; Borrelli 2002; Hofmann 2001 |
| Protein / free amino acids | 7.5–10 / ≈0 | 7.5–10 / ≈0 | amino acids consumed (Maillard, Strecker); protein partly built into melanoidins | — | partial | Farah 2012; Bekedam 2006 |
| Lipids (triglycerides + unsaponifiables) | 17 | 11 | ~stable | — | insoluble (reach the cup as an emulsion) | Farah 2012 |
| Diterpenes | esters 0.9 | 0.2 (cafestol 0.07–0.43; 16-O-methylcafestol 0.08–0.37; kahweol in 20% of samples) | partly degraded | 316.4 (cafestol) | insoluble | Farah 2012; Viencz 2023; Gunning 2018 |
| Minerals (ash) | 4.5 | 4.7 | conserved | — | potassium salts soluble | Farah 2012 |
| Diketopiperazines (DKPs) | in infusions: main cyclo(Pro-X) at 5–250 µg/mL | — | form early; ~90% of final level by CTN 100 | 210.3 (cyclo(Pro-Leu)) | [unverified] | Kaur 2026; Poisson 2017 |
| Mozambioside and its roast products (Arabica only) | 21–170 nmol/g | — | converted to more bitter products | — | — | Bichlmaier 2025 |
| Moisture | 0–5 (green 8–12) | 0–5 | falls | 18.0 | — | Poisson 2017 |
| CO₂ (entrapped) | 1–2% of fresh weight; whole beans release 2.5–2.8 (light), 4.7–6.6 (medium) or 8.5–11.9 mg/g (dark) over 400 h | ground Robusta releases more than ground Arabica (3.9 vs 3.0 mg/g in 90 h) | increases | 44.0 | Henry solubility H = 3.4×10⁻⁴ mol m⁻³ Pa⁻¹ (25 °C) | Smrke 2018; Sander 2023 |
| Volatiles, total | ≈0.1 | ≈0.1 | — | — | — | Poisson 2017 |

Notes. (i) The Farah (2012) and Illy & Viani (1995) tables are compilations (C). Ranges partly reflect analytical method, especially for melanoidins and polysaccharides. (ii) Reported green Arabica CGA varies by source: 3.4–4.8% (Ky 2001, via Poisson 2017), 4.1–7.9% (Farah 2012), 6.7–9.2% (Belitz 2009, via Poisson 2017). (iii) The Schrader (1996) abstract gives 3-CQL at 21 g/kg and 4-CQL at 10 g/kg. That is about ten times the peak values of Farah (2005) and is probably a typographical error [unverified]; do not use it. (iv) Farah (2012) reports g/100 g without stating the basis. Roasted coffee holds 0–5% water, so the difference from % db is at most 5%.

### 1.2 Behaviour in espresso and sensory role

**Table 2.** Cup concentration, transfer efficiency, kinetic class (defined in §3.2), intra-particle data and taste role.

| Compound / class | Espresso concentration (conditions) | Share of bean content reaching the cup | Kinetic class | Intra-particle data | Taste role, thresholds |
|---|---|---|---|---|---|
| Caffeine | 2.10 mg/mL (8 g → 30 mL) [Gloess 2013]; 4.57 mg/g (mean over all 15 runs, 20 g → 40 g; not the centre point) [Schmieder 2023]; 1.6–6.5 mg/mL and 51–322 mg/serving (20 cafés) [Crozier 2012]; 48–317 mg/serving (104 cafés) [Ludwig 2014]; 117–200 mg per 25 mL from 7.5 g (20 brands) [Caprioli 2014] | 0.79% of dose mass [Gloess 2013], i.e. ≈60–66% of the caffeine if beans contain 1.2–1.3% [D]. 82% of the fitted pool c₀λ for a 40 g cup [D, Schmieder] | K2 (λ/dose 1.15) | D_bean = 1.9×10⁻¹⁰ m²/s at 80 °C (1.7–2.0 mm particles), hindrance factor 12 [Jaganyi 1999]; rate constant rises 8× from 25.8 to 84.1 °C [Spiro & Selwood 1984] (≈32 kJ/mol [D]) | bitter. Detection threshold 1.2 mM [Keast & Roper 2007]; 750 µmol/L [Poisson 2017] |
| Trigonelline | 2.45 mg/g [Schmieder]; 3.39 mg/g [Angeloni 2023]; 28–65 mg per 25 mL [Caprioli 2014] | 92% of fitted pool for a 40 g cup [D] | K1 (λ/dose 0.80) | — | weakly bitter [unverified]; mainly an aroma precursor |
| 5-CQA, 3-CQA | 5-CQA 2.96 mg/g [Schmieder]; 5.27 mg/g [Angeloni 2023]; 3-CQA 0.58 and 5-CQA 0.28 mg/mL (darker roast) [Gloess]; total CGA 1.5–2.2 mg/g in Certified Italian Espresso [Caprioli 2013] | 3-CQA 0.218% and 5-CQA 0.103% of dose mass [Gloess]; lungo extracts more efficiently, especially 5-CQA | K1–K2 (λ/dose 1.04); >70% within 8 s [Ludwig 2012] | — | astringent, slightly bitter; set pH and titratable acidity [Santanatoglia 2024b] |
| diCQAs, diCGLs | — | low | K3 [Ludwig 2012; Blumberg 2010] | — | bitter/astringent [unverified] |
| Monoester CGLs | 3-CQL 3.04 and 4-CQL 1.51 mg per g of a Robusta soluble extract [Kraehenbuehl 2017] | — | K1 [Blumberg 2010] | — | coffee-typical bitterness, 9.8–180 µmol/L [Frank 2006]; hydrolyse to acids on hot holding |
| Phenylindanes | not quantified | low ("strong retention" by the grounds) | K4 | — | harsh, lingering bitterness, 23–178 µmol/L [Frank 2007] |
| Organic acids | titratable acidity (TA) 11.5 mmol/L to pH 6.6 and 24.1 mmol/L to pH 8 [D from Gloess titration]; pH 5.5–5.9 [Gloess]. Individual acids in espresso were measured [Khamitova 2020a; Santanatoglia 2024a] but the values were not accessible to me | high [inferred] | K1 | — | sourness; follows organic acids more than CGA [Santanatoglia 2024b] |
| Sugars | no espresso data found | — | K1 [inferred] | — | sweetness near or below threshold [Batali 2020b] |
| Soluble polysaccharides | measured [Khamitova 2022], values not accessed | — | — | — | body; foam stability tracks GM and AG [Nunes 1997] |
| Melanoidins | up to 25% of brew dry matter [Borrelli 2002], i.e. ≈25 mg/g at 10% TDS [D] | 50% extracted within 9 s in capsules | K2–K3: slower than CGA [Bartel 2015] | — | colour, body; bind thiols [Hofmann 2001] |
| Lipids | 1.80 mg/mL (Ar) vs 0.55 mg/mL (Rob) [Petracco 1989, Sec]; 45–147 mg (Ar) and 14–119 mg (Rob) per 25 mL [Illy & Navarini 2011]; esterified fatty acids 0.13% [Gloess] | 0.5% of dose mass, i.e. ≈3% of bean lipid [D] | K5; most comes out in the first ~25 mL | — | creaminess; retain hydrophobic odorants |
| Cafestol, kahweol | ≈1–1.5 mg cafestol and ≈1 mg kahweol per cup [Urgert 1995; Gross 1997]. Across brew types, total cafestol esters span 5–232 mg/L and kahweol esters 2–1016 mg/L [Moeenfard 2016] | low; carried on suspended solids [Santanatoglia 2025] | K5 | — | no taste role (health only) |
| K⁺ | not found for espresso; 9.8 mg released per g coffee at equilibrium, 80 °C [D from Jaganyi 1999] | high [inferred] | K1 | D_bean 3.15×10⁻¹⁰ m²/s, hindrance factor 16 | main counter-ion of the acids [inferred] |
| Mg²⁺ | 171–243 mg/L (café medians) [Konieczyński 2025]. USDA gives 80 mg/100 g, which is inconsistent with its K value | 6–25% leached in boiled coffee [Stelmach 2013] | K3 | D_bean 7.0×10⁻¹¹ m²/s, hindrance factor 29 | [unverified] |
| Ca²⁺ | 81 mg/L median (Polish cafés), ≈92% of it from the water [Konieczyński 2025] | 14–42% leached [Stelmach 2013] | — | — | — |
| Phosphate (P) | 167–211 mg/L [Konieczyński 2025] | — | K2 | D_bean 1.09×10⁻¹⁰ m²/s, hindrance factor 24 | phosphoric-acid sourness (borderline perceptible) [Rune 2023] |
| DKPs | 5–250 µg/mL (infusions) [Kaur 2026] | — | — | — | metallic bitterness; 190–4000 µmol/L [Poisson 2017] |
| Mozambioside + products | — | 41–128% of powder content in the brew [Bichlmaier 2025] | — | — | bitter at 27–132 µM; depends on TAS2R43 genotype |
| CO₂ | ≈61 mg available per 13.5 g double shot [Illy & Navarini 2011] | partly dissolved, partly in crema | K6 | Henry constant at 93 °C ≈4× its 25 °C value [D] | drives crema |
| TDS | 52.5 g/L (classic 30 mL Arabica shot) [Illy & Navarini]; 9.7% (20 g → 40 g) [Schmieder]; 4.0–5.6% (8 g → 30 mL) [Gloess] | EY 17.7–22.1% [Gloess]; 19.4% [D from Schmieder; not printed in the paper] | K2 (λ/dose 0.87) | — | body correlates with total solids [Gloess] |

### 1.3 Lipids, emulsion and crema

- **State.** A regular Arabica espresso (30 mL in 30 s) is an oil-in-water emulsion at 0.2–0.3% by volume (90% of droplets <10 µm). It also carries about 5 g/L of cell-wall fragments 2–5 µm across and 52.5 g/L of dissolved solids [Illy & Navarini 2011, citing Illy & Viani 2005].
- **Transport.** Lipids reach the cup by suspension, not by dissolving. In paper-filtered brew only 0.4% of the recovered lipid reaches the cup; most stays in the grounds and 9.4% in the paper [Ratnayake 1993]. Diterpenes travel with suspended solids [Santanatoglia 2025]. The first ~25 mL of a shot is lipid-rich, at about 2.1 mg/mL triglycerides [Petracco 1989, Sec]. One study found similar lipid totals for Arabica and Robusta (57 vs 58 mg) but three times more polar lipid in Robusta [Ratnayake 1993, via Illy & Navarini 2011].
- **Crema.** Crema is at least 10% of the volume, has a density of 0.40–0.60 g/mL and bubbles of 10–150 µm. Foam volume rises from about 2.5 to 12 mL as powder CO₂ rises from 0.25 to 4.5 mg/g (R² = 0.907) [Navarini, ASIC 2006, Sec]. Foamability increases with roast degree and protein content; foam stability tracks GM and AG and peaks at medium roast [Nunes 1997].
- **Viscosity.** The continuous phase measures about 0.50 mPa·s at 70 °C and 1.40 mPa·s at 25 °C [Navarini, ASIC 2004, Sec]. INEI certification requires >1.5 mPa·s at 45 °C [Sec].

---

## 2. Key aroma compounds

### 2.1 Identity, thresholds, concentrations

**Table 3.** Key odorants. Thresholds are orthonasal, in water (µg/L). **S95** = Semmelroch et al. 1995 (measured nasal thresholds). **L** = Leffingwell & Associates compilation. Bean contents are SIDA values for one Colombian Arabica and one Indonesian Robusta [S95]. Brew values are the medium-roast Arabica brew concentrations of Mayer (2000), as tabulated in µg/100 mL by Hofmann (2001) and converted here to µg/L. Hofmann's own brew was percolated at 50 g/L; I did not check Mayer's exact recipe. OAV [D] = brew concentration ÷ threshold; ranges span S95 and L where both exist. A/R = more abundant in Arabica, Robusta, or similar in both [Poisson 2017, Table 12.2, unless noted].

| Odorant | Descriptor | Threshold S95 | Threshold L | Bean Ar / Rob (mg/kg) | Brew (µg/L) | OAV [D] | A/R |
|---|---|---|---|---|---|---|---|
| 2-Furfurylthiol (2-FFT) | roasty, coffee-like; rubbery when concentrated | 0.01 | 0.005 | 1.08 / 1.73 (other lots 1.71 / 1.96) | 17 | 1700–3400 | R |
| 3-Mercapto-3-methylbutyl formate (MMBF) | catty, blackcurrant | 0.0035 | — | 0.13 / 0.115 | 5.7 | ≈1600 | similar |
| 3-Methyl-2-butene-1-thiol | sulfury-roasty | — | — | — | 0.6 | — | R (Farah 2012) |
| Methanethiol | sulfury; "freshness" | — | 0.02 | — | 170 | ≈8500 | R |
| 2-Methyl-3-furanthiol | meaty | — | — | — | 1.1 | — | A (Farah 2012) |
| Methional | boiled potato | 0.2 | 0.2 | 0.24 / 0.095 | 10 | 50 | A |
| Acetaldehyde | fruity | — | 15–120 | — | 4700 | 40–310 | — |
| Propanal | fruity | — | 9.5–37 | — | not in Mayer's brew set | — | — |
| 2-Methylpropanal | malty, fermented | — | 0.1–2.3 | — | 760 | 330–7600 | — |
| 2-Methylbutanal | green, malty | — | — | — | 870 | — | R |
| 3-Methylbutanal | malty, cocoa | — | 0.2–2 | — | 570 | 290–2900 | similar |
| 2,3-Butanedione | buttery | — | 2.3–6.5 | — | 2100 | 320–910 | similar |
| 2,3-Pentanedione | buttery | — | — | — | 1600 | — | A |
| Furaneol (HDMF) | caramel | 10 | — | 109 / 57 | 7200 | 720 | A |
| Homofuraneol | caramel, sweet | 1.15 | 43 | 17.3 / 14.3 | 800 | 19–700 | — |
| Sotolon | seasoning, curry | 20 | 0.001–0.04 | 1.47 / 0.63 | 80 | 4–80 000 | similar |
| Abhexon | seasoning | 7.5 | 0.00001 | 0.16 / 0.085 | — | — | A (Farah 2012) |
| Guaiacol | smoky, phenolic | 2.5 | 3–21 | 4.2 / 28.2 | 120 | 6–48 | R |
| 4-Ethylguaiacol | spicy | 50 | 50 | 1.63 / 18.1 | 48 | ≈1 | R |
| 4-Vinylguaiacol | spicy, clove | 20 | 3 | 64.8 / 177.7 | 740 | 37–250 | R |
| Vanillin | vanilla | 25 | 20–200 | 4.8 / 16.1 | 210 | 1–10 | — |
| (E)-β-Damascenone | honey, cooked apple | 0.00075 | 0.002 | 0.195 / 0.205 | 1.6 | 800–2100 | — |
| 2-Ethyl-3,5-dimethylpyrazine (EDMP) | earthy, roasty | 2.0 | 1 | 0.33 / 0.94 | 17 | 8–17 | R |
| 2-Ethenyl-3,5-dimethylpyrazine | roasty, earthy | — | — | — | 1.0 | — | R |
| 2,3-Diethyl-5-methylpyrazine | earthy, roasty | 1.0 | — | 0.095 / 0.31 | 3.6 | 3.6 | R |
| 3-Isobutyl-2-methoxypyrazine (IBMP) | pea, earthy | — | 0.002–0.016 | unchanged by roasting [Czerny & Grosch 2000] | 1.5 | 94–750 | A |
| Phenylacetaldehyde | honey, floral | — | 4 | — | — | — | — |
| 2-Methylisoborneol (off-note) | earthy, musty | 0.0025 [Vitzthum 1999] | — | Rob 120–430 ng/kg vs Ar <20–30 ng/kg | — | — | R |
| Hexanal (staling marker) | green, grassy | — | 4.5–5 | — | — | — | — |

Points to carry into the model:
- **Treat the threshold source as a parameter.** Sotolon (20 vs 0.001–0.04) and abhexon (7.5 vs 0.00001) show how far compilations disagree.
- **A high OAV does not guarantee impact.** β-Damascenone has the highest OAV in the powder (2.6×10⁵ [S95]), yet panels did not notice when it was omitted from a recombinate. Omission tests identified 2-FFT, 4-vinylguaiacol, alkylpyrazines, furanones, acetaldehyde, propanal, methylpropanal and 2- and 3-methylbutanal as the highest-impact odorants [Czerny 1999; Buffo & Cardelli-Freire 2004].
- **Simple alkylpyrazines are not key odorants.** Their thresholds are high (2-methylpyrazine 60–105 000 µg/L; 2,5-dimethylpyrazine 800–1800 µg/L [L]).
- **Species difference** [Poisson 2017]. Robusta beans have more isoleucine and leucine (giving 2- and 3-methylbutanal), more free amino acids (pyrazines), more CGA (phenols) and more tryptophan (skatole). Arabica beans have more sucrose (diketones, furfurals, furaneol).
- **Estimating espresso concentrations.** Espresso uses about 8–10× more coffee per litre than this brew, but recovers less of the nonpolar odorants. Espresso concentrations are therefore probably several times the brew column, by an odorant-specific factor set by its yield class (§2.2) [D, unverified].

### 2.2 Volatility, polarity, extraction and storage behaviour

**Table 4.** log P and vapour pressure (VP, mmHg at 25 °C) as used by Mestdagh (2014). Henry constants from the Sander (2023) compilation: H in mol m⁻³ Pa⁻¹ at 298 K; B = d ln H / d(1/T) in K; K_aw = 1/(H·R·T) is the dimensionless gas/water ratio [D]. Brew yields from Semmelroch & Grosch (1996) and Blank et al. (1992; abstract as quoted in search results). FD = flavour dilution factor, powder → brew [Blank 1992, via Yeretzian 2017]. Kinetic family letters A–E follow Sánchez-López (2016) (A fastest, E slowest; C = very volatile).

| Odorant | log P | VP | H; K_aw (25 °C); B | Brew yield / FD | Espresso kinetics | Roasting and storage |
|---|---|---|---|---|---|---|
| 2,3-Butanedione | −1.34 | 57 | 0.73; 5.5×10⁻⁴; 5700 | 75–100% | fastest; family A | 35% formed from sucrose [Poisson 2018]; peaks at medium roast; −50% in headspace 15 min after grinding |
| 2,3-Pentanedione | −0.83 | 26 | 0.13; 3.1×10⁻³; 6200 | high | family B | 76% formed from sucrose |
| Acetaldehyde | — | — | 0.13; 3.1×10⁻³; 5900 | >75% | family A | — |
| Propanal | — | — | 0.099; 4.1×10⁻³; 4300 | — | family A (its PTR-MS ion is shared with acetone) | — |
| 2-Methylpropanal | — | — | 0.051; 7.9×10⁻³ | — | family C (released before flow) | lost after grinding |
| 2-/3-Methylbutanal | 1.27 | 49 | 0.025 / 0.011; 0.016 / 0.037 | — | intermediate [Mestdagh]; PTR-MS trace in family E (identity ambiguous) | lost after grinding |
| Methanethiol | 0.93 | 1901 | 0.0038; 0.11; 3400 | — | off the polarity trend | drops within 1 day of roasting; oxidises to DMDS (DMDS/MeSH ratio is a freshness index) |
| Dimethyl sulfide (DMS) | 0.98 | 647 | 0.0053; 0.076; 3500 | — | family C | — |
| 2-FFT | 1.73 | 4.0 | not in compilation | <25%; FD 256 → 64 | intermediate | increases with roasting time [Baggenstoss 2008, via Poisson 2017]; bound in the cup |
| MMBF | 1.63 | 0.42 | not in compilation | FD 2048 → 256 | intermediate | can vanish in dark roasts |
| EDMP | 1.46 | 0.81 | 2.9; 1.4×10⁻⁴; 8500 | FD 2048 → 1024 | intermediate | formed early, then roughly constant |
| IBMP | — | — | 0.17; 2.4×10⁻³ | 10–25%; FD 512 → 128 | — | from green coffee, unchanged by roasting |
| Guaiacol | 1.34 | 0.18 | 8.6; 4.7×10⁻⁵ | 75–100% | intermediate [Mestdagh]; slow family E | higher in dark roasts and in Robusta |
| 4-Ethylguaiacol / 4-vinylguaiacol | 2.43 / 2.57 | 0.017 / 0.019 | 5.5 (estimated) / — | FD 256 → 512 / 512 → 512 | slow | both increase strongly with roasting; 4-vinylguaiacol falls again at CTN <50 |
| Vanillin | — | — | 1.7×10³; 2.4×10⁻⁷; 6800 | >75% | — | increases strongly with roasting |
| β-Damascenone | 3.10 | 0.02 | 0.32; 1.3×10⁻³; 4600 | 10–25%; FD 2048 → 64 | slowest | increases with roasting |
| Furaneol, sotolon, abhexon | — | — | not in compilation | 75–100%; sotolon FD 512 → 2048 | fast [inferred] | sotolon increases strongly with roasting |
| Pyridine | 0.84 | 23 | 0.91; 4.4×10⁻⁴; 4700 | — | family E | increases continuously with roasting |
| Hexanal | 1.93 | 11 | 0.045; 9.0×10⁻³; 6400 | — | — | rises after about 7 weeks of storage in air |

Sources for the right-hand columns: Czerny & Grosch 2000; Poisson 2017; Yeretzian 2017; Holscher & Steinhart 1992; Glöss 2014.

Mechanisms:
- **Polarity rule (capsule, constant 20 bar).** Mestdagh et al. (2014) collected 10–150 mL from a ≈6.3 g lungo capsule and fitted hyperbolic yield curves (R² 0.973–0.998). The initial slope (a/b) falls linearly with log P: a/b = −0.0466·log P + 0.1433 (R² = 0.66). It is unrelated to vapour pressure. As the cup grows from 13 to 144 mL, the aroma shifts from polar (log P <0.9) toward non-polar (log P >1.75) odorants.
- **Five families in a semi-automatic machine** [Sánchez-López 2016]. Conditions: 18 g → ≈31.5 g in 25 s at 9 bar and 92 °C. Family A (log K_ow −1.34 to 0.73) peaks at about 10 s and falls below 40% of its maximum by the end. Family E peaks at about 20 s and is still at 80–95% of maximum at the end. Family C shows a shoulder at 4 s, before any liquid flows. Raising pressure to 11 bar increases volatiles over the whole shot. Raising temperature to 96 °C increases late extraction, more so for non-polar compounds.
- **Temperature and matrix.** Extrapolated with B, K_aw at 93 °C is 8–50× its 25 °C value for most entries (×35 for 2,3-butanedione, ×4 for CO₂) [D; extrapolation uncertain]. Non-volatile coffee solids shift Henry constants; the constants do not depend on concentration over 10⁻⁴–10 ppm [Pollien 2003]. Lipids lower the volatility of hydrophobic odorants [Hofmann 2001].
- **Headspace does not scale with EY** [Smrke 2024]. Some ions fall steadily as EY rises; pyrazine-type ions are lowest near 19.5% EY. Fast, low-EY shots hold more highly volatile and non-polar compounds, which the authors attribute partly to evaporation during longer extractions.
- **Reactions in the cup.** Melanoidins at brew concentration (125 mg per 10 mL) halve headspace 2-FFT within 20 min, and almost none remains by 30 min. Low-MW melanoidins (1.5–3 kDa) are most active; aldehydes are unaffected [Hofmann 2001]. In real brew about 60% of 2-FFT binds to hydroxyhydroquinone within 10 min [Müller & Hofmann 2007]. CGLs hydrolyse during hot holding and add sourness [Vitzthum 1999]. Loss of 3-CQL and 4-CQL, even at subthreshold levels, alters stored ready-to-drink coffee [Lin 2022].

---

## 3. Extraction kinetics per compound

### 3.1 Studies

**Table 5.** Compound-resolved espresso and espresso-like kinetics.

| Study | System | Key quantitative result |
|---|---|---|
| Schmieder 2023 (A, FT) | Decent DE1; flow-controlled 1–3 mL/s; 80–98 °C; 20 g dose; particle size D[4,3] 273–295 µm; 10 fractions | c = c₀·exp(−m/λ). Centre point: λ = 16.1 g (trigonelline), 23.1 g (caffeine), 20.8 g (5-CQA), 17.5 g (TDS); c₀ = 6.70, 9.71, 6.79 mg/g and 0.248 g/g. λ ranges over the design: 13.1–16.6 g (trigonelline), 18.9–24.1 g (caffeine), 17.3–21.6 g (5-CQA), 13.2–18.4 g (TDS). Faster flow lowers c₀ and raises λ. Cup caffeine 129/184/207 mg and TDS 2.92/3.88/4.19 g at 20/40/60 g out. Pressure 2.6–8.4 bar |
| Kuhn 2017 (A, Abs) | commercial machine | finer grind extracts more caffeine and trigonelline per gram of beverage; tamping pressure has no effect; trigonelline/caffeine ratio depends on extracted mass |
| Ludwig 2012 (A, Abs) | espresso vs filter, timed fractions | >70% of antioxidants (CQAs, melanoidins, caffeine; not diCQA) leave in the first 8 s of espresso; filter shows a U-shaped profile |
| Bartel 2015 (A, Abs) | pods and capsules, cumulative fractions | melanoidins extract more slowly than CGA (50% within 9 s); the most antioxidant-active melanoidins come late |
| Blumberg 2010 (A, Abs) | percolation | CQAs and monoester CGLs fast; diCGLs slow; phenylindanes strongly retained |
| Gloess 2013 (A, FT) | 9 brew methods | espressi extract less efficiently than lunghi (5-CQA most affected); efficiency mainly set by water solubility |
| Mestdagh 2014; Sánchez-López 2014, 2016 (A) | capsule at 20 bar; semi-automatic machine at 7–11 bar and 82–96 °C | polarity rule and five kinetic families (§2.2) |
| Smrke 2024 (A, FT) | 20 g → 40 g at 9 bar, with added fines | 10–15 s shots already reach 17–18% EY (>80% of the maximum); EY plateaus beyond 40 s |
| Caprioli 2013 (A, Abs) | timed portions, two machines | cup CGA 1.5–2.2 g/kg; 5-CQA > 3-CQA > 3,5-diCQA (Gloess found 3-CQA > 5-CQA with a darker roast) |
| Jaganyi 1999, 2000; Spiro 1984–1989 (A) | batch infusion of sieved coffee | rate order K⁺ > caffeine > P > Mg²⁺ > Mn²⁺; hindrance factors ≈10–50 (Table 2) |
| Khamitova 2020a, b; Angeloni 2020 (A, Abs) | baskets, perforated-disc heights, sieved particle sizes, 12–14 g doses | caffeine per cup rises from 500–1000 µm to 200–300 µm particles; a 12 g dose gives only ≈9% fewer bioactives than 14 g; lignans are ≈95% extracted |
| Liang 2021 (A, Abs) | full immersion, equilibrium | EY ≈21% regardless of brew ratio; equilibrium constant independent of grind, roast and 80–99 °C |
| Angeloni 2023; Pannusch 2024 (B) | percolation models fitted to compound data | two-grain model with flow and temperature terms; "kinetic control chart" app |

### 3.2 Kinetic classes

**Table 6.** Proposed classes. λ/dose = λ divided by dose mass (Schmieder centre point).

| Class | Members | Evidence | Parameterisation |
|---|---|---|---|
| **K1 very fast** (λ/dose ≈ 0.7–0.9) | trigonelline; citric, malic, acetic, formic, lactic acids; phosphate; monoester CQAs and CGLs; sugars; K⁺; polar volatiles | Schmieder; Ludwig ">70% in 8 s"; family A; highest D_bean (K⁺) | fast washout pool (broken cells, fines) plus kernel diffusion with D ~10⁻¹⁰ m²/s (K⁺: 3.2×10⁻¹⁰ at 80 °C); fit the pool fraction |
| **K2 intermediate** (λ/dose ≈ 1.0–1.2) | caffeine; 5-/3-CQA; bulk TDS; furans, pyrazines, aldehydes, 2-FFT; low-MW melanoidins | Schmieder; Mestdagh; Bartel | as K1 with a smaller washout pool; caffeine D_bean 1.9×10⁻¹⁰ m²/s |
| **K3 slow** (still extracting at the end of the shot) | diCQAs, diCGLs; Mg²⁺, Mn²⁺; non-polar odorants (β-damascenone, vinyl- and ethylguaiacol); high-MW melanoidins | Ludwig; Blumberg; Jaganyi (hindrance 29–48); Mestdagh | D 10⁻¹¹–10⁻¹⁰ m²/s and/or partition favouring the solid; fit to fraction data |
| **K4 retained or bound** | phenylindanes; thiols | Blumberg; Hofmann 2001; Müller & Hofmann 2007 | adsorption isotherm on the grounds plus first-order binding in the liquid |
| **K5 particulate / emulsion** | triglycerides, diterpenes, cell-wall fines | Petracco; Ratnayake; Santanatoglia 2025 | source term tied to fines erosion and shear (fines module of notes 01 and 03), not diffusion |
| **K6 gas / flash-volatile** | CO₂, methanethiol, DMS, methylpropanal | family C; Smrke 2018, 2024 | release on wetting plus headspace loss from the stream and the cup (Table 4 Henry constants) |

**Sanity check [D].** Jaganyi's caffeine rate constant is 2.67×10⁻³ s⁻¹ for 925 µm radius particles at 80 °C. Scaling as k ∝ D/r² gives about 0.10 s⁻¹ (τ ≈ 10 s) for a 150 µm boulder and about 3.7 s⁻¹ (τ ≈ 0.3 s) for a 25 µm fine. Both are consistent with shot timescales, but swelling and CO₂ add uncertainty (see note 01, §5).

### 3.3 Practical rules

- **Brew ratio comes first.** Stopping at 38 g instead of 40 g changes cup concentrations as much as halving the flow rate [Schmieder 2023].
- **Temperature effects are small and inconsistent.** Schmieder saw nearly identical kinetics at 80 and 98 °C, with weak interactions in the full design. Andueza (2003) found 92 °C optimal, mainly on volatiles and flavour. Most tasters cannot tell 80 °C from 93 °C in a triangle test [Klotz 2020].
- **Pressure.** At 11 bar, volatiles rise throughout the shot [Sánchez-López 2016]. At 9 atm foam consistency was best, along with "fresh", fruity, malty and buttery odorants [Andueza 2002].
- **Composition ratios drift with yield.** Trigonelline:caffeine [Kuhn 2017], polar:non-polar aroma [Mestdagh 2014] and 3-CQA:5-CQA [Gloess 2013] all change with yield. TDS alone cannot predict taste.

---

## 4. Bean properties → composition

### 4.1 Species

Arabica has about 2× less caffeine and about 1.5× less green-bean CGA than Robusta. It has about 2× more sucrose, about 1.6× more lipid and about 1.4× more trigonelline [Farah 2012; Poisson 2017]. Roasted Robusta has 2–5× more total organic acids, mainly formic and acetic [Yeager 2023]. Robusta markers: 16-O-methylcafestol (trace levels also occur in Arabica [Gunning 2018]) and 2-methylisoborneol [Vitzthum 1999]. Mozambioside occurs only in Arabica [Czech 2024].

### 4.2 Growing conditions and processing

| Factor | Effect | Source |
|---|---|---|
| Variety or clone (*C. canephora*, 67 lots, same roast) | Robusta clones had the most trigonelline, melanoidins and 16-O-methylcafestol; Conilon × Robusta hybrids had the most caffeine, CGA, cafestol and total diterpenes | Viencz 2023 (A, FT) |
| Altitude (Ethiopian green Arabica) | per 100 m: caffeine −0.12 g/kg; CGA −1.23 g/kg; sucrose +3.02 g/kg in wet-processed beans (+0.36, not significant, in dry-processed); +2.11 unshaded vs +0.93 shaded | Worku 2018 (A, Abs) |
| Air temperature during seed development | controls CGA and fatty-acid composition; totals of lipid, sugar, polysaccharide and CGA unaffected; glucose rises with altitude | Joët 2010 (A, Abs) |
| Cool climate | more acidity and fruitiness (ethanal and acetone as markers); heat raises butanediols, linked to green and earthy defects | Bertrand 2012 (A, Abs) |
| Wet vs dry processing | dry-processed beans keep more glucose and fructose; sucrose unaffected | Knopp 2006 (A, Abs) |
| Honey processing | much more 2-isopropylmalic acid (177.5 ng/g in honey-processed espresso) | Santanatoglia 2024c |
| Self-induced anaerobic fermentation | more esters, alcohols and acids; longer fermentation raises acetic acid and pyrazines after roasting; one Robusta clone reached 5.45 g/kg lactic acid and 5.10 g/kg ethanol during fermentation | da Silva Vale 2022; Dias 2026 |
| Fermented off-note | marked by ethyl formate | Lindinger 2009 |
| Green-coffee storage | cup quality flattens even under good storage | Yeretzian 2017 (C) |
| Bean density | no quantitative density → composition relation found (altitude is the usual proxy) | gap |

### 4.3 Roast degree: quantitative relations

| Quantity | Relation or data | Source |
|---|---|---|
| Mass and structure | light-to-medium roast ≈14% weight loss; dark ≈20% dry-matter loss; volume up to +80%; density 1.3 → 0.7 g/cm³; porosity ≈0.5 (dark) | Farah 2005; Smrke 2018 |
| Moisture | 8–12% → 0–5% | Poisson 2017 |
| CGA | first-order Arrhenius kinetics with species-specific parameters (r = 0.98); weight loss modelled separately (r = 0.99); ≈90% of CGA has reacted after 9 min in a laboratory roast | Perrone 2010; Farah 2005 |
| CGLs | 3-CQL peaks at 230 (Ar) / 254 (Rob) mg/100 g at ≈14% weight loss; maximum near CTN 100–110, falling to ≈20% of peak by CTN 50 | Farah 2005; Poisson 2017, Fig. 12.6 |
| Phenylindanes, DKPs | phenylindanes rise steeply toward CTN 50; DKPs reach ≈90% of final level by CTN 100; bitterness turns from "coffee-like" to harsh and metallic | Poisson 2017 |
| Trigonelline | strong loss; nicotinic acid formed = 4–6% of initial trigonelline (Farah: ≈3%); NMP ≤0.25% | Lang 2008; Stadler 2002b |
| Sucrose, free amino acids | react first. Sucrose is largely gone at roast end: 0.0% in the Illy & Viani table; Farah gives 4.2% to trace depending on roast degree | Poisson 2017; Farah 2012 |
| Polysaccharides | −12–24% (light), −35–40% (dark); arabinose released from AG feeds acid and melanoidin formation | Poisson 2017; Redgwell 2002 |
| Organic acids | citric and malic fall; acetic, lactic, phosphoric, quinic and glycolic rise within light roasts; formic and acetic form early, then degrade or evaporate; perceived acidity falls; a cooler finish (206 vs 223 °C) gives more CGA and a more acidic espresso | Rune 2023; Poisson 2017; Carcea 2024 |
| Melanoidins | amount rises with roast; molecular-weight trend disputed (falling: Borrelli 2002; prolonged roasting favours high MW: Bekedam 2008) | as cited |
| Lipids | triglycerides stable; diterpenes partly lost (0.2–0.9 g/100 g remain); tocopherols −79 to −100% | Farah 2012 |
| CO₂, whole beans (Weibull fit over 400 h) | light (131 Pt): M∞ 3.4–3.7 mg/g, λ 310–377 h, k 0.96–1.00; medium (101 Pt): 5.7–7.3 mg/g, 190–270 h; dark (78 Pt): 10.2–12.7 mg/g, 153–242 h, k 0.85–0.96. Faster roasts degas faster at medium and dark roast, but not at light roast. Roasting at 200 °C forms ≈3 mL/g (STP); at 230 °C ≈9 mL/g | Smrke 2018; Barbera 1967 (Sec) |
| Key odorants | pyrazines form early, then roughly constant; 2-FFT, pyridine, N-methylpyrrole and DMTS keep rising with roast time; diketones, furfurals and 4-vinylguaiacol peak at medium roast and fall at CTN <50; MMBF can disappear. Fast roasts give more solubles, diketones and furfurals, fewer phenols, and less CGA loss | Poisson 2017; Baggenstoss 2008 (Sec) |

### 4.4 Age since roast

- **CO₂.** Release follows M(t) = M∞[1 − exp(−(t/λ)^k)]. In fast-roasted dark beans the data split into two pools: a fast pool holding 20% (2.18 mg/g, τ 37.6 h) and a slow pool holding 80% (10.34 mg/g, τ 182.5 h). Fits to 400 h underestimate the total. A light roast followed to 800 h gives M∞ 5.07 mg/g, λ 715 h, k 0.842. Grinding fresh coffee releases up to 75% of the gas within 90 s. Some CO₂ stays sorbed and comes out only on wetting, which explains residual crema from old coffee. HCO₃⁻ in the brewing water also generates CO₂ [Smrke 2018].
- **Aroma.** Methanethiol drops within a day [Holscher & Steinhart 1992]. Aldehydes and diketones halve within 15 min of grinding [Mayer & Grosch 2001]. The DMDS/MeSH ratio is a robust freshness index; aluminium barrier packaging slows its rise [Glöss 2014]. Hexanal appears late (about 7 weeks in air). Panels detect decline at 9 months and rancidity at 18 months even in vacuum packs [Kreuml 2013].

---

## 5. Water chemistry

| Evidence | Finding | Caveat |
|---|---|---|
| Hendon 2014 | gas-phase DFT binding to five acids, caffeine and eugenol ranks Mg²⁺ > Ca²⁺ > Na⁺; Na⁺ binds caffeine and eugenol more weakly than water does; bean K⁺ is labile; bicarbonate neutralises chlorogenic (pKa 2.66) and the smaller acids (pKa 3.14–3.86) | B: computational only, no solvent model; the authors call for experiments |
| Bratthäll 2024 | Mg and Ca chlorides at drinking-water levels barely change citric, malic, lactic and quinic acids; at 10× they do. Pre- and post-brew additions give similar results, so acid extraction is largely independent of water; post-brew interactions may still affect perception | A: filter/immersion brewing, four acids |
| Liu 2025 | harder water favoured extraction of taste compounds from dark roasts, softer water from light roasts; mechanisms proposed: water penetration and release of taste compounds from proteins | A (Abs), filter brewing |
| Navarini & Rivetti 2010 | espresso review: alkalinity and cations affect sensory quality; treatment controls chlorine and scale | C (Abs) |
| Konieczyński 2025 | espresso Ca and Sr come mainly from the water; machines leach Ni and Pb | A |
| SCA water standard | TDS 150 mg/L (75–250); calcium hardness 68 mg/L as CaCO₃ (17–85); alkalinity ≈40 mg/L; pH 7.0 (6.5–7.5); Na ≈10 mg/L; chlorine 0 | D (secondary sources; primary not read) |
| Water in the cited kinetic studies | Volvic (HCO₃⁻ 71, Ca 11.5, Mg 8 mg/L) in Sánchez-López 2016; Acqua Panna in Mestdagh 2014 | a confounder between studies |

**Buffering estimate [D].** Gloess et al. (2013) report titratable acidity (to pH 6.6) of 11.5 mmol/L for espresso and 3.1 mmol/L for filter coffee. Water at 40 mg/L alkalinity as CaCO₃ supplies 0.8 meq/L, enough to neutralise roughly 7% of the espresso's acidity versus 26% of the filter coffee's (ignoring water held in the grounds and the different titration endpoint). In espresso, alkalinity therefore matters more through pH and CO₂ formation than through total acidity.

---

## 6. Sensory modelling evidence

### 6.1 Bitterness

**Bitter classes and taste thresholds (detection or recognition, as reported, in water):**
- caffeine: 0.75–1.2 mmol/L
- CGLs: 9.8–180 µmol/L
- phenylindanes: 23–178 µmol/L
- (furan-2-yl)methylated benzenediols: 100–537 µmol/L [Kreppenhofer 2011]
- DKPs: 190–4000 µmol/L
- mozambioside products: 27–80 µM [Bichlmaier 2025]
- NMP: a suggested contributor, not demonstrated [Stadler 2002b]
- melanoidins: no isolated bitterness value was found in the sources reviewed [unverified]

Caffeine's share of total bitterness is disputed (≤10%, about 15% or 10–20%). Bitterness quality shifts with roast from mild, CGL-type to harsh phenylindane and metallic DKP types (Poisson 2017, Fig. 12.6). Two observations support a causal role for CGLs: enzymatic hydrolysis of CGLs reduced perceived bitterness [Kraehenbuehl 2017], and decaffeinated espresso was rated less bitter and more acidic, with lower pH and higher TA [Cusielo 2026].

### 6.2 Acidity

**pH, TA and perceived sourness diverge:**
- In eight filter methods, CGA dominated pH and TA, while sourness tracked organic acids [Santanatoglia 2024b].
- Espresso and lungo have similar pH (5.5–5.9), but espresso has 3–4× the TA per sip [Gloess 2013]. A pH-only model will fail for espresso.
- Batali et al. (2021) studied TA, sourness and liking in drip coffee; I could not read their abstract, so their conclusion is [unverified].

**Single acids are rarely perceptible:**
- In French-press coffee, citric acid (0.23–0.60 g/L) was the only acid clearly above its detection threshold (<0.16 g/L).
- The thresholds of malic, acetic and lactic acid were above their concentrations; phosphoric acid sat just below its concentration.
- Coffee experts could not identify any single acid spiked at its average concentration [Rune 2023].

Perceived acidity therefore emerges from the whole acid–buffer system (H⁺, undissociated acids, K⁺). Lighter roasts are perceived as more acidic [Poisson 2017; Carcea 2024].

### 6.3 Sweetness

Roasting destroys most sucrose. In drip fractions, the later, lower-TDS fractions were sweeter and more floral, yet no fraction contained perceptible monosaccharide levels. Sweetness was attributed to less masking and to sweet-associated aroma [Batali 2020b]. Across roasts, sweetness falls as TDS rises [Frost 2020]. In a model solution (not coffee), a subthreshold odorant enhanced sweetness [Labbe 2007]. Adding sucrose to espresso raised perceived sweetness and body [Cusielo 2026]. A light roast holding 2–4% sucrose could put ≈1–2% sucrose into a 1:2 espresso if transfer were high [D]; no espresso sugar measurements were found.

### 6.4 Body, mouthfeel, astringency

Total solids correlate with body and texture [Gloess 2013]. Polysaccharides add viscosity and mouthfeel [Poisson 2017]. The lipid emulsion adds creaminess. "Body" alone does not capture coffee mouthfeel [Navarini 2004]. Crema and body increased with roast temperature [Carcea 2024]. Caffeine and CGA concentrations correlate with bitterness and astringency [Gloess 2013].

### 6.5 Psychophysics and interactions

- **Power functions.** Stevens' law, I = k·Cⁿ, has classic exponents of 1.3 (sucrose), 1.4 (NaCl) and 0.8 (saccharin) [compilations, C]. I found no coffee-specific bitter or sour exponents.
- **Individual differences.** Caffeine detection thresholds do not predict a person's suprathreshold bitterness ratings [Keast & Roper 2007].
- **OAV and DoT are screening tools only.** Impact has to be confirmed by recombination and omission tests (the sensomics workflow; Poisson 2017, Fig. 12.1).
- **Interactions.** Bitter–sweet, sour–sweet and aroma–taste interactions are expected; no coffee-specific coefficients exist.

### 6.6 Quantitative models

| Model | Inputs → outputs | Data | Performance / limits |
|---|---|---|---|
| Lindinger 2008 (A, FT) | 16 PTR-MS headspace ions → 9 aroma + 2 taste attributes | 11 training + 8 validation espressos; 10 panelists | predictions within the least significant difference per attribute; custom normalisation; taste predicted by correlation, not mechanism |
| Bressanello 2018 (A, Abs) | HS-SPME-GC-MS → sensory notes (chemometrics) | industrial samples | best for woody, bitter and acidic notes |
| Frost 2020; Batali 2020a; Guinard 2023 (A) | TDS, EY, brew ratio → descriptive and consumer data (drip) | 3 roasts × 9 targets; 87–93 °C | response surfaces for bitter, sour, sweet, thickness, citrus and burnt; temperature has no effect at fixed TDS/EY; two consumer clusters |
| Gloess 2013 (A, FT) | chemistry ↔ sensory correlations | 9 methods, 1 coffee | total solids ↔ body; headspace ↔ aroma intensity; caffeine/CGA ↔ bitterness and astringency |
| Pannusch 2024 (B) | flow, temperature → cup TDS, caffeine, trigonelline, CGA | fitted to Schmieder 2023 | chemistry only, no sensory link |
| Smrke 2024 (A) | EY and time → hedonic score | 1 taster, 1 coffee | optimum ≈19–20% EY at ≈30 s; not a panel |

**Control charts and espresso.** The drip "Golden Cup" is TDS 1.15–1.35% and EY 18–22% [Batali 2020a]. Guinard et al. (2023) replaced it with sensory and consumer charts and called for an espresso equivalent. Certified Italian Espresso specifies 7 ± 0.5 g, 88 ± 2 °C, 9 ± 1 bar, 25 ± 2.5 mL in about 25 s, served at 67 ± 3 °C [INEI, Sec]. Shots of that style contain about 4–5.6% total solids [Gloess 2013; Illy & Navarini 2011]. Modern 1:2 shots reach about 9–10% TDS at 19–20% EY [Schmieder 2023; Smrke 2024]. I found no peer-reviewed sensory map of espresso against TDS and EY.

---

## Implications for the simulator design

### A. Recommended chemical state

| Tier | Species | Rationale |
|---|---|---|
| 1, non-volatile (~18) | caffeine; trigonelline; 3-, 4- and 5-CQA (or total monoester CQA with a roast-dependent isomer split); FQA; diCQA; monoester CGLs (lumped); diCGLs; phenylindanes (lumped); quinic, citric, malic, acetic, formic and lactic acids; phosphate; sucrose; K⁺ | rate and threshold data exist; these carry bitterness, acidity, caffeine dose and the pH/TA balance |
| 1, volatile (~22) | 2-FFT, MMBF, 3-methyl-2-butene-1-thiol, methanethiol, methional, acetaldehyde, 2-methylpropanal, 2- and 3-methylbutanal, 2,3-butanedione, 2,3-pentanedione, furaneol, homofuraneol, sotolon, abhexon, guaiacol, 4-ethyl- and 4-vinylguaiacol, vanillin, β-damascenone, EDMP, 2,3-diethyl-5-methylpyrazine, IBMP | the high-impact set from omission tests and OAVs; bean contents and partitioning data exist for most |
| 2, lumped | melanoidins (2–3 molecular-weight classes); soluble polysaccharides; protein (with melanoidins); DKPs; mozambioside products (Arabica switch); Mg²⁺ and Ca²⁺ (bean + water); lipid emulsion with diterpene tracers; CO₂; a polar-volatile pool and a pyrazine pool | needed to close the TDS balance and to model body, crema and binding |
| 3, optional | NMP, nicotinic acid; 2-methylisoborneol; DMS and DMDS; hexanal; ethyl formate | diagnostics and off-notes |

### B. Which parameters come from the literature and which must be fitted

| Parameter group | From the literature (as priors with ranges) | Must be fitted or learned |
|---|---|---|
| Bean composition | Farah 2012; Illy & Viani; Viencz 2023; Yeager 2023 meta-dataset (Dryad doi:10.25338/B8C91C; download needs an access token); odorant contents from Semmelroch 1995 and Mayer 2000 | lot-specific values; Robusta acid profiles; volatile contents across roast degrees |
| Roast transforms | CGA first-order Arrhenius kinetics (Perrone 2010); CGL peak (Farah 2005); relative curves for caffeine, CGLs, DKPs and phenylindanes (Poisson 2017); trigonelline yields; polysaccharide losses; CO₂ Weibull parameters | time–temperature kinetics for every pathway except CGA; mapping between colour scales; odorant formation. An ML surrogate is reasonable here if constrained by mass balance |
| Transport | D_bean for caffeine, K, Mg, Mn and P (Jaganyi 1999); caffeine temperature dependence (Spiro 1984); espresso λ values (Schmieder 2023); odorant polarity rule (Mestdagh 2014) | D, washout fractions and partition coefficients for all other species; activation energies; fines dependence. Fit jointly to Schmieder, Ludwig, Bartel and Kuhn fraction data |
| Binding and retention | qualitative only (Blumberg 2010; Hofmann 2001; Müller & Hofmann 2007: ≈60% of 2-FFT bound in 10 min) | phenylindane adsorption; thiol binding rate constants |
| Emulsion | lipid per cup (Petracco, Ratnayake, Gloess) | shear- and fines-dependent emulsion generation; odorant partitioning into oil |
| Volatility | Henry constants and B for 25+ compounds (Sander 2023); kinetic families (Sánchez-López 2016) | evaporation coefficients for the stream and the cup; matrix corrections |
| Water | alkalinity stoichiometry (HCO₃⁻ + H⁺ → CO₂ + H₂O); SCA ranges | cation effects (weak priors); post-brew perception effects |
| Thresholds | Tables 2 and 3, with the spread between sources | thresholds in a coffee matrix; Stevens exponents; interaction weights |

### C. Taste model structure and trust

1. **Dose.** Compute DoT for each tastant and OAV for each odorant. Odorant headspace comes from K_aw(T) with matrix corrections for melanoidin binding and lipid partitioning. Acidity comes from an acid–base speciation module (pKa values, K⁺, water alkalinity) that outputs both pH and TA, because sourness follows TA and organic acids more than pH.
2. **Intensity.** For each modality, I = I_max·Dⁿ/(D₅₀ⁿ + Dⁿ) on weighted dose sums:
   - bitter: caffeine, CGLs, phenylindanes, DKPs, mozambioside products
   - sour: TA and organic acids
   - sweet: sucrose plus aroma-congruence terms
   - astringent: CQAs and diCQAs
   - body: TDS, a viscosity proxy and the emulsion

   Stevens exponents serve as priors; fit them.
3. **Interactions.** Add bitter–sweet suppression, sour–sweet suppression and aroma-driven sweetness terms, fitted to recombination or calibration data.
4. **Calibration.** First reproduce the drip TDS/EY response surfaces [Frost 2020; Guinard 2023] as a consistency check. Then calibrate to espresso data [Gloess 2013; Lindinger-type designs; in-house descriptive panels]. An ML residual (e.g. gradient boosting or a Gaussian process) may be added, constrained to stay monotone in dose.
5. **Trust.**
   - High: the direction of change of bitterness, body and strength with TDS, brew ratio and roast; caffeine per cup (±20%).
   - Medium: relative sourness from modelled TA; roast-dependent bitterness quality; Arabica–Robusta aroma contrasts.
   - Low: absolute intensity scores, sweetness, fruity and floral notes, and origin or processing nuances.

   Report outputs as relative profiles with uncertainty bands, and expose the threshold source as a user-visible assumption.

---

## Open questions / data gaps

1. **No absolute espresso aroma data.** I found no SIDA quantification of the ~25 key odorants in espresso, and no time-resolved espresso fractions with absolute amounts. Mestdagh (2014) reports normalised values only; PTR-MS is semi-quantitative. Bean-to-cup yields per odorant, and their dependence on temperature and pressure, are unknown.
2. **Transport parameters are missing for most species.** Measured diffusivities and partition coefficients exist essentially only for caffeine and four ions, at 80 °C with 1–2 mm particles.
3. **The harsh-bitterness compounds are unquantified in espresso.** No espresso data were found for phenylindanes, diCGLs, DKPs or mozambioside products.
4. **The TDS mass balance is unresolved.** Caffeine, trigonelline and 5-CQA together make up only about 10% of espresso TDS [D from Schmieder 2023: (184 + 98 + 120) mg / 3.88 g]. How the rest divides among melanoidins, polysaccharides, acids, minerals (especially K⁺) and lipids, and how that changes during a shot, is not established.
5. **The acid system is poorly measured in espresso.** Data on individual acids versus roast and origin are scarce, there is no sourness model for the espresso matrix, and no espresso K⁺ value was found.
6. **The cause of sweetness is untested in espresso.** Candidates are residual sucrose, aroma and masking.
7. **Espresso water experiments are scarce.** The cation argument rests on computation.
8. **Thresholds are uncertain.** Compilations disagree widely, thresholds measured in a coffee matrix are rare, and genotype effects (e.g. TAS2R43) are not represented.
9. **Lipids and crema.** Emulsification kinetics and odorant partitioning into oil and foam are unquantified.
10. **There is no espresso sensory map.** No peer-reviewed descriptive map of espresso sensory attributes against TDS and EY exists.

---

## References

FT = full text read; Img = page images read; Abs = abstract only; Sec = secondary source.

**Books, chapters, compilations**
- Farah A. (2012) Coffee constituents. In Chu Y-F (ed.) *Coffee: Emerging Health Effects and Disease Prevention*, Wiley-Blackwell, 21–58. doi:10.1002/9781119949893.ch2 (FT)
- Poisson L., Blank I., Dunkel A., Hofmann T. (2017) The chemistry of roasting—decoding flavor formation. In Folmer B (ed.) *The Craft and Science of Coffee*, Academic Press, 273–309. doi:10.1016/B978-0-12-803520-7.00012-8 (Img pp. 273–298)
- Yeretzian C., Blank I., Wyser Y. (2017) Protecting the flavors—freshness as a key to quality. *Ibid.*, 329–353 (Img pp. 331–336)
- Mestdagh F., Glabasnia A., Giuliano P. (2017) The brew—extracting for excellence. *Ibid.*, 355–380. doi:10.1016/B978-0-12-803520-7.00015-3 (not accessed)
- Wellinger M., Smrke S., Yeretzian C. (2017) Water for extraction. *Ibid.*, 381–398. doi:10.1016/B978-0-12-803520-7.00016-5 (not accessed)
- Illy A., Viani R. (eds.) (2005) *Espresso Coffee: The Science of Quality*, 2nd ed. Elsevier (Sec)
- Vitzthum O.G. (1999) Thirty years of coffee chemistry research. In Teranishi R. et al. (eds.) *Flavor Chemistry: 30 Years of Progress*, Kluwer, 117–133 (FT)
- Sander R. (2023) *Atmos. Chem. Phys.* 23:10901–12440. doi:10.5194/acp-23-10901-2023 (database pages)
- Leffingwell & Associates, Odor & Flavor Detection Thresholds in Water, www.leffingwell.com/odor.htm, accessed 2026-10-13 (C)
- PubChem compound records (solubility); USDA FoodData Central #171891

**Composition and roasting**
- Viencz T. et al. (2023) *J. Food Compos. Anal.* 117:105140. doi:10.1016/j.jfca.2023.105140 (FT)
- Farah A. et al. (2005) *J. Agric. Food Chem.* 53:1505–1513. doi:10.1021/jf048701t (Abs)
- Perrone D. et al. (2010) *J. Agric. Food Chem.* 58:12238–12243. doi:10.1021/jf102110u (Abs)
- Moon J.K., Yoo H.S., Shibamoto T. (2009) *J. Agric. Food Chem.* 57:5365–5369. doi:10.1021/jf900012b (Abs)
- Schrader K. et al. (1996) *J. Sci. Food Agric.* 71:392–398 (Abs)
- Lang R. et al. (2008) *J. Agric. Food Chem.* 56:11114–11121. doi:10.1021/jf802838s (Abs)
- Stadler R.H. et al. (2002b) *J. Agric. Food Chem.* 50:1200–1206. doi:10.1021/jf011235c (Abs)
- Redgwell R.J. et al. (2002) *Carbohydr. Res.* 337:421–431. doi:10.1016/S0008-6215(02)00010-1 (Abs)
- Borrelli R.C. et al. (2002) *J. Agric. Food Chem.* 50:6527–6533. doi:10.1021/jf025686o (Abs)
- Bekedam E.K. et al. (2006) *J. Agric. Food Chem.* 54:7658. doi:10.1021/jf0615449 (Abs)
- Bekedam E.K. et al. (2007) *J. Agric. Food Chem.* 55:761. doi:10.1021/jf063010d (Abs)
- Bekedam E.K. et al. (2008) *J. Agric. Food Chem.* 56:7138. doi:10.1021/jf800999a (Abs)
- Smrke S. et al. (2018) *J. Agric. Food Chem.* 66:5293–5300. doi:10.1021/acs.jafc.7b03310 (FT)
- Poisson L. et al. (2018) *J. Agric. Food Chem.* 66:2422–2431. doi:10.1021/acs.jafc.6b04849 (FT)
- Gunning Y. et al. (2018) *Food Chem.* 248:52–60. doi:10.1016/j.foodchem.2017.12.034 (Abs)
- Carcea M. et al. (2024) *Eur. Food Res. Technol.* 249:1287–1301. doi:10.1007/s00217-023-04213-0 (Abs)

**Taste-active compounds**
- Frank O., Zehentbauer G., Hofmann T. (2006) *Eur. Food Res. Technol.* 222:492–508. doi:10.1007/s00217-005-0143-6 (Sec)
- Frank O. et al. (2007) *J. Agric. Food Chem.* 55:1945–1954. doi:10.1021/jf0632280 (Abs)
- Blumberg S., Frank O., Hofmann T. (2010) *J. Agric. Food Chem.* 58:3720–3728. doi:10.1021/jf9044606 (Abs)
- Kreppenhofer S., Frank O., Hofmann T. (2011) *Food Chem.* 126:441–449. doi:10.1016/j.foodchem.2010.11.008 (Abs)
- Kraehenbuehl K. et al. (2017) *Food Chem.* 218:9–14. doi:10.1016/j.foodchem.2016.09.055 (FT)
- Ginz M., Engelhardt U.H. (2000) *J. Agric. Food Chem.* 48:3528–3532. doi:10.1021/jf991256v (Abs)
- Kaur S. et al. (2026) *Food Res. Int.* 223:117871. doi:10.1016/j.foodres.2025.117871 (Abs)
- Czech C. et al. (2024) *Food Chem.* 446:138884. doi:10.1016/j.foodchem.2024.138884 (Abs)
- Bichlmaier C. et al. (2025) *Food Chem.* 469:142547. doi:10.1016/j.foodchem.2024.142547 (Abs)
- Lin H., Tello E., Simons C.T., Peterson D.G. (2022) *Food Chem.* 395:133555. doi:10.1016/j.foodchem.2022.133555 (Abs)

**Aroma**
- Blank I., Sen A., Grosch W. (1992) *Z. Lebensm. Unters. Forsch.* 195:239–245. doi:10.1007/BF01202802 (Sec)
- Semmelroch P., Laskawy G., Blank I., Grosch W. (1995) *Flavour Fragr. J.* 10:1–7. doi:10.1002/ffj.2730100102 (FT)
- Semmelroch P., Grosch W. (1996) *J. Agric. Food Chem.* 44:537–543. doi:10.1021/jf9505988 (Abs)
- Czerny M., Mayer F., Grosch W. (1999) *J. Agric. Food Chem.* 47:695–699. doi:10.1021/jf980759i (Abs)
- Czerny M., Grosch W. (2000) *J. Agric. Food Chem.* 48:868–872. doi:10.1021/jf990609n (Abs)
- Mayer F., Czerny M., Grosch W. (2000) *Eur. Food Res. Technol.* 211:272–276. doi:10.1007/s002170000169 (Sec, via Hofmann 2001)
- Hofmann T., Czerny M., Calligaris S., Schieberle P. (2001) *J. Agric. Food Chem.* 49:2382–2386. doi:10.1021/jf0012042 (FT)
- Müller C., Hofmann T. (2007) *J. Agric. Food Chem.* 55:4095–4102. doi:10.1021/jf070095p (Abs)
- Buffo R.A., Cardelli-Freire C. (2004) *Flavour Fragr. J.* 19:99–104. doi:10.1002/ffj.1325 (FT)
- Angeloni S. et al. (2021) *Molecules* 26:3856. doi:10.3390/molecules26133856 (FT)
- Pollien P. et al. (2003) *Int. J. Mass Spectrom.* 228:69–80. doi:10.1016/S1387-3806(03)00197-0 (Abs)
- Holscher W., Steinhart H. (1992) *Z. Lebensm. Unters. Forsch.* 195:33–38 (FT summary)
- Glöss A.N. et al. (2014) *Chimia* 68:179–182. doi:10.2533/chimia.2014.179 (Abs)
- Kreuml M.T. et al. (2013) *Food Sci. Nutr.* 1:267–272. doi:10.1002/fsn3.35 (Abs)
- Lindinger C. et al. (2009) *J. Agric. Food Chem.* 57:9972–9978. doi:10.1021/jf901673d (Abs)

**Extraction**
- Schmieder B.K.L. et al. (2023) *Foods* 12:2871. doi:10.3390/foods12152871 (FT)
- Kuhn M. et al. (2017) *J. Food Eng.* 206:37–47. doi:10.1016/j.jfoodeng.2017.03.002 (Abs)
- Mestdagh F. et al. (2014) *Food Res. Int.* 63:271–274. doi:10.1016/j.foodres.2014.03.011 (FT)
- Sánchez-López J.A., Zimmermann R., Yeretzian C. (2014) *Anal. Chem.* 86:11696–11704. doi:10.1021/ac502992k (Abs)
- Sánchez-López J.A. et al. (2016) *Int. J. Mass Spectrom.* 401:22–30. doi:10.1016/j.ijms.2016.02.015 (FT)
- Smrke S., Eiermann A., Yeretzian C. (2024) *Sci. Rep.* 14:5612. doi:10.1038/s41598-024-55831-x (FT)
- Gloess A.N. et al. (2013) *Eur. Food Res. Technol.* 236:607–627. doi:10.1007/s00217-013-1917-x (FT + supplementary tables)
- Ludwig I.A. et al. (2012) *Food Res. Int.* 48:57–64. doi:10.1016/j.foodres.2012.02.023 (Abs)
- Ludwig I.A. et al. (2014) *Food Funct.* 5:1718–1726. doi:10.1039/c4fo00290c (Abs)
- Crozier T.W. et al. (2012) *Food Funct.* 3:30–33. doi:10.1039/c1fo10240k (Abs)
- Caprioli G. et al. (2013) *J. Food Res.* 2(3):55. doi:10.5539/jfr.v2n3p55 (Abs)
- Caprioli G. et al. (2014) *Int. J. Food Sci. Nutr.* 65:465–469. doi:10.3109/09637486.2013.873890 (Abs)
- Bartel C., Mesias M., Morales F.J. (2015) *Food Res. Int.* 67:356–365. doi:10.1016/j.foodres.2014.11.053 (Abs)
- Khamitova G. et al. (2020a) *Food Res. Int.* 133:109220. doi:10.1016/j.foodres.2020.109220 (Abs)
- Khamitova G. et al. (2020b) *Food Chem.* 314:126220. doi:10.1016/j.foodchem.2020.126220 (Abs)
- Khamitova G. et al. (2022) *Eur. Food Res. Technol.* 248:1217–1226. doi:10.1007/s00217-022-03960-w (not accessed)
- Angeloni S. et al. (2020) *Int. J. Food Sci. Nutr.* 71:193–200. doi:10.1080/09637486.2019.1624693 (Abs)
- Angeloni S. et al. (2023) *Appl. Sci.* 13:2688. doi:10.3390/app13042688 (Abs)
- Pannusch V.B. et al. (2024) *J. Food Eng.* 367:111887. doi:10.1016/j.jfoodeng.2023.111887 (metadata only)
- Jaganyi D., Vanmare J., Clark T. (1999) *J. Sci. Food Agric.* 79:323–326 (FT)
- Jaganyi D., Madlala S.P. (2000) *J. Sci. Food Agric.* 80:85–90 (Abs)
- Spiro M., Selwood R.M. (1984) *J. Sci. Food Agric.* 35:915–924. doi:10.1002/jsfa.2740350817 (Abs)
- Spiro M., Hunter J.E. (1985) *J. Sci. Food Agric.* 36:871–876 (Abs)
- Spiro M., Toumi R., Kandiah M. (1989) *J. Sci. Food Agric.* 46:349–356 (Abs)
- Liang J., Chan K.C., Ristenpart W.D. (2021) *Sci. Rep.* 11:6904. doi:10.1038/s41598-021-85787-1 (Abs)
- Andueza S. et al. (2002) *J. Agric. Food Chem.* 50:7426–7431. doi:10.1021/jf0206623 (Abs)
- Andueza S. et al. (2003) *J. Sci. Food Agric.* 83:240–248. doi:10.1002/jsfa.1304 (Abs)
- Klotz J.A., Winkler G., Lachenmeier D.W. (2020) *Foods* 9:36. doi:10.3390/foods9010036 (Abs)

**Lipids, colloids, minerals**
- Illy E., Navarini L. (2011) *Food Biophys.* 6:335–348. doi:10.1007/s11483-011-9220-5 (FT)
- Nunes F.M. et al. (1997) *J. Agric. Food Chem.* 45:3238–3243. doi:10.1021/jf970009t (Abs)
- Ratnayake W.M.N. et al. (1993) *Food Chem. Toxicol.* 31:263–269. doi:10.1016/0278-6915(93)90076-B (Abs)
- Urgert R. et al. (1995) *J. Agric. Food Chem.* 43:2167–2172. doi:10.1021/jf00056a039 (Abs)
- Gross G., Jaccaud E., Huggett A.C. (1997) *Food Chem. Toxicol.* 35:547–554. doi:10.1016/S0278-6915(96)00123-8 (Abs)
- Moeenfard M., Erny G.L., Alves A. (2016) *J. Food Sci. Technol.* 53:3916–3927. doi:10.1007/s13197-016-2378-6 (Abs)
- Santanatoglia A. et al. (2025) *J. Food Compos. Anal.* 137:106929. doi:10.1016/j.jfca.2024.106929 (Abs)
- Konieczyński P. et al. (2025) *Foods* 14:426. doi:10.3390/foods14030426 (FT)
- Stelmach E., Pohl P., Szymczycha-Madeja A. (2013) *Food Chem.* 141:1956–1961. doi:10.1016/j.foodchem.2013.05.011 (Abs)

**Growing conditions, processing**
- Worku M. et al. (2018) *Food Res. Int.* 105:278–285. doi:10.1016/j.foodres.2017.11.016 (Abs)
- Joët T. et al. (2010) *Food Chem.* 118:693–701. doi:10.1016/j.foodchem.2009.05.048 (Abs)
- Bertrand B. et al. (2012) *Food Chem.* 135:2575–2583. doi:10.1016/j.foodchem.2012.06.060 (Abs)
- Knopp S., Bytof G., Selmar D. (2006) *Eur. Food Res. Technol.* 223:195–201. doi:10.1007/s00217-005-0172-1 (Abs)
- Santanatoglia A. et al. (2024c) *Food Chem.* 460:140644. doi:10.1016/j.foodchem.2024.140644 (Abs)
- da Silva Vale A. et al. (2022) *Foods* 12:37. doi:10.3390/foods12010037 (Abs)
- Dias S.R. et al. (2026) *Int. J. Food Microbiol.* 453:111711. doi:10.1016/j.ijfoodmicro.2026.111711 (Abs)

**Water, acidity, sensory**
- Hendon C.H., Colonna-Dashwood L., Colonna-Dashwood M. (2014) *J. Agric. Food Chem.* 62:4947–4950. doi:10.1021/jf501687c (FT)
- Navarini L., Rivetti D. (2010) *Food Chem.* 122:424–428. doi:10.1016/j.foodchem.2009.04.019 (Abs)
- Bratthäll T., Figueira J., Nording M.L. (2024) *Heliyon* 10:e26625. doi:10.1016/j.heliyon.2024.e26625 (Abs)
- Liu Y. et al. (2025) *J. Food Compos. Anal.* 146:107987. doi:10.1016/j.jfca.2025.107987 (Abs)
- Yeager S.E. et al. (2023) *Crit. Rev. Food Sci. Nutr.* 63:1010–1036. doi:10.1080/10408398.2021.1957767 (Abs + ASIC poster)
- Rune C.J.B. et al. (2023) *Curr. Res. Food Sci.* 6:100485. doi:10.1016/j.crfs.2023.100485 (Abs)
- Santanatoglia A. et al. (2024a) *J. Food Compos. Anal.* 125:105732. doi:10.1016/j.jfca.2023.105732 (metadata)
- Santanatoglia A. et al. (2024b) *Food Chem.* 454:139717. doi:10.1016/j.foodchem.2024.139717 (Abs)
- Batali M.E., Ristenpart W.D., Guinard J.X. (2020a) *Sci. Rep.* 10:16450. doi:10.1038/s41598-020-73341-4 (FT)
- Batali M.E. et al. (2020b) *J. Sci. Food Agric.* 100:2953–2962. doi:10.1002/jsfa.10323 (Abs)
- Batali M.E. et al. (2021) *ACS Food Sci. Technol.* 1:559–569. doi:10.1021/acsfoodscitech.0c00078 (metadata only)
- Frost S.C., Ristenpart W.D., Guinard J.X. (2020) *J. Food Sci.* 85:2530–2543. doi:10.1111/1750-3841.15326 (Abs)
- Guinard J.X. et al. (2023) *J. Food Sci.* 88:2168–2177. doi:10.1111/1750-3841.16531 (Abs)
- Keast R.S.J., Roper J. (2007) *Chem. Senses* 32:245–253. doi:10.1093/chemse/bjl052 (Abs)
- Labbe D. et al. (2007) *Chem. Senses* 32:205–214. doi:10.1093/chemse/bjl040 (Abs)
- Lindinger C. et al. (2008) *Anal. Chem.* 80:1574–1581. doi:10.1021/ac702196z (FT)
- Bressanello D. et al. (2018) *J. Agric. Food Chem.* 66:7096–7109. doi:10.1021/acs.jafc.8b01340 (Abs)
- Navarini L. et al. (2004) *J. Texture Stud.* 35:525–541. doi:10.1111/j.1745-4603.2004.35504.x (Abs)
- Cusielo K.V.C. et al. (2026) *J. Food Sci.* 91:e71157. doi:10.1111/1750-3841.71157 (Abs)
