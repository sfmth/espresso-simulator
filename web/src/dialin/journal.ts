// SPDX-License-Identifier: GPL-2.0-or-later
/** Local journal. A save resolves only after its IndexedDB transaction commits. */
import type { CalibrationProfile, JournalDocument, JournalEntry } from './types';
import { cloneDocument, MAX_JOURNAL_BYTES, validateDocument } from './journalValidation';
import { applyCalibration } from './calibration';

export function emptyJournal(): JournalDocument {
  return { schema: 'puckworks.journal/1', entries: [], calibrations: [] };
}

/** External files cannot attest that their prediction preceded the observation. */
export function parseJournal(text: string): JournalDocument {
  if (new TextEncoder().encode(text).length > MAX_JOURNAL_BYTES)
    throw new Error('Journal exceeds 10 MB limit');
  const input: unknown = JSON.parse(text);
  validateDocument(input);
  const doc = cloneDocument(input);
  doc.entries = doc.entries.map((entry) => ({
    ...entry,
    source: 'json',
    ...(entry.prediction ? { prediction: { ...entry.prediction, origin: 'import' as const } } : {}),
  }));
  return doc;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Duplicate identical records are idempotent; conflicting ids are explicit errors. */
export function mergeJournal(current: JournalDocument, incoming: JournalDocument): JournalDocument {
  const a = cloneDocument(current),
    b = cloneDocument(incoming);
  function merge<T extends { id: string }>(left: T[], right: T[], kind: string): T[] {
    const byId = new Map(left.map((v) => [v.id, v]));
    for (const row of right) {
      const old = byId.get(row.id);
      if (old && stable(old) !== stable(row)) {
        // Reimporting our own export adds no evidence, and must not replace local provenance.
        const normalize = (v: T) => {
          const copy = structuredClone(v) as T & {
            source?: string;
            prediction?: { origin: string };
          };
          if ('source' in copy) copy.source = 'json';
          if (copy.prediction) copy.prediction.origin = 'import';
          return copy;
        };
        if (stable(normalize(old)) !== stable(normalize(row)))
          throw new Error(`Conflicting ${kind} id ${row.id}; existing record preserved`);
      } else if (!old) byId.set(row.id, row);
    }
    return [...byId.values()];
  }
  return cloneDocument({
    schema: a.schema,
    entries: merge(a.entries, b.entries, 'entry'),
    calibrations: merge(a.calibrations, b.calibrations, 'calibration'),
  });
}

function assertSnapshots(current: JournalDocument, next: JournalDocument): void {
  const previous = new Map(current.entries.map((e) => [e.id, e]));
  for (const entry of next.entries) {
    const old = previous.get(entry.id);
    if (old) {
      for (const key of ['createdAt', 'setupId', 'recipe', 'source'] as const)
        if (stable(old[key]) !== stable(entry[key]))
          throw new Error(`Entry ${entry.id}: ${key} is immutable; create a new entry`);
      if (old.prediction && stable(old.prediction) !== stable(entry.prediction))
        throw new Error(`Entry ${entry.id}: prediction snapshot is immutable`);
      if (old.measurement && !old.prediction && entry.prediction)
        throw new Error(`Entry ${entry.id}: cannot add a prediction after its measurement`);
      if (old.measurement && old.measurement.recordedAt !== entry.measurement?.recordedAt)
        throw new Error(`Entry ${entry.id}: measurement timestamp is immutable`);
    }
    if (entry.prediction?.origin === 'app' && !old?.prediction) {
      if (entry.source !== 'manual' || entry.measurement)
        throw new Error(`Entry ${entry.id}: save the prediction before adding a measurement`);
      const now = Date.now(),
        predictionAt = Date.parse(entry.prediction.recordedAt),
        createdAt = Date.parse(entry.createdAt);
      if (
        predictionAt < now - 60_000 ||
        predictionAt > now + 5000 ||
        createdAt > predictionAt ||
        createdAt < now - 60_000
      )
        throw new Error(`Entry ${entry.id}: app predictions must be recorded now, before the shot`);
    }
    if (
      entry.prediction &&
      entry.measurement &&
      entry.prediction.origin === 'app' &&
      Date.parse(entry.measurement.recordedAt) <= Date.parse(entry.prediction.recordedAt)
    )
      throw new Error(`Entry ${entry.id}: measurement must follow prediction`);
  }
  const profiles = new Map(current.calibrations.map((p) => [p.id, p]));
  for (const p of next.calibrations)
    if (profiles.has(p.id) && stable(profiles.get(p.id)) !== stable(p))
      throw new Error(`Calibration ${p.id}: saved fit is immutable; create a new calibration`);
}

export interface JournalStore {
  load(): Promise<JournalDocument>;
  save(doc: JournalDocument): Promise<void>;
  persistent: boolean;
  close(): void;
}

/** Explicit volatile fallback for unavailable/blocked storage; never claims durability. */
function memoryJournal(): JournalStore {
  let doc = emptyJournal(),
    closed = false;
  let queue = Promise.resolve();
  const enqueue = <T>(action: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(() => {
      if (closed) throw new Error('Journal is closed');
      return action();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    persistent: false,
    load: () => enqueue(() => cloneDocument(doc)),
    save: (value) => {
      let snapshot: JournalDocument;
      try {
        snapshot = cloneDocument(value);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return enqueue(() => {
        assertSnapshots(doc, snapshot);
        doc = snapshot;
      });
    },
    close: () => {
      closed = true;
    },
  };
}

export async function openJournal(): Promise<JournalStore> {
  if (typeof indexedDB === 'undefined') return memoryJournal();
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('puckworks-journal', 1);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error('Journal storage opening timed out'));
      }, 3000);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('documents'))
          request.result.createObjectStore('documents');
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (timedOut) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timeout);
        reject(request.error ?? new Error('Could not open journal storage'));
      };
      request.onblocked = () => {
        clearTimeout(timeout);
        timedOut = true;
        reject(new Error('Journal storage is blocked'));
      };
    });
  } catch {
    return memoryJournal();
  }
  let closed = false;
  db.onversionchange = () => {
    closed = true;
    db.close();
  };
  let queue = Promise.resolve();
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(() => {
      if (closed) throw new Error('Journal is closed');
      return action();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let lastSeen: JournalDocument | null = null;
  const transaction = (
    mode: IDBTransactionMode,
    next?: JournalDocument,
  ): Promise<JournalDocument> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction('documents', mode),
        store = tx.objectStore('documents');
      let result = emptyJournal(),
        validationError: unknown;
      const request = store.get('journal');
      request.onsuccess = () => {
        try {
          result =
            request.result === undefined
              ? emptyJournal()
              : cloneDocument(request.result as JournalDocument);
          if (next) {
            if (stable(result) !== stable(lastSeen ?? emptyJournal()))
              throw new Error(
                'Journal changed in another tab; reload before saving to preserve its changes',
              );
            assertSnapshots(result, next);
            store.put(next, 'journal');
            result = next;
          }
        } catch (error) {
          validationError = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        lastSeen = cloneDocument(result);
        resolve(cloneDocument(result));
      };
      tx.onerror = tx.onabort = () =>
        reject(
          validationError instanceof Error
            ? validationError
            : (tx.error ?? new Error('Journal transaction failed; changes were not saved')),
        );
    });
  return {
    persistent: true,
    load: () => enqueue(() => transaction('readonly')),
    save: (value) => {
      let snapshot: JournalDocument;
      try {
        snapshot = cloneDocument(value);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return enqueue(async () => {
        await transaction('readwrite', snapshot);
      });
    },
    close: () => {
      closed = true;
      db.close();
    },
  };
}

export interface Scorecard {
  eligible: number;
  evaluated: number;
  passed: number;
  required: 10;
  met: boolean;
  timeMaeS: number | null;
  timeOnly: { evaluated: number; passed: number; maeS: number | null; met: boolean };
  eyMaePoints: number | null;
  rows: { entryId: string; timeErrorS: number; eyErrorPoints: number; pass: boolean }[];
  excluded: Record<
    'training' | 'imported' | 'noPrediction' | 'noMeasurement' | 'missingTds' | 'notProspective',
    number
  >;
}
/** Compare actual conditions with the exact saved fit; numeric solver tier is not a physical condition. */
function sameConditions(entry: JournalEntry, profile: CalibrationProfile): boolean {
  if (!entry.prediction) return false;
  try {
    const expected = applyCalibration(entry.recipe, profile, entry.prediction.coreVersion);
    const executed = structuredClone(entry.prediction.executedRecipe);
    delete expected.numerics;
    delete executed.numerics;
    return stable(expected) === stable(executed);
  } catch {
    return false;
  }
}
/** Real prospective observations only. Imported/backfilled/training records cannot pass V9. */
export function scorecard(entries: JournalEntry[], profiles: CalibrationProfile[]): Scorecard {
  const result: Scorecard = {
    eligible: 0,
    evaluated: 0,
    passed: 0,
    required: 10,
    met: false,
    timeMaeS: null,
    timeOnly: { evaluated: 0, passed: 0, maeS: null, met: false },
    eyMaePoints: null,
    rows: [],
    excluded: {
      training: 0,
      imported: 0,
      noPrediction: 0,
      noMeasurement: 0,
      missingTds: 0,
      notProspective: 0,
    },
  };
  const training = new Set(profiles.flatMap((p) => p.trainingIds));
  let timingAbsoluteError = 0;
  for (const entry of entries) {
    const p = entry.prediction,
      m = entry.measurement;
    if (training.has(entry.id)) {
      result.excluded.training++;
      continue;
    }
    if (!p) {
      result.excluded.noPrediction++;
      continue;
    }
    if (!m) {
      result.excluded.noMeasurement++;
      continue;
    }
    if (p.origin !== 'app' || entry.source !== 'manual') {
      result.excluded.imported++;
      continue;
    }
    const calibration = profiles.find((c) => c.id === p.calibrationId);
    const at = Date.parse(p.recordedAt),
      measuredAt = Date.parse(m.recordedAt),
      createdAt = Date.parse(entry.createdAt);
    if (
      !calibration ||
      calibration.setupId !== entry.setupId ||
      calibration.coreVersion !== p.coreVersion ||
      !Number.isFinite(at) ||
      !Number.isFinite(measuredAt) ||
      !Number.isFinite(createdAt) ||
      createdAt > at ||
      !(Date.parse(calibration.createdAt) <= at) ||
      !(at < measuredAt) ||
      !sameConditions(entry, calibration)
    ) {
      result.excluded.notProspective++;
      continue;
    }
    const timeErrorS = p.summary.shot_time_s - m.timeS;
    if (
      !Number.isFinite(timeErrorS) ||
      !Number.isFinite(m.yieldG) ||
      !Number.isFinite(entry.recipe.prep.dose_g) ||
      m.timeS <= 0 ||
      m.yieldG <= 0 ||
      entry.recipe.prep.dose_g <= 0
    ) {
      result.excluded.notProspective++;
      continue;
    }
    result.timeOnly.evaluated++;
    timingAbsoluteError += Math.abs(timeErrorS);
    if (Math.abs(timeErrorS) <= 3 + 1e-9) result.timeOnly.passed++;
    if (m.tdsPercent === undefined || !Number.isFinite(m.tdsPercent)) {
      result.excluded.missingTds++;
      continue;
    }
    // TDS is a percentage here; EY points = percentage × beverage mass / dry dose.
    const measuredEy = (m.tdsPercent * m.yieldG) / entry.recipe.prep.dose_g;
    if (
      m.tdsPercent <= 0 ||
      m.tdsPercent > 100 ||
      m.yieldG <= 0 ||
      m.timeS <= 0 ||
      entry.recipe.prep.dose_g <= 0 ||
      measuredEy > 100
    ) {
      result.excluded.notProspective++;
      continue;
    }
    const eyErrorPoints = p.summary.ey * 100 - measuredEy;
    if (![timeErrorS, eyErrorPoints].every(Number.isFinite)) {
      result.excluded.notProspective++;
      continue;
    }
    const pass = Math.abs(timeErrorS) <= 3 + 1e-9 && Math.abs(eyErrorPoints) <= 1 + 1e-9;
    result.rows.push({ entryId: entry.id, timeErrorS, eyErrorPoints, pass });
  }
  if (result.timeOnly.evaluated)
    result.timeOnly.maeS = timingAbsoluteError / result.timeOnly.evaluated;
  result.timeOnly.met =
    result.timeOnly.evaluated >= result.required &&
    result.timeOnly.passed === result.timeOnly.evaluated;
  result.eligible = result.evaluated = result.rows.length;
  result.passed = result.rows.filter((r) => r.pass).length;
  result.met = result.evaluated >= result.required && result.passed === result.evaluated;
  if (result.evaluated) {
    result.timeMaeS =
      result.rows.reduce((sum, r) => sum + Math.abs(r.timeErrorS), 0) / result.evaluated;
    result.eyMaePoints =
      result.rows.reduce((sum, r) => sum + Math.abs(r.eyErrorPoints), 0) / result.evaluated;
  }
  return result;
}
