// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The recipe editor: one folding section per recipe block, each with a
 * one-line summary and a count of its problems. A section opens by itself when
 * a new problem appears in it, so no error stays hidden.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Catalog } from '../engine/shotTypes';
import { BasketSection } from './editor/BasketSection';
import { EditorContext, type EditorContextValue } from './editor/context';
import { GrinderSection } from './editor/GrinderSection';
import { MachineSection } from './editor/MachineSection';
import { OverridesSection } from './editor/OverridesSection';
import { BeanSection, PrepSection, StopSection } from './editor/SimpleSections';
import { WaterSection, ChemistrySection } from './editor/WaterSection';
import {
  basketSummary,
  beanSummary,
  grinderSummary,
  machineSummary,
  overridesSummary,
  prepSummary,
  stopSummary,
} from './editor/summaries';
import { sectionOf, type RecipeForm } from './recipeForm';
import { useShotStore } from './shotStore';
import { EquipmentDiagram } from './EquipmentDiagram';

type SectionId =
  'bean' | 'water' | 'chemistry' | 'grinder' | 'basket' | 'prep' | 'machine' | 'stop' | 'overrides';

interface SectionSpec {
  id: SectionId;
  title: string;
  /** Error-key prefixes that belong to the section. */
  keys: readonly string[];
  summary: (form: RecipeForm, catalog: Catalog) => string;
  render: () => ReactNode;
}

const SECTIONS: readonly SectionSpec[] = [
  {
    id: 'bean',
    title: 'Bean',
    keys: ['bean'],
    summary: beanSummary,
    render: () => <BeanSection />,
  },
  {
    id: 'water',
    title: 'Brew water',
    keys: ['water'],
    summary: (form) =>
      Object.values(form.water).some((v) => v !== '')
        ? 'Your water analysis'
        : 'Illustrative water defaults',
    render: () => <WaterSection />,
  },
  {
    id: 'chemistry',
    title: 'Cup chemistry',
    keys: ['chemistry'],
    summary: (form) =>
      form.chemistry.enabled === 'no'
        ? 'Off · legacy species'
        : 'Acidity · aroma · phases · refractometer',
    render: () => <ChemistrySection />,
  },
  {
    id: 'grinder',
    title: 'Grinder',
    keys: ['grinder'],
    summary: grinderSummary,
    render: () => <GrinderSection />,
  },
  {
    id: 'basket',
    title: 'Basket',
    keys: ['basket'],
    summary: basketSummary,
    render: () => <BasketSection />,
  },
  {
    id: 'prep',
    title: 'Puck preparation',
    keys: ['prep'],
    summary: (form) => prepSummary(form),
    render: () => <PrepSection />,
  },
  {
    id: 'machine',
    title: 'Machine',
    keys: ['machine'],
    summary: machineSummary,
    render: () => <MachineSection />,
  },
  {
    id: 'stop',
    title: 'Stop and numerics',
    keys: ['stop', 'numerics'],
    summary: stopSummary,
    render: () => <StopSection />,
  },
  {
    id: 'overrides',
    title: 'Sandbox overrides',
    keys: ['overrides'],
    summary: (form) => overridesSummary(form),
    render: () => <OverridesSection />,
  },
];

function Section({
  spec,
  form,
  catalog,
  errorCount,
}: {
  spec: SectionSpec;
  form: RecipeForm;
  catalog: Catalog;
  errorCount: number;
}) {
  const [open, setOpen] = useState(() => errorCount > 0);
  const previous = useRef(errorCount);
  const reveal = useShotStore((s) => s.reveal);
  useEffect(() => {
    // Open the section when a problem appears in it.
    if (errorCount > previous.current) setOpen(true);
    previous.current = errorCount;
  }, [errorCount]);
  // Open the section when one of its fields is to be shown ("Go to the field").
  const [seenReveal, setSeenReveal] = useState(reveal?.nonce ?? 0);
  if (reveal && reveal.nonce !== seenReveal) {
    setSeenReveal(reveal.nonce);
    if (spec.keys.includes(sectionOf(reveal.path))) setOpen(true);
  }
  return (
    <details
      className="editor-section"
      id={`section-${spec.id}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary id={`section-${spec.id}-summary`}>
        <span className="section-title">{spec.title}</span>
        <span className="section-summary">{spec.summary(form, catalog)}</span>
        {errorCount > 0 && (
          <span className="badge badge-error">
            {errorCount} problem{errorCount === 1 ? '' : 's'}
          </span>
        )}
      </summary>
      <div className="section-body">{open ? spec.render() : null}</div>
    </details>
  );
}

export function RecipeEditor({
  context,
  onSubmit,
}: {
  context: EditorContextValue;
  onSubmit: () => void;
}) {
  const form = useShotStore((s) => s.form);
  const counts = new Map<string, number>();
  for (const key of Object.keys(context.errors)) {
    const section = sectionOf(key);
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return (
    <EditorContext.Provider value={context}>
      <form
        className="recipe-editor"
        aria-label="Recipe"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <EquipmentDiagram />
        {SECTIONS.map((spec) => (
          <Section
            key={spec.id}
            spec={spec}
            form={form}
            catalog={context.catalog}
            errorCount={spec.keys.reduce((n, k) => n + (counts.get(k) ?? 0), 0)}
          />
        ))}
        {/* Enter in a field runs the recipe, like the Run button. */}
        <button type="submit" className="visually-hidden" tabIndex={-1}>
          Run this recipe
        </button>
      </form>
    </EditorContext.Provider>
  );
}
