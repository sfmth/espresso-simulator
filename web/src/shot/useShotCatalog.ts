// SPDX-License-Identifier: GPL-2.0-or-later
import { useEffect, useState } from 'react';
import { useEngine } from '../engine/EngineContext';
import { useShotStore } from './shotStore';

/** One shared catalog loader, independent of which workspace is visible. */
export function useShotCatalog(): { retry: () => void } {
  const engine = useEngine();
  const catalog = useShotStore((s) => s.catalog);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (catalog) return;
    let active = true;
    engine.catalog().then(
      ({ result }) => {
        if (active) useShotStore.getState().setCatalog(result);
      },
      (error: unknown) => {
        if (active)
          useShotStore
            .getState()
            .setCatalogError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [engine, catalog, attempt]);
  return {
    retry: () => {
      useShotStore.getState().setCatalogError(null);
      setAttempt((a) => a + 1);
    },
  };
}
