// SPDX-License-Identifier: GPL-2.0-or-later
/** M2 physical cup outputs, kept separate from sensory predictions. */
import type { ReactNode } from 'react';
import { HelpButton } from '../help/HelpButton';
import {
  celsius,
  fixed,
  grams,
  milligrams,
  millilitres,
  percent,
  sig,
  speciesName,
} from './format';
import type { ShotOutcome } from './shotStore';

function Metric({
  label,
  term,
  value,
  hint,
}: {
  label: string;
  term: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="tile">
      <dt>
        {label}
        <HelpButton term={term} label={label} />
      </dt>
      <dd>
        <span className="tile-value">{value}</span>
        {hint && <span className="tile-hint">{hint}</span>}
      </dd>
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="advanced chemistry-detail">
      <summary>{title}</summary>
      {children}
    </details>
  );
}

export function CupChemistryPanel({ outcome }: { outcome: ShotOutcome | null }) {
  const chemistry = outcome?.result.chemistry;
  if (!chemistry)
    return (
      <p className="note">
        {outcome
          ? 'This result has no cup chemistry. Enable cup chemistry and run the recipe again.'
          : 'Cup chemistry appears after the first run.'}
      </p>
    );
  const { acidity, aroma, texture, refractometer, mass_closure: closure } = chemistry;
  const name = (id: string) => speciesName(id, outcome?.build.derived.compounds);
  return (
    <div className="panel-stack cup-chemistry" aria-label="Cup chemistry results">
      <div>
        <h4>
          Estimated cup chemistry
          <HelpButton term="output.cup.chemistry" />
        </h4>
      </div>
      {outcome?.build.spec.chemistry && (
        <p className="note">
          Cup conditions: {fixed(outcome.build.spec.chemistry.aroma_age_s, 0)} s after extraction;
          closed headspace {millilitres(outcome.build.spec.chemistry.cup_headspace_m3)} at{' '}
          {celsius(chemistry.reference_temp_c, 0)}.
        </p>
      )}
      <dl className="tiles" aria-label="Cup chemistry summary">
        <Metric
          label="Estimated cup pH"
          term="output.cup.ph"
          value={fixed(acidity.ph, 2)}
          hint={`Acid-base balance at ${celsius(chemistry.reference_temp_c, 0)}; ${acidity.ph === null ? 'no charge-balance root' : 'intrinsic-pH charge closure'}`}
        />
        <Metric
          label="Titratable acidity to pH 6.6"
          term="output.cup.titratable"
          value={`${fixed(acidity.titratable_acidity_mmol_l_to_ph_6_6, 2)} mmol/L`}
          hint="Base equivalents needed to reach the endpoint"
        />
        <Metric
          label="Titratable acidity to pH 8.0"
          term="output.cup.titratable"
          value={`${fixed(acidity.titratable_acidity_mmol_l_to_ph_8, 2)} mmol/L`}
        />
        <Metric
          label="Lipid emulsion"
          term="output.cup.lipid"
          value={milligrams(texture.lipid_mass_kg)}
          hint={`${sig(texture.lipid_concentration_g_l)} g/L; excluding listed diterpenes; a separate phase`}
        />
        <Metric
          label="Recovered CO₂"
          term="output.cup.co2"
          value={milligrams(texture.co2_recovered_mass_kg)}
        />
        <Metric
          label="Crema volume proxy"
          term="output.cup.crema"
          value={millilitres(texture.crema_volume_proxy_m3)}
          hint={`${millilitres(texture.crema_gas_volume_m3)} gas; not a measured foam volume`}
        />
      </dl>
      <section aria-labelledby="refractometer-title">
        <h4 id="refractometer-title">
          Estimated refractometer reading
          <HelpButton term="output.cup.apparent-tds" label="Estimated refractometer reading" />
        </h4>
        <dl className="tiles">
          <Metric
            label="Apparent TDS"
            term="output.cup.apparent-tds"
            value={percent(refractometer.apparent_tds, 2)}
            hint={`Sample ${celsius(refractometer.sample_temp_c, 0)}; reference ${celsius(refractometer.reference_temp_c, 0)}`}
          />
          <Metric
            label="True coffee TDS"
            term="output.cup.true-tds"
            value={percent(refractometer.coffee_true_tds, 2)}
            hint="Dissolved coffee solids by mass"
          />
          <Metric
            label="Coffee-equivalent TDS at reference"
            term="output.cup.equivalent-tds"
            value={percent(refractometer.coffee_equivalent_tds_at_reference, 2)}
            hint="Composition-dependent instrument estimate"
          />
          <Metric
            label="Water mineral TDS"
            term="output.cup.mineral-tds"
            value={percent(refractometer.water_mineral_tds, 3)}
            hint={
              refractometer.mineral_blank_subtracted
                ? 'Mineral blank subtracted from the reading'
                : 'Minerals included in the reading'
            }
          />
        </dl>
        <p className="note">
          The estimated temperature contribution is {percent(refractometer.temperature_bias, 3)}{' '}
          TDS.
          <HelpButton term="output.cup.temperature-bias" />
        </p>
      </section>
      <Disclosure title={`Aroma partitioning and thiol binding (${aroma.length} compounds)`}>
        <p className="note">
          Headspace and liquid concentrations use their own phase volumes. The water-threshold ratio
          is a concentration ratio; it is not a sensory prediction for espresso.
        </p>
        <div className="table-wrap">
          <table aria-label="Aroma partitioning">
            <thead>
              <tr>
                <th scope="col">Compound</th>
                <th scope="col">
                  Liquid (µg/L)
                  <HelpButton term="output.aroma.liquid" />
                </th>
                <th scope="col">
                  Headspace (µg/L)
                  <HelpButton term="output.aroma.headspace" />
                </th>
                <th scope="col">
                  Bound mass
                  <HelpButton term="output.aroma.bound" />
                </th>
                <th scope="col">
                  Water-threshold ratio
                  <HelpButton term="output.aroma.threshold" />
                </th>
              </tr>
            </thead>
            <tbody>
              {aroma.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{name(s.id)}</th>
                  <td>{sig(s.liquid_concentration_ug_l)}</td>
                  <td>{sig(s.headspace_concentration_ug_l)}</td>
                  <td>{sig(s.bound_mass_kg * 1e9)} µg</td>
                  <td>{sig(s.odor_activity_ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
      <Disclosure title="Acid speciation">
        <p className="note">
          Brew-water alkalinity contribution: {sig(acidity.water_alkalinity_mmol_l)} mmol/L. Acid
          concentrations describe the estimated cup inventory, not perceived acidity.
        </p>
        <div className="table-wrap">
          <table aria-label="Acid speciation">
            <thead>
              <tr>
                <th scope="col">Acid</th>
                <th scope="col">
                  Total (mmol/L)
                  <HelpButton term="output.acid.total" />
                </th>
                <th scope="col">
                  Mean charge
                  <HelpButton term="output.acid.charge" />
                </th>
                <th scope="col">
                  Ionized fraction
                  <HelpButton term="output.acid.ionized" />
                </th>
              </tr>
            </thead>
            <tbody>
              {acidity.acids.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{name(s.id)}</th>
                  <td>{sig(s.total_mol_l * 1e3)}</td>
                  <td>{fixed(s.mean_charge, 2)}</td>
                  <td>{percent(s.ionized_fraction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
      <Disclosure title="Separate phase inventories">
        <div className="table-wrap">
          <table aria-label="Separate phase inventories">
            <thead>
              <tr>
                <th scope="col">Phase or compound</th>
                <th scope="col">
                  Available
                  <HelpButton term="output.phase.available" />
                </th>
                <th scope="col">
                  In the cup
                  <HelpButton term="output.phase.cup" />
                </th>
                <th scope="col">
                  Retained
                  <HelpButton term="output.phase.retained" />
                </th>
              </tr>
            </thead>
            <tbody>
              {chemistry.phases.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{name(s.id)}</th>
                  <td>{milligrams(s.available_mass_kg)}</td>
                  <td>{milligrams(s.cup_mass_kg)}</td>
                  <td>{milligrams(s.retained_mass_kg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
      <Disclosure title="Dissolved-solids accounting">
        <p>
          About these consistency checks
          <HelpButton term="output.accounting" />
        </p>
        <dl className="chemistry-accounting">
          <div>
            <dt>
              Lumped solubles in the cup
              <HelpButton term="output.accounting" label="Lumped solubles in the cup">
                <p>
                  The total dissolved-coffee mass from the overall extraction model: beverage mass
                  multiplied by true coffee TDS.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.lumped_solubles_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Quantified dissolved species
              <HelpButton term="output.accounting" label="Quantified dissolved species">
                <p>
                  The sum of the named dissolved compounds tracked individually. It does not
                  identify all material in the drink.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.quantified_dissolved_species_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Unassigned dissolved solubles (accounting remainder)
              <HelpButton term="output.accounting" label="Unassigned dissolved solubles">
                <p>
                  The nonnegative difference between overall solubles and the sum of named dissolved
                  compounds. This bookkeeping remainder does not identify its chemical composition.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.unassigned_solubles_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Independently transported unassigned solubles
              <HelpButton
                term="output.accounting"
                label="Independently transported unassigned solubles"
              >
                <p>
                  Unassigned material carried by its own transport calculation. Unlike the
                  accounting remainder, it is not defined by subtracting the other reported totals.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.transport_unassigned_solubles_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Transported dissolved total (named + unassigned)
              <HelpButton term="output.accounting" label="Transported dissolved total">
                <p>
                  The sum of individually transported named compounds and independently transported
                  unassigned material, for comparison with the overall dissolved-coffee calculation.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.transported_dissolved_species_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Relative transport closure error
              <HelpButton term="output.accounting" label="Relative transport closure error">
                <p>
                  The relative mismatch between the transported dissolved total and the overall
                  dissolved-coffee calculation. It is a consistency diagnostic, not measurement
                  uncertainty.
                </p>
              </HelpButton>
            </dt>
            <dd>{sig(closure.relative_transport_closure_error)}</dd>
          </div>
          <div>
            <dt>
              Species exceeding lumped solubles
              <HelpButton term="output.accounting" label="Species exceeding lumped solubles">
                <p>
                  The amount by which named dissolved species would exceed the overall solubles
                  total. A positive value signals inconsistent composition or transport assumptions.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.overassigned_solubles_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Excluded diagnostic mass
              <HelpButton term="output.accounting" label="Excluded diagnostic mass">
                <p>
                  Mass assigned to diagnostic or overlapping aggregate tracers. It is excluded from
                  the dissolved-species sum to avoid double counting.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.excluded_diagnostic_mass_kg, 3)}</dd>
          </div>
          <div>
            <dt>
              Separate phase inventory
              <HelpButton term="output.accounting" label="Separate phase inventory">
                <p>
                  Material reported separately as oil, gas or other non-dissolved phases. It is not
                  added to dissolved coffee TDS.
                </p>
              </HelpButton>
            </dt>
            <dd>{grams(closure.phase_inventory_mass_kg, 3)}</dd>
          </div>
        </dl>
        <p className="note">
          The species are diagnostic tracers beside the lumped extraction model. Unassigned material
          is not identified by this catalogue; diagnostic, lipid and gas masses are excluded from
          the dissolved-species sum.
        </p>
      </Disclosure>
      {chemistry.warnings.length > 0 && (
        <div className="run-warning" role="note">
          <p className="build-notes-title">Cup chemistry assumptions:</p>
          <ul>
            {chemistry.warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
