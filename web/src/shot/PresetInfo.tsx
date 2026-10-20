// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * What a preset is: its description, its flags (generic, estimated,
 * unverified, disputed, owner-gear) as labelled badges, its evidence grade and
 * tag, and its notes, shown next to the picker. Flags that call for caution
 * carry a "!" marker and words, never colour alone.
 */
import type { PresetBase } from '../engine/shotTypes';

export const FLAG_LABELS: Record<string, string> = {
  generic: 'Generic example',
  estimated: 'Estimated values',
  unverified: 'Unverified specs',
  disputed: 'Disputed',
  'owner-gear': 'Maintainer’s own gear',
};

const CAUTION = new Set(['unverified', 'disputed', 'owner-gear']);

export function FlagBadges({ flags }: { flags: readonly string[] }) {
  return (
    <>
      {flags.map((flag) => (
        <span key={flag} className={`badge${CAUTION.has(flag) ? ' badge-caution' : ''}`}>
          {CAUTION.has(flag) && (
            <span className="badge-mark" aria-hidden="true">
              !
            </span>
          )}
          {FLAG_LABELS[flag] ?? flag}
        </span>
      ))}
    </>
  );
}

export function PresetInfo({ preset }: { preset: PresetBase | undefined }) {
  if (!preset) return null;
  return (
    <div className="preset-info">
      <p className="preset-description">{preset.description}</p>
      <p className="badges" role="group" aria-label="Preset flags and evidence">
        <FlagBadges flags={preset.flags} />
        <span className="badge">Evidence grade {preset.evidence_grade}</span>
        <span className="badge">{preset.tag}</span>
      </p>
      {preset.notes.length > 0 && (
        <ul className="preset-notes">
          {preset.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Builder notes for one section, after a build. */
export function BuildNotes({ notes, stale }: { notes: readonly string[]; stale?: boolean }) {
  if (notes.length === 0) return null;
  return (
    <div className="build-notes">
      <p className="build-notes-title">From the model{stale ? ' (for earlier inputs)' : ''}:</p>
      <ul>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
