// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { calculateRoastAge, localDate } from './dates';

describe('explicit roast age calculation', () => {
  it('counts calendar days across leap day and DST boundaries', () => {
    expect(calculateRoastAge('2024-02-28', '2024-03-01')).toEqual({ ok: true, days: 2 });
    expect(calculateRoastAge('2026-03-07', '2026-03-09')).toEqual({ ok: true, days: 2 });
    expect(calculateRoastAge('2026-10-23', '2026-10-23')).toEqual({ ok: true, days: 0 });
  });
  it.each(['', '2026-2-01', '2026-02-29', '2026-04-31', '0000-01-01', '2026-13-01'])(
    'rejects an invalid or partial calendar date %s',
    (date) => {
      expect(calculateRoastAge(date, '2026-10-23').ok).toBe(false);
      expect(calculateRoastAge('2026-01-01', date).ok).toBe(false);
    },
  );
  it('rejects roast dates after the shot and ages beyond the model limit', () => {
    expect(calculateRoastAge('2026-10-24', '2026-10-23')).toMatchObject({
      ok: false,
      error: expect.stringContaining('on or before'),
    });
    expect(calculateRoastAge('2000-01-01', '2026-10-23', 3650)).toMatchObject({
      ok: false,
      error: expect.stringContaining('3650 days'),
    });
  });
  it('formats the local calendar day rather than substituting UTC', () => {
    const date = new Date(2026, 0, 2, 23, 59);
    expect(localDate(date)).toBe('2026-01-02');
  });
});
