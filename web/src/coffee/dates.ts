// SPDX-License-Identifier: GPL-2.0-or-later
/** Calendar days, independent of DST and the time of day at which the shot was entered. */
export function localDate(today = new Date()): string {
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
}

function calendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value)
    return null;
  return timestamp / 86_400_000;
}

export function calculateRoastAge(
  roastDate: string,
  shotDate: string,
  maxDays?: number,
): { ok: true; days: number } | { ok: false; error: string } {
  const roast = calendarDay(roastDate);
  const shot = calendarDay(shotDate);
  if (roast === null) return { ok: false, error: 'Enter a real roast date as YYYY-MM-DD.' };
  if (shot === null) return { ok: false, error: 'Enter a real shot date as YYYY-MM-DD.' };
  const days = shot - roast;
  if (days < 0) return { ok: false, error: 'The roast date must be on or before the shot date.' };
  if (maxDays !== undefined && days > maxDays)
    return {
      ok: false,
      error: `This model supports ages up to ${maxDays} days; these dates are ${days} days apart.`,
    };
  return { ok: true, days };
}
