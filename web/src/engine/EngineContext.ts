// SPDX-License-Identifier: GPL-2.0-or-later
import { createContext, useContext } from 'react';
import { getEngine, type Engine } from './engine';

/** Supplies the engine to components; tests provide a fake. */
export const EngineContext = createContext<Engine | null>(null);

/** The engine from context, or the app-wide one. */
export function useEngine(): Engine {
  return useContext(EngineContext) ?? getEngine();
}
