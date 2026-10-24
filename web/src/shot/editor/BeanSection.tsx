// SPDX-License-Identifier: GPL-2.0-or-later
/** Coffee facts, estimated roast assumptions, and user-composed blends. */
import { useState, type ReactNode } from 'react';
import { COFFEE_CATALOG, coffeeToBeanInput } from '../../coffee/catalog';
import { calculateRoastAge, localDate } from '../../coffee/dates';
import { roastBasisWithOverride } from '../../coffee/roastMetadata';
import {
  ROAST_ASSUMPTIONS,
  ROAST_COLOR_SAMPLES,
  ROAST_COLOR_SCALES,
  ROAST_LABEL_BASIS,
  isSingleCoffeePreset,
  roastAssumptionName,
} from '../../coffee/roast';
import {
  BEAN_PROCESSES,
  BEAN_STORAGE,
  BEAN_VARIETIES,
  type BeanInput,
  type RoastColor,
} from '../../engine/shotTypes';
import { SelectField, TextField } from '../fields';
import { useSetupConstraints } from '../../setup/ConstraintContext';
import { replaceCoffee, type CoffeeChange } from '../coffeeChanges';
import { BuildNotes, PresetInfo } from '../PresetInfo';
import { FIELDS } from '../recipeFields';
import {
  DEFAULT_RECIPE,
  emptyForm,
  recipeToForm,
  type BeanForm,
  type BeanLeafForm,
  type CoffeeForm,
} from '../recipeForm';
import { useShotStore } from '../shotStore';
import { findPreset, useEditorContext } from './context';
import './BeanSection.css';

const PROCESS_LABELS: Record<string, string> = {
  washed: 'Washed',
  natural: 'Natural',
  honey: 'Honey',
  anaerobic: 'Anaerobic',
};
const STORAGE_LABELS: Record<string, string> = {
  sealed: 'Sealed',
  open: 'Open to air',
  frozen: 'Frozen',
};
const VARIETY_LABELS: Record<string, string> = {
  unspecified: 'Unspecified',
  'typica-bourbon': 'Typica / Bourbon',
  gesha: 'Gesha',
  'ethiopian-landrace': 'Ethiopian landrace',
  canephora: 'Canephora (Robusta)',
  hybrid: 'Hybrid',
};

let componentSequence = 0;
function componentKey(): string {
  return `coffee-new-${++componentSequence}`;
}
function leafForm(bean: BeanInput): BeanLeafForm {
  const imported = recipeToForm({ ...DEFAULT_RECIPE, bean });
  if (!imported.ok) throw new Error(imported.error);
  return imported.form.bean;
}
function sourceLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Open new problems and requested fields without collapsing a corrected draft. */
function CoffeeDetails({
  paths,
  summary,
  className = 'coffee-details',
  defaultOpen = false,
  children,
}: {
  paths: string[];
  summary: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { errors } = useEditorContext();
  const reveal = useShotStore((s) => s.reveal);
  const belongs = (path: string) =>
    paths.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
  const count = Object.keys(errors).filter(belongs).length;
  const requested = reveal && belongs(reveal.path);
  const [open, setOpen] = useState(defaultOpen || count > 0 || Boolean(requested));
  const [seenCount, setSeenCount] = useState(count);
  const [seenReveal, setSeenReveal] = useState(reveal?.nonce ?? 0);
  if (seenCount !== count) {
    setSeenCount(count);
    if (count > seenCount) setOpen(true);
  }
  if (reveal && reveal.nonce !== seenReveal) {
    setSeenReveal(reveal.nonce);
    if (requested) setOpen(true);
  }
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {summary}
        {count > 0 && (
          <span className="badge badge-error">
            {count} problem{count === 1 ? '' : 's'}
          </span>
        )}
      </summary>
      {children}
    </details>
  );
}

function CoffeeLeafEditor({
  bean,
  path,
  onChange,
  onReplace,
}: {
  bean: BeanLeafForm;
  path: string;
  onChange: (bean: BeanLeafForm) => void;
  onReplace: (bean: BeanLeafForm) => void;
}) {
  const { catalog, errors } = useEditorContext();
  const [search, setSearch] = useState('');
  const [shotDate, setShotDate] = useState(localDate);
  const [ageCalculation, setAgeCalculation] = useState<{ error?: string; message?: string }>({});
  const patch = (changes: Partial<BeanLeafForm>) => onChange({ ...bean, ...changes });
  const facts = bean.coffee ?? {};
  const setFacts = (changes: Partial<CoffeeForm>) => patch({ coffee: { ...facts, ...changes } });
  const preset =
    findPreset(catalog.presets.beans, bean.preset) ?? catalog.presets.beans.find((p) => p.default);
  const match = COFFEE_CATALOG.find((coffee) => coffee.id === facts.id);
  const query = search.trim().toLowerCase();
  const coffees = COFFEE_CATALOG.filter(
    (coffee) =>
      !query ||
      [
        coffee.name,
        coffee.roaster,
        coffee.country,
        coffee.region,
        coffee.producer,
        coffee.process_label,
        ...coffee.varieties,
      ].some((v) => v?.toLowerCase().includes(query)),
  );
  const choice = match ? `coffee:${match.id}` : bean.preset ? `preset:${bean.preset}` : '';
  const isLegacyBlend = preset && !isSingleCoffeePreset(preset);
  const currentRoast = bean.roast_level;
  const knownRoast =
    currentRoast === '' || ROAST_ASSUMPTIONS.some((r) => Number(r.value) === Number(currentRoast));
  const species =
    bean.arabica_fraction === ''
      ? ''
      : Number(bean.arabica_fraction) === 100
        ? '100'
        : Number(bean.arabica_fraction) === 0
          ? '0'
          : 'legacy';
  const color = facts.roast_color;
  const source = sourceLink(match?.source_url ?? facts.source_url);
  const input = (key: keyof BeanLeafForm) => `${path}.${key}`;
  const factInput = (key: string) => `${path}.coffee.${key}`;
  const setColor = (changes: Partial<NonNullable<CoffeeForm['roast_color']>>) =>
    setFacts({
      roast_color: {
        scale: 'agtron-gourmet',
        sample: 'unspecified',
        value: '',
        ...color,
        ...changes,
      },
    });
  return (
    <div className="coffee-leaf">
      <div className="field-grid">
        <TextField
          path={`${path}.coffee-search`}
          label="Find a coffee"
          value={search}
          inputMode="text"
          onChange={setSearch}
          placeholder="Roaster, origin, variety or coffee name"
        />
        <SelectField
          path={input('preset')}
          label="Coffee"
          value={choice}
          error={errors[input('preset')]}
          hint="Choose a single-origin coffee, or enter your own bag’s details."
          options={[
            { value: '', label: 'My own coffee / default assumptions' },
            ...coffees.map((coffee) => ({
              value: `coffee:${coffee.id}`,
              label: `${coffee.roaster} — ${coffee.name}${coffee.availability === 'archived' ? ' (archived lot)' : ''}`,
            })),
            ...(match && !coffees.includes(match)
              ? [{ value: `coffee:${match.id}`, label: `${match.roaster} — ${match.name}` }]
              : []),
            ...catalog.presets.beans
              .filter(isSingleCoffeePreset)
              .map((p) => ({ value: `preset:${p.id}`, label: `Generic: ${p.name}` })),
            ...(isLegacyBlend && bean.preset
              ? [{ value: `preset:${bean.preset}`, label: `Imported legacy blend: ${preset.name}` }]
              : []),
          ]}
          onChange={(value) => {
            if (value.startsWith('coffee:')) {
              const coffee = COFFEE_CATALOG.find((c) => c.id === value.slice(7));
              if (coffee) onReplace(leafForm(coffeeToBeanInput(coffee)));
            } else
              onReplace(leafForm(value.startsWith('preset:') ? { preset: value.slice(7) } : {}));
          }}
        />
      </div>
      {query && (
        <p className="field-hint" role="status">
          {coffees.length} matching coffees
        </p>
      )}
      {match ? (
        <div className="coffee-source">
          <p>
            <strong>
              {match.roaster} · {match.name}
            </strong>
            <br />
            {[match.country, match.region, match.process_label, match.varieties.join(', ')]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="field-hint">
            {match.availability === 'archived'
              ? 'Archived lot; availability and later harvests may differ. '
              : ''}
            Source checked {match.verified_at}.
            {source && (
              <>
                {' '}
                <a href={source} target="_blank" rel="noreferrer">
                  Roaster’s source
                </a>
              </>
            )}
          </p>
          {match.assumptions.length > 0 && (
            <details>
              <summary>Model assumptions for this coffee</summary>
              <ul>
                {match.assumptions.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : bean.preset ? (
        <PresetInfo preset={preset} />
      ) : null}
      <div className="field-grid">
        <SelectField
          path={input('arabica_fraction')}
          label="Species"
          value={species}
          error={errors[input('arabica_fraction')]}
          options={[
            {
              value: '',
              label:
                preset?.arabica_fraction === 0
                  ? 'Use preset: Robusta / Canephora'
                  : preset && preset.arabica_fraction !== 1
                    ? `Use imported mixture: ${Number((100 * preset.arabica_fraction).toFixed(6))}% Arabica`
                    : 'Use preset: Arabica',
            },
            { value: '100', label: 'Arabica' },
            { value: '0', label: 'Robusta / Canephora' },
            ...(species === 'legacy'
              ? [{ value: 'legacy', label: `Imported mixture: ${bean.arabica_fraction}% Arabica` }]
              : []),
          ]}
          onChange={(value) => {
            if (value !== 'legacy') patch({ arabica_fraction: value });
          }}
        />
        <SelectField
          path={`${path}.roast-description`}
          label="Roast description"
          value={
            knownRoast ? (currentRoast === '' ? '' : String(Number(currentRoast))) : '__custom'
          }
          term="roast"
          error={errors[input('roast_level')]}
          options={[
            {
              value: '',
              label: `Use preset assumption (${roastAssumptionName(preset?.roast_level).toLowerCase()})`,
            },
            ...ROAST_ASSUMPTIONS,
            ...(!knownRoast
              ? [{ value: '__custom', label: 'Custom model roast — see technical details' }]
              : []),
          ]}
          onChange={(value) => {
            if (value === '__custom') return;
            const label = ROAST_ASSUMPTIONS.find((r) => r.value === value)?.label;
            patch({
              roast_level: value,
              coffee: {
                ...facts,
                model_roast_basis: roastBasisWithOverride(
                  facts,
                  `${label ?? 'Preset roast assumption'}. ${ROAST_LABEL_BASIS}`,
                ),
              },
            });
          }}
          hint={
            <>
              {facts.roast_label && <>Roaster’s description: {facts.roast_label}. </>}The model uses
              an approximate roast assumption. Labels vary between roasters.
            </>
          }
        />
        <TextField
          path={input('days_off_roast')}
          label="Days off roast"
          value={bean.days_off_roast}
          onChange={(days_off_roast) => patch({ days_off_roast })}
          error={errors[input('days_off_roast')]}
          placeholder={preset ? `${preset.days_off_roast} assumed from preset` : undefined}
          hint="Enter the age of this bag when the shot was made."
        />
        <SelectField
          path={input('storage')}
          label="Bean storage"
          value={bean.storage}
          onChange={(storage) => patch({ storage: storage as BeanLeafForm['storage'] })}
          options={[
            { value: '', label: 'Use model default (sealed)' },
            ...BEAN_STORAGE.map((value) => ({ value, label: STORAGE_LABELS[value] })),
          ]}
          error={errors[input('storage')]}
          hint="Storage effects are model estimates."
        />
      </div>
      <CoffeeDetails
        paths={[factInput('roast_color')]}
        defaultOpen={Boolean(color)}
        summary={
          <>
            Measured roast color{' '}
            {color
              ? `· ${color.value || 'enter value'} ${ROAST_COLOR_SCALES.find((s) => s.value === color.scale)?.label}`
              : '(optional)'}
          </>
        }
      >
        <p className="field-hint">
          Copy the scale and sample type reported by the roaster or instrument. The measurement is
          saved separately; it does not automatically replace the model roast assumption.
        </p>
        {color ? (
          <>
            <div className="field-grid">
              <SelectField
                path={factInput('roast_color.scale')}
                label="Color scale"
                value={color.scale}
                options={ROAST_COLOR_SCALES}
                onChange={(scale) => setColor({ scale: scale as RoastColor['scale'] })}
              />
              <TextField
                path={factInput('roast_color.value')}
                label="Measured roast color"
                value={color.value}
                onChange={(value) => setColor({ value })}
                error={errors[factInput('roast_color.value')]}
              />
              <SelectField
                path={factInput('roast_color.sample')}
                label="Color sample"
                value={color.sample}
                options={ROAST_COLOR_SAMPLES}
                onChange={(sample) => setColor({ sample: sample as RoastColor['sample'] })}
              />
              <TextField
                path={factInput('roast_color.instrument')}
                label="Color instrument (optional)"
                inputMode="text"
                value={color.instrument ?? ''}
                onChange={(instrument) => setColor({ instrument })}
                error={errors[factInput('roast_color.instrument')]}
              />
            </div>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setFacts({ roast_color: undefined })}
            >
              Remove color measurement
            </button>
          </>
        ) : (
          <button type="button" className="button button-quiet" onClick={() => setColor({})}>
            Add a color measurement
          </button>
        )}
      </CoffeeDetails>
      <CoffeeDetails
        paths={[
          'id',
          'name',
          'roaster',
          'country',
          'region',
          'producer',
          'varieties',
          'process_label',
          'roast_label',
          'roast_date',
          'source_url',
          'harvest',
        ].map(factInput)}
        summary="Bag and origin details"
      >
        <div className="field-grid">
          {(
            [
              ['name', 'Coffee name'],
              ['roaster', 'Roaster'],
              ['country', 'Country'],
              ['region', 'Region'],
              ['producer', 'Producer / farm'],
              ['process_label', 'Published process'],
              ['roast_label', 'Published roast label'],
              ['roast_date', 'Roast date (YYYY-MM-DD)'],
              ['harvest', 'Harvest'],
              ['source_url', 'Source URL'],
            ] as const
          ).map(([key, label]) => (
            <TextField
              key={key}
              path={factInput(key)}
              label={label}
              inputMode="text"
              value={facts[key] ?? ''}
              onChange={(value) => {
                setFacts({ [key]: value });
                if (key === 'roast_date') setAgeCalculation({});
              }}
              error={errors[factInput(key)]}
            />
          ))}
          <TextField
            path={factInput('varieties')}
            label="Varieties as published (comma separated)"
            inputMode="text"
            value={facts.varieties?.join(', ') ?? ''}
            error={errors[factInput('varieties')]}
            onChange={(value) => setFacts({ varieties: value.split(',').map((v) => v.trim()) })}
          />
        </div>
        <div className="field-grid">
          <TextField
            path={`${path}.age-shot-date`}
            label="Shot date for age (YYYY-MM-DD)"
            term="age"
            inputMode="text"
            value={shotDate}
            onChange={(value) => {
              setShotDate(value);
              setAgeCalculation({});
            }}
            hint="Choose when the shot was or will be made. The helper starts at today’s local date."
          />
        </div>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            const result = calculateRoastAge(
              facts.roast_date ?? '',
              shotDate,
              FIELDS['bean.days_off_roast'].max,
            );
            if (!result.ok) {
              setAgeCalculation({ error: result.error });
              return;
            }
            patch({ days_off_roast: String(result.days) });
            setAgeCalculation({
              message: `Set age to ${result.days} day${result.days === 1 ? '' : 's'} for the shot on ${shotDate}.`,
            });
          }}
        >
          Calculate age from roast date
        </button>
        {ageCalculation.error && (
          <p className="field-error" role="alert">
            {ageCalculation.error}
          </p>
        )}
        {ageCalculation.message && (
          <p className="field-hint" role="status">
            {ageCalculation.message}
          </p>
        )}
        <p className="field-hint">
          These facts stay with the recipe. Names, origin, published process and color do not imply
          measured chemical composition. A saved roast date does not automatically change recorded
          shot age; use Calculate age when you want to update it.
        </p>
      </CoffeeDetails>
      <CoffeeDetails
        paths={['roast_level', 'bean_temp_c', 'altitude_m', 'process', 'variety_group'].map(
          (key) => `${path}.${key}`,
        )}
        summary="Technical model details"
      >
        <div className="field-grid">
          <TextField
            path={input('roast_level')}
            label="Model roast index (0–1)"
            value={bean.roast_level}
            onChange={(roast_level) =>
              patch({
                roast_level,
                coffee: {
                  ...facts,
                  model_roast_basis: roastBasisWithOverride(
                    facts,
                    `User-specified internal model index ${roast_level || '(preset default)'}; not a measured roast-color conversion.`,
                  ),
                },
              })
            }
            error={errors[input('roast_level')]}
            placeholder={preset ? `${preset.roast_level} from preset` : undefined}
            hint="Compatibility control for existing recipes and model experiments. 0 is very light; 1 is very dark."
          />
          <TextField
            path={`${input('arabica_fraction')}-technical`}
            label="Legacy Arabica share (%)"
            value={bean.arabica_fraction}
            onChange={(arabica_fraction) => patch({ arabica_fraction })}
            error={errors[input('arabica_fraction')]}
            hint="Existing mixtures remain readable. Use separate coffees to create a new blend."
          />
          <TextField
            path={input('bean_temp_c')}
            label="Bean temperature (°C)"
            value={bean.bean_temp_c}
            onChange={(bean_temp_c) => patch({ bean_temp_c })}
            error={errors[input('bean_temp_c')]}
            placeholder="Room temperature"
          />
          <TextField
            path={input('altitude_m')}
            label="Growing altitude (m)"
            value={bean.altitude_m}
            onChange={(altitude_m) => patch({ altitude_m })}
            error={errors[input('altitude_m')]}
            hint="Recorded descriptor; no fitted altitude coefficient."
          />
          <SelectField
            path={input('process')}
            label="Model process category"
            value={bean.process}
            options={[
              { value: '', label: 'Use preset / not specified' },
              ...BEAN_PROCESSES.map((value) => ({ value, label: PROCESS_LABELS[value] })),
            ]}
            onChange={(process) => patch({ process: process as BeanLeafForm['process'] })}
            error={errors[input('process')]}
          />
          <SelectField
            path={input('variety_group')}
            label="Variety group"
            value={bean.variety_group}
            options={[
              { value: '', label: 'Use preset / unspecified' },
              ...BEAN_VARIETIES.map((value) => ({ value, label: VARIETY_LABELS[value] })),
            ]}
            onChange={(variety_group) =>
              patch({ variety_group: variety_group as BeanLeafForm['variety_group'] })
            }
            hint="Recorded descriptor; no variety-specific chemical multiplier."
          />
        </div>
        {facts.model_roast_basis && <p className="field-hint">{facts.model_roast_basis}</p>}
      </CoffeeDetails>
    </div>
  );
}

export function BeanSection() {
  const { catalog, errors, notes, notesStale } = useEditorContext();
  const form = useShotStore((s) => s.form);
  const patch = useShotStore((s) => s.patchForm);
  const setup = useSetupConstraints();
  const [knowledgeNotice, setKnowledgeNotice] = useState('');
  const undo = useShotStore((s) => s.undo);
  const undoLast = useShotStore((s) => s.undoLast);
  const b = form.bean;
  const components = b.components;
  const replace = (bean: BeanForm, change: CoffeeChange) => {
    try {
      const changed = replaceCoffee(form, bean, change, setup);
      setKnowledgeNotice(
        changed
          ? 'Known settings now follow the retained coffees. Facts for a replaced or removed coffee were cleared; Undo restores the previous coffee and its known settings.'
          : 'Coffee updated. Undo restores the previous coffee settings.',
      );
    } catch (error) {
      setKnowledgeNotice(
        error instanceof Error ? error.message : 'Could not update coffee settings.',
      );
    }
  };
  const update = (bean: BeanForm) =>
    patch('bean', { ...bean, coffee: bean.coffee, components: bean.components });
  const total =
    components?.reduce((sum, component) => sum + Math.max(0, Number(component.weight) || 0), 0) ??
    0;
  const title = (bean: BeanLeafForm) =>
    bean.coffee?.name ?? findPreset(catalog.presets.beans, bean.preset)?.name ?? 'Your coffee';
  return (
    <div className="coffee-editor">
      {components ? (
        <>
          <TextField
            path="bean.coffee.name"
            label="Blend name"
            inputMode="text"
            value={b.coffee?.name ?? ''}
            onChange={(name) => update({ ...b, coffee: { ...b.coffee, name } })}
            error={errors['bean.coffee.name']}
          />
          <p className="field-hint">
            Add up to six coffees. Enter relative parts, such as 70 and 30 or 7 and 3; the model
            uses their normalized mass shares.
          </p>
          {errors['bean.components'] && (
            <p className="field-error" role="alert">
              {errors['bean.components']}
            </p>
          )}
          <div
            className="coffee-blend-bar"
            role="img"
            aria-label={components
              .map(
                (component) =>
                  `${title(component.bean)}: ${total > 0 ? ((100 * (Number(component.weight) || 0)) / total).toFixed(1) : '0'} percent`,
              )
              .join('; ')}
          >
            {components.map((component, i) => (
              <span
                key={component.key}
                className={`coffee-share coffee-share-${i % 6}`}
                style={{ flexGrow: Math.max(0, Number(component.weight) || 0) }}
              />
            ))}
          </div>
          {components.map((component, i) => (
            <CoffeeDetails
              className="coffee-component"
              key={component.key}
              paths={[`bean.components.${i}`]}
              defaultOpen={i === 0}
              summary={
                <>
                  <span>
                    {i + 1}. {title(component.bean)}
                  </span>
                  <strong>
                    {total > 0 ? ((100 * (Number(component.weight) || 0)) / total).toFixed(1) : '0'}
                    %
                  </strong>
                </>
              }
            >
              <div className="coffee-component-body">
                <div className="coffee-component-actions">
                  <TextField
                    path={`bean.components.${i}.weight`}
                    label={`Coffee ${i + 1} parts by mass`}
                    value={component.weight}
                    error={errors[`bean.components.${i}.weight`]}
                    onChange={(weight) =>
                      update({
                        ...b,
                        components: components.map((row, j) =>
                          j === i ? { ...row, weight } : row,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => replace({ ...component.bean }, { kind: 'use-alone', index: i })}
                  >
                    Use coffee {i + 1} alone
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={components.length <= 1}
                    onClick={() =>
                      replace(
                        { ...b, components: components.filter((_, j) => j !== i) },
                        { kind: 'remove', index: i },
                      )
                    }
                  >
                    Remove coffee {i + 1}
                  </button>
                </div>
                <CoffeeLeafEditor
                  bean={component.bean}
                  path={`bean.components.${i}.bean`}
                  onChange={(bean) =>
                    update({
                      ...b,
                      components: components.map((row, j) => (j === i ? { ...row, bean } : row)),
                    })
                  }
                  onReplace={(bean) =>
                    replace(
                      {
                        ...b,
                        components: components.map((row, j) => (j === i ? { ...row, bean } : row)),
                      },
                      { kind: 'replace', path: `bean.components.${i}.bean` },
                    )
                  }
                />
              </div>
            </CoffeeDetails>
          ))}
          <button
            type="button"
            className="button button-quiet"
            disabled={components.length >= 6}
            onClick={() =>
              replace(
                {
                  ...b,
                  components: [
                    ...components,
                    { key: componentKey(), weight: '1', bean: emptyForm().bean },
                  ],
                },
                { kind: 'add' },
              )
            }
          >
            Add another coffee
          </button>
          <p className="field-hint">
            Each coffee’s composition and age are evaluated before mixing. The simulation then uses
            one homogeneous coffee bed; it does not track separate extraction paths for each
            component.
          </p>
        </>
      ) : (
        <>
          <CoffeeLeafEditor
            bean={b}
            path="bean"
            onChange={update}
            onReplace={(bean) => replace(bean, { kind: 'replace', path: 'bean' })}
          />
          <button
            type="button"
            className="button button-quiet"
            onClick={() =>
              replace(
                {
                  ...emptyForm().bean,
                  coffee: { name: 'My blend' },
                  components: [
                    { key: componentKey(), weight: '1', bean: { ...b } },
                    { key: componentKey(), weight: '1', bean: emptyForm().bean },
                  ],
                },
                { kind: 'create-blend' },
              )
            }
          >
            Create a blend with this coffee
          </button>
        </>
      )}
      {undo?.label === 'Undo coffee change' && (
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            try {
              undoLast();
              setKnowledgeNotice('Restored the previous coffee and its known settings.');
            } catch (error) {
              setKnowledgeNotice(
                error instanceof Error ? error.message : 'Could not restore coffee settings.',
              );
            }
          }}
        >
          Undo coffee change
        </button>
      )}
      {knowledgeNotice && (
        <p className="field-hint" role="status">
          {knowledgeNotice}
        </p>
      )}
      <BuildNotes notes={notes.bean} stale={notesStale} />
    </div>
  );
}
