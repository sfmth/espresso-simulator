<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 05 — Water and particle inventory

*Primary-source audit, 2026-10-16. This note identifies model and input constraints; it introduces no fitted coefficient or new transport law.*

**Resolve reservoir ownership and preserve measured particle-size information before adding water-exchange kinetics.** The current full-water concentration and the published particle partition coefficient use overlapping solute inventories. Wetting measurements support several water environments and concurrent headspace/puck filling, but the sources reviewed here do not independently determine an espresso mobile/immobile exchange rate. Conservation of numerical state variables alone cannot establish that their physical inventories are disjoint.

Evidence terminology follows [note 01](01-extraction-and-flow-physics.md). Mathematical deductions below are labelled **derived**. Access and measurement limitations are part of each source's interpretation. Existing calibration groups and held-out observations remain unchanged.

## 1. What the partition coefficient counts

[Roman Corrochano's thesis](https://etheses.bham.ac.uk/id/eprint/7176/2/Roman-Corrochano17EngD.pdf), §3.3.13, printed pp82–83, defines $K=C_b/C_s$. The concentration $C_s$ includes both solute in internal pore solution and material attached to the matrix, per particle envelope volume. The source balance is

$$
M_0=y_0m=C_bV_b+C_sV_s,\qquad
V_b=V_w-m\chi,\qquad V_s=\frac{Sm}{\rho_p},
$$

and its Eq. 3.17 is

$$
\frac{1}{C_{b,\mathrm{eq}}}
=\frac{V_w}{my_0}
+\frac{1}{y_0}\left(\frac{S}{K\rho_p}-\chi\right).
$$

Here $\chi$ is absorbed-water volume per coffee mass, $S$ is swollen/dry particle volume, and $\rho_p$ is dry particle-envelope density. Solute volume is neglected. The reported $K=0.61$ at 80 °C uses $S=1$. The bed model in §3.4.2 starts fully wetted and uses intergranular liquid storage. These definitions were verified in the full thesis: its title page is dated December 2015; the [repository record](https://etheses.bham.ac.uk/id/eprint/7176/) lists 2017. The thesis is publicly readable but retains author/third-party copyright; it is not redistributed here.

### Consequence for the current model

The [shot model](../model/shot-model.md#53-kernel-diffusion-in-a-sphere-with-a-partition-boundary) represents kernel loading as $C_s=\varepsilon_c u$, with boundary $u=c/(K\varepsilon_c)$ when its loading cap is inactive. Meanwhile, its liquid holdup includes selected intraparticle water. Renaming $u$ a concentration-equivalent loading does not change the equilibrium envelope inventory $c/K$.

**Derived accounting identity.** Let $a=V_{\mathrm{internal}}/V_s$ be the internal water share already represented at concentration $c$. For the same physical inventory,

$$
M=(V_w-aV_s)c+V_s\frac{c}{K}
 =V_wc+V_s\left(\frac1K-a\right)c.
$$

Combining $V_wc$ with the unchanged particle inventory $V_sc/K$ counts an extra $aV_sc$. This is an overlap in equilibrium capacity, even when the implementation exactly conserves its defined sum. The identity applies to the envelope portion governed by that partition law. It does not justify subtracting all bed uptake from coarse kernels while ignoring broken-shell pools, loading caps, or partial wetting.

Two consistent choices of variables are external liquid plus total particle loading, or full-water concentration plus the residual $R=C_s-ac$. The latter has

$$
R_{\mathrm{eq}}=\left(\frac1K-a\right)c,\qquad
K_R=\frac{K}{1-Ka}\quad(Ka<1).
$$

At $Ka=1$ the residual equilibrium capacity vanishes. For $Ka>1$, it cannot represent a nonnegative matrix-only reservoir with internal pore liquid at $c$. This restriction concerns that interpretation, not a universal bound on empirical partition coefficients. The thesis's long-time absorbed-water measurement is not automatically the simulator's startup water share.

Changing the partition number alone is not an exact correction of the transient model. If $a$ is constant and the macroscopic $c(t)$ is spatially uniform within a kernel, transforming $\partial_t C_s=D\nabla^2 C_s$ gives

$$
\partial_tR=D\nabla^2R-a\,\partial_tc.
$$

If $a$ varies only with time, the transformation also adds $-c\,\partial_ta$. Different internal and external concentrations require a separate state and exchange relation. Those relations are not identified by the equilibrium experiment. A future correction must reconcile storage, fluxes and initialization together; simply removing intraparticle liquid holdup would also undo the existing front-cell water accounting. No such code change is made by this audit.

## 2. What wetting and uptake measurements establish

[Foster et al. 2025](https://pure.port.ac.uk/ws/portalfiles/portal/107511955/Dynamics_of_liquid_infiltration_into_an_espresso_bed_using_time-resolved_micro-computed_tomography.pdf) (DOI 10.1063/5.0245167; full text) uses roughly one-second microCT reconstructions of 10 g beds. It observes front depth $s(t)$, ponded headspace height $H(t)$, and nonuniform infiltration. Penetration begins before ponding; ponding and front advance then coexist. Before breakthrough, its model includes

$$
\dot H=Q/A-q,\quad \phi_T\dot s=q,\quad
q=\frac{\kappa}{\mu s}[p_h-p_a+p_c+\rho g(H+s)],
$$

$$
p_h=\frac{p_aH_0\beta}{H_0-H},\qquad
p_p=p_m-(p_m-p_a)(Q/Q_m)^2.
$$

The pressures here are absolute. Fixed trapped-gas moles, instantaneous gas heating, capillary pressure and the quadratic pump curve are assumptions. Free pump flow is measured; the in-shot pressure/flow curves are predictions. Fitted $\phi_T=0.322$, $\kappa=2.97\times10^{-15}\,\mathrm{m^2}$, and a 0.796 s time shift are not independent parameter measurements. The imaging challenges mandatory complete-headspace-fill-before-infiltration, but does not identify particle exchange kinetics. The published PDF is CC BY-NC 4.0; raw data are available on reasonable request, with no open raw archive located in this audit. No request was sent.

[Mateus et al. 2007](https://pubs.acs.org/doi/10.1021/jf062841g) (DOI 10.1021/jf062841g; publisher abstract) reports about 0.15 g/g nonfreezable water, peripheral wetting of approximately 1 mm particles at 1 g/g added water, reduced helium-inaccessible porosity, and a swelling-derived moisture diffusivity around $2–3\times10^{-11}\,\mathrm{m^2/s}$. Helium accessibility can increase through matrix plasticization as well as pore filling. Nonfreezable water is not a measured hydraulic immobile fraction, and the fitted diffusivity is not an independent pressurized-puck exchange rate. No open full text or raw-data archive was verified.

The companion [low-field NMR study](https://www.sciencedirect.com/science/article/abs/pii/S0260877407000076) (DOI 10.1016/j.jfoodeng.2006.12.015; publisher abstract and method snippets) distinguishes polar components attributed to cell-wall and cell-lumen water, with $T_2$ values around 6 and 27 ms at 50% water content and 90 °C. Signal changes continue over minutes. These magnetic-relaxation times are not hydraulic residence or intercompartment exchange times. The observations support distinct water environments without supplying their transfer law under espresso conditions.

Swelling is also an uncertain proxy for uptake. [Hargarten et al. 2020](https://scijournals.onlinelibrary.wiley.com/doi/10.1002/jsfa.10440) (full text) reports about 15% **diameter** increase, predominantly in the first 30 s and complete by about four minutes; its microscopy uses particles approximately 400–1000 µm across and explicitly deals with bubbles. [Maille et al. 2021](https://www.sciencedirect.com/science/article/pii/S0260877420305069) (publisher abstract and section snippets) finds no significant swelling over 0.5–5 minutes after accounting for changing particle entrainment, while observing gas release and its interference with sizing. Seven of its eight coffees had been ground 4–6 months earlier, limiting fresh-coffee extrapolation. The conflicting observations do not justify a universal swelling-based uptake constant.

## 3. Independent hydraulic observations

[Waszkiewicz et al. 2026](https://arxiv.org/html/2512.21528v2) measures pump-outlet pressure and cup mass at 10 Hz, with outlet flow obtained from differentiated and smoothed cup mass. Separate empty-basket/restrictor measurements estimate pressure losses. There is no independent in-shot inlet-flow time series. These data constrain pressure and cup delivery jointly, but cannot alone separate upstream storage from particle uptake. Keep the existing startup holdout and the original acquisition clock; publication curves shifted to a 5 g reference do not define pump-on time. [Code/data are public](https://github.com/RadostW/espresso), with a [Zenodo record](https://zenodo.org/records/18046315); a software licence should not be generalized to unrelated datasets.

[Moroney et al. 2019](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0219906) does use an in-line CORI-FLOW meter and pressure transducer. Its 60 g, 250 mL/min, approximately one-litre experiments constrain flow, pressure and extraction; the model starts saturated. Listed supplements contain model videos and extraction/control-chart appendices, not an independently metered inlet/outlet startup dataset. The article is CC BY. Among the sources reviewed here, no synchronized record of independent inlet flow, outlet flow, pressure and spatial water retention was located; this is a scoped search result, not a claim that none exists.

## 4. Particle-size inputs

[Schmieder et al. 2023, §2.4 and Fig. A1](https://www.mdpi.com/2304-8158/12/15/2871) distinguishes dry panel (a) from wet panel (b). The published wet means and repeat-measurement SDs are:

| Grinding level | D43, µm | D32, µm |
|---|---:|---:|
| 1.4 | 273 ± 7.6 | 28.3 ± 1.6 |
| 1.7 | 277 ± 17 | 26.9 ± 3.2 |
| 2.0 | 295 ± 18 | 29.2 ± 1.4 |

The full wet distribution is appropriate evidence for the case already declared wet-based. Matching D43 with an assumed 25% fines mixture discards its measured sub-10 µm population. This does not establish wet-dispersion particle sizes as dry-bed hydraulic geometry. The article is CC BY 4.0. Its public supplement supplies extraction tables and an OriginPro project; a raw PSD table was not verified. The proposed PSD input is a figure digitization, not an instrument export.

### Digitization and its limits

Use cumulative volume $Q_3$ differences as bin weights. The plotted density $q_3$ has units mm$^{-1}$, despite the logarithmic diameter axis: integrating it against log diameter without the Jacobian is incorrect. A [manufacturer's HELOS/WINDOX example](https://archive.sympatec.com/images/Software/WxReport01.pdf) separates cumulative upper-band $x_0$ from density mean-band $x_m$ positions. That example uses logarithmic density and does not establish the position convention of Schmieder's linear-density plot. Apparent agreement after shifting density coordinates is insufficient to infer a manufacturer rule.

The inspected extraction uses the full visible error-bar span, including color-overlap gaps, rather than the longest uninterrupted vertical segment. Ambiguous density/cumulative crossings are omitted from the measured points. Independent inspection confirmed the corrected interior cap midpoints and the first retained point, near 3.04 µm, for all three colors. The [source importer](../../python/puckworks_tools/sources/schmieder2023_psd.py) retains the raw readings and applies a least-squares monotonic projection; the largest correction in the inspected curves is about 0.26 percentage points. Both the projection and any omitted points are part of the reconstruction, not new measurements.

At the inspected 600 dpi rendering, the plot spans about 969 pixels per unit cumulative share and 315 pixels per diameter decade. A working reading tolerance of ±3 pixels means approximately ±0.31 percentage points in $Q_3$ and ±2.2% in diameter for separable points. The dataset records a more conservative estimated allowance of one percentage point in cumulative volume for occlusion and projection. These are reading allowances, not experimental SDs or confidence intervals. Points below roughly 3.04 µm are omitted because overlap and the baseline prevent a reliable detailed trace. The first retained cumulative value supplies the unresolved fine-tail share. Setting $Q_3=1$ at 1000 µm truncates to the displayed range; it does not measure zero material above that size.

**Derived bin conversion.** For piecewise uniform density in linear diameter on $[l_i,h_i]$, with volume shares $w_i=Q_3(h_i)-Q_3(l_i)$,

$$
D_{43}=\sum_iw_i\frac{l_i+h_i}{2},\qquad
\frac1{D_{32}}=\sum_iw_i\frac{\log(h_i/l_i)}{h_i-l_i}.
$$

The representative diameter $(h_i-l_i)/\log(h_i/l_i)$ preserves each bin's surface-area-to-volume ratio. The within-bin density is an explicit assumption; it is not uniquely determined by the figure.

**Derived unresolved fine tail.** Let $w_h=Q_3(d_*)$ at the first retained diameter $d_*$ and let $I_t=\sum_{i\in\mathrm{resolved}}w_i\log(h_i/l_i)/(h_i-l_i)$. Using the independently reported D32 as a constraint, one effective diameter represents the unresolved share:

$$
d_h=\frac{w_h}{D_{32}^{-1}-I_t},\qquad 0<d_h<d_*.
$$

The denominator and support condition must be checked; an incompatible moment must fail rather than silently clip the diameter. This determines an effective harmonic size, not the actual shape or number of modes below $d_*$. The inspected reconstruction gives nominal effective sizes around 1.3–1.5 µm, with positive values below $d_*$ also for the published D32 ± one SD. These are derived inputs, not recovered instrument readings. Choosing the reported mean D32 is a reconstruction convention: the mean of D32 across repeated measurements need not equal D32 of their mean PSD.

D32 agreement is therefore an input constraint, not independent validation of the trace. Unfitted D43 remains a sanity check. The D32 ± one SD runs are source-moment sensitivities, not a complete uncertainty band: CDF reading, moment covariance, truncation, and within-bin shape remain uncertain. No pressure, flow or extraction outcome enters this reconstruction. Preserve the reconstructed sub-2 µm mass when reducing the PSD to simulation classes. The [dataset and metadata](../../data/datasets/schmieder2023-psd/dataset.yaml) record the final trace, support choices and numerical provenance.

## 5. Evidence required for a later exchange model

The next model must assign water and solute once, recover the intended equilibrium inventory, and distinguish variable changes from new kinetics. Existing equilibrium partition and lumped extraction measurements do not independently separate water uptake, internal diffusion, binding and surface dissolution.

Useful online experiments would synchronize incoming water mass, outgoing beverage mass and soluble mass, pressure near the bed, temperature, and front position or retained water. Empty/bypassed-bed measurements distinguish machine storage and losses. Imaging plus inlet volume distinguishes ponding from bed uptake; pressure decay with both flows measured distinguishes residual supply from released storage. An independently characterized tracer or water-mobility measurement is needed to identify exchange separately from solute chemistry. These are criteria for qualifying further evidence, not a request for equipment, owner measurements, or new fitted parameters.
