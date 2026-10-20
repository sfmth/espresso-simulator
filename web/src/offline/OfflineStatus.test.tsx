// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflineClient, OfflineSnapshot } from './offline';
import { OfflineStatus } from './OfflineStatus';

function client(initial: Partial<OfflineSnapshot> = {}) {
  let state: OfflineSnapshot = {
    phase: 'checking',
    online: true,
    saved: false,
    action: null,
    updating: false,
    error: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const value: OfflineClient = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: vi.fn(),
    reloadToUseSavedCopy: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    value,
    update(patch: Partial<OfflineSnapshot>) {
      act(() => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
      });
    },
    listeners,
  };
}
afterEach(cleanup);
describe('offline availability UI', () => {
  it('hides development status and states unsupported/offline conditions without disabling the app', () => {
    const f = client({ phase: 'disabled' });
    const { unmount } = render(<OfflineStatus client={f.value} />);
    expect(screen.queryByRole('status')).toBeNull();
    f.update({
      phase: 'unavailable',
      online: false,
      error: 'Offline use is unavailable in this browser.',
    });
    expect(screen.getByRole('status').textContent).toContain('Offline.');
    expect(screen.getByText('Offline use is unavailable in this browser.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    expect(f.listeners.size).toBe(0);
  });
  it('shows installation, controlled readiness and an explicit saved-copy fallback', () => {
    const f = client({ phase: 'installing' });
    render(<OfflineStatus client={f.value} />);
    expect(screen.getByRole('status').textContent).toContain('Saving this app');
    f.update({ phase: 'unavailable', saved: true, action: 'enable' });
    expect(screen.getByRole('status').textContent).not.toContain('Ready for offline use.');
    expect(screen.getByRole('button', { name: 'Reload to enable offline use' })).toBeTruthy();
    f.update({ phase: 'ready', action: null });
    expect(screen.getByRole('status').textContent).toBe('Ready for offline use.');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('warns about the current session and only requests an update on the explicit button click', () => {
    const f = client({ phase: 'ready', saved: true, action: 'update' });
    render(<OfflineStatus client={f.value} />);
    expect(f.value.reloadToUseSavedCopy).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('An app update is available.');
    expect(
      screen.getByText(/Reload closes current simulations and may reset the recipe form/),
    ).toBeTruthy();
    expect(screen.getByText(/Saved journal records stay in this browser/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(f.value.reloadToUseSavedCopy).toHaveBeenCalledOnce();
    f.update({ updating: true });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Loading update…' }).disabled,
    ).toBe(true);
  });
});
