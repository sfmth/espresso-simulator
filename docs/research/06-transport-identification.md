<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 06 — Transport identification after the inventory correction

*Source review and bounded diagnostics, 2026-10-16. The numerical examples below use preserved v3
and native 0.6.0. They motivate a joint identification review; they are not final v4 results.*

The remaining V1 errors are much larger than the observed effects of timestep, output sampling or
optimizer restart. Existing uncertain water, particle and preparation assumptions therefore need
joint review before adding a new exchange law. The corrected reservoir accounting remains as
specified in [ADR 0012](../decisions/0012-total-particle-solute-inventory.md).

## 1. Observable direction, scoring and numerical checks

[Schmieder et al. (2023)](https://www.mdpi.com/2304-8158/12/15/2871) fits
$c(m)=c_0\exp(-m/\lambda)$, where $m$ and $\lambda$ are **beverage mass in grams**.
A larger $\lambda$ means slower concentration decay. It is not an inverse rate or a time constant.
The case builder uses this convention and fits model fraction concentrations at the same accumulated
mid-masses as the source. Refitting the published fraction data reproduces its $\lambda$ and $c_0$
within 0.055% and 0.027%, respectively.

V1's loss is half the sum of squared normalized residuals: logarithmic model/data residuals for
$\lambda$, $c_0$ and cup masses, plus the declared pressure residual. It contains 315 residuals over
15 conditions. The separate target counts use $|\mathrm{model}/\mathrm{data}-1|\leq0.10$:
60 decay masses and 180 cup masses. Both model and data cups use the authors' Eq. 3 at 20, 40 and
60 g. Missing or nonfinite predictions do not enter a successful numerator or reduce its denominator.
The [calibration specification](../validation/calibration.md) retains the pressure convention,
uncertainty floors and separate 15% leave-one-condition-out tolerance.

At fixed v3 values, median model/data $\lambda$ was 1.392 for TDS and 1.332 for trigonelline.
A deterministic midpoint restart of the pruned V1 parameter set reduced cost from 2412.12 to
2411.37, leaving scores at 25/60 and 158/180. Halving maximum timestep from 0.05 to 0.025 s changed
$\lambda$ and $c_0$ by at most 0.252%; halving output spacing from 0.1 to 0.05 s changed
$\lambda$ by at most 0.0055%. Scores were unchanged. These checks do not prove convergence of every
model observable, but cannot explain the much larger V1 decay mismatch.

Smaller finite differences destabilized hydraulic derivative estimates. Diagnostics therefore used
the existing 0.01 step: 1% of the bound span for linear parameters, 0.01 dex for log parameters,
with bounded trust-region least squares and ordinary solver tolerances. `xtol` termination is
recorded separately from first-order optimality; it does not establish a stationary or global optimum.

## 2. Source volume bases and the retained closure

[Grudeva, Moroney and Foster (2026)](https://www.cambridge.org/core/journals/european-journal-of-applied-mathematics/article/multiscale-model-for-espresso-brewing-asymptotic-analysis-and-numerical-simulation/4D2A6BDF66F8306EFD260A111A4F3BD7),
§§2.1–2.6, distinguishes fine fragments without accessible internal pores from porous boulders.
Its Eqs. 2, 11 and 16 assign water and front-carried solute consistently:

$$
\phi_T=\phi_l+\phi_b\varepsilon_p,\qquad
C_b^+=C_{b,0}+\varepsilon_p c_l.
$$

Here boulder concentration counts solute per particle-envelope volume. Eq. 17's surface law assumes
unit partition and explicitly allows a different partition basis. The paper does not measure
species-specific surface affinities. Its [publisher PDF](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/4D2A6BDF66F8306EFD260A111A4F3BD7/S095679252500018Xa.pdf/a-multiscale-model-for-espresso-brewing-asymptotic-analysis-and-numerical-simulation.pdf)
is CC BY 4.0.

[Pannusch et al. (2024)](https://doi.org/10.1016/j.jfoodeng.2023.111887), §3.1 and Appendix D, is
available in the [author's dissertation appendix](https://mediatum.ub.tum.de/doc/1734154/1734154.pdf).
Its fine and coarse storage terms are respectively $\alpha_{s1}c_{s1}$ and
$\phi_{v2}\alpha_{s2}c_{s2}$. Thus coarse total-envelope loading is $C_{s2}=\phi_{v2}c_{s2}$:
a fitted liquid/$c_{s2}$ partition becomes $K_i/\phi_{v2}$ on an envelope basis, while the fine
partition remains $K_i$. Its transfer coefficient already includes internal diffusion. Copying
those coefficients into one envelope partition or adding that transfer resistance alongside our
diffusion kernel would change their meaning.

Pannusch fits the same Schmieder extraction observations, so its fitted constants are not
independent validation. Section 4.1 cautions that they depend on the model and experimental errors.
Table D.1 uses a **dry** PSD with D32 = 84 µm, coarse internal porosity 0.4, 20 g dose, 58 mm basket
and 15 mm bed height. Those choices differ from our qualified wet-CDF input. The article retains
Elsevier copyright; the [author code/data repository](https://data.mendeley.com/datasets/y2tz67f6ry/1)
states CC BY-NC 3.0. No author implementation or fitted constants were imported.

[Corrochano's whole-particle partition basis](https://etheses.bham.ac.uk/id/eprint/7176/2/Roman-Corrochano17EngD.pdf),
§3.3.13, and its inventory implications are detailed in [note 05](05-water-and-particle-inventory.md).
That measurement does not separately identify shell and kernel equilibrium capacities.

**Derived implication for the current model.** For pool-envelope volume $\Omega$, its reference
capacity is $P=\varepsilon_c\Omega$, with $\varepsilon_c=\varepsilon_p(1-u_w)$. Its unsaturated
equilibrium with loading ceilings inactive is $c=S/P$, while kernels use total-envelope loading
$c/K$. For uniform $K$ and volume-weighted pool fraction $F$, the mixture therefore has

$$
K_{\mathrm{mixture}}=\left[F\varepsilon_c+(1-F)/K\right]^{-1}.
$$

V3 experiment 7 has $F=0.694835$, $\varepsilon_c=0.275$ and kernel $K=0.61$, giving
$K_{\mathrm{mixture}}=1.44644$. The effective pool-capacity choice is a constitutive assumption,
not merely a numerical change of units or preservation of a measured whole-particle $K$.
The retained congruent species-pool map also freezes species surface exchange when net lumped
exchange is zero; species $K$ and $D$ affect kernels. This is an explicit model limitation,
not a discovered sign or conservation error.

## 3. Why the apparent shortcuts were not selected

Assigning the same measured whole-particle $K$ to both pools and kernels is a possible new closure,
not a source identity. In experiment 7 it raises the unsaturated equilibrium storage equivalent
from 29.46 to 60.62 mL. More retention need not improve the excessive $\lambda$. Independent
species surface exchange can be condensed conservatively and positively, but choosing its pool
partition, shared saturation activity and optional deposition ceiling requires additional
constitutive assumptions. None is identified independently by the reviewed measurements.

Nor can fine/shell water be removed while leaving all other inventories unchanged. If every
broken shell were dense and only its kernel porous, with pool fraction $F$, consistent dose and
density would require

$$
V_b=\frac{M}{\rho_s(1-\varepsilon)[1-\varepsilon_p(1-F)]}.
$$

For v3's 40 µm shell, $F=0.675$–0.701 across the wet PSDs. This changes the bed from 39.61 mL to
21.33–21.70 mL, whereas Pannusch's tabulated 58 mm × 15 mm bed is about 39.6 mL. An opened lumen
in a coarse particle's shell is not automatically a collapsed dense fine fragment. Setting the
existing pool capacity to zero also removes or singularizes its solute reservoir. A geometric
revision must reconcile dry mass, water, heat and exchange together.

Fixed-v3 experiment-7 mechanism limits reinforce the distinction: all-pool species share
$\lambda=20.72$ g, whereas the observed trigonelline/TDS values are 16.09/17.47 g; removing all
pools gives much slower decay. These are mathematical probes, not proposed priors or universal
bounds on mixed spatial models. The concentration-only residual transformation rejected in
[note 05 §1](05-water-and-particle-inventory.md#1-what-the-partition-coefficient-counts) likewise
requires a dynamic correction, not just a different partition number.

## 4. Bounded diagnostic fits

The following local V1-only probes retain all 15 conditions and the original targets. Expanded
fits free the original 15 V1/shared parameters plus the named additions; the midpoint row instead
uses v3's pruned V1 set. They have different degrees of freedom and are not a model-selection test.

| Diagnostic | V1 cost | λ within 10% | Cups within 10% |
|---|---:|---:|---:|
| Fixed v3 | 2412.12 | 25/60 | 158/180 |
| Midpoint restart of pruned V1 fit | 2411.37 | 25/60 | 158/180 |
| Existing particle-water fraction free | 836.93 | 31/60 | 174/180 |
| Water plus trigonelline and 5-CQA kernel partitions free | 649.30 | 37/60 | 173/180 |
| Existing preparation spread and edge coefficients free | 714.61 | 37/60 | 172/180 |

The water/partition probe ended at water fraction 0.5 and trigonelline $K=1$, with 5-CQA $K=0.6925$.
Their local SD/prior-SD ratios were 0.83, 1.75 and 0.90: improvement did not independently identify
them. Its first-order optimality remained about 358 at `xtol`. The preparation probe narrowed the
inner spread but strengthened edge restriction; its two coefficients were correlated ($r=-0.73$),
and edge/viscosity-exponent correlation was 0.93. It ended at `xtol` with optimality 72, while the
caffeine surface scale reached its lower prior. Both final predictions had no missing cases.

These results justify joint identifiability review of existing assumptions. They do not establish
that any individual diagnostic is the final calibrated model or passes the scientific gates.
The [JSON companion](../validation/m11-transport-identification.json) preserves compact metrics,
fit scopes, recorded solver/input identities and SHA-256 hashes of the source artifacts. Local
originals are retained in `.local/v3-v1-diagnostics/`,
`.local/v1-pool-audit/diagnostics.json`, its `partition-water-fit/partition-water.summary.json`,
and `.local/transport-refinement/{water-fit.score,prep-fit}.json`. These are development artifacts,
not additional experimental datasets.

## 5. Scope of the subsequent joint identification

Schmieder §2.4 reports Grande TRE distribution and levelling, followed by a parallel 25 kgf tamp.
The input model has no Grande TRE category; its old omitted-category fallback was `tap`.
The diagnostic tapping/base-edge coefficients are therefore **not** exported as global app
calibrations. Two setup-specific spec nuisances instead describe actual inner spread and actual
edge multiplier for all V1 conditions, after fines/basket corrections. The spread prior
0.195883–0.740029 is the intersection of the existing tap support after each nominal wet-PSD
correction; the edge prior 0.229046–0.687138 is the existing base support times
$((27/29)/0.87)^2$. These remain grade-D conditional supports. Fixed prewetting variance and edge
area are not separately identified. [Registry records](../../data/params/calibration.yaml) and
[case-builder documentation](../validation/case-builders.md) give the exact mapping.

Particle water retains its existing **prior 0.5–1**, distinct from its **physical range 0–1**.
For newly wetted volume $V\Delta w$, $\beta=(1-\varepsilon)\varepsilon_p f$ admits
$\beta V\Delta w\,c^+$ solute into particles and debits the external mobile balance by the same
amount. Fitted $f$ describes effective water admitted at the front under instantaneous filling;
it is not a measured hydration rate. It also changes hydraulic and thermal storage. At fixed
temperature after complete wetting it no longer directly changes local exchange coefficients,
although startup history remains different. The pool/kernel loading scale $u_w$ stays fixed.

Trigonelline and 5-CQA kernel partitions retain their existing 0.42–1 priors; no Pannusch fitted
values are transplanted. Lumped diffusivity is reopened only inside its existing
$1.9\times10^{-11}$–$1.6\times10^{-10}$ m²/s prior. This is an effective coefficient fitted to
stirred-vessel extraction curves on a D43 basis, not a separately measured microscopic diffusivity.
The earlier fixing decision preceded the corrected inventory. Species diffusivities and surface
transfer speed remain fixed; no prior is widened to chase a score.

The joint calibration uses only the declared V1 kinetics, V2 dispersion, V4 long-time flow and V6
density response. V3, V4 startup/transient and V5 observations do not select parameters or closures.
Full-block leave-one-condition-out refits re-estimate shared parameters with one V1 condition
removed; they remain conditional on the full-fit parameter/pruning structure. Final v4 fit,
identifiability, sensitivity and held-out results belong in
[calibration.md](../validation/calibration.md), rather than being anticipated by this note.
