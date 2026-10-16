// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Form controls of the recipe editor. Every control has a visible label tied
 * to it, an optional help button that expands an explanation (glossary.ts),
 * hint text, and an inline error that is announced through aria-describedby
 * and aria-invalid. Ids derive from the recipe path, so builder errors that
 * name a path can be matched to their input.
 */
import { useState, type ReactNode } from 'react';
import { GLOSSARY } from './glossary';

/** The DOM id of the control for a recipe path. */
export function fieldId(path: string): string {
  return `rf-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** A help button that shows or hides an explanation of `term` below its row. */
export function useHelp(id: string, term?: string) {
  const [open, setOpen] = useState(false);
  const entry = term ? GLOSSARY[term] : undefined;
  const helpId = `${id}-help`;
  const button = entry ? (
    <button
      type="button"
      className="help-button"
      aria-expanded={open}
      aria-controls={helpId}
      aria-label={`What is ${entry.title}?`}
      onClick={() => setOpen((o) => !o)}
    >
      ?
    </button>
  ) : null;
  const text = entry ? (
    <p className="help-text" id={helpId} hidden={!open}>
      {entry.text}
    </p>
  ) : null;
  return { button, text };
}

/** A heading-level help: a title with a help button and the expandable explanation. */
export function HelpHeading({
  id,
  term,
  children,
  level = 3,
}: {
  id: string;
  term: string;
  children: ReactNode;
  level?: 3 | 4;
}) {
  const help = useHelp(id, term);
  const Heading = level === 3 ? 'h3' : 'h4';
  return (
    <>
      <div className="field-head">
        <Heading id={id}>{children}</Heading>
        {help.button}
      </div>
      {help.text}
    </>
  );
}

interface CommonProps {
  /** Recipe path; also the error key and the source of the id. */
  path: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  term?: string;
  className?: string;
}

function describedBy(id: string, error?: string, hint?: ReactNode): string | undefined {
  const ids = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Messages({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  return (
    <>
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
    </>
  );
}

export interface TextFieldProps extends CommonProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
}

/** A number (or text) input that keeps what was typed, so partial input can be corrected. */
export function TextField({
  path,
  label,
  error,
  hint,
  term,
  className,
  value,
  onChange,
  placeholder,
  inputMode = 'decimal',
}: TextFieldProps) {
  const id = fieldId(path);
  const help = useHelp(id, term);
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        {help.button}
      </div>
      {help.text}
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        onChange={(event) => onChange(event.target.value)}
      />
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends CommonProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
}

export function SelectField({
  path,
  label,
  error,
  hint,
  term,
  className,
  value,
  onChange,
  options,
  disabled,
}: SelectFieldProps) {
  const id = fieldId(path);
  const help = useHelp(id, term);
  const known = options.some((o) => o.value === value);
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        {help.button}
      </div>
      {help.text}
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        onChange={(event) => onChange(event.target.value)}
      >
        {!known && <option value={value}>{value || '—'}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

export interface CheckFieldProps {
  path: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  term?: string;
}

export function CheckField({ path, label, checked, onChange, hint, term }: CheckFieldProps) {
  const id = fieldId(path);
  const help = useHelp(id, term);
  return (
    <div className="field field-check">
      <div className="field-head">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <label htmlFor={id}>{label}</label>
        {help.button}
      </div>
      {help.text}
      <Messages id={id} hint={hint} />
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
}

/** A group of radio buttons in a fieldset with a legend. */
export function RadioGroup<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  term,
}: {
  name: string;
  legend: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  term?: string;
}) {
  const id = fieldId(name);
  const help = useHelp(id, term);
  return (
    <fieldset className="radio-group">
      <legend>
        {legend}
        {help.button}
      </legend>
      {help.text}
      <div className="radio-options">
        {options.map((o) => (
          <label key={o.value} className="radio-option">
            <input
              type="radio"
              name={id}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
