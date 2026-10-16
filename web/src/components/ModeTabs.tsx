// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The mode switcher, following the WAI-ARIA tabs pattern: one tab stop, arrow
 * keys (and Home/End) move between tabs, and selection follows focus.
 */
import { useRef, type KeyboardEvent } from 'react';
import { MODES, type Mode } from '../store';

export const tabId = (mode: Mode) => `tab-${mode}`;
export const panelId = (mode: Mode) => `panel-${mode}`;

interface ModeTabsProps {
  mode: Mode;
  onChange: (mode: Mode) => void;
}

export function ModeTabs({ mode, onChange }: ModeTabsProps) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = MODES.findIndex((m) => m.id === mode);
    const last = MODES.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % MODES.length
        : event.key === 'ArrowLeft'
          ? (current + last) % MODES.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    const target = MODES[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="mode-tabs" role="tablist" aria-label="Mode" onKeyDown={onKeyDown}>
      {MODES.map((m, index) => {
        const selected = m.id === mode;
        return (
          <button
            key={m.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={tabId(m.id)}
            aria-selected={selected}
            aria-controls={panelId(m.id)}
            tabIndex={selected ? 0 : -1}
            className="mode-tab"
            onClick={() => onChange(m.id)}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
