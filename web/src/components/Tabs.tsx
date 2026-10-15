// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Tabs following the WAI-ARIA pattern: one tab stop, arrow keys and Home/End
 * move between tabs, selection follows focus. Panels are mounted the first
 * time they are shown and then stay mounted (hidden), so their state, charts
 * and scroll positions survive switching.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  render: () => ReactNode;
}

export interface TabsProps<T extends string> {
  /** Prefix of the tab and panel ids; must be unique on the page. */
  idPrefix: string;
  label: string;
  tabs: readonly TabSpec<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function Tabs<T extends string>({
  idPrefix,
  label,
  tabs,
  value,
  onChange,
  className,
}: TabsProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [mounted, setMounted] = useState<ReadonlySet<T>>(() => new Set([value]));
  if (!mounted.has(value)) setMounted(new Set([...mounted, value]));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((t) => t.id === value);
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (current + last) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    buttons.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div className="sub-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className="sub-tab"
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${idPrefix}-panel-${tab.id}`}
          aria-labelledby={`${idPrefix}-tab-${tab.id}`}
          hidden={tab.id !== value}
          tabIndex={0}
          className="sub-panel"
        >
          {mounted.has(tab.id) ? tab.render() : null}
        </div>
      ))}
    </div>
  );
}
