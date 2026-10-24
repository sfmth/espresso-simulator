// SPDX-License-Identifier: GPL-2.0-or-later
/** Illustrated burr swaps edit the existing empirical grinder model. */
import { useId } from 'react';
import { InlineConstraintControl } from '../../setup/ConstraintContext';
import type { GrinderPreset } from '../../engine/shotTypes';
import { parseDecimal } from '../../lab/sphereForm';
import { findPreset, useEditorContext } from '../editor/context';
import { fieldId } from '../fields';
import { focusSoon } from '../focus';
import { changeGrinderMode, defaultForm, GRINDER_ADVANCED, type RecipeForm } from '../recipeForm';
import { useShotStore } from '../shotStore';
import './GrinderInternals.css';

type Grinder = RecipeForm['grinder'];

// Mirrors the input guard in puckmodel/src/models/grinder.rs, not a new PSD parameter.
const MIN_NATIVE_GAP_UM = 5;

/** Same dial mapping as the builder; preserve the gap before clearing calibration. */
function currentGap(grinder: Grinder, preset?: GrinderPreset): number | null {
  if (grinder.mode === 'psd') return null;
  if (grinder.by === 'gap') {
    const gap = parseDecimal(grinder.gap_um);
    return gap !== null && gap > 0 ? Math.max(MIN_NATIVE_GAP_UM, gap) : null;
  }
  if (
    [grinder.setting, grinder.setting_ref, grinder.gap_at_ref_um, grinder.gap_per_unit_um].some(
      (value) => value.trim() !== '' && parseDecimal(value) === null,
    )
  )
    return null;
  const dial = grinder.mode === 'preset' ? preset?.dial : undefined;
  const setting = parseDecimal(grinder.setting) ?? dial?.default;
  const referenceGap = parseDecimal(grinder.gap_at_ref_um) ?? dial?.gap_at_ref_um;
  const step = parseDecimal(grinder.gap_per_unit_um) ?? dial?.gap_per_unit_um;
  if (setting === undefined || referenceGap === undefined || step === undefined) return null;
  const clamped = dial ? Math.min(dial.max, Math.max(dial.min, setting)) : setting;
  const gap =
    referenceGap + step * (clamped - (parseDecimal(grinder.setting_ref) ?? dial?.ref ?? 0));
  return Number.isFinite(gap) ? Math.max(MIN_NATIVE_GAP_UM, gap) : null;
}

function BurrParts({ conical }: { conical: boolean }) {
  return conical ? (
    <g data-burr-shape="conical">
      <path className="burr-metal" d="M92 66Q200 24 308 66V124Q200 168 92 124Z" />
      <ellipse className="burr-opening" cx="200" cy="66" rx="108" ry="34" />
      <ellipse className="burr-metal" cx="200" cy="66" rx="72" ry="23" />
      {Array.from({ length: 14 }, (_, i) => (
        <path key={i} d={`M${101 + i * 15} 73l-5 48`} />
      ))}
      <path className="burr-metal" d="M200 101L278 190Q200 221 122 190Z" />
      {Array.from({ length: 9 }, (_, i) => (
        <path key={i} d={`M200 105L${130 + i * 17.5} 191`} />
      ))}
      <path className="burr-axis" d="M200 22V98M200 209V232" />
    </g>
  ) : (
    <g data-burr-shape="flat">
      {[76, 173].map((cy) => (
        <g key={cy}>
          <path className="burr-metal" d={`M84 ${cy}v18a116 38 0 0 0 232 0v-18Z`} />
          <ellipse className="burr-metal" cx="200" cy={cy} rx="116" ry="38" />
          <g transform={`translate(200 ${cy}) scale(1 .33)`}>
            {Array.from({ length: 28 }, (_, i) => (
              <path key={i} d="M39 0L108 14" transform={`rotate(${(i * 360) / 28})`} />
            ))}
          </g>
          <ellipse className="burr-opening" cx="200" cy={cy} rx="30" ry="10" />
        </g>
      ))}
      <path className="burr-axis" d="M200 20V62M200 87V159M200 184V232" />
    </g>
  );
}

function BurrIcon({ conical }: { conical: boolean }) {
  return (
    <svg viewBox="65 20 270 215" aria-hidden="true" focusable="false">
      <BurrParts conical={conical} />
    </svg>
  );
}

function InternalField({
  name,
  label,
  value,
  hint,
  placeholder,
}: {
  name: 'gap_um' | 'burr_diameter_mm' | 'rpm' | 'setting';
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
}) {
  const id = useId();
  const { errors } = useEditorContext();
  const error = errors[`grinder.${name}`];
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>Internal {label}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) =>
          useShotStore.getState().patchForm('grinder', { [name]: event.target.value })
        }
      />
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
      <InlineConstraintControl path={`grinder.${name}`} />
    </div>
  );
}

export function GrinderInternals() {
  const id = useId();
  const { catalog, errors } = useEditorContext();
  const form = useShotStore((state) => state.form);
  const undo = useShotStore((state) => state.undo);
  const grinder = form.grinder;
  const preset = findPreset(catalog.presets.grinders, grinder.preset);
  const familyId = grinder.mode === 'preset' ? preset?.family : grinder.family;
  const family =
    grinder.mode === 'psd'
      ? undefined
      : findPreset(catalog.presets.grinder_families, familyId ?? '');
  const gapPaths =
    grinder.by === 'gap'
      ? ['grinder.gap_um']
      : ['grinder.setting', 'grinder.gap_at_ref_um', 'grinder.gap_per_unit_um'];
  const gap = gapPaths.some((path) => errors[path]) ? null : currentGap(grinder, preset);
  const defaults = defaultForm().grinder;
  const defaultGap = currentGap(defaults, findPreset(catalog.presets.grinders, defaults.preset));
  const gapLabel = gap !== null && gap > 0 ? `${Number(gap.toPrecision(6))} µm` : 'not resolved';
  const swap = (nextFamily: string) => {
    // Passing through a different mode also clears overrides on family → family swaps.
    const source = grinder.mode === 'family' ? { ...grinder, mode: 'psd' as const } : grinder;
    const next = changeGrinderMode(source, 'family', catalog.presets.grinders);
    for (const key of GRINDER_ADVANCED) next[key] = '';
    const nextGrinder: Grinder = {
      ...next,
      mode: 'family',
      family: nextFamily,
      by: 'gap',
      gap_um:
        gap !== null && gap > 0
          ? String(Number(gap.toPrecision(12)))
          : defaultGap !== null && defaultGap > 0
            ? String(defaultGap)
            : '',
    };
    useShotStore.getState().loadForm({ ...form, grinder: nextGrinder }, 'Undo burr swap');
  };
  const morePath =
    grinder.mode === 'psd'
      ? 'grinder.psd'
      : grinder.by === 'gap'
        ? 'grinder.gap_um'
        : 'grinder.setting';

  return (
    <section className="grinder-internals" aria-labelledby={`${id}-heading`}>
      <div className="grinder-internals-head">
        <h3 id={`${id}-heading`}>Inside the grinder</h3>
        <p>Open the burr chamber and choose a burr family.</p>
      </div>
      <figure className="grinder-cutaway">
        <svg viewBox="0 0 400 270" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
          <title id={`${id}-title`}>
            {family
              ? `${family.burr === 'conical' ? 'Conical' : 'Flat'} burr assembly`
              : grinder.mode === 'psd'
                ? 'Measured particle distribution'
                : 'Unspecified burr assembly'}
          </title>
          <desc id={`${id}-desc`}>
            {family
              ? family.burr === 'conical'
                ? 'An outer toothed ring and an inner cone, separated to show the cutting surfaces. Beans enter above; grounds leave below.'
                : 'Two toothed flat discs, separated to show their cutting faces. Beans enter through the centre and grounds move outward.'
              : grinder.mode === 'psd'
                ? 'A document represents measured particle sizes. Burr geometry cannot be inferred from those measurements.'
                : 'Choose a known grinder preset or a burr family to see the burr assembly.'}{' '}
            Illustrative shapes and separation, not a scale engineering drawing.
          </desc>
          {family ? (
            <>
              <BurrParts conical={family.burr === 'conical'} />
              <path className="burr-flow" d="M70 28H200V47M194 38L200 47L206 38" />
              <path
                className="burr-flow"
                d={
                  family.burr === 'conical'
                    ? 'M132 157L78 218M78 206L78 218L91 215'
                    : 'M160 125H60V220M53 210L60 220L67 210'
                }
              />
              <path className="burr-gap" d="M332 112H350M341 112V151M332 151H350" />
              <text x="320" y="172">
                Gap
              </text>
              <text x="12" y="22">
                Beans in
              </text>
              <text x="12" y="258">
                Grounds out
              </text>
            </>
          ) : (
            <g data-burr-shape="unknown">
              <rect className="burr-metal" x="95" y="30" width="210" height="197" rx="8" />
              <path d="M120 89H280M120 117H280M120 145H280M120 173H280M120 201H280M200 89V201" />
              <text x="122" y="68">
                Particle-size data
              </text>
              <text x="76" y="257">
                Burr geometry unspecified
              </text>
            </g>
          )}
        </svg>
        <figcaption>
          {grinder.mode === 'psd'
            ? 'Measured PSD is active. No burr geometry is assigned.'
            : `${grinder.mode === 'preset' ? `${preset?.name ?? 'Unknown grinder'} · ` : ''}${family?.name ?? 'Choose a burr family'}. Effective gap: ${gapLabel}.`}{' '}
          Exploded illustration; the separation and teeth are schematic.
        </figcaption>
      </figure>
      <p className="grinder-swap-hint" id={`${id}-swap-hint`}>
        A burr swap uses a generic family instead of the current named grinder or measured PSD. It
        keeps a resolved gap and clears the previous grinder’s calibration, PSD shape and burr
        overrides.
        {grinder.mode === 'psd' &&
          ' A measured PSD has no gap; a swap starts at the default recipe’s gap. Review it before running.'}
      </p>
      <div
        className="burr-family-options"
        role="group"
        aria-label="Swap burr family"
        aria-describedby={`${id}-swap-hint${errors['grinder.family'] ? ` ${id}-family-error` : ''}`}
      >
        {catalog.presets.grinder_families.map((option) => (
          <button
            type="button"
            className="burr-family-option"
            key={option.id}
            aria-pressed={grinder.mode === 'family' && familyId === option.id}
            data-burr-family={option.id}
            onClick={() => swap(option.id)}
          >
            <BurrIcon conical={option.burr === 'conical'} />
            <span>{option.name}</span>
          </button>
        ))}
      </div>
      {errors['grinder.family'] && (
        <p className="field-error" id={`${id}-family-error`}>
          {errors['grinder.family']}
        </p>
      )}
      <InlineConstraintControl path="grinder.family" />
      <p className="field-hint">
        Family differences use estimated particle-size coefficients. Tooth shapes here explain the
        parts; the simulator does not calculate cutting from their geometry. Flat low-fines and
        traditional families share the same disc illustration.
      </p>
      {undo?.label === 'Undo burr swap' && (
        <button
          type="button"
          className="button button-quiet"
          onClick={() => useShotStore.getState().undoLast()}
        >
          Undo burr swap
        </button>
      )}
      {grinder.mode !== 'psd' && (
        <div className="grinder-internal-fields">
          {grinder.by === 'gap' ? (
            <InternalField name="gap_um" label="burr gap (µm)" value={grinder.gap_um} />
          ) : (
            <InternalField
              name="setting"
              label="grinder setting"
              value={grinder.setting}
              placeholder={preset ? String(preset.dial.default) : undefined}
            />
          )}
          <InternalField
            name="burr_diameter_mm"
            label="burr diameter (mm)"
            value={grinder.burr_diameter_mm}
            placeholder={
              grinder.mode === 'preset' && preset?.burr_diameter_mm
                ? `${preset.burr_diameter_mm} from preset`
                : undefined
            }
            hint="Recorded only; does not change the simulation."
          />
          <InternalField
            name="rpm"
            label="burr speed (RPM)"
            value={grinder.rpm}
            placeholder={
              grinder.mode === 'preset' && preset?.rpm ? `${preset.rpm} from preset` : undefined
            }
            hint="Recorded only; does not change the simulation."
          />
        </div>
      )}
      {errors.grinder && <p className="field-error">{errors.grinder}</p>}
      <button
        type="button"
        className="button button-quiet"
        onClick={() => {
          useShotStore.getState().revealField(morePath);
          focusSoon([fieldId(morePath), 'section-grinder-summary'], 10, () =>
            useShotStore.getState().clearReveal(),
          );
        }}
      >
        Full grinder settings
      </button>
    </section>
  );
}
