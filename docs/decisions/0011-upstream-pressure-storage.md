<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 0011 — Optional upstream pressure storage

**Status:** Accepted as an experimental, opt-in closure, 2026-10-16.

## Context

The [community comparison](../validation/community-shot-comparison.md) found continued cup gain
during a positive low-flow bloom. The algebraic solver has no charged water inventory: commanding
zero flow removes pressure and outflow immediately. Replaying observed pressure supplies virtual
pump water, so its pressure agreement cannot test a storage mechanism. The experiment lacks
independently measured inlet flow, PSD and headspace; it does not identify a compliance value.

## Decision

Add `machine.hydraulic_compliance_m3_pa`, C ≥ 0, with C = 0 preserving the existing algebraic
solver. The recipe registry exposes `model.machine.hydraulic_compliance` in mL/bar, default 0,
grade D and estimated. Its 0–10 mL/bar range is an implementation bound, not a measured prior.
The conversion is 1 mL/bar = 10⁻¹¹ m³/Pa.

For C > 0, after the existing sequential headspace fill, track gauge pressure P and charged
carrier volume V = C P. Start uncharged and conserve

$$C\,\frac{dP}{dt}=Q_\mathrm{pump}-Q_\mathrm{bed}(P).$$

Use backward Euler for pressure on the predicted end-of-step bed curve. The scalar balance
is monotone; a bracketed solve stays stable at small positive C. The same accepted bed volume
advances the wetting front and enters transport. Pump volume is accounted separately. Rollback
restores pressure as well as the front and water inventories when a transport or mass-event
step is retried. This is first-order pressure integration with a frozen predicted front,
not a fully coupled implicit front/pressure solve.

Pressure caps throttle incoming water and act with a check valve: they do not drain storage.
A lowered command can therefore leave the bed temporarily above the command while stored
water drains. A pump pause permits outflow without fictitious inlet delivery. This boundary
does not model an active relief valve; the pump's OPV field also remains an inlet cap.

At the final stop, a vent discharges headspace plus charged storage and sets stored pressure
to zero. Without a vent, charged storage alone feeds the tail. Unpressurised headspace remains
retained; there is no gravity drainage. `drip_tau_s` keeps its existing input shape, but for
C > 0 it sets only an observation horizon of 8τ, not the pressure-decay constant. A zero
horizon ends observation immediately, retaining any unspent storage in the volume account.

Expose cumulative inlet, outlet and vented carrier volumes, charged storage and total retained
volume in every result. Their identity is

$$V_\mathrm{in}=V_\mathrm{out}+V_\mathrm{vent}
 +V_\mathrm{headspace}+\phi_T\sum_i W_i+C P.$$

These are hydraulic carrier volumes, not exact solvent masses. Cup grams include dissolved
solids. Use cumulative-volume differences for interval diagnostics instead of integrating
sampled instantaneous flows. Stop inventories include the instantaneous vent at its timestamp.

## Consequences

- Default recipes and the v2 fit keep zero compliance; no coefficients or scientific gates change.
- The fixed community grid compares C = 0, 0.5 and 2 mL/bar, with no best-fit selection. Pressure
  replays retain C = 0. Reduced steps check the opt-in result's numerical sensitivity.
- A linear compliance can test the storage structure but cannot identify headspace gas, machine
  elasticity, puck deformation or water exchange. It also omits a separate storage thermal node,
  nonlinear gas compression, simultaneous filling/infiltration and active pressure relief.
- Analytical RC charging/discharging, pump limits, pauses/resumption, partial wetting, vents,
  mass and pressure events, rejected steps and native/WASM fixtures verify the implementation.
  Conservation and convergence do not establish experimental accuracy.

## Alternatives considered

Fitting the pore-air mobility coefficient to bloom cup mass could hide missing water storage.
Prescribing a pressure-decay curve during the pause would again require an unaccounted source
unless accompanied by a water inventory. A resolved gas/liquid or mobile/immobile-water model
needs additional evidence to constrain its parameters; it remains future work.
