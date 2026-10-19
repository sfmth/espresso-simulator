// SPDX-License-Identifier: GPL-2.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyJournal, openJournal } from './journal';
import type { JournalDocument } from './types';

/** Publish state only after the IndexedDB transaction commits. Queue rapid edits. */
export function useJournal() {
  const [document, setDocument] = useState<JournalDocument>(emptyJournal);
  const [ready, setReady] = useState(false);
  const [persistent, setPersistent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backend = useRef<Awaited<ReturnType<typeof openJournal>> | null>(null);
  const latest = useRef(document);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    let opened: Awaited<ReturnType<typeof openJournal>> | null = null;
    void openJournal()
      .then(async (journal) => {
        opened = journal;
        if (!active) {
          journal.close();
          return;
        }
        try {
          const loaded = await journal.load();
          if (!active) return;
          backend.current = journal;
          latest.current = loaded;
          setDocument(loaded);
          setPersistent(journal.persistent);
          setReady(true);
        } catch (failure) {
          if (active) setError(String(failure));
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
      backend.current = null;
      opened?.close();
    };
  }, []);
  const update = useCallback(
    (change: (current: JournalDocument) => JournalDocument, signal?: AbortSignal) => {
      const task = queue.current
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          if (!backend.current) throw new Error('The journal is not ready.');
          const next = change(latest.current);
          await backend.current.save(next, signal);
          latest.current = next;
          setDocument(next);
          setError(null);
        });
      queue.current = task;
      return task;
    },
    [],
  );
  return { document, ready, persistent, error, update };
}
