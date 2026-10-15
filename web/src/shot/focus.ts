// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Keyboard focus after actions that remove the focused control (removing a
 * row, unpinning, resetting an override): focus moves to a neighbour named by
 * id once React has rendered it, instead of falling back to the page body.
 */

const schedule: (callback: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (callback) => void requestAnimationFrame(callback)
    : (callback) => void setTimeout(callback, 16);

/**
 * Focuses the element `ids[0]` after the next render, trying for a few frames
 * while it appears (a folded section may have to open first); only if it never
 * appears are the later ids tried, in order, as fallbacks.
 */
export function focusSoon(
  ids: string | readonly string[],
  tries = 10,
  onDone?: (focused: boolean) => void,
): void {
  const list = typeof ids === 'string' ? [ids] : ids;
  const attempt = (left: number) => {
    const candidates = left > 0 ? list.slice(0, 1) : list;
    const element = candidates
      .map((id) => document.getElementById(id))
      .find((e): e is HTMLElement => e !== null);
    if (element) {
      element.focus();
      onDone?.(true);
      return;
    }
    if (left > 0) schedule(() => attempt(left - 1));
    else onDone?.(false);
  };
  schedule(() => attempt(tries));
}
