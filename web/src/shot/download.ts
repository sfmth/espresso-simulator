// SPDX-License-Identifier: GPL-2.0-or-later
/** Saving a file the page made (a Blob), which never leaves the browser. */

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename: string, value: unknown): void {
  downloadText(filename, `${JSON.stringify(value, null, 2)}\n`, 'application/json');
}

export function downloadCsv(filename: string, csv: string): void {
  downloadText(filename, csv, 'text/csv');
}

/** A file name with the date: "puckworks-result-2026-10-14.json". */
export function datedName(stem: string, extension: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `puckworks-${stem}-${date}.${extension}`;
}
