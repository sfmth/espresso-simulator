// SPDX-License-Identifier: GPL-2.0-or-later
import { createContext, useContext, type ReactNode } from 'react';
import { useShotCatalog } from './useShotCatalog';
import { useShotRun, type ShotRunControls } from './useShotRun';

export interface SharedShotRunControls extends ShotRunControls {
  retryCatalog: () => void;
}
const ShotRunContext = createContext<SharedShotRunControls | null>(null);

/** Own the automatic/full run channels once, above the Lab and Explore views. */
export function ShotRunProvider({ children }: { children: ReactNode }) {
  const { retry } = useShotCatalog();
  const controls = useShotRun();
  return (
    <ShotRunContext.Provider value={{ ...controls, retryCatalog: retry }}>
      {children}
    </ShotRunContext.Provider>
  );
}
export function useOptionalSharedShotRun(): SharedShotRunControls | null {
  return useContext(ShotRunContext);
}
export function useSharedShotRun(): SharedShotRunControls {
  const controls = useOptionalSharedShotRun();
  if (!controls) throw new Error('Shared shot controls require ShotRunProvider.');
  return controls;
}
