// SPDX-License-Identifier: GPL-2.0-or-later
import { useEffect, useSyncExternalStore } from 'react';
import { getOfflineClient, type OfflineClient } from './offline';

export function OfflineStatus({ client = getOfflineClient() }: { client?: OfflineClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    client.start();
  }, [client]);
  if (state.phase === 'disabled') return null;
  return (
    <aside className="offline-status" aria-label="Offline availability">
      <p role="status">
        {!state.online && <strong>Offline. </strong>}
        {state.phase === 'ready'
          ? 'Ready for offline use.'
          : state.saved
            ? 'Offline copy saved. Reload to enable offline use.'
            : state.phase === 'checking'
              ? 'Checking offline availability…'
              : state.phase === 'installing'
                ? 'Saving this app for offline use…'
                : 'This version is not ready for offline use.'}
        {state.action === 'update' && ' An app update is available.'}
      </p>
      {state.error && <p className="note">{state.error}</p>}
      {state.action && (
        <div>
          <button
            className="button"
            type="button"
            disabled={state.updating}
            onClick={client.reloadToUseSavedCopy}
          >
            {state.updating
              ? 'Loading update…'
              : state.action === 'enable'
                ? 'Reload to enable offline use'
                : 'Reload to update'}
          </button>
          <p className="note">
            Reload closes current simulations and may reset the recipe form. Export inputs in Lab
            first if needed. Saved journal records stay in this browser.
          </p>
        </div>
      )}
    </aside>
  );
}
