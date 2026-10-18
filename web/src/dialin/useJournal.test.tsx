// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as journal from './journal';
import { useJournal } from './useJournal';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('drops a cancelled update waiting behind an earlier save before invoking its mutation', async () => {
  let finish!: () => void;
  const firstSave = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save = vi.fn(() => firstSave);
  const store: journal.JournalStore = {
    persistent: false,
    load: () => Promise.resolve(journal.emptyJournal()),
    save,
    close: vi.fn(),
  };
  vi.spyOn(journal, 'openJournal').mockResolvedValue(store);
  const { result } = renderHook(useJournal);
  await waitFor(() => expect(result.current.ready).toBe(true));
  let first!: Promise<void>;
  act(() => {
    first = result.current.update((doc) => doc);
  });
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const control = new AbortController();
  const change = vi.fn((doc: ReturnType<typeof journal.emptyJournal>) => doc);
  let cancelled!: Promise<unknown>;
  act(() => {
    cancelled = result.current.update(change, control.signal).catch((failure: unknown) => failure);
  });
  control.abort();
  await act(async () => {
    finish();
    await first;
  });
  expect(await cancelled).toMatchObject({ name: 'AbortError' });
  expect(change).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledOnce();
  expect(result.current.document).toEqual(journal.emptyJournal());
});
