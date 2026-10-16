<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Particle kernel: diffusion out of a sphere

*puckcore 0.1.0 · Milestone M0 · Last updated 2026-10-14.*

Code:
- [`crates/puckcore/src/kernel/sphere.rs`](../../crates/puckcore/src/kernel/sphere.rs): API and time integration.
- [`sphere/shells.rs`](../../crates/puckcore/src/kernel/sphere/shells.rs): grids and conductances.
- [`sphere/analytic.rs`](../../crates/puckcore/src/kernel/sphere/analytic.rs): Crank's solution.
- [`linalg/tridiag.rs`](../../crates/puckcore/src/linalg/tridiag.rs): tridiagonal solver.
- [`math.rs`](../../crates/puckcore/src/math.rs): deterministic `exp` and `cbrt`.

Every particle in the extraction model is a diffusing sphere (PLAN §7.3, module X; [research note 01](../research/01-extraction-and-flow-physics.md) §3.2 and §10).

**M0 scope.** M0 solves the simplest case: a sphere with uniform initial content, releasing into a perfect sink. It has an exact solution, so it checks the numerics and the toolchain end to end, from Rust through WebAssembly and Python.

**M1 plan.** M1 will reuse the same discretisation with a surface flux coupled to the bed liquid.

## 1. Problem

A sphere of radius $a$ holds a uniform concentration $c_0$ at $t = 0$. For $t > 0$ its surface is held at zero (a perfect sink), and the solute diffuses with constant diffusivity $D$:

$$\frac{\partial c}{\partial t}=\frac{D}{r^2}\frac{\partial}{\partial r}\Big(r^2\frac{\partial c}{\partial r}\Big),\qquad \partial_r c\,|_{r=0}=0,\qquad c(a,t)=0,\qquad c(r,0)=c_0 .$$

The output is the released fraction:

$$\frac{M_t}{M_\infty}=1-\frac{3}{a^3c_0}\int_0^a c\,r^2\,dr .$$

With $\tau = Dt/a^2$ and $\rho = r/a$, the problem has no parameters left. The released fraction depends only on τ, and the numerical result only on (τ, N, grid, scheme, steps). The code works in these units: unit radius, unit diffusivity, and volumes and conductances divided by 4π.

## 2. Analytic solution

From Crank (1975, §6.3), the long-time series (eq. 6.20) and the short-time expansion (eq. 6.21) are

$$\frac{M_t}{M_\infty}=1-\frac{6}{\pi^2}\sum_{n\ge1}\frac{e^{-n^2\pi^2\tau}}{n^2}
=6\sqrt{\tau}\Big(\pi^{-1/2}+2\sum_{n\ge1}\operatorname{ierfc}\frac{n}{\sqrt\tau}\Big)-3\tau .$$

**Evaluation.** `crank_sphere_release_fraction` switches branch at τ = 0.01:
- **Below the switch:** it uses $6\sqrt{\tau/\pi}-3\tau$. The dropped ierfc terms are below 1e-40.
- **Above the switch:** it sums the series until a term falls below 1e-18 of the sum, about 20 terms at τ = 0.01. The powers $e^{-n^2\pi^2\tau}=q^{n^2}$ come from a single exponential $q=e^{-\pi^2\tau}$, with two multiplications per term.

**Checks.** The values are checked independently in the unit tests:
- **Reference values.** Twelve values from 1e-6 ≤ τ ≤ 3 were computed with mpmath at 50 digits from both exact forms, which agree to 1e-49. The largest difference at these points is 1.1e-16.
- **Dense sampling.** Over the whole range the absolute error is at most **5.7e-16** (1.8e-15 relative). That is the largest an independent review found against a 60-digit reference; our own check of 40 001 log-spaced points gives 5.2e-16. The largest errors sit just above the branch switch (τ ≈ 0.011–0.013), from round-off in the series.
- **Branch overlap.** The two truncated branches agree to **9.4e-16** over 1e-3 ≤ τ ≤ 0.03.
- **Monotonicity.** The released fraction is monotone over 1e-8 ≤ τ ≤ 10.

## 3. Discretisation in space

### 3.1 Shells

The sphere is split into N shells with face radii $0=r_0<r_1<\dots<r_N=a$. The unknowns are the shell averages $c_j$. Two grids are available:

| grid | faces | volumes | use |
|---|---|---|---|
| uniform radius | $r_j = a\,j/N$ | $\propto 3j^2+3j+1$ | simple; coarse near the surface |
| equal volume | $r_j = a\,(j/N)^{1/3}$ | all equal | outer shell 3× thinner than uniform (δ ≈ a/3N); coarse near the centre |

The finite-volume equations, in flux form, are

$$V_j\frac{dc_j}{dt}=G_{j-\frac12}(c_{j-1}-c_j)-G_{j+\frac12}(c_j-c_{j+1}),\qquad G_{-\frac12}=0,\quad c_N=0 .$$

The mass released through the surface accumulates at the rate $G_{N-\frac12}\,c_{N-1}$. The sum over shells telescopes, so the method conserves mass by construction.

### 3.2 Conductances: exact for parabolic profiles

Let $\mu_j$ be the volume average of $r^2$ over shell j. Each face gets

$$G_{j+\frac12}=\frac{2D\,r_{j+1}^3}{\mu_{j+1}-\mu_j},\qquad
\mu_j=\frac35\,\frac{r_{j+1}^5-r_j^5}{r_{j+1}^3-r_j^3},$$

and the surface gets the same formula, with the surface as a node at zero concentration and "μ = a²".

**What it buys.** With shell averages as unknowns, the semi-discrete fluxes are then **exact for every profile $c=A+Br^2$**. That family covers:
- the uniform state;
- the parabolic profile of uniform depletion, the basis of Glueckauf's linear-driving-force approximation (Glueckauf 1955);
- the smooth, even behaviour of $c$ at the centre.

**The volume-coordinate alternative.** The coordinate $u=(r/a)^3$ turns the equation into $\partial_t c=(9D/a^2)\,\partial_u(u^{4/3}\partial_u c)$, so equal-volume shells form a uniform grid in u. With face coefficients $u_f^{4/3}$ that is the obvious discretisation, but near the centre $c\approx c_0+\beta u^{2/3}$ is not smooth in u:
- **First faces.** The flux there is wrong by an O(1) fraction: 2% at the first face (point values) or 5.7% (shell averages), decaying like $k^{-2}$.
- **Consequences.** That gives an error of order $N^{-2/3}$ in the central shell and $N^{-5/3}$ in the released fraction. The equal-volume grid makes this worse because its central shell is large: $r_1=a\,N^{-1/3}$, which is a/4 for N = 64.

A design study confirmed this, using a NumPy prototype that integrates the semi-discrete system exactly in time by eigendecomposition. The table gives the equal-volume error at τ = 0.3:

| N | $u^{4/3}$ faces: error | order | parabola-exact (used): error | order |
|---|---|---|---|---|
| 64 | +4.39e-5 | 1.61 | +6.78e-6 | 1.96 |
| 256 | +4.59e-6 | 1.63 | +4.40e-7 | 1.98 |
| 1024 | +4.71e-7 | 1.65 | +2.81e-8 | 1.99 |

The same study tried two other options. Steady spherical conductances between centroid radii gave order ≈ 1.6. Midpoint radii in u gave an erratic order. The surface treatment barely matters: all four tested variants are second order.

### 3.3 No cancellation

For thin shells, the differences of powers above lose up to 11 digits. The code rewrites them as products of positive terms. With $p=r_j$, $q=r_{j+1}$, $s=r_{j+2}$ and $S_2(x,y)=x^2+xy+y^2$:

$$\mu_{j+1}-\mu_j=\tfrac35(s-p)\,\frac{P}{S_2(p,q)\,S_2(q,s)},\qquad P=q^3S_2(p,s)+q^2(p+s)S_2(p,s)+qps(p+s)^2+p^2s^2(p+s),$$

$$a^2-\mu_{N-1}=\frac{(a-p)(2a^3+4a^2p+6ap^2+3p^3)}{5\,S_2(p,a)} .$$

The shell widths come from cancellation-free formulas too: 1/N on the uniform grid, $(1/N)/S_2(r_j,r_{j+1})$ on the equal-volume grid. On a uniform grid of 100 000 shells, the conductances match $r_f^2/\Delta r$ to 1e-9 relative.

### 3.4 Properties

- **Conservative and symmetric.** $V^{-1}K$ is similar to a symmetric positive definite matrix.
- **M-matrices.** Every implicit system $\alpha V+\beta K$ is a strictly diagonally dominant M-matrix.
- **Second order** on both grids (§6.4).

## 4. Discretisation in time

### 4.1 Schemes

In matrix form, $V\dot c=-Kc$, and the released fraction $R$ grows at $f=G_s c_{N-1}/M_0$, where $M_0=\sum V_j$. Steps have size h in τ.

| scheme | step | released fraction |
|---|---|---|
| backward Euler | $(V+hK)\,c^{n+1}=Vc^n$ | $R^{n+1}=R^n+h f^{n+1}$ |
| BDF2 (first step backward Euler) | $(3V+2hK)\,c^{n+1}=V(4c^n-c^{n-1})$ | $3R^{n+1}-4R^n+R^{n-1}=2hf^{n+1}$ |
| Crank–Nicolson | $(V+\tfrac h2K)\,c^{n+\frac12}=Vc^n$, then $c^{n+1}=2c^{n+\frac12}-c^n$ | $R^{n+1}=R^n+\tfrac h2(f^n+f^{n+1})=R^n+hf^{n+\frac12}$ |

The Crank–Nicolson form is a backward-Euler half-step followed by extrapolation. It is algebraically identical to $(V+\tfrac h2K)c^{n+1}=(V-\tfrac h2K)c^n$, needs no matrix-vector product, and shares its matrix with the backward-Euler half-steps of the Rannacher start-up.

### 4.2 Start-up

**The problem.** The initial state is discontinuous at the surface, so the release grows like $\sqrt t$, and no fixed step resolves that.
- **Continuum estimate.** One backward-Euler step of size Δt from the step profile releases $\sqrt{D\Delta t}$ per unit area. The exact value is $2\sqrt{D\Delta t/\pi}$, so the step misses 11.4%.
- **Reference case.** On the reference case that alone costs 4.8e-3 in released fraction at the first output, ten times the spatial error.
- **No fixed scheme escapes it.** A plain constant-step BDF2 run gives 5.3e-3, and Crank–Nicolson with Rannacher half-steps 3.0e-3 (§6.3).

**The cure.** The first output intervals run on a finer sub-grid:
- **Sub-grid.** The first `startup_intervals` = 4 output intervals are each split into `startup_substeps` = 8 equal sub-steps. The chosen scheme runs on that sub-grid with its own start: BDF2 begins with one backward-Euler sub-step, and Crank–Nicolson replaces its first `rannacher_steps` = 2 sub-steps with four backward-Euler half-steps (Rannacher 1984).
- **Switch.** At $t_4$ the scheme continues with the user's step. BDF2 restarts its recurrence from the stored states at $t_3$ and $t_4$, both from the sub-grid, so it never differences the discontinuous initial state.
- **Why four intervals.** With one interval, BDF2's first full step reaches back to $c^0$ and the error at $t_2$ is 1.4e-3. With four, the remaining switch error falls as $K^{-3/2}$.
- **Why four half-steps.** Two half-steps left a weakly damped stiff residual of about 1e-5 c0 in Crank–Nicolson. Four reduce it to about 1e-8, as Giles & Carter (2006) analyse for non-smooth data.

**Cost.** The start-up adds 28 solves (30 for Crank–Nicolson), 1.4% of the reference run. It leaves the error away from the initial layer unchanged: at τ = 0.1 the error moves only from −5.34e-6 to −4.99e-6. `SolverOptions` can change these numbers; `startup_substeps = 1` turns the start-up off.

### 4.3 Mass accounting

**Accumulation.** The released fraction is accumulated with each scheme's own time discretisation (the table in §4.1). Sub-steps and half-steps contribute with their own sizes. BDF2's recurrence runs in increment form, $\delta^{n+1}=(\delta^n+2hf^{n+1})/3$, which avoids cancellation.

**Conservation.** The column sums of K are $G_s e_{N-1}$, so for every scheme

$$\sum_j V_j c_j^{n}+M_0R^n=M_0$$

holds exactly in exact arithmetic. For BDF2 the combined quantity obeys the BDF2 recurrence itself, whose roots are 1 and 1/3, so round-off does not grow.

**Measurement.** `mass_balance_error` is the largest value over the output times of

$$\Big|R^n-\frac{M_0-\sum_jV_jc_j^n}{M_0}\Big| .$$

The sums use Neumaier's compensated summation (Neumaier 1974), so the number measures the solver's conservation, not the summation.

### 4.4 Linear algebra and cost

**Factorisations.** Each run factorises at most three constant tridiagonal matrices before the time loop. Backward Euler needs one per step size. BDF2 adds the backward-Euler matrix for its first step. Crank–Nicolson needs one per step size; its half-steps share it.

**Solver.** `linalg::TridiagonalLu` stores reciprocal pivots and the scaled super-diagonal, so one solve is two sweeps of a few flops per row.

**Loop.** The time loop does not allocate: buffers are swapped, and the output vectors are pre-sized.

### 4.5 Floating-point formulation

The systems are solved for the new concentrations themselves.

**Why this form.** For an M-matrix with non-negative data, Thomas elimination never subtracts: every intermediate value is non-negative. That gives two guarantees:
1. **Positivity.** Backward Euler stays non-negative *in floating point*, not just in exact arithmetic.
2. **Accuracy.** Every component has small *relative* error, including a nearly depleted outer shell.

Point 2 is what keeps the surface flux $G_s c_{N-1}$ accurate when a step is very stiff.

**The alternative tried.** Solving for the increment Δc instead, with a flux-form right-hand side, had real advantages:
- the reference-case mass balance improved from 5e-14 to 2e-16;
- the round-off drift described below disappeared.

But it failed badly on stiff steps. With 100 000 shells, one step of τ = 1e6 released 59% instead of 100%, and τ = 1e200 gave a "released fraction" of 1e192. The increment form computes $c^{n+1}_{N-1}=c^n_{N-1}+\Delta$ by cancellation, so the outer concentration loses its relative accuracy. It was therefore rejected. The concentration form gives $1-2\times10^{-9}$ at τ = 1e200, with c ≥ 0 exactly.

**The price.** Shells that barely change pick up the same rounding every step and drift by about $n_\text{steps}\,\varepsilon$: at most 3.6e-13 above $c_0$ after 2000 steps in our probes.

### 4.6 Determinism

**The problem.** With Rust 1.99, `f64::exp` calls the platform's maths library: glibc natively (`exp@GLIBC_2.29`) and a musl-derived port in WebAssembly. The two can differ in the last bit.

**`cbrt` today.** `f64::cbrt` comes from Rust's own compiler-builtins on both targets, so it would agree today. That is a toolchain detail which could change, so the core does not rely on it either (defence in depth).

**The fix.** `puckcore::math` implements both from IEEE-754 basic operations only, which every platform rounds identically, plus bit manipulation:
- **`exp`:** Cody–Waite range reduction and a degree-13 Taylor polynomial.
- **`cbrt`:** a bit-level first estimate, then five Newton steps in correction form.

Rust never fuses or reorders floating-point operations by itself. The shipped Python extension and WebAssembly module import no maths functions at all.

**Accuracy.** The goal is determinism, not correct rounding. Measured against mpmath:
- **`exp`:** the largest error found is 1.16 ulp (1.15 ulp over 10⁶ random arguments). About 90% of results are correctly rounded, so it differs from glibc in the last bit for about 10% of arguments (10.5% of those the analytic solution uses).
- **`cbrt`:** the largest error found is 0.73 ulp. About 91% of results are correctly rounded, and perfect cubes come out exact.

The unit tests check both against exact references: correctly rounded values for `exp`, and exact integer residuals for `cbrt`. They never compare with the standard library, whose accuracy varies by platform; glibc's own `cbrt` errs by up to about 3 ulp.

**Result.** Native and WebAssembly builds are bit-identical (§6.9).

## 5. Interfaces

The binding contracts are unchanged from the M0 skeleton (`simulateSphereRelease` and `crankSphereReleaseFraction` in JavaScript; `puckcore.simulate_sphere_release` and `crank_sphere_release_fraction` in Python). The Rust core adds:
- **`simulate_sphere_release_with(params, &SolverOptions)`.** It returns the result and `SolverDiagnostics`: the smallest concentration at any step, and the number of linear solves.
- **`SolverOptions`.** Fields `startup_intervals` (default 4), `startup_substeps` (8, from 1 to 1024) and `rannacher_steps` (2).
- **`linalg::TridiagonalLu`.** `new`, `refactor` and `solve_in_place`, plus `tridiagonal_mul`.
- **`math::exp` and `math::cbrt`.**

**Validation.** Inputs must be finite and positive, with 2 ≤ N ≤ 100 000 and 1 ≤ steps ≤ 10⁷, as in the contract. One check is new: $D t_\text{end}/a^2$ must not exceed 1e200 (overflow). Its error names `t_end_s`.

**Evaluating τ.** τ is computed as (D·t)/(a·a), the original order, so ordinary inputs give the same bits as before. If either product leaves the normal range, it switches to (D/a)·(t/a). Extreme but valid inputs therefore work; for example D = 1e300, t = 1e10, a = 1e155 gives τ = 1 instead of ∞/∞.

**Output times.** They are $t_k=(k/n)\,t_\text{end}$, so the last one is exactly $t_\text{end}$.

## 6. Verification (measured)

**Commands.** `cargo test` asserts every number in this section in a CI-sized form. `cargo run --release -p puckcore --example sphere_verification` prints the full tables. The workstream-C report ([docs/validation/m0-kernel-verification.md](../validation/m0-kernel-verification.md), from `puckworks-tools verify`) repeats the analysis independently from Python.

**Setup.** Measured on an AMD Ryzen 9 7945HX, Rust 1.99.0 release build. Errors are numerical minus analytic released fraction.

### 6.1 Method

| aspect | how it is measured |
|---|---|
| space orders | refine N at 20 000–30 000 BDF2 steps, so the time error (< 1e-9) is negligible |
| time orders | refine the step at 256 equal-volume shells, against the same discretisation run with 102 400 BDF2 steps, which isolates the time error |
| where | at τ = 0.1 and 0.3, away from the initial layer |
| also reported | the max error over all outputs |
| other checks | conservation and positivity over a 480-case sweep: 2 grids × 3 schemes × N ∈ {2, 7, 64, 300} × τ_end ∈ {0.001, 0.03, 0.267, 1, 5} × steps ∈ {1, 3, 50, 2000}; conservation also at N = 600 and 2000 |

### 6.2 Reference case

The reference case is a = 150 µm, D = 1e-10 m²/s, t_end = 60 s (τ_end = 0.267), 64 shells and 2000 steps.

| grid | scheme | max abs error | error at τ = 0.1 | mass balance | min c/c0 |
|---|---|---|---|---|---|
| equal volume | backward Euler | 1.115e-3 | −1.82e-4 | 1.3e-14 | 3.76e-4 |
| **equal volume** | **BDF2** | **5.141e-4** | **−4.99e-6** | **5.4e-14** | 3.76e-4 |
| equal volume | Crank–Nicolson | 5.401e-4 | −5.17e-6 | 1.9e-14 | 3.76e-4 |
| uniform radius | backward Euler | 5.959e-3 | −1.38e-4 | 3.6e-15 | 1.11e-3 |
| uniform radius | BDF2 | 5.245e-3 | +3.95e-5 | 2.9e-14 | 1.11e-3 |
| uniform radius | Crank–Nicolson | 5.252e-3 | +3.93e-5 | 4.4e-15 | 1.11e-3 |

The M0 target, max abs error < 1e-3 for equal volume and BDF2, is met at 5.1e-4. The placeholder solver gave 1.03e-2.

### 6.3 What the maximum error measures

**Where it occurs.** In every row above, the largest error sits at the first output, t = Δt. There the boundary layer, $\sqrt{D\Delta t}$ = 1.7 µm, spans only about two outer shells: 0.78 µm on the equal-volume grid, 2.3 µm on the uniform one.

**Empirical law.** Once the time error is controlled, it follows

$$\max|\text{error}|\approx \frac{C}{N^2\sqrt{\Delta\tau}},\qquad C\approx0.022\ \text{(equal volume)},\quad 0.19\ \text{(uniform radius)},$$

with C fitted to the exact-in-time spatial error at the first output for N = 64 to 1024. It holds for shells thinner than $\sqrt{D\Delta t}$; the uniform grid at N = 64 is not, and gives C = 0.24. The ratio of the two constants, about 9, is the square of the outer-shell thickness ratio.

**Consequences.**
- **No convergence in Δt at fixed N.** The first output moves earlier as Δt shrinks: 20 000 steps give 1.97e-3 with 64 shells.
- **Order ½ at fine N.** With very many shells the first-output error becomes a time error. Because of the √t singularity it scales like $\sqrt{\Delta\tau}$, for every scheme; the start-up cuts its constant by more than an order of magnitude but cannot change the order. The workstream-C report shows exactly this: an order of 0.50 for the max error at N = 65 536.
- **Not a test of the time scheme.** The orders below are measured at fixed τ instead.
- **Choosing a grid.** To keep the early-time error below ε, use $N\gtrsim\sqrt{0.022/(\varepsilon\sqrt{\Delta\tau})}$ equal-volume shells.

**Start-up ablation** (reference case, equal volume):

| scheme | start-up | max abs error (at step 1) | error at τ = 0.1 |
|---|---|---|---|
| backward Euler | default (4 × 8) | 1.115e-3 | −1.82e-4 |
| backward Euler | none | 5.271e-3 | −1.83e-4 |
| BDF2 | default (4 × 8) | 5.141e-4 | −4.99e-6 |
| BDF2 | none | 5.271e-3 | −5.34e-6 |
| Crank–Nicolson | default (4 × 8) | 5.401e-4 | −5.17e-6 |
| Crank–Nicolson | none (Rannacher only) | 2.980e-3 | −5.40e-6 |

### 6.4 Convergence in space

BDF2 with 20 000 steps (τ = 0.1) and 30 000 steps (τ = 0.3). The order is $\log_2$ of successive error ratios.

| N | equal volume, τ = 0.1 | order | uniform radius, τ = 0.1 | order | equal volume, τ = 0.3 | order | uniform radius, τ = 0.3 | order |
|---|---|---|---|---|---|---|---|---|
| 8 | −2.448e-4 | – | +2.535e-3 | – | +3.891e-4 | – | +5.917e-4 | – |
| 16 | −7.131e-5 | 1.78 | +6.297e-4 | 2.01 | +1.019e-4 | 1.93 | +1.478e-4 | 2.00 |
| 32 | −1.958e-5 | 1.86 | +1.572e-4 | 2.00 | +2.638e-5 | 1.95 | +3.695e-5 | 2.00 |
| 64 | −5.224e-6 | 1.91 | +3.928e-5 | 2.00 | +6.775e-6 | 1.96 | +9.238e-6 | 2.00 |
| 128 | −1.370e-6 | 1.93 | +9.819e-6 | 2.00 | +1.730e-6 | 1.97 | +2.310e-6 | 2.00 |
| 256 | −3.551e-7 | 1.95 | +2.455e-6 | 2.00 | +4.400e-7 | 1.98 | +5.777e-7 | 2.00 |
| 512 | −9.107e-8 | 1.96 | +6.140e-7 | 2.00 | +1.116e-7 | 1.98 | +1.446e-7 | 2.00 |
| 1024 | −2.303e-8 | 1.98 | +1.537e-7 | 2.00 | +2.842e-8 | 1.97 | +3.638e-8 | 1.99 |

**Second order on both grids.**
- **Equal-volume order.** It approaches 2 from below as a weaker correction from the coarse central shells fades.
- **Error size.** At equal N the equal-volume grid is 7× more accurate at τ = 0.1, and at τ = 0.3 the two grids are comparable.

`cargo test` asserts orders between 1.8 and 2.2 for N = 32 to 256.

### 6.5 Convergence in time

256 equal-volume shells, error at τ = 0.1 against the 102 400-step reference. The reference's own spatial error, −3.55e-7, cancels out.

| steps | Δτ | BE error | order | BDF2 error | order | CN error | order | max abs error vs analytic: BE / BDF2 / CN |
|---|---|---|---|---|---|---|---|---|
| 25 | 4.0e-3 | −4.559e-3 | – | +1.867e-4 | – | +4.214e-5 | – | 5.4e-3 / 6.5e-4 / 3.2e-4 |
| 50 | 2.0e-3 | −2.477e-3 | 0.88 | +4.981e-5 | 1.91 | +1.160e-5 | 1.86 | 3.8e-3 / 4.6e-4 / 2.3e-4 |
| 100 | 1.0e-3 | −1.288e-3 | 0.94 | +1.282e-5 | 1.96 | +3.032e-6 | 1.94 | 2.7e-3 / 3.2e-4 / 1.7e-4 |
| 200 | 5.0e-4 | −6.559e-4 | 0.97 | +3.251e-6 | 1.98 | +7.746e-7 | 1.97 | 1.9e-3 / 2.3e-4 / 1.3e-4 |
| 400 | 2.5e-4 | −3.309e-4 | 0.99 | +8.184e-7 | 1.99 | +1.957e-7 | 1.98 | 1.3e-3 / 1.6e-4 / 1.0e-4 |
| 800 | 1.25e-4 | −1.662e-4 | 0.99 | +2.053e-7 | 2.00 | +4.919e-8 | 1.99 | 9.6e-4 / 1.1e-4 / 8.7e-5 |
| 1600 | 6.25e-5 | −8.330e-5 | 1.00 | +5.140e-8 | 2.00 | +1.232e-8 | 2.00 | 6.8e-4 / 6.8e-5 / 8.4e-5 |

**Orders.** Backward Euler is first order, and BDF2 and Crank–Nicolson second order. Crank–Nicolson's error constant is 4× smaller than BDF2's.

**Max-error column.** It falls more slowly than the error at τ = 0.1. For Crank–Nicolson it stops falling at 8e-5: with 256 shells the first-output spatial error takes over (§6.3).

`cargo test` checks these orders at 128 shells, within ±0.15 of 1, 2 and 2.

### 6.6 Mass balance

| case | BE | BDF2 | CN |
|---|---|---|---|
| reference, equal volume | 1.3e-14 | 5.4e-14 | 1.9e-14 |
| reference, uniform radius | 3.6e-15 | 2.9e-14 | 4.4e-15 |
| 2 shells, 1 step, τ_end = 5 | 2.2e-16 | 4.4e-16 | 1.1e-16 |
| 1000 shells, 100 000 steps, τ_end = 1 | 1.6e-12 | 5.7e-12 | 5.7e-12 |
| 100 000 shells, 20 steps, τ_end = 0.1 | 1.5e-8 | 2.8e-8 | 1.1e-8 |

**Where it comes from.** Conservation holds exactly in exact arithmetic. What remains is the solves' backward error: about $\varepsilon(1+h\sum_jG_j/M_0)$ per solve with $|c|\le1$, where $\sum_jG_j/M_0$ grows like $N^2$. So the error grows with the number of shells, with the step's stiffness, and slowly with the number of steps (about 5e-17 per step for 1000 shells). Summed over a run, that gives the bound

$$\text{mass balance}\le4\,\varepsilon\;n_\text{solves}\,(1+\Delta\tau\,N^2).$$

**Measured against the bound.** Over 1080 runs, the largest error is at most 34% of the bound:
- N = 2–5000 on both grids, all schemes;
- τ_end from 0.001 to 5;
- 1 to 2000 steps.

The largest value is 8.0e-13 for N ≤ 300 and 3.5e-11 at N = 2000. `cargo test` asserts the bound on 502 of these runs, including N = 600 and 2000.

**Against the target.** Even 100 000 shells stay more than four orders of magnitude inside the PLAN §10 target of 0.1% per run.

### 6.7 Positivity

Smallest c/c0 at any step, sub-steps included:

| case | BE | BDF2 | CN |
|---|---|---|---|
| reference, equal volume | +3.76e-4 | +3.75e-4 | +3.75e-4 |
| reference, uniform radius | +1.11e-3 | +1.11e-3 | +1.11e-3 |
| 64 EV shells, τ_end = 0.267, 1 step | +5.41e-4 | +3.67e-4 | +3.87e-4 |
| 64 EV shells, τ_end = 2.67, 2000 steps | +2.2e-14 | +1.9e-14 | +1.9e-14 |
| 256 EV shells, τ_end = 2.67, 2000 steps | +5.6e-15 | +4.7e-15 | −6.5e-11 |
| 64 EV shells, τ_end = 2.67, 20 steps (π²Δτ = 1.3) | +5.7e-11 | −1.41e-3 | −9.4e-8 |
| 64 EV shells, τ_end = 2.67, 1 step | +4.5e-8 | −4.37e-2 | −9.0e-3 |

**Backward Euler** is always ≥ 0, in floating point (§4.5).

**BDF2 and Crank–Nicolson** are not positivity preserving. In the sweep and in the probes above, they stay ≥ −1e-10 under these conditions:
- **BDF2:** the step resolves the slowest decay, Δτ ≤ 0.04 (π²Δτ ≤ 0.4), at any τ. Below π²Δτ = 1/2 its roots for the slow mode are real and positive; probes stayed positive out to τ = 50.
- **Crank–Nicolson:** the same step condition, and also τ ≤ 1, while c is still above about 1e-4.

**Long steps.** A step comparable to the decay time ($e^{-\lambda\Delta\tau}<1/4$) makes the BDF2 right-hand side $4c^n-c^{n-1}$ negative. Both schemes then damp the slowest mode with oscillation. The worst case seen is −4.4e-2, one step of τ = 2.67 when the sphere is already empty.
- **Coarse grids.** Their slowest discrete mode is faster than π², so 2-shell BDF2 already undershoots at Δτ = 0.05.

**Late times (Crank–Nicolson only).** Crank–Nicolson is A-stable, not L-stable, so stiff modes decay slowly: $|R(z)|\to1$. After the Rannacher steps a residual of about 1e-8 c0 is left. It shows up as small negative values once the true solution falls below it, around τ ≳ 1.5, even with small steps. BDF2 is L-stable and has no such residual.

**Choice of scheme.** The Python default, BDF2, is the better choice for long runs.

### 6.8 Determinism, scaling and validation

All of these are asserted in `cargo test`:
- **Determinism.** Repeated runs are bit-identical.
- **Scaling.** Power-of-two rescalings that keep $Dt/a^2$, such as (2a, 4t) and (8D, t/8), give bit-identical results. Rescalings by 3 and 7 agree within 1e-13, and the shell radii scale with a.
- **Validation.** Every invalid parameter is rejected with an error naming it. The limits themselves (N = 2 and 100 000; one step) are accepted.

### 6.9 Native versus WebAssembly

**Method.** Python (native, PyO3) and Node 26 (WebAssembly, wasm-bindgen 0.2.129) were run on the reference case for all six grid × scheme combinations. 300 further random parameter sets covered N from 2 to 2000, 1 to 500 steps, both grids and all schemes.

**Result.** **All 255 640 output values were bit-identical**, as were the error messages for invalid input. That is far inside the PLAN §10 target of 1e-9 relative. An independent review found the same over 893 206 values.

### 6.10 Timings

Median wall time per call:

| case | native Rust | Python binding | WebAssembly (Node 26) |
|---|---|---|---|
| 64 shells × 2000 steps (reference, BDF2) | 0.63 ms | 0.68 ms | 0.72 ms |
| 1024 shells × 20 000 steps (BDF2) | 92 ms | – | – |

**Breakdown.** These times include the analytic solution at every output and the per-output mass-balance check. Backward Euler and Crank–Nicolson cost the same within 3%.

**Size.** The release WebAssembly module is 49.9 KB.

## 7. Limitations

- **Model.** The kernel assumes a perfect sink, constant D and a uniform initial concentration in a spherical particle. M1 replaces the sink with a flux coupled to the bed liquid and adds the surface pool. The grids and the time integration carry over.
- **Early-time error.** The early-time error is set by the spatial resolution of the boundary layer at the first output (§6.3). The start-up refinement fixes the time error there, not the spatial one.
- **Start-up length.** With very coarse runs (about 20 steps), the error just after the switch back to the user's step is still about 1e-3 with BDF2. Eight start-up intervals would halve it.
- **Positivity.** BDF2 and Crank–Nicolson are not positivity preserving for long steps (Δτ > 0.04), and Crank–Nicolson also undershoots by about 1e-8 c0 at late times (τ ≳ 1.5) even with small steps (§6.7). Backward Euler is the safe choice for very coarse steps; BDF2 for long runs.
- **Mass balance** grows with N × step stiffness, as $4\varepsilon\,n_\text{solves}(1+\Delta\tau N^2)$ at most. It reaches about 1e-8 at 100 000 shells (§6.6).
- **Round-off drift.** Shells that barely change drift by about $n_\text{steps}\varepsilon$ (§4.5).

## References

- Cody WJ, Waite W (1980) *Software Manual for the Elementary Functions.* Prentice-Hall.
- Crank J (1975) *The Mathematics of Diffusion*, 2nd ed. Oxford University Press. §6.3, eqs. 6.20 and 6.21.
- Giles MB, Carter R (2006) Convergence analysis of Crank–Nicolson and Rannacher time-marching. *J Comput Finance* 9(4):89–112.
- Glueckauf E (1955) Formulae for diffusion into spheres and their application to chromatography. *Trans Faraday Soc* 51:1540–1551. doi:10.1039/TF9555101540
- Higham NJ (2002) *Accuracy and Stability of Numerical Algorithms*, 2nd ed. SIAM. Ch. 4 (summation) and ch. 9 (LU factorisation, including tridiagonal matrices).
- Neumaier A (1974) Rundungsfehleranalyse einiger Verfahren zur Summation endlicher Summen. *Z Angew Math Mech* 54:39–51.
- Rannacher R (1984) Finite element solution of diffusion problems with irregular data. *Numer Math* 43:309–327.
- Research note 01, [§3.2](../research/01-extraction-and-flow-physics.md#32-generic-multiscale-formulation-common-core) (formulation) and [§10](../research/01-extraction-and-flow-physics.md#10-numerics-for-a-browser) (browser numerics).
