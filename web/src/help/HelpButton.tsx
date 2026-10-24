// SPDX-License-Identifier: GPL-2.0-or-later
import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useShotStore } from '../shot/shotStore';
import { INSTRUMENTS } from './instruments';
import { parameterHelp } from './parameterHelp';
import './HelpButton.css';

export function HelpContent({
  term,
  label,
  children,
}: {
  term: string;
  label?: string;
  children?: ReactNode;
}) {
  const catalog = useShotStore((s) => s.catalog);
  const registry = term.startsWith('overrides.')
    ? catalog?.registry.parameters.find((p) => p.id === term.slice(10))
    : undefined;
  const entry = parameterHelp(term, label, registry);
  return (
    <>
      <strong>{entry.title}</strong>
      <p>
        <b>What it means</b>
        <br />
        {entry.meaning}
      </p>
      <p>
        <b>How it affects the simulation</b>
        <br />
        {entry.effect}
      </p>
      <p>
        <b>How to find it</b>
        <br />
        {entry.measure}
      </p>
      {entry.instruments?.length ? (
        <details className="help-instruments">
          <summary>Useful measuring tools</summary>
          {entry.instruments.map((id) => {
            const tool = INSTRUMENTS.find((t) => t.id === id);
            return tool ? (
              <div className="help-instrument" key={id}>
                <a href={tool.url} target="_blank" rel="noreferrer">
                  {tool.name}
                </a>
                <p>{tool.typicalCost}</p>
                <p>{tool.purpose}</p>
                <p>{tool.limitations}</p>
                <small>US price checked {tool.checkedAt}; before tax and shipping.</small>
                {tool.sources?.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.label}
                  </a>
                ))}
              </div>
            ) : null;
          })}
        </details>
      ) : null}
      {children && <div className="help-extra">{children}</div>}
      {registry?.sources?.length ? (
        <details>
          <summary>Parameter sources</summary>
          <ul>
            {registry.sources.map((source, i) => (
              <li key={i}>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.citation}
                  </a>
                ) : (
                  source.citation
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** An inline, keyboard-operable explanation next to an input or result label. */
export function HelpButton({
  term,
  label,
  children,
}: {
  term: string;
  label?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const title = label ?? parameterHelp(term).title;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  return (
    <span className="metric-help">
      <button
        ref={button}
        type="button"
        className="help-button"
        aria-label={`Help for ${title}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-label={`${title} help`}
            id={id}
            className="metric-help-content metric-help-popover"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
                button.current?.focus();
              }
            }}
          >
            <HelpContent term={term} label={label}>
              {children}
            </HelpContent>
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
            >
              Close help for {title}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Use with an input/select child so help stays outside its accessible label. */
export function HelpField({
  label,
  term,
  children,
}: {
  label: string;
  term: string;
  children: ReactElement<{ id?: string }>;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  return (
    <div className="field help-field">
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        <HelpButton term={term} label={label} />
      </div>
      {cloneElement(children, { id })}
    </div>
  );
}
