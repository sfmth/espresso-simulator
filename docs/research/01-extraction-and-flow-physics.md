# 01 — Espresso extraction and flow physics: models, parameters, validation data

*Research note for the browser espresso simulator (planning phase). Compiled 2026-10-13.*

**Scope.** Mechanistic models of flow through the espresso bed ("puck") and of solubles extraction, the parameter values needed to implement them, the experimental datasets that can validate them, and the numerical formulations cheap enough to run in a browser. Particle-size distributions (PSD) and grinding are covered only as inputs to flow and extraction.

**Evidence key** (used in tables): **A** = peer-reviewed primary measurement; **B** = peer-reviewed model, fit or indirect inference; **C** = thesis, book or review; **D** = community or grey literature (single operator, informal replication); **[unverified]** = claim or number I could not confirm against a readable source. "Derived" = computed in this note from cited inputs (inputs stated). Where I read only an abstract, this is noted.

**Conventions.** $z$ is depth (inlet $z=0$, outlet $z=L$); $q$ is the Darcy (superficial) flux in m s⁻¹; $\varepsilon$ is intergranular (bed) porosity; $\varepsilon_p$ is intraparticle porosity; concentrations are kg m⁻³ unless stated; TDS is % w/w; EY = mass of dissolved solids in the cup divided by dry dose. A 58 mm basket has area $A = 2.64\times10^{-3}$ m².

---

## 1. Executive summary

1. **Model backbone.** The literature converges on a **multiscale, pseudo-2D ("Newman-type") model**: 1D advection(-dispersion) of dissolved solids through the bed, coupled at every depth to diffusion inside representative spherical particles of two classes (fines < 100 µm, "boulders" > 100 µm). Variants: Moroney et al. 2015/2016/2019 (double porosity: surface "broken-cell" pool plus kernel diffusion), Cameron et al. 2020 (homogenized, nonlinear surface rate), and Grudeva, Moroney & Foster 2025/26 (adds the infiltration stage and an asymptotically reduced model about 100× cheaper).
2. **The flow closure is the weakest link.** Kozeny–Carman with the dry-measured PSD, and steady-state permeameter data (10⁻¹³–10⁻¹⁴ m², Corrochano et al. 2015), overpredict espresso flow by up to three orders of magnitude (permeameter 2–200×, Kozeny–Carman 10–1000×). Back-calculated **in-shot effective permeability is about (2–15)×10⁻¹⁵ m²** (derived, §4.3). Swelling, consolidation/poroelastic compaction, fines and gas are the candidate causes; no dataset separates them.
3. **Flow is not linear in pressure.** Above about 5 bar, long-time flow saturates (Waszkiewicz et al. 2026: $Q/Q_c = 1-(1-P/P_c)^4$ with $P_c \approx 12$ bar). Corrochano (2017) found flow rising from 3 to 5 bar and falling at 7 bar.
4. **Flow rises during a constant-pressure shot** mainly because the bed wets (5–10 s), dissolution opens porosity, and pore-liquid viscosity falls as concentration drops from ~25% TDS. Swelling, compaction and fines migration act the other way.
5. **Intraparticle transport.** For caffeine at 80 °C, $D_\text{eff} \approx 1.6$–$2.1\times10^{-10}$ m² s⁻¹ (hindrance factor 11–14). Lumped solubles span about 10⁻¹²–10⁻¹⁰ m² s⁻¹ depending on molecular size and fitting method. Fines empty in under ~2 s; boulders (radius 150–250 µm) need tens to hundreds of seconds, so espresso is diffusion-limited for coarse particles.
6. **Ceilings.** Maximum extractable yield is about 28–34%. A saturation-like ceiling of about 210–280 kg m⁻³ shows in the first drops (~25% TDS).
7. **Channeling.** The extraction–permeability positive feedback (Lee, Smith & Arshad 2023) reproduces the **non-monotonic EY versus grind** curve of Cameron et al. 2020. Community radial-coring data show puck edges extracted at about half the centre's level, and paper filters, puck screens or less headspace raise mean EY by 2–3.4 points (evidence D).
8. **Browser feasibility.** A 1D bed with 30–50 cells, two particle classes and 6–8 radial shells for boulders is a few hundred stiff ODEs, which runs in real time with an implicit or IMEX integrator. Heterogeneity can be added cheaply as N parallel 1D columns sharing one inlet pressure.

---

## 2. Processes and timescales

| Process | Timescale | Basis |
|---|---|---|
| Wetting/infiltration until first drops | 5–10 s, up to 1/3 of the shot | Grudeva 2025 (B); Waszkiewicz 2026 (A) |
| Particle swelling | 60–80% within 30 s, done in ~4 min | Hargarten 2020 (A) |
| Bed consolidation under flow | mostly within the first 20–30 s | Corrochano 2017 (C, measured) |
| Liquid advective residence $\varepsilon L/q$ | ~2–5 s ($\varepsilon=0.2$, $L=14$ mm, $q=7\times10^{-4}$ m s⁻¹) | derived |
| Tracer mean residence (measured) | ~5× the plug-flow estimate | Vaca Guerra 2024 (A, 22 °C tracer) |
| Diffusion out of fines, $a^2/(\pi^2D)$, $a$ = 5–15 µm, $D=10^{-10}$ | 0.03–0.2 s | derived |
| Diffusion out of boulders, $a$ = 150–250 µm | 23–63 s ($a^2/D$ = 225–625 s) | derived |
| Surface dissolution, $(k b/\varepsilon)^{-1}$ with $k=10^{-3}$ m s⁻¹ | ~0.002–0.02 s (very stiff) | derived from Grudeva 2025 parameters |
| Shot duration | 20–30 s (SCA definition, as quoted by Cameron 2020); 14–40 s observed | Cameron 2020; Smrke 2024 |

**Dimensionless groups** (typical shot, derived):
- Particle Reynolds number $Re_p = \rho q d/\mu \approx 0.2$–0.7 for $d$ = 100–300 µm: laminar, with weak inertia. Mo et al. 2023 found inertial (Forchheimer) deviations at $Re$ = 0.8–3.9 based on $d_{43}$.
- Bed Péclet number $qL/D$: about 5×10³ with molecular $D$, but the measured Bodenstein numbers ($vL/D_{ax}$) are only **8–17** (Vaca Guerra 2024, §4.8).
- Mass Biot number $k_f a/D_\text{eff} \gg 1$ for boulders, so internal diffusion controls.

---

## 3. Mechanistic extraction models

### 3.1 Literature map

| Model | Structure | Notable assumptions | Validated against | Evidence |
|---|---|---|---|---|
| Fasano & Talamucci 2000 (SIAM J Math Anal); Fasano, Talamucci & Petracco 2000 (book chapter) | 1D, multispecies; solid particles plus solutes removed from the matrix; porosity changes with removal; fines accumulate in a compact low-permeability layer near the outlet | removal rate depends on bound concentration and flux intensity; no matrix compression; Darcy fails at high gradients (illy experiments). Features taken from the authors' ECMI'98 abstract; the full papers were not read | mainly existence/uniqueness theory; qualitative illy data | B |
| Moroney et al. 2015 (CES), 2016 (SIAM J Appl Math; J Math Ind), 2019 (PLoS ONE) | double porosity: fast dissolution from broken surface cells plus slow kernel diffusion; volume-averaged bed; two grain sizes; 1D and CFD | constant porosity; fully wetted at t = 0; liquid diffusion neglected | drip-filter column (60 g, 59 mm, 250 mL min⁻¹, 90 °C) and well-mixed tests | B (+A data) |
| Cameron et al. 2020 (Matter) | homogenized multiscale model (battery analogy); fines + boulders as dense spheres; Fickian intragranular diffusion; nonlinear surface rate | homogeneous flow; isothermal; bed pre-filled at t = 0 | café espresso: EY vs grind, dose, pressure | B + A |
| Grudeva, Moroney & Foster 2025/26 (Eur J Appl Math) | Cameron-type model plus sharp wetting front; matched asymptotics give 4 regions and a reduced model | instantaneous grain wetting; constant viscosity; no swelling | full versus reduced numerics (time-resolved data promised) | B |
| Lee, Smith & Arshad 2023 (Phys Fluids) | two parallel pathways; Kozeny–Carman permeability evolving with dissolution | lumped in depth; single transfer term | Cameron EY–grind data | B |
| Ellero & Navarini 2019; Mo et al. 2021, 2022, 2023, 2024 | SPH/SDPD particle-resolved flow; fines advected and trapped at filter; swelling; mechanical erosion; μCT-based geometry; 1D swelling model | small domains (sub-mm to mm) | transient permeability (direct/inverse discharge), caffeine/trigonelline/CGA, μCT porosity | B (+A μCT) |
| Kuhn et al. 2017; Pannusch et al. 2024 | Kuhn: reduced packed-bed model with physically meaningful parameters for individual solutes. Pannusch: extends a "two-grain" model with flow-rate and temperature dependence of mass transfer, presented as a control chart and app | lumped parameters | time-resolved caffeine, trigonelline, CGA, TDS | B + A (abstracts read) |
| Vaca Guerra et al. 2023, 2024 | Moroney-type model plus measured axial dispersion; modified Kozeny–Carman; compound-specific | constant bed porosity | tracer RTD, TDS/caffeine/trigonelline/5-CQA for 3 PSDs | A + B |
| Giacomini 2020; Egidi 2022; Giacomini 2022/23; Angeloni 2023 (review) | advection–diffusion–reaction, multi-species, reduced percolation model (Crank–Nicolson + fixed-point) | — | HPLC compound data under varied conditions | B |
| Sano et al. 2019 | volume-averaged model with lumped analytical solutions for drip, espresso and immersion; one controlling dimensionless group | lumped | brewing experiments | B (abstract read) |
| Waszkiewicz et al. 2026 (Phys Fluids) | coarse-grained poroelastic Darcy model; dissolution-dependent stress-free porosity | quasi-static; Kozeny–Carman | flow vs pressure (1–12 bar), TDS fractions, μCT | A + B |

### 3.2 Generic multiscale formulation (common core)

**Flow.** In the wetted bed, flow is incompressible Darcy flow:

$$q=-\frac{\kappa}{\mu}\frac{\partial p}{\partial z},\qquad \frac{\partial q}{\partial z}=0\;\;\Rightarrow\;\; q(t)=\frac{\Delta P(t)}{\mu\displaystyle\int_0^L \frac{dz}{\kappa(z,t)}}\quad\text{(series resistances)}$$

**Bed liquid** (macroscale):

$$\varepsilon\frac{\partial c}{\partial t}+\frac{\partial}{\partial z}\Big(qc-\varepsilon D_{ax}\frac{\partial c}{\partial z}\Big)=\sum_{j\in\{f,b\}} b_j G_j,\qquad b_j=\frac{3\phi_j}{a_j}$$

Here $b_j$ is reactive surface area per bed volume, $\phi_j$ the bed volume fraction of class $j$ and $a_j$ its radius (Grudeva 2025, eq. 4). Boundary conditions: $c=0$ at the inlet, zero diffusive flux at the outlet.

**Particles** (microscale, one representative sphere per class at each $z$):

$$\frac{\partial c_j}{\partial t}=\frac{1}{r^2}\frac{\partial}{\partial r}\Big(r^2D_j\frac{\partial c_j}{\partial r}\Big),\qquad \partial_r c_j|_{r=0}=0,\qquad -D_j\,\partial_r c_j|_{r=a_j}=G_j$$

**Surface-flux closures in use:**
- Linear with partition coefficient: $G=k\,(K\,c_j|_a-c)$, where $K=c_\text{liq}/c_\text{solid}$ at equilibrium. Measured $K$ = 0.42, 0.57 and 0.61 at 20, 50 and 80 °C (Corrochano 2017).
- Saturating (Grudeva 2025): $G=k\,(\min(c_j|_a,c_\text{sat})-c)$.
- Cameron 2020: $G=k\,c_j|_a\,(c_j|_a-c)(c_\text{sat}-c)$, which vanishes at saturation, at equilibrium and when the grain is depleted.

**Output:**

$$\text{EY}(t)=\frac{A}{M_\text{dose}}\int_0^t q\,c(L,\tau)\,d\tau$$

**Assumptions to state in the simulator:** spherical grains (measured sphericity is about 0.75, Corrochano 2017); constant fluid properties (often violated, §4.10); a 1D bed (violated by channeling, §6); no particle motion (violated by fines migration and consolidation, §4.5–4.7).

### 3.3 Moroney et al. (2015, 2016, 2019): double porosity

A grain is a **surface layer of broken cells**, where solubles dissolve quickly, around a **kernel of intact cells**, which release solubles slowly through a tortuous pore network. The CES 2015 paper is paywalled and was not read; its structure is reproduced in the open J Math Ind 2016 paper, in PLoS ONE 2019, and explicitly in Vaca Guerra 2024. In Vaca Guerra's form:

$$\varepsilon\,\partial_t c_h=\partial_z(D_{ax}\partial_z c_h)-u\,\partial_z c_h+(1-\varepsilon)\,(\mathcal{A}+\mathcal{B})$$

- Kernel exchange: $\mathcal{A}=\alpha S_1(c_v-c_h)$, with $\alpha=\alpha^*\,(D_v/l)\,\varepsilon_p^{4/3}$, $S_1=6/d_{32,\text{coarse}}$ and $l$ = half the coarse $d_{43}$.
- Surface dissolution: $\mathcal{B}=\beta S_2(c_\text{sat}-c_h)\,\phi_{c0}\,\psi_s$, with $\beta=\beta^*\,2D_v/m$, $m\approx40$ µm (open-pore diameter), and $\psi_s$ the remaining surface-soluble fraction.
- Kernel pores: $\partial_t(\varepsilon_p c_v)=-\mathcal{A}$.

$\alpha^*$ and $\beta^*$ are fitted.

**Key results:**
- Two timescales, fitted in a well-mixed system (Moroney et al. 2016, J Math Ind): surface dissolution $t_s$ = 1.18 s (fine) and 19.4 s (coarse); kernel diffusion $t_d$ = 42.2 s (fine) and 270 s (coarse). Extractable mass was 32% (fine) and 28% (coarse), at 90 °C.
- Matched asymptotics give closed-form composite solutions in a few dimensionless groups, useful for fast fitting (Moroney et al. 2016, SIAM). The fast/slow split supports a **two-pool (bi-exponential) surrogate**.
- PLoS ONE 2019 parameters (coffee bed, 90 °C): true density 1400 kg m⁻³; intragranular porosity 0.56; soluble volume fraction 0.143 (fine) and 0.122 (coarse); initial pore concentration $c_{s0}$ = 358.6 and 305 kg m⁻³. Fitted lumped coefficients $h_{sl}$: 5.1×10⁻⁴ and 1.43×10⁻³ m s⁻¹ (fine grind, small and large grains); 1.66×10⁻⁴ and 2.90×10⁻⁴ m s⁻¹ (coarse). These are too large for physical film coefficients and should be treated as fitted constants.
- In a 60° truncated cone, outlet concentrations were similar to the cylinder but CFD showed strongly non-uniform local extraction. Even in the cylinder, local EY varied by about 5 points for the fine grind. **Lesson: matching the cup does not mean uniform extraction.**

### 3.4 Cameron et al. (2020)

Homogenized equations (their eqs. 18–22) on two particle families (fines < 100 µm, boulders > 100 µm) with the nonlinear rate above. Liquid dispersion was judged negligible ($D_\text{eff}c_\text{sat}/L \ll qc_\text{sat}$).

**Fitted values:** $D_s$ = 6.25×10⁻¹⁰ m² s⁻¹ and $k$ = 6×10⁻⁷ m⁷ kg⁻² s⁻¹.

**Inputs:**
- Volume fraction of grounds $f_s$ = 0.8272 (from Moroney's thesis), i.e. bed porosity about 0.17.
- $c_\text{sat}$ = 212.4 kg m⁻³ (as tabulated by Lee 2023 from Cameron's SI; the SI itself was not read).
- Darcy flux from measured shot times: $q = M_\text{out}/(\pi R_0^2\rho t_\text{shot})$. The model does not predict flow.

**Experiment:** San Remo Opera, EK43, 20 g in / 40 g out, 92 °C, 98 N automated tamp, n = 5 per point. 9 bar clogged at fine settings, so they used 6 bar. Tamp force had no appreciable effect on shot time or EY. At GS 2.5, 99% of particles by number are < 100 µm and carry 80% of the surface area.

**Result:** shot time is linear in grind setting. EY peaks near GS 1.7 (about 23%) and falls on both sides; the model predicts a monotonic increase for finer grinds unless part of the bed is made inaccessible ("partially clogged" regime).

### 3.5 Grudeva, Moroney & Foster (2025/26): infiltration plus asymptotics

**Wetting front:**

$$\frac{ds_w}{dt}=\frac{q}{\phi_T},\qquad \phi_T=\phi_l+\phi_b\varphi_{lb},\qquad t_w=\frac{\phi_T L}{q_\text{app}}$$

Boulders are porous ($\varphi_{lb}$ = 0.35–0.55); fines are not.

**Four moving regions:** dry; saturated liquid (no dissolution); a thin layer where fines dissolve fast (an intrinsic moving internal boundary layer); and a region of slow boulder extraction near the inlet. The reduced model is one ODE for the saturation front $s_d(t)$ plus an ODE along characteristics:
- reduced solve about **10 s** versus about **1000 s** for the full model (desktop, ε = 10⁻²);
- the full model becomes prohibitive below ε ≈ 3×10⁻³ because the moving internal layer needs a fine mesh everywhere.

The authors report unpublished experiments in which **first-drip concentration was recipe-independent**, which motivates a saturation ceiling.

**Parameter table** (their Table 1):

| Parameter | Value |
|---|---|
| $\phi_f$ | 0.10–0.25 |
| $\phi_l$ | 0.1–0.2 |
| $D_{sf} = D_{sb}$ | 1×10⁻⁹ m² s⁻¹ |
| $D_\text{eff}$ (liquid) | 1×10⁻⁸ m² s⁻¹ |
| $c_\text{init}$ | 310 kg m⁻³ |
| $c_\text{sat}$ | 224 kg m⁻³ |
| $a_b$ | 229 µm |
| $a_f$ | 3.65 µm |
| $k$ | 1×10⁻³ m s⁻¹ |
| $\mu$ | 3.15×10⁻⁴ Pa s |
| $L$ | 8.4 mm |
| $t_w$ | 5 s |

**Inconsistencies to note:**
- The tabulated overpressure "9.2×10⁻⁶ Pa" is a typo (presumably 9.2×10⁵ Pa).
- The listed $\kappa$ = 2.2×10⁻¹⁶ m² does not match $q\mu L/\Delta P$ ≈ 4.4×10⁻¹⁵ m² from the same table.
- $q_\text{app}$ = 1.52×10⁻³ m s⁻¹ equals the Moroney 2019 drip-column flux (derived), not a measured espresso flux.

### 3.6 Lee, Smith & Arshad (2023): two-pathway channeling model

Two equal halves with porosities $\varepsilon_{1,2}=\varepsilon_0\pm\delta$, total flow $Q$ imposed and split by permeability.

- Flow split: $Q_i=Q\,\kappa_i/(\kappa_1+\kappa_2)$, with dimensionless Kozeny–Carman $\kappa_i=\varepsilon_i^3/(1-\varepsilon_i)^2$. The paper prints $(1-\varepsilon^2)$, which looks like a typo.
- Dissolution opens porosity, assuming equal densities of soluble and insoluble matter: $\text{EY}=(\varepsilon-\varepsilon_0)/(1-\varepsilon_0)$.
- Solid and liquid balances:

$$\frac{d}{dt}\Big[\tfrac{(1-\varepsilon_i)AL\rho_c}{2}\Big]=-\frac{DS(c_\text{sat}-c_i)}{2\lambda}\theta(\text{EY}_\text{max}-\text{EY}_i)$$

$$\frac{d}{dt}\Big[\tfrac{\varepsilon_iALc_i}{2}\Big]=\frac{DS(c_\text{sat}-c_i)}{2\lambda}\theta(\cdot)-Q_ic_i$$

- Shot time and total grain surface fitted linearly to grind setting $g$: $t_\text{shot}=50.5-11.5g$ s and $S=0.543-0.112g$ m².
- Fitted: $\lambda/D=1.25\times10^5$ s m⁻¹, $\delta$ = 0.035, EY_max = 33.8%; with $\varepsilon_0$ = 0.173, $c_\text{sat}$ = 212.4 kg m⁻³.
- The fit **needed a doubled, "unphysical" $\rho_c$** (798 instead of 399 kg m⁻³).

**Findings:**
- The flow–dissolution instability exists at **all** grind sizes.
- The EY peak occurs when one pathway is fully exhausted: at the finest grind, one half reaches about 34% while the other stays near 11–12%, yet the cup reads about 21%.
- Code (wxMaxima, Octave) is in the arXiv ancillary files (arXiv:2206.12373).

### 3.7 Poroelastic flow model (Waszkiewicz et al. 2026)

Mechanical equilibrium $\partial_z(\sigma+p)=0$ (Terzaghi), Darcy flow with $k=k(\phi(\sigma))$, strain $e=(\Phi-\phi)/(1-\phi)$, and Hookean stress $\sigma=Ye$:

$$k(\sigma)=\frac{d_p^2}{\kappa}\,\frac{(\Phi-\sigma/Y)^3}{(\Phi-1)^2(1-\sigma/Y)},\qquad Q=\frac{A}{\mu h_0}\int_0^{P}k(\sigma')\,d\sigma'$$

Pores close when $\sigma>\Phi Y$, at the outlet first, because matrix stress is largest there. To leading order the normalized long-time curve is independent of $\Phi$. Their eq. 16, $\hat Q\approx\hat P(4-6\hat P+4\hat P^2-\hat P^3)$, simplifies algebraically to

$$\frac{Q}{Q_c}=1-\Big(1-\frac{P}{P_c}\Big)^4,\qquad P\le P_c,$$

with fitted $Q_c$ = 1.90 ± 0.15 g s⁻¹ and $P_c$ = 12 ± 3 bar (18.5 g, 58 mm basket).

For transients they set $\Phi(t)=m_d(t)/m_0$ (dissolved mass fraction) and scale flow with $F(\Phi(t))$. This reproduces the time-dependent flow at higher pressures and fails in the low-pressure Darcy regime.

---

## 4. Flow through the puck

### 4.1 Darcy and Forchheimer

Darcy holds approximately ($Re_p \lesssim 1$; Corrochano 2017 reports $Re_p$ = 0.04–4 with linear Q–ΔP up to 4.5 bar). Forchheimer form:

$$-\nabla p=\frac{\mu}{\kappa}q+\frac{\rho}{\kappa_1}|q|q$$

μCT-based SPH gives a Darcy permeability that falls with pressure gradient from about 5.2×10⁻¹³ to 2.5×10⁻¹³ m² over 50–400 bar m⁻¹ (Mo et al. 2023). This pressure dependence is a candidate explanation for scatter in literature permeabilities, alongside compaction (§4.5).

A community rule of thumb is that puck resistance ≈ $\sqrt{\Delta P}/Q$ describes spent pucks better than $\Delta P/Q$ (Gagné 2025, citing Champion 2020; D). It is consistent with either inertia or compaction.

### 4.2 Kozeny–Carman and polydisperse beds

$$\kappa=\frac{\varepsilon^3}{K_K S_0^2(1-\varepsilon)^2},\qquad S_0=\sum_i x_i\frac{6}{\psi_i d_i},$$

with $K_K\approx5$ (equivalently $\kappa=\varepsilon^3(\psi d_{32})^2/[180(1-\varepsilon)^2]$; Ergun uses 150). $x_i$ are solid volume fractions. The Sauter mean $d_{32}$ is the correct average because fines dominate surface area: 20 vol% of 30 µm fines plus 80% of 300 µm boulders gives $d_{32}$ = 107 µm, with 71% of the surface on the fines (derived).

**Corrections in the literature:**
- Porosity-dependent tortuosity $\tau=\varepsilon^{-n}$:
  - Corrochano 2017 ("Model 2", n = 0.5) gave the best fit;
  - Mo 2023 measured τ = 1.80 at ε = 0.17, i.e. n ≈ 0.33.
- A modified Kozeny–Carman using the mean size α and uniformity β of the coarse mode, plus a model for porosity under compression (Vaca Guerra et al. 2023). Abstract read; coefficients not obtained.
- **Measurement sensitivity.** Dry versus wet laser diffraction changes $d_{32}$ by 3–4× (e.g. 79.7 vs 22.3 µm for the same grind) because the wet method detects 1–10 µm fragments (Corrochano 2017). With ε = 0.15–0.25, Kozeny–Carman gives about 10⁻¹³–10⁻¹² m² from dry $d_{32}$ (80–131 µm) and about 10⁻¹⁴–10⁻¹³ m² from wet $d_{32}$ (22–38 µm) (derived).

### 4.3 Measured and effective permeabilities

| Source | Value (m²) | Conditions | Evidence |
|---|---|---|---|
| Corrochano et al. 2015; Corrochano 2017, Table 6.1 | 2.6×10⁻¹⁴ – 4.4×10⁻¹³ | **fully extracted** beds after 600 s flow; 0.5–4.5 bar; bed density 360–480 kg m⁻³; 4 espresso-range grinds; ~30% density increase cut κ 3–4× | A |
| Mo et al. 2023 (μCT + SPH) | 2.6×10⁻¹³ – 3.5×10⁻¹² (sub-volumes); ~5.5×10⁻¹³ typical | capsule powders, unextracted geometry; porosity threshold set to 0.17 by assumption | B |
| Moka-pot literature (via Corrochano 2017) | 0.7–4×10⁻¹³ (Navarini 2009, time-dependent); 8.98×10⁻¹³ (King 2008); 2.3×10⁻¹² (Gianino 2007, considered unreliable by Corrochano) | stove-top brewers | A (secondary) |
| **In-shot effective (derived)**, $\kappa=q\mu L/\Delta P$ | **1.8–3.5×10⁻¹⁵** | Waszkiewicz: 9 bar, 1.0–1.9 g s⁻¹, L = 14 mm, μ = 0.31 mPa s | derived |
| | 2.2–3.7×10⁻¹⁵ | Cameron: 6 bar, 40 g in ~30 s, L assumed 8.4–14 mm | derived |
| | 6.8×10⁻¹⁵ / 1.5×10⁻¹⁴ | Schmieder: 3 mL s⁻¹ at 8.0 bar (GL 1.4) / 3.6 bar (GL 2.0), L ≈ 15 mm; pressure measured upstream of the portafilter | derived |

**Implication.** Espresso operates at about 10⁻¹⁵ m², roughly 2–200× below steady-state permeameter values and ~10–1000× below dry-PSD Kozeny–Carman. Waszkiewicz et al. estimate the same 10³ gap and note that 200 µm glass beads give "virtually no resistance". In-shot permeability therefore **must be calibrated**, not predicted from PSD.

### 4.4 Porosity and density

| Quantity | Values | Notes |
|---|---|---|
| Solid (skeletal) density | 1337–1348 kg m⁻³ (He pycnometry, fine grinds); 1400 kg m⁻³ (Moroney 2019) | A / B |
| Intraparticle porosity $\varepsilon_p$ | 0.50–0.65 overall, 0.50–0.57 for espresso grinds (Hg + He); 0.56 (Moroney 2019); 0.47 (Hg, Vaca Guerra 2024); 0.35–0.55 (Schenker 2000, via Grudeva) | A |
| Puck bulk density | 360–480 kg m⁻³ (permeameter range); **≈500 kg m⁻³** for 18.5 g in a 58 mm basket filled to 14 mm (derived from Waszkiewicz) | A / derived |
| Total porosity (inter + intra) | 1 − ρ_bed/ρ_s ≈ 0.63–0.64 at 500 kg m⁻³ | derived; **well constrained** |
| Intergranular porosity $\varepsilon$ | 0.17 (Cameron via Moroney thesis); 0.10–0.20 (Grudeva); 0.21–0.26 dry initial (Vaca Guerra 2024); 0.10–0.29 at 480 kg m⁻³ for assumed ε_p = 0.60–0.50 (Corrochano 2017) | split from intraparticle porosity is **poorly constrained** |

**Check bed height before reusing model geometries.** Grudeva's $L$ = 8.4 mm is listed as measured, but the dose and basket are not given. In a 58 mm basket with a 20 g dose it would imply ~900 kg m⁻³, about twice measured bulk densities (derived). Cameron derives $L$ from $f_s$ = 0.8272 and a grounds density (eq. 25; the density value is in the unread SI). If that density is close to the solid density, i.e. grains treated as dense, the computed $L$ would be roughly half the real puck height. Cameron's N₂ sorption found no microporosity, but Hg porosimetry shows 10–20 nm pores and ε_p ≈ 0.5 (Corrochano).

### 4.5 Consolidation and poroelastic compaction

- **Measured consolidation:** wet beds shortened by 0–31% under flow, mostly within 20–30 s; finer and looser beds consolidated more (Corrochano 2017; 80 °C, 2:1 diameter:length).
- **Non-monotonic flow with pressure:** average flow rose from 3 to 5 bar and **fell at 7 bar** (same source), attributed to consolidation; Petracco (2005) reported similar behaviour.
- **Poroelastic regulation:** Darcy-like below about 5 bar and saturating above (Waszkiewicz 2026, 60 shots at 11 pressures). The effective wet-puck Young's modulus is unmeasured; their whole-bean reference is about 40 MPa.
- **Model option:** quasi-static poroelastic (Hewitt et al. 2016 constitutive form, §3.7); compaction-time ODE for transients.

### 4.6 Swelling on wetting (sources disagree)

| Source | Result | Method |
|---|---|---|
| Hargarten, Kuhn & Briesen 2020 | ~15% diameter increase, independent of size and roast; 60–80% of it in 30 s, complete in 4 min; erosion creates fines, more so at higher T | laser diffraction, microscopy (A) |
| Mateus et al. 2007 | particle volume +20–23% at 10–15 min (1 g water per g coffee); moisture D ≈ (2–3)×10⁻¹¹ m² s⁻¹; ~0.15 g g⁻¹ non-freezable water | sizing, pycnometry, SEM, DSC (A) |
| Spiro et al. 1989 (via Corrochano) | diameter +17% (≈ +60% volume) | microscopy |
| Maille et al. 2021 | **no significant swelling** over 0.5–5 min | laser diffraction (entrainment-corrected), microscopy (A) |
| Corrochano 2017 | $d_{43}$ unchanged or +4% (≈ +12% volume); water-balance estimates S = 0.98–1.3 | A |
| Mo et al. 2022, 2024 (models) | small swelling (~3.6% size) barely matters at fixed flow but raises strength at fixed pressure drop | B |
| Waszkiewicz 2026 | μCT of the puck shows "considerable swelling" | A (qualitative) |

**Recommendation:** treat swelling as a calibration parameter acting mainly on intergranular porosity: 0–15% in diameter, relaxation time ≈ 20–30 s. Hargarten's 60–80% within 30 s implies τ ≈ 19–33 s for an exponential relaxation [derived]. *(Corrected 2026-10-14; this previously said 10–30 s, which is inconsistent with that data.)*

### 4.7 Fines migration, clogging, erosion

- **Fasano–Talamucci:** fines detach and accumulate in a compact, low-permeability layer at the outlet; the illy experiments violated Darcy.
- **Ellero & Navarini 2019 (SPH):** fines trapped in the filter reproduce the transient permeability seen in direct/inverse discharge experiments. A fines solid fraction θ = 0.006 cut permeability by nearly an order of magnitude; reversing the flow releases the fines.
- **Erosion:** with partly dry, brittle grains, erosion makes porosity heterogeneous axially and transversely (Mo et al. 2021, SDPD). Post-shot μCT always shows higher porosity at the bottom (outlet), consistent with pressure-dependent erosion (Mo et al. 2023).
- **Model option:** a time-growing outlet resistance layer, plus an erosion term increasing ε where the local wall shear proxy $q^2/\kappa$ is high.

### 4.8 Wetting front, preinfusion, two-phase flow, dispersion

- **Infiltration:** time-resolved μCT shows a sharp wet/dry front at uniform depth for finer grinds, reproduced by a 1D unsaturated flow model coupled to pump dynamics (Foster et al. 2025; abstract and conference abstract read).
- **Preinfusion and wetting** take 5–10 s (Grudeva; Waszkiewicz). A significant share of extraction happens during infiltration while grains are soluble-rich (Grudeva).
- **Headspace:** uneven prewetting from shower-screen jets coalescing (below about 5 mL s⁻¹ fill rate) pre-forms preferential paths. Reducing headspace on a DE1 raised mean EY by **3.4 points** (95% CI 3.0–3.8, 10 shots, dark roast, 1:1) (Gagné 2025, data from Buckman 2023; D).
- **Two-phase flow:** a relative permeability $\kappa_r(S_w)$ is needed while air or CO₂ occupies pores (Corrochano 2017).
- **Dispersion:** KCl tracer RTDs (22 °C) gave **Bo = vL/D_ax ≈ 8.7–10.4** after 30 g, **16.8** in the dry initial state and **7.7** after 60 g, with residence times about 5× plug flow (Vaca Guerra 2024). This contradicts the "negligible dispersion" assumption of Cameron and Grudeva. **Treat $D_{ax}$ as uncertain**: from molecular (~10⁻⁹ m² s⁻¹) up to about 10⁻⁶–10⁻⁵ m² s⁻¹ (derived from Bo ≈ 8–17 with interstitial v = 2–6 mm s⁻¹ and L ≈ 14 mm, e.g. ≈5×10⁻⁶ m² s⁻¹ at v = 3.6 mm s⁻¹, Bo = 10).

### 4.9 CO₂

- **Content:**
  - whole-bean total degassing $M_\infty$ = 3.4–12.7 mg g⁻¹, rising with roast degree and speed (Smrke et al. 2018);
  - residual CO₂ after fine grinding 4.5–8.5 mg g⁻¹ (as cited by Smrke 2018), or 4.5–12 mg g⁻¹ (as cited by Corrochano from Anderson 2003 and Wang & Lim 2014);
  - characteristic degassing time of ground coffee about 10 h at 20 °C (Corrochano, citing Anderson 2003).
- **Volume in the bed:** if all the CO₂ (4.5–12 mg g⁻¹) were released as gas at 5.4 atm and 80 °C, it would occupy **0.5–3× the bed pore volume** (Corrochano 2017, Table 6.2, 7.2–9.5 g lab beds). For 18 g at 10 atm and 90 °C, it would be about 15 mL versus about 7 mL of intergranular pore space (derived). Under pressure CO₂ partly dissolves and may supersaturate (Ellero & Navarini 2019, introduction).
- **No direct measurement of its hydraulic effect in espresso was found.**

### 4.10 Extract viscosity and density

- **Water viscosity:** 0.354, 0.315 and 0.298 mPa s at 80, 90 and 95 °C [CRC standard values]. Near 90 °C, viscosity changes about −1.1% per °C (derived). Over 90–96 °C the change is about 5% (Waszkiewicz).
- **Coffee solutions at 4 °C (Moreno et al. 2015):** 1.99, 5.84, 32.9 and 426 mPa s at 5, 20, 35 and 50% w/w. Arrhenius activation energies are 22.0, 25.9, 34.1 and 51.3 kJ mol⁻¹, so the relative viscosity shrinks as temperature rises.
- **Density** (same source, 0–25 °C): 1036–1277 kg m⁻³ for 10–50% w/w. Their mixing rule is not valid at brew temperature.
- **Not read:** Sobolík et al. 2002 (0–80 °C correlation) and Telis-Romero et al. 2001 (274–365 K, 49–90% water) are the relevant high-temperature sources. **Relative viscosity at 90 °C and 5–25% TDS is a data gap.**
- **Concentration conversion:** 25% TDS ≈ 270–280 kg m⁻³ (derived, density 1.08–1.12).

### 4.11 Why flow rises during a constant-pressure shot

| Mechanism | Sign on flow | Magnitude / timescale | Evidence |
|---|---|---|---|
| Wetting front reaches the outlet; headspace pressurizes | ↑ (from zero) | 5–10 s | A/B (Foster 2025, Waszkiewicz 2026) |
| Dissolution opens porosity | ↑ | Kozeny–Carman factor ×4 at EY 10%, ×12 at 20% if all removed mass became intergranular pore space (upper bound, derived with Lee's relation); the 10–20 s rise is similar across pressures | B (Lee 2023, Waszkiewicz 2026) |
| Pore-liquid viscosity falls as concentration drops from ~25% to <2% TDS | ↑ | plausibly 1.5–3× locally [magnitude unverified at 90 °C] | inferred (Moreno 2015) |
| CO₂ and air displacement (κ_r → 1) | ↑ | early seconds, larger for fresh coffee | inferred (Corrochano 2017) |
| Erosion and channel growth | ↑ (and heterogeneity) | progressive | B (Mo 2021; Lee 2023) |
| Puck warming from ambient (lower μ) | ↑ | first seconds | inferred; pods reach a plateau temperature after a start phase (Albanese 2009) |
| Swelling | ↓ | 30 s – 4 min | A, conflicting (§4.6) |
| Consolidation/compaction | ↓ | 20–30 s; stronger at higher ΔP | A (Corrochano), A/B (Waszkiewicz) |
| Fines migration to the outlet | ↓ (transient) | seconds to tens of seconds | B (Ellero 2019) |

Long-time flow then plateaus or dips slightly (Waszkiewicz). Pausing and restarting a shot raises flow without extra dissolution. The authors attribute this to puck delamination caused by backflow through the three-way valve; μCT shows horizontal delaminations.

---

## 5. Intra-particle mass transfer

### 5.1 Microstructure

- **Cells:** cell pockets 25–40 µm (Schenker 2000, via Corrochano) or 30–60 µm (Mo 2023); cell lumina radius about 20 µm with walls about 10 µm thick (Grudeva).
- **Pores:** mercury porosimetry shows ~40 µm micropores plus 10–20 nm nanopores (wall pores); particle tortuosity is 3–7 (Corrochano 2017).
- **Fines:** fines are cell fragments, with a mode at 25–50 µm (Mo 2023) and a separate population of 1–10 µm fragments (Corrochano). Their size barely changes with grind setting; their share does (Cameron).

### 5.2 Broken-cell washout versus intact-cell diffusion

- **Fines:** fines (< 100 µm, about 1–3 cells) are almost all broken cells and empty within seconds.
- **Boulders:** boulders have a broken shell about ½–1 cell thick. For d = 300 µm and 30 µm cells, that is 27–49% of their volume; for 600 µm, 14–27% (geometric estimate, this note).
- **Fitted surface pools:** Vaca Guerra 2024 assumed 29% of TDS and caffeine to be surface-available for their finest PSD. Moroney's fits give $t_s$ ≈ 1–19 s and $t_d$ ≈ 42–270 s (§3.3).
- **Implication:** model each class with a **surface pool** (dissolution-limited, capped by $c_\text{sat}$) plus a **kernel** (diffusion-limited).

### 5.3 Effective diffusivities

| Species / class | $D$ (m² s⁻¹) | Conditions | Source |
|---|---|---|---|
| Caffeine in water | 2.2×10⁻⁹ (80 °C); 1.89×10⁻⁹ (80 °C); ~2×10⁻⁹ | — | Jaganyi 1999 (citing Price et al.); Corrochano 2017 (citing Poling); Ellero 2019 |
| Caffeine in coffee particles | 1.90×10⁻¹⁰ (HF 12) | 80 °C, 1.7–2.0 mm particles, k_obs = 2.67×10⁻³ s⁻¹ with $k=12D/r^2$ | Jaganyi et al. 1999 (A) |
| | 1.58–2.05×10⁻¹⁰ (HF 11–14) | 80 °C, five origins | Jaganyi & Madlala 2000, via Corrochano |
| | HF 11.1 (80 °C), 29.7 (25.5 °C) | — | Spiro & Chong 1997, via Corrochano |
| Minerals in particles, 80 °C | K⁺ 3.15×10⁻¹⁰ (HF 16); Mg²⁺ 7.0×10⁻¹¹ (29); H₂PO₄⁻ 1.09×10⁻¹⁰ (24); Mn²⁺ 4.4×10⁻¹¹ (48) | — | Jaganyi et al. 1999 (A) |
| Lumped solubles (fits) | 0.8–1.1×10⁻¹⁰ (70–85 °C, Fourier-series fit; the thesis prints this once as ×10⁻¹¹) | — | Voilley & Simatos 1979, via Corrochano |
| | 6.0×10⁻¹³ – 4.2×10⁻¹² (90 °C, late-time steady-state fit) | — | Zanoni et al. 1992, via Corrochano |
| | 1.9×10⁻¹¹ (fine grind) to 1.6×10⁻¹⁰ on a $d_{43}$ basis (up to 2.1×10⁻¹⁰ on a coarse-peak basis); 1.26×10⁻¹⁰ pooled | 80 °C, stirred | Corrochano 2017 (A) |
| By MW class, microstructure-based, 80 °C | low (caffeine-like) 1.9–3.7×10⁻¹⁰; medium 5.3–10.6×10⁻¹¹; high 1.8–3.7×10⁻¹¹; very high (22–24 kDa) 0.6–1.6×10⁻¹² | — | Corrochano 2017 (B) |
| Model-fitted for espresso | $D_s$ 6.25×10⁻¹⁰ (Cameron); 1×10⁻⁹ (Grudeva); release $D_r$ 2×10⁻¹⁰ (Ellero) | — | B |

**Spread and the fitting-method effect.** The apparent diffusivity depends on which part of the curve is weighted: early points are dominated by small fast molecules, late points by large slow ones. Corrochano needed **four diffusivity classes** to fit whole curves (mean percentage error 5–8%) versus 6–17% with a single coefficient. Espresso-model fits (6×10⁻¹⁰ to 10⁻⁹) sit **above** immersion-measured intraparticle values (10⁻¹¹–10⁻¹⁰). They probably absorb surface washout and heterogeneity, so they are not physical diffusivities.

### 5.4 Molecular size and temperature

- **Stokes–Einstein:** $D=k_BT/(6\pi\mu r_h)$, so $D_\text{eff}=D_\text{aq}/HF$ with $HF\approx\tau_p/\varepsilon_p$ (microstructural hindrance 7.6–13.6; Corrochano). Bulk D at 80 °C runs from 1.89×10⁻⁹ m² s⁻¹ (caffeine, 194 g mol⁻¹) through 5.4×10⁻¹⁰ and 1.9×10⁻¹⁰ m² s⁻¹ (galactomannan DP 20 and 45) to 7.7–8.5×10⁻¹² m² s⁻¹ for a "very high MW" fraction sized by DLS (Corrochano). That fraction is reported as 22–24 kDa, but a diffusivity this low implies a hydrodynamic radius of order 100 nm, i.e. aggregates (derived).
- **Temperature (Stokes–Einstein scaling with $T/\mu$, derived):** factor 1.24 from 80 to 95 °C, 1.69 from 50 to 80 °C, 3.4 from 20 to 80 °C.
- **Measured temperature ratios** for the lumped coefficient (Corrochano Table 5.6):
  - 80 vs 50 °C: ×1.3, against ×1.7 predicted (higher T also extracts slower species);
  - 80 vs 20 °C: ×9.3, against ×3.5 predicted (complexation and dissolution limits at low T; compare Spiro's HF 29.7 at 25.5 °C).
- **Arrhenius forms** $D=D_0e^{-E_a/RT}$ can be fitted. Over 80–96 °C the Stokes–Einstein factor of about 1.5% per °C is an adequate default.

### 5.5 Solubility, saturation, partition and maximum yield

| Quantity | Value | Source |
|---|---|---|
| Saturation (lumped solubles) | 212.4 kg m⁻³ (Cameron, via Lee 2023); 224 kg m⁻³ (Grudeva); first drops about 25% TDS ≈ 275 kg m⁻³ (Waszkiewicz; tanh amplitude 25.6 ± 1.3%); fitted $c_0$ = 0.23–0.31 g g⁻¹ (Schmieder) | A/B |
| Fitted "saturation" by species | TDS 513 kg m⁻³ (bounded below by the pore concentration, so not a solubility); caffeine 54.5; trigonelline 74.9; 5-CQA 65.9 kg m⁻³ | Vaca Guerra 2024 (B) |
| Partition $K=c_\text{liq}/c_\text{solid}$ | 0.42 (20 °C), 0.57 (50 °C), 0.61 (80 °C), lumped solubles, assuming swelling factor 1; caffeine about 1 (Spiro, via Corrochano) | Corrochano 2017 (A) |
| Immersion "equilibrium constant" (different definition: E = K·E_max) | 0.717 ± 0.007, insensitive to 80–99 °C, grind and roast; E = 20.7 ± 1.1% | Liang et al. 2021 (A) |
| Maximum extractable yield | 32% (fine) and 28% (coarse) (Moroney); 30% (A), 28% (B) and 22% (H, coarse) at equilibrium (Corrochano); 30% assumed (Liang); 30.3% (Smith & Lee 2021); 33.8% fit (Lee 2023) | A/B |
| Liquid retained by grounds | 2.48 ± 0.19 mL g⁻¹ (immersion, after filtration) | Liang 2021 |

### 5.6 Compound-level kinetics (espresso)

- **Ordering:** concentration in successive fractions decays roughly exponentially with cumulative beverage mass, $c(m)=c_0e^{-m/\lambda}$. Decay is fastest for **trigonelline and TDS** (λ ≈ 13–18 g), then 5-CQA (λ ≈ 17–22 g), and slowest for caffeine (λ ≈ 19–24 g), correlating with polarity (Schmieder 2023, 15 conditions, Table A1).
- **Controls:** flow rate had the strongest effect on cup composition. Temperature had none measurable at 80–98 °C under flow control.
- **Particle size:** finer grinds give more caffeine and trigonelline per collected mass; tamping had no detectable effect (Kuhn 2017, abstract read).
- **Ratios shift with progress:** the trigonelline/caffeine ratio shifts with extracted mass, so the **cup composition depends on the trajectory, not only on EY** (Kuhn 2017). Two 22% EY shots at different grind settings cannot have the same composition (Cameron 2020).

---

## 6. Channeling and heterogeneity

**Mechanisms:**
1. Dissolution–permeability positive feedback (Lee 2023; analogous to the reaction-infiltration instability).
2. Initial density heterogeneity from distribution and tamping.
3. Fines aggregates and clogging (Cameron).
4. Erosion (Mo 2021; Mahadevan et al. 2012).
5. Uneven prewetting from shower screen and headspace.
6. Edge and basket effects: outlet-hole pattern and cone geometry (Moroney 2019).
7. End-of-shot delamination (Waszkiewicz).

**Quantitative evidence:**

| Observation | Numbers | Evidence |
|---|---|---|
| Non-monotonic EY vs grind | EK43, 6 bar, 20/40 g: ~21.3% (GS 1.1), peak ~23% (GS 1.7), ~20.6% (GS 2.3), values read from Lee 2023 Fig. 5. Model-vs-data gap if dead zones are assumed: 13.1%, 6.1%, 2.6% at GS 1.1, 1.3, 1.5 | A (Cameron 2020) |
| Two-pathway model | one pathway at about 34% versus about 11% while the cup reads about 21% | B (Lee 2023) |
| Radial EY (cored pucks) | centre 25%, middle 23%, edge 13% (mean 21%); paper filter below: 25/24/22% (mean 24%); convex tamper: edge 7% (mean 20%) | D (Ribes 2020, DE1, VST 15 g, EK43) |
| Puck screen | edge 16–17% → 22–23%; mean +2 (VST) / +3 points (Pullman) | D (Ribes 2021) |
| μCT before/after | porosity higher at the outlet after extraction; delamination and lift-off; sharp infiltration front | A (Mo 2023; Waszkiewicz 2026; Foster 2025) |
| RTD | Bo ≈ 8–17 (about 9–10 after 30 g), dispersion growing with extraction | A (Vaca Guerra 2024) |

Classical packed-bed wall channeling would *over*-extract edges. The community data show *under*-extracted edges. My inference is that this comes from flow focusing by the basket and outlet-hole pattern, not wall porosity; it is not yet tested.

**Puck preparation and hardware: evidence ratings**

| Variable | Finding | Rating |
|---|---|---|
| Tamping force | no appreciable effect on shot time or EY (Cameron, 98 N standard); no detectable effect on caffeine/trigonelline kinetics (Kuhn 2017) | **Moderate** (2 peer-reviewed studies, limited ranges) |
| Bed density (dose per volume) | +30% density cuts κ 3–4× (Corrochano) | Moderate–high (permeameter) |
| Dose / brew ratio | lower dose at the same output raises EY; recommended 15 g coarse vs 20 g (Cameron); brew ratio is the first lever (Schmieder) | Moderate–high |
| Distribution / WDT | used as standard to ensure reproducibility (Waszkiewicz); no controlled peer-reviewed comparison found | **Low** (D) |
| Basket geometry / outlet pattern | cone CFD shows non-uniform extraction (Moroney 2019); baskets and perforated-disk height change compound yields (Khamitova 2020); radial EY data | Moderate (model) / low (D) |
| Paper filter below the puck | +3 points mean EY, flatter radial profile | **Low** (D, single operator) |
| Puck screen (contact screen) | +2–3 points mean EY | **Low** (D) |
| Headspace reduction | +3.4 points EY (95% CI 3.0–3.8, n = 10) | Low–moderate (D, quantified) |
| Shower-screen dispersion | jets coalesce below ~5 mL s⁻¹; uneven prewetting | Low (C/D, mechanistic) |
| Preinfusion | significant extraction during infiltration (model); peer-reviewed controlled espresso data not found | Low |
| Flow vs pressure control | swelling raises strength under fixed ΔP but not fixed flow (Mo 2024, model); flow control recommended | Low–moderate (B) |
| Pressure level | 7/9/11 atm classified by sensory and odorants, 9 atm best foam (Andueza 2002); 9 bar clogs fine grinds (Cameron) | Moderate |

---

## 7. Thermal aspects

**Brew temperature effects:**
- Machines run at 88–96 °C (SCA 92–95 °C).
- **Under flow control:** set points of 80, 89 and 98 °C (measured above the puck as 79.1, 88.2 and 96.5 °C) gave **no measurable change** in trigonelline, caffeine, 5-CQA or TDS mass in the cup (Schmieder 2023).
- **Ambiguous or compound-specific:**
  - effects at 88/92/96/98 °C were ambiguous (Andueza 2003, as summarized by Schmieder);
  - 88→93 °C versus 93→88 °C gradients shift specific compounds and sensory attributes (Salamanca 2017);
  - pods at 90/100/110 °C gave physicochemical parameters rising with temperature (Albanese 2009).
- **Mechanisms:** viscosity (−1.1% per °C), diffusivity (about +1.5% per °C, Stokes–Einstein), partition (K 0.57→0.61 from 50→80 °C) and compound-specific chemistry. Most published espresso models are isothermal (Cameron justified this by active temperature control and the high heat capacity of water).

**Heat losses and profile:**
- In pods, the extraction temperature reached a plateau after a start-up phase, so the process was approximately isothermal (Albanese 2009).
- No peer-reviewed in-puck temperature field for espresso was found. Community thermocouple reports of a 4–9 °C drop across the puck and spout readings about 5 °C below the puck top are anecdotal [unverified].
- The group, portafilter and basket thermal masses, and the room-temperature grounds, cool the first few grams of water.

**Model:**

$$(\rho c)_\text{eff}\partial_tT+\rho_wc_wq\,\partial_zT=\partial_z(k_\text{eff}\partial_zT)-h_wa_w(T-T_w)$$

The thermal Péclet number $\rho_wc_wqL/k_\text{eff}$ is about 10² (with an assumed $k_\text{eff}$ ≈ 0.3–0.5 W m⁻¹ K⁻¹ [unverified]), so the equation is advection-dominated. Lump the basket and portafilter into one node with a calibrated $h_w$. Coffee heat capacity: green-bean estimates of ~1.0–1.9 kJ kg⁻¹ K⁻¹ appear in secondary sources [unverified]; no roasted-ground value was verified.

---

## 8. Parameter table

| Symbol | Parameter | Typical value / range | Units | Conditions | Source (evidence) |
|---|---|---|---|---|---|
| $M$ | dose | 7–9 (single), 14–18 (double), 15–22 (café) | g | — | SCA via Cameron 2020; Grudeva 2025 |
| $M_\text{out}$ | beverage mass | 20–60; brew ratio 1:1–1:3 | g | — | Cameron; Schmieder |
| $\Delta P$ | pump/basket pressure | 9 ± 2 (common); 6 (Cameron); 1–12 studied | bar | — | Ellero 2019; Cameron; Waszkiewicz |
| $T$ | brew water temperature | 88–96 (SCA 92–95) | °C | — | Cameron; Schmieder |
| $t$ | shot time | 20–30 (SCA); 14–40 observed | s | — | Cameron; Smrke 2024 |
| $Q$ | flow rate | 1–3 (Schmieder); 2.5–4 (Vaca Guerra); fitted long-time 1.7–1.9 g s⁻¹ at 5–12 bar (Waszkiewicz) | mL s⁻¹ | 58 mm baskets | A |
| TDS | cup strength | 8–12 typical; 9.68 mean (20 g / 40 g); first drops ~25 | % w/w | — | Schmieder; Waszkiewicz |
| EY | extraction yield | 17–23 "tasty" band; 20–23 measured | % | — | Cameron |
| $A$, $L$ | basket area, puck height | 2.64×10⁻³; 14 mm for 18.5 g | m², mm | IMS 58 mm | Waszkiewicz |
| $\rho_\text{bed}$ | puck bulk density | 360–480; ≈500 | kg m⁻³ | dry, tamped | Corrochano; derived |
| $\rho_s$ | solid density | 1337–1400 | kg m⁻³ | He pycnometry | Corrochano; Moroney 2019 |
| $\varepsilon$ | intergranular porosity | 0.10–0.29 (0.17 common) | — | split uncertain | §4.4 |
| $\varepsilon_p$ | intraparticle porosity | 0.47–0.65 | — | Hg/He | Corrochano; Vaca Guerra; Moroney |
| $\psi$ | sphericity | ~0.75 (0.75–0.85) | — | — | Corrochano; Moroney 2019 |
| $\tau$ | bed tortuosity; particle tortuosity | 1.56–1.91; 3–7 | — | μCT-SPH; Hg | Mo 2023; Corrochano |
| $a_f$, $a_b$ | fines and boulder radius | 3.65–25; 50–460 (espresso grinds mostly 100–250) | µm | — | Grudeva; Moroney 2019; Corrochano; Waszkiewicz |
| $\phi_f$ | fines volume share | 10–36 (dry); 30–49 (wet) | % < 100 µm | — | Corrochano; Mo 2023 |
| $d_{32}$ | Sauter diameter | 80–131 (dry) vs 22–38 (wet), espresso grinds | µm | laser diffraction | Corrochano |
| $\kappa$ | permeability, steady/extracted | 2.6×10⁻¹⁴ – 4.4×10⁻¹³ | m² | 0.5–4.5 bar | Corrochano 2015 (A) |
| $\kappa_\text{eff}$ | in-shot effective permeability | (2–15)×10⁻¹⁵ | m² | 3.6–9 bar | derived §4.3 |
| $P_c$, $Q_c$ | poroelastic calibration | 12 ± 3; 1.90 ± 0.15 | bar; g s⁻¹ | 18.5 g, light/medium-light roast | Waszkiewicz (B) |
| — | consolidation | 0–31% of bed height, mostly in 20–30 s | — | 80 °C | Corrochano |
| $S$ | swelling | 0–15% diameter (disputed) | — | — | §4.6 |
| $\mu_w$ | water viscosity | 0.354 / 0.315 / 0.298 | mPa s | 80 / 90 / 95 °C | CRC |
| $\mu(c)$ | extract viscosity | 5.8 mPa s at 20% w/w, 4 °C; $E_a$ 22–51 kJ mol⁻¹ | — | — | Moreno 2015 (low T only) |
| $\rho_\text{ext}$ | extract density | 1036–1277 | kg m⁻³ | 10–50% w/w, 0–25 °C | Moreno 2015 |
| CO₂ | gas content | whole bean 3.4–12.7; ground residual 4.5–12 | mg g⁻¹ | roast-dependent | Smrke 2018; Corrochano |
| $D_\text{aq}$ | caffeine in water | 1.9–2.2×10⁻⁹ | m² s⁻¹ | 80 °C | Jaganyi 1999; Corrochano |
| $D_\text{eff}$ | caffeine in particle | 1.6–2.1×10⁻¹⁰ (HF 11–14) | m² s⁻¹ | 80 °C | Jaganyi 1999/2000 |
| $D_\text{eff}$ | lumped solubles | 10⁻¹²–10⁻¹⁰ (by MW class) | m² s⁻¹ | 80 °C | Corrochano |
| $D_s$ | fitted espresso diffusivity | 6.25×10⁻¹⁰ – 1×10⁻⁹ | m² s⁻¹ | 92 °C | Cameron; Grudeva |
| $D_{ax}$ | axial dispersion | 10⁻⁸ (assumed by Grudeva) to ~5×10⁻⁶ (from Bo ≈ 10) | m² s⁻¹ | — | Grudeva; derived from Vaca Guerra |
| $k$ | surface mass-transfer coefficient | 1×10⁻³ (Grudeva); lumped 1.7×10⁻⁴ – 1.4×10⁻³ (Moroney 2019) | m s⁻¹ | — | B |
| $k_C$ | Cameron rate constant | 6×10⁻⁷ | m⁷ kg⁻² s⁻¹ | — | B |
| $t_s$, $t_d$ | surface and kernel timescales | 1.2–19; 42–270 | s | 90 °C, well-mixed | Moroney 2016 |
| $\lambda$ | exponential decay mass | TDS 13–18; caffeine 19–24 | g of beverage | DE1, 20 g | Schmieder 2023 |
| $c_\text{sat}$ | saturation, lumped | 210–280 | kg m⁻³ | — | §5.5 |
| $K$ | liquid/solid partition | 0.42–0.61 | — | 20–80 °C | Corrochano |
| $c_{s0}$ | initial soluble concentration in grains | 305–359 (per pore volume); 310 (per grain volume); 513 (TDS in pores) | kg m⁻³ | definitions differ | Moroney 2019; Grudeva; Vaca Guerra |
| EY_max | extractable fraction | 28–34 | % | — | §5.5 |
| $t_w$ | wetting time | 5–10 | s | — | Grudeva; Waszkiewicz |
| Bo | Bodenstein number | 7.7–16.8 | — | 22 °C tracer | Vaca Guerra 2024 |

---

## 9. Validation datasets

| Dataset | What was measured | Conditions | Where the data are |
|---|---|---|---|
| Cameron et al. 2020 | EY vs grind setting (mean ± SD, n = 5); shot time vs GS; modelled EY vs dose (16–24 g) and pressure (4–10 bar); laser-diffraction PSDs at GS 1.0–2.5 | EK43, San Remo Opera, 6 bar, 92 °C, 20 g / 40 g | Figs. 2–5 (digitize); parameter tables in SI (not read). Open full text at OSTI 1973594 |
| Lee et al. 2023 | digitized Cameron EY; model fits | — | arXiv:2206.12373 ancillary code (wxMaxima, Octave) |
| Schmieder et al. 2023 | trigonelline, caffeine, 5-CQA, TDS in 6 of 10 time fractions; pressure, flow, temperature logs | DE1, 20 g, 1/2/3 mL s⁻¹, GL 1.4/1.7/2.0, 80/89/98 °C, 15-run central composite design, triplicates | Appendix Table A1 (fits), raw concentrations in SI Table S1 and replicate fits in S3 (open access, Foods) |
| Kuhn et al. 2017 | high-time-resolution caffeine and trigonelline vs particle size and tamping (triplicates) | commercial machine | figures (paywalled; abstract only read) |
| Vaca Guerra et al. 2024 (and 2023a/b) | instant outlet concentration of TDS, caffeine, trigonelline and 5-CQA vs time for 3 PSDs; tracer RTDs (Bo, residence time) at 0/30/60 g; initial bed porosity | Bezzera machine, ULKA pump, 15–18 g, 2.5–4 mL s⁻¹ | tables and appendix of the open-access paper (J Food Eng 368, 111913) |
| Waszkiewicz et al. 2026 | flow and mass vs time at 11 basket pressures (1–12 bar, 60 shots, ≥120 s); long-time flow vs pressure; TDS in 5 s fractions (3 replicates); μCT before/after | Sanremo Zoe, 18.5 g, 58 mm IMS, 20 kg tamp, WDT | stated GitHub and Zenodo archive (URLs not checked); arXiv:2512.21528 |
| Foster et al. 2025 | wetting-front position vs time (time-resolved μCT) with pump dynamics | espresso bed | Phys Fluids 37, 013383 (open access; not read in full) |
| Smrke et al. 2024 | beverage mass vs time, EY, extraction time vs median size and added-fines share; PTR-MS volatiles; sensory | Black Eagle, 9 bar, 20 g / 40 g, 6 burr gaps, +1/2/4 g fines | figures; data on request |
| Corrochano 2015 / 2017 | steady Q–ΔP permeability (4 grinds × 3 densities, 20/80 °C); consolidation vs time; dry/wet PSD; porosimetry; partition K; stirred-vessel kinetics at 20/50/80 °C | lab rig, 0.5–4.5 bar | EngD thesis (open, etheses.bham.ac.uk/7176), Tables 4.1–4.10, 5.x, 6.1–6.2 |
| Moroney et al. 2015, 2019 | outlet concentration vs time (drip column), pressure drop (2.3 / 0.65 bar), PSDs | 60 g, 250 mL min⁻¹, 90 °C | figures; PLoS SI has videos and PDFs, no raw tables |
| Mo et al. 2023 | μCT porosity profiles before/after; permeability and tortuosity of sub-volumes; PSDs | capsules (Iperespresso) | Sci Rep 13, 16374 (open), Tables 1–5 |
| Sánchez-López et al. 2014, 2016 | 1 s resolution online volatiles (95 ion traces) during espresso | capsule systems; semi-automatic machine | Anal Chem; Int J Mass Spectrom (figures) |
| Parameter studies: Jaganyi 1999 and Spiro (infusion rates); Hargarten, Maille, Mateus (swelling); Smrke 2018 (degassing) | rate constants vs size and T; swelling kinetics; Weibull degassing fits by roast | immersion; storage | tables and figures |
| Ribes 2020/21; Buckman 2023 (community) | radial EY by coring; puck screen and paper filter effects; headspace effect | DE1 | decentespresso.com documents; Gagné 2025 |
| visualizer.coffee (community) | thousands of DE1 shot logs: pressure, flow, weight, temperature vs time | heterogeneous | public web database (quality and metadata uneven) |

**Best first targets:** Cameron's EY vs grind (exercises heterogeneity), Schmieder's compound kinetics (open, replicated, raw SI), Waszkiewicz's flow vs pressure vs time (open code and data), and Vaca Guerra's outlet kinetics plus RTD.

---

## 10. Numerics for a browser

| Formulation | State size | Cost per simulated shot (JS/WASM, estimate) | Captures |
|---|---|---|---|
| Empirical: $c(m)=c_0e^{-m/\lambda}$ (Schmieder); tanh TDS(t), $m_d(t)$ (Waszkiewicz) | a few parameters | µs | cup totals and kinetics within the fitted domain |
| Lumped two-pool or bi-exponential (Moroney asymptotics); Sano 2019 analytical | 2–4 ODEs | µs | fast/slow extraction, dose, flow |
| N-pathway lumped (Lee 2023 generalized) | 2N ODEs | ≪ 1 ms | channeling, EY spread, EY–grind peak |
| **1D multiscale (method of lines)** | $N_z$ = 30–50 × (1 liquid + fines 1–2 + boulders 6–8 shells + surface pool) ≈ 300–600 | ~1–10 ms with banded implicit solves | depth profiles, compound kinetics, flow coupling |
| 1D + N parallel columns | (N = 4–16) × above | 10–100 ms | heterogeneity with depth resolution |
| Grudeva reduced model | front ODE + characteristics ODE | ~100× cheaper than full 1D | saturated-front regime |
| 2D axisymmetric Darcy + transport | ~20 × 40 cells × particle states | 0.1–1 s (Poisson solve each step) | basket, edge and shower effects (offline or WebGPU) |
| SPH/LBM pore-scale | 10⁵–10⁷ particles | hours (HPC) | closure generation only |

**Discretization.**
- Finite volumes in $z$ with upwind or TVD (van Leer) advection. First-order upwind adds numerical dispersion $\approx q\Delta z/2$, about 10⁻⁷ m² s⁻¹ for $N_z$ = 40, which is acceptable given Bo ≈ 10.
- Particles: equal-volume radial shells (finite volume, conservative), or the Glueckauf linear driving force $d\bar c/dt=(15D/a^2)(c^*-\bar c)$ for fines and as a cheap boulder option.
- Exact checks: perfect-sink sphere $M_t/M_\infty=1-\frac{6}{\pi^2}\sum n^{-2}e^{-n^2\pi^2Dt/a^2}$ (Crank).
- Flow: series-resistance integral each step; poroelastic factor via the closed form in §3.7.
- Pump: pressure- or flow-controlled boundary condition plus headspace compliance ODE.

**Stiffness.** Rates span about 10²–10³ s⁻¹ (fines dissolution, $kb/\varepsilon$) down to 10⁻² s⁻¹ (boulder diffusion). Use implicit Euler or BDF2 on the banded Jacobian, or IMEX (explicit advection, implicit exchange). The saturation front (Grudeva) becomes a moving internal layer as ε → 0; use quasi-steady elimination of the fast surface step or a fine mesh. Positivity and mass conservation should be verified each step (total soluble mass budget).

**Reduced and analytic results for surrogates:**
1. Two-pool kinetics with $t_s$, $t_d$ (Moroney).
2. $\hat Q=1-(1-\hat P)^4$ (Waszkiewicz).
3. Darcy series resistance with $\kappa(\text{EY})$ through $\varepsilon=\varepsilon_0+\text{EY}(1-\varepsilon_0)$ (Lee).
4. LDF $15D/a^2$.
5. Schmieder exponential with λ(flow, grind, T) from Table A1.
6. Sano 2019 lumped solutions.
7. Melrose et al. 2018 reduced variables for control charts.

---

## Implications for the simulator design

1. **Implement first: Tier-1 core.** A 1D-in-depth multiscale model (§3.2) with:
   - two particle classes, each with a surface (broken-cell) pool plus kernel diffusion (6 shells for boulders, LDF for fines);
   - the Grudeva saturating flux with $c_\text{sat}$ ≈ 210–280 kg m⁻³ plus a partition coefficient;
   - a wetting-front ODE for preinfusion;
   - Darcy series-resistance flow coupled to a pressure- or flow-controlled pump with headspace compliance;
   - lumped solubles plus 3–4 tracked species (caffeine, trigonelline, 5-CQA, "acids"/low-MW), each with its own $D_\text{eff}$ (scaled by MW class), $K$, initial content and surface fraction.

   Calibrate first against Schmieder 2023 and Vaca Guerra 2024, then Cameron 2020.
2. **Permeability is a calibrated state, not a prediction.** Use $\kappa_\text{eff}(t,z)=\kappa_0\cdot f_\text{diss}(\text{EY}_\text{loc})\cdot f_\text{comp}(\sigma\text{ or }\Delta P)\cdot f_\text{swell}(t)\cdot f_\text{gas}(S_w,t)\cdot f_\text{fines}(t)$, with $\kappa_0\sim10^{-15}$ m² for espresso grinds. Use Kozeny–Carman only for **relative** changes (PSD, density, dissolution).
3. **Heterogeneity is essential for realistic EY versus grind.** Run N = 4–16 parallel 1D columns with a lognormal initial κ (or porosity offsets δ), shared inlet pressure and an edge column with reduced conductance (radial data). This is the cheapest mechanism that reproduces the Cameron peak and gives a local-EY distribution (a better flavour proxy than mean EY).
4. **What can be lumped:**
   - thermal: one node for basket and portafilter plus advective puck temperature, with viscosity and diffusivity tied to temperature by Stokes–Einstein;
   - CO₂: a decaying relative-permeability penalty scaled by roast age;
   - fines migration: a growing outlet resistance layer;
   - swelling: an exponential relaxation, τ ≈ 20–30 s (§4.6);
   - dispersion: a single $D_{ax}$ or Bo parameter;
   - compaction: the Waszkiewicz closed form.
5. **Needs ML or Bayesian calibration:**
   - the PSD/dose/tamp/roast/freshness → $\kappa_0$ and compaction-scale closure (the biggest gap);
   - surface-pool fraction and $D_\text{eff}$ per compound class;
   - heterogeneity variance as a function of grind and puck prep;
   - μ(TDS, T) at brew temperature (fit once data exist);
   - a fast emulator (Gaussian process or neural ODE) of the Tier-1/2 model for UI sliders, with physics-model fallback outside the training domain.

   Use hierarchical Bayesian calibration so that parameters shared across datasets (D classes, K, c_sat) are separated from setup-specific ones (κ₀, heterogeneity).
6. **Defer:** 2D axisymmetric for basket, shower-screen and headspace studies; particle-scale SPH/LBM only offline to generate closures.

---

## Open questions and data gaps

1. **PSD → in-shot hydraulics.** No dataset maps a measured PSD (with defined dry/wet method), dose, tamp, roast and age to the in-shot pressure–flow trajectory at 9 bar. The gap between in-shot κ and permeameter values (2–200×) or dry-PSD Kozeny–Carman (10–1000×) is unexplained, and the contributions of swelling, compaction, fines and gas are not separated.
2. **Spatially resolved extraction.** Local EY maps and channel statistics exist only from community coring and structural μCT. No combined dataset gives time-resolved flow and TDS plus final local-EY or concentration fields.
3. **Compound-level transport at brew temperature.** $D_\text{eff}$, partition, initial distribution (surface versus kernel) and temperature dependence at 85–96 °C are available for about 3 compounds. Acids, melanoidins and volatiles in espresso are largely unparameterized.
4. **Extract viscosity at 80–95 °C for 1–30% TDS.** Only low-temperature data were read. Viscosity feedback on flow is therefore unquantified.
5. **Swelling under confinement.** Published magnitudes range from 0 to 15% in diameter, and kinetics under pressure in a confined bed are unknown.
6. **Wet-puck mechanics.** No measured modulus or consolidation law under hot flow; Waszkiewicz's $P_c$ is a fitted single-coffee value.
7. **Axial dispersion in hot beds.** The only tracer data were taken at 22 °C. Bo ≈ 10 conflicts with the "negligible dispersion" assumption in Cameron and Grudeva.
8. **CO₂ hydraulics.** Gas volume can exceed pore volume on paper, but its effect on flow and extraction versus roast age has not been measured.
9. **Thermal field.** No peer-reviewed in-puck temperature measurements for espresso machines.
10. **Puck preparation and accessories** (WDT, paper filters, puck screens, headspace): only single-operator community data, so no peer-reviewed controlled replication exists.
11. **Sources not read in full** (paywalled or inaccessible; abstracts or secondary citations only): Moroney 2015 (CES) and 2016 (SIAM), Fasano & Talamucci 2000, Kuhn 2017, Pannusch 2024, Vaca Guerra 2023, Foster 2025, Hargarten 2020, Maille 2021, Sano 2019, Anderson 2003, Sobolík 2002, Telis-Romero 2001, Andueza 2003, and the Cameron 2020 SI. Values attributed to them here come from abstracts or from secondary citations, as marked.

---

## References

Primary and secondary sources used; DOIs verified against Crossref unless marked.

- Albanese D, Di Matteo M, Poiana M, Spagnamusso S (2009) Espresso coffee (EC) by POD: thermal profile and water temperature. *Food Res Int* 42:727–732. doi:10.1016/j.foodres.2009.02.027
- Anderson BA, Shimoni E, Liardon R, Labuza TP (2003) Diffusion kinetics of CO₂ in fresh roasted and ground coffee. *J Food Eng* 59:71–78. doi:10.1016/S0260-8774(02)00432-6 (not read)
- Andueza S, et al. (2002) Influence of water pressure on the final quality of Arabica espresso. *J Agric Food Chem* 50:7426–7431. doi:10.1021/jf0206623
- Andueza S, et al. (2003) Influence of extraction temperature on the final quality of espresso coffee. *J Sci Food Agric* 83:240–248. doi:10.1002/jsfa.1304 (not read)
- Angeloni S, Giacomini J, Maponi P, et al. (2023) Computer percolation models for espresso coffee: state of the art. *Appl Sci* 13:2688. doi:10.3390/app13042688
- Cameron MI, Morisco D, Hofstetter D, Uman E, Wilkinson J, Kennedy ZC, Fontenot SA, Lee WT, Hendon CH, Foster JM (2020) Systematically improving espresso. *Matter* 2:631–648. doi:10.1016/j.matt.2019.12.019
- Cordoba N, Fernandez-Alduenda M, Moreno FL, Ruiz Y (2020) Coffee extraction: a review of parameters. *Trends Food Sci Technol* 96:45–60. doi:10.1016/j.tifs.2019.12.004
- Corrochano BR, Melrose JR, Bentley AC, Fryer PJ, Bakalis S (2015) Steady-state permeability of roast and ground coffee in packed beds. *J Food Eng* 150:106–116. doi:10.1016/j.jfoodeng.2014.11.006
- Corrochano BR (2017) *Advancing the engineering understanding of coffee extraction*. EngD thesis, Univ. Birmingham. etheses.bham.ac.uk/7176
- Crank J (1975) *The Mathematics of Diffusion*, 2nd ed. Oxford.
- Egidi N, Giacomini J, Maponi P, Perticarini A, Cognigni L, Fioretti L (2022) An advection–diffusion–reaction model for coffee percolation. *Comput Appl Math* 41:229. doi:10.1007/s40314-022-01929-9
- Ellero M, Navarini L (2019) Mesoscopic modelling and simulation of espresso coffee extraction. *J Food Eng* 263:181–194. doi:10.1016/j.jfoodeng.2019.05.038
- Fasano A, Talamucci F (2000) A comprehensive mathematical model for a multispecies flow through ground coffee. *SIAM J Math Anal* 31:251–273. doi:10.1137/S0036141098336698
- Fasano A, Talamucci F, Petracco M (2000) The espresso coffee problem. In: Fasano A (ed) *Complex Flows in Industrial Processes*, Birkhäuser, 241–280. doi:10.1007/978-1-4612-1348-2_8 (features from the ECMI'98 abstract)
- Folmer B (ed) (2017) *The Craft and Science of Coffee*. Academic Press. Chapter: Mestdagh F, Glabasnia A, Giuliano P, The brew—extracting for excellence, 355–380. doi:10.1016/B978-0-12-803520-7.00015-3
- Foster J, Lee W, Moroney K, Prjamkov D, Salamon M, Smith A, Petrassem-de-Sousa J, Vynnycky M (2025) Dynamics of liquid infiltration into an espresso bed using time-resolved micro-CT. *Phys Fluids* 37:013383. doi:10.1063/5.0245167
- Gagné J (2021) *The Physics of Filter Coffee* (not consulted here); Gagné J (2025) *The Physics of Espresso*, Scott Rao Coffee Books, ISBN 9798350747737 (only the free shower-screen and headspace extract was read)
- Giacomini J, Khamitova G, Maponi P, Vittori S, Fioretti L (2020) Water flow and transport in porous media for in-silico espresso coffee. *Int J Multiphase Flow* 126:103252. doi:10.1016/j.ijmultiphaseflow.2020.103252
- Giacomini J, Maponi P, Perticarini A (2022/23) A reduced percolation model for espresso coffee. *J Math Chem* 61:520–538. doi:10.1007/s10910-022-01428-6
- Glueckauf E (1955) Formulae for diffusion into spheres. *Trans Faraday Soc* 51:1540–1551. doi:10.1039/TF9555101540
- Grudeva Y, Moroney KM, Foster JM (2026; online 2025) A multiscale model for espresso brewing: asymptotic analysis and numerical simulation. *Eur J Appl Math* 37:496–519. doi:10.1017/S095679252500018X
- Hargarten VB, Kuhn M, Briesen H (2020) Swelling properties of roasted coffee particles. *J Sci Food Agric* 100:3960–3970. doi:10.1002/jsfa.10440
- Hewitt DR, Nijjer JS, Worster MG, Neufeld JA (2016) Flow-induced compaction of a deformable porous medium. *Phys Rev E* 93:023116. doi:10.1103/PhysRevE.93.023116
- Illy A, Viani R (eds) (2005) *Espresso Coffee: The Science of Quality*, 2nd ed. Elsevier. Petracco M, Percolation, 259–289. doi:10.1016/B978-012370371-2/50008-1
- Jaganyi D, Vanmare J, Clark T (1999) Kinetic study of mineral ion extraction from Kenyan Arabica coffee. *J Sci Food Agric* 79:323–326. doi:10.1002/(SICI)1097-0010(199902)79:2<323::AID-JSFA201>3.0.CO;2-E
- Jaganyi D, Madlala SP (2000) Kinetics of coffee infusion: mineral ions and caffeine from several medium-roasted coffees. *J Sci Food Agric* 80:85–90. doi:10.1002/(SICI)1097-0010(20000101)80:1<85::AID-JSFA489>3.0.CO;2-# (values via Corrochano)
- Khamitova G, Angeloni S, Borsetta G, et al. (2020) Optimization of espresso extraction through particle size, perforated disk height and filter basket. *Food Chem* 314:126220. doi:10.1016/j.foodchem.2020.126220
- Kuhn M, Lang S, Bezold F, Minceva M, Briesen H (2017) Time-resolved extraction of caffeine and trigonelline from finely-ground espresso coffee. *J Food Eng* 206:37–47. doi:10.1016/j.jfoodeng.2017.03.002 (abstract read)
- Lee WT, Smith A, Arshad A (2023) Uneven extraction in coffee brewing. *Phys Fluids* 35:054110. doi:10.1063/5.0138998 (arXiv:2206.12373)
- Liang J, Chan KC, Ristenpart WD (2021) An equilibrium desorption model for full immersion brewed coffee. *Sci Rep* 11:6904. doi:10.1038/s41598-021-85787-1
- Mahadevan A, Orpe AV, Kudrolli A, Mahadevan L (2012) Flow-induced channelization in a porous medium. *EPL* 98:58003. doi:10.1209/0295-5075/98/58003
- Maille MJ, Sala K, Scott DM, Zukswert H (2021) Critical examination of particle swelling during wetting of ground coffee. *J Food Eng* 295:110420. doi:10.1016/j.jfoodeng.2020.110420 (abstract read)
- Mateus M-L, Rouvet M, Gumy J-C, Liardon R (2007) Interactions of water with roasted and ground coffee in the wetting process. *J Agric Food Chem* 55:2979–2984. doi:10.1021/jf062841g
- Matias AFV, Coelho RCV, Andrade JS, Araújo NAM (2021) Flow through time-evolving porous media: swelling and erosion. *J Comput Sci* 53:101360. doi:10.1016/j.jocs.2021.101360
- Matias AFV, et al. (2023) Continuum model for extraction and retention in porous media. *Phys Fluids* 35:123611. doi:10.1063/5.0176273
- Melrose J, Roman-Corrochano B, Montoya-Guerra M, Bakalis S (2018) Toward a new brewing control chart for the 21st century. *J Agric Food Chem* 66:5301–5309. doi:10.1021/acs.jafc.7b04848
- Mo C, Johnston R, Navarini L, Ellero M (2021) Modeling the effect of flow-induced mechanical erosion during coffee filtration. *Phys Fluids* 33:093101. doi:10.1063/5.0059707
- Mo C, Navarini L, Suggi Liverani F, Ellero M (2022) Modeling swelling effects during coffee extraction with SPH. *Phys Fluids* 34:043104. doi:10.1063/5.0086897
- Mo C, Johnston R, Navarini L, Suggi Liverani F, Ellero M (2023) Coffee matrix microstructure and flow properties via X-ray microtomography and SPH. *Sci Rep* 13:16374. doi:10.1038/s41598-023-42380-y
- Mo C, Navarini L, Suggi Liverani F, Ellero M (2024) Modelling swelling effects in real espresso extraction using a 1D coarse-grained model. *J Food Eng* 365:111843. doi:10.1016/j.jfoodeng.2023.111843
- Moreno FL, et al. (2015) Rheological behaviour, freezing curve, and density of coffee solutions near freezing. *Int J Food Prop* 18:426–438. doi:10.1080/10942912.2013.833221
- Moroney KM, Lee WT, O'Brien SBG, Suijver F, Marra J (2015) Modelling of coffee extraction during brewing using multiscale methods. *Chem Eng Sci* 137:216–234. doi:10.1016/j.ces.2015.06.003 (not read)
- Moroney KM, et al. (2016) Asymptotic analysis of the dominant mechanisms in the coffee extraction process. *SIAM J Appl Math* 76:2196–2217. doi:10.1137/15M1036658 (abstract read)
- Moroney KM, et al. (2016) Coffee extraction kinetics in a well mixed system. *J Math Ind* 7:3. doi:10.1186/s13362-016-0024-6
- Moroney KM, O'Connell K, Meikle-Janney P, O'Brien SBG, Walker GM, Lee WT (2019) Analysing extraction uniformity from porous coffee beds. *PLoS ONE* 14:e0219906. doi:10.1371/journal.pone.0219906
- Pannusch VB, Schmieder BKL, Vannieuwenhuyse L, Minceva M, Briesen H (2024) Model-based kinetic espresso brewing control chart. *J Food Eng* 367:111887. doi:10.1016/j.jfoodeng.2023.111887 (abstract read)
- Salamanca CA, Fiol N, González C, Saez M, Villaescusa I (2017) Espresso extraction using a temperature gradient. *Food Chem* 214:622–630. doi:10.1016/j.foodchem.2016.07.120
- Sánchez-López JA, Zimmermann R, Yeretzian C (2014) Time-resolved extraction of aroma compounds during espresso preparation (PTR-ToF-MS). *Anal Chem* 86:11696–11704. doi:10.1021/ac502992k
- Sano Y, Kubota S, Kawarazaki A, Kawamura K, Kashiwai H, Kuwahara F (2019) Mathematical model for coffee extraction based on volume averaging theory. *J Food Eng* 263:1–12. doi:10.1016/j.jfoodeng.2019.05.025
- Schenker S, Handschin S, Frey B, Perren R, Escher F (2000) Pore structure of coffee beans affected by roasting conditions. *J Food Sci* 65:452–457. doi:10.1111/j.1365-2621.2000.tb16026.x
- Schmieder BKL, Pannusch VB, Vannieuwenhuyse L, Briesen H, Minceva M (2023) Influence of flow rate, particle size, and temperature on espresso extraction kinetics. *Foods* 12:2871. doi:10.3390/foods12152871
- Smith A, Lee WT (2021) Brewing optimal coffee. *Eur J Phys* 42:025805. doi:10.1088/1361-6404/abc97d
- Smrke S, Wellinger M, Suzuki T, Balsiger F, Opitz SEW, Yeretzian C (2018) Time-resolved gravimetric method to assess degassing of roasted coffee. *J Agric Food Chem* 66:5293–5300. doi:10.1021/acs.jafc.7b03310
- Smrke S, Eiermann A, Yeretzian C (2024) The role of fines in espresso extraction dynamics. *Sci Rep* 14:5612. doi:10.1038/s41598-024-55831-x
- Spiro M, Selwood RM (1984) Caffeine infusion from coffee: the effect of particle size. *J Sci Food Agric* 35:915–924. doi:10.1002/jsfa.2740350817
- Spiro M, Toumi R, Kandiah M (1989) The hindrance factor in intra-bean diffusion. *J Sci Food Agric* 46:349–356. doi:10.1002/jsfa.2740460313
- Spiro M, Chong YY (1997) Temperature variation of the hindrance factor. *J Sci Food Agric* 74:416–420. doi:10.1002/(SICI)1097-0010(199707)74:3<416::AID-JSFA868>3.0.CO;2-0 (values via Corrochano)
- Vaca Guerra M, Harshe YM, Fries L, Rothberg S, Palzer S, Heinrich S (2023) Influence of particle size distribution on espresso extraction via packed bed compression. *J Food Eng* 340:111301. doi:10.1016/j.jfoodeng.2022.111301 (abstract read)
- Vaca Guerra M, Harshe YM, Fries L, Payan Lozada J, Atxutegi A, Palzer S, Heinrich S (2024) Modeling the extraction of espresso components as dispersed flow through a packed bed. *J Food Eng* 368:111913. doi:10.1016/j.jfoodeng.2023.111913
- Voilley A, Simatos D (1979) Modeling the solubilization process during coffee brewing. *J Food Process Eng* 3:185–198. doi:10.1111/j.1745-4530.1979.tb00238.x (via Corrochano)
- Waszkiewicz R, Myck F, Białas Ł, Puciata-Mroczynska M, Dzikowski M, Szymczak P, Lisicki M (2026) Under pressure: poroelastic regulation of flow in espresso brewing. *Phys Fluids* 38:063113. doi:10.1063/5.0319611 (arXiv:2512.21528)
- Zanoni B, Pagliarini E, Peri C (1992) Modelling the aqueous extraction of soluble substances from ground roasted coffee. *J Sci Food Agric* 58:275–279. doi:10.1002/jsfa.2740580217 (via Corrochano)
- Community/grey sources: Ribes S (2020) Radial uniformity of espresso extractions; Ribes S (2021) Effects of a puck screen on extraction (decentespresso.com docs); Buckman (2023) headspace data, as reported in Gagné 2025; visualizer.coffee.
