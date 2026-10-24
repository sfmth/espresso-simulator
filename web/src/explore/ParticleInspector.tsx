// SPDX-License-Identifier: GPL-2.0-or-later
import { HelpButton, HelpField } from '../help/HelpButton';
import { useId } from 'react';
import type { ParticleProfile } from './microstructure';
export function ParticleInspector({
  profile,
  index,
  count,
  onSelect,
  ey,
  playing = false,
}: {
  profile: ParticleProfile | null;
  index: number;
  count: number;
  onSelect: (index: number) => void;
  ey: number | null;
  playing?: boolean;
}) {
  const eyId = useId();
  const values = profile?.concentrationKgM3;
  const max = Math.max(1, ...(values ?? []));
  const points = profile
    ? Array.from(
        profile.radiusFraction,
        (r, i) => `${40 + r * 300},${180 - (profile.concentrationKgM3[i] / max) * 150}`,
      ).join(' ')
    : '';
  return (
    <section
      className="panel panel-stack particle-inspector"
      aria-labelledby="particle-inspector-title"
    >
      <h3 id="particle-inspector-title">
        Particle inspector
        <HelpButton term="ey" label="Particle extraction yield" />
      </h3>
      <HelpField label="Particle number" term="visual-selection">
        <input
          type="number"
          min={1}
          max={count}
          value={index + 1}
          aria-describedby={eyId}
          onChange={(e) =>
            onSelect(Math.max(0, Math.min(count - 1, Math.round(Number(e.target.value)) - 1)))
          }
        />
      </HelpField>
      <p id={eyId} aria-live={playing ? 'off' : 'polite'} aria-atomic="true">
        Particle {index + 1} extraction yield:{' '}
        {ey !== null && Number.isFinite(ey)
          ? `${(ey * 100).toFixed(2)}%`
          : 'unavailable for this selected cell and snapshot'}
        .
      </p>
      {profile ? (
        <>
          <p>
            Class {profile.classIndex + 1} · diameter {(profile.radiusMm * 2000).toFixed(1)} µm ·
            intact kernel radius {(profile.kernelRadiusMm * 1000).toFixed(1)} µm
          </p>
          {values?.length ? (
            <>
              <svg
                className="particle-profile"
                viewBox="0 0 380 220"
                role="img"
                aria-label="Exact coupled core shell-average loading against normalized intact-kernel radius"
              >
                <line x1="40" y1="180" x2="345" y2="180" />
                <line x1="40" y1="25" x2="40" y2="180" />
                <polyline points={points} />
                <text x="190" y="213" textAnchor="middle">
                  Intact-kernel radius fraction (0–1)
                </text>
                <text x="45" y="18">
                  Equivalent loading (kg/m³), 0–{max.toFixed(1)}
                </text>
                {profile.radiusFraction.length < 20 &&
                  Array.from(profile.radiusFraction, (r, i) => (
                    <circle key={i} cx={40 + r * 300} cy={180 - (values[i] / max) * 150} r="3" />
                  ))}
              </svg>
              <p className="note">
                Each value is a concentration-equivalent soluble loading, normalized by the model’s
                reference capacity; it is not a separate physical water inventory. Shell averages
                are plotted at their outer face. The kernel radius excludes the broken-cell surface
                layer. This is the lumped soluble pool; individual compound profiles are not
                resolved here.
              </p>
              <details>
                <summary>Shell data table</summary>
                <div className="table-wrap">
                  <table>
                    <caption>Kernel shell data for particle {index + 1}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Kernel radius fraction</th>
                        <th scope="col">Equivalent loading (kg/m³)</th>
                        <th scope="col">Initial kernel loading remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(profile.radiusFraction, (r, i) => (
                        <tr key={i}>
                          <td>{r.toFixed(4)}</td>
                          <td>{values[i].toFixed(4)}</td>
                          <td>
                            {profile.remainingFraction
                              ? `${(profile.remainingFraction[i] * 100).toFixed(2)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p>This class has no intact kernel; its soluble content starts in the surface pool.</p>
          )}
          <p>
            Surface-pool content remaining:{' '}
            {profile.surfaceRemainingFraction === null
              ? 'no initial surface pool'
              : `${(profile.surfaceRemainingFraction * 100).toFixed(2)}%`}
            .
          </p>
          <p className="note">
            All displayed particles in this size class share the selected continuum cell’s exact
            state. Particle positions do not introduce extra extraction differences.
          </p>
        </>
      ) : (
        <p>
          Select the cell exported by Run Explore to inspect its exact kernel shells. Run Explore
          again to export a different selected cell.
        </p>
      )}
    </section>
  );
}
