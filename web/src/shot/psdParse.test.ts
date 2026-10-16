// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { formatPsdText, MAX_PSD_ROWS, parsePsdText } from './psdParse';

describe('parsePsdText', () => {
  it('reads tab-separated columns copied from a spreadsheet, with a header', () => {
    expect(parsePsdText('Size (µm)\tVolume %\n30\t10\n60\t15\n150\t75\n')).toEqual({
      ok: true,
      diameter_um: [30, 60, 150],
      volume_fraction: [10, 15, 75],
      notes: [],
    });
  });

  it('reads semicolons with decimal commas, as European exports write them', () => {
    const result = parsePsdText('d;q\n12,5;0,25\n100;0,75');
    expect(result).toMatchObject({
      ok: true,
      diameter_um: [12.5, 100],
      volume_fraction: [0.25, 0.75],
    });
  });

  it('reads commas and spaces as separators, skipping comments and blank lines', () => {
    expect(parsePsdText('# from my sieve run\n\n100, 0.4\n  300   0.6  ')).toMatchObject({
      ok: true,
      diameter_um: [100, 300],
      volume_fraction: [0.4, 0.6],
    });
  });

  it('accepts scientific notation and uses only the first two columns', () => {
    const result = parsePsdText('5e1\t1e-1\tq0\n1.5E2\t0.9\textra');
    expect(result).toEqual({
      ok: true,
      diameter_um: [50, 150],
      volume_fraction: [0.1, 0.9],
      notes: ['Only the first two columns are used.'],
    });
  });

  it('puts rows that run from coarse to fine in increasing order', () => {
    const result = parsePsdText('500\t0.2\n300\t0.5\n100\t0.3');
    expect(result).toMatchObject({
      ok: true,
      diameter_um: [100, 300, 500],
      volume_fraction: [0.3, 0.5, 0.2],
    });
    expect(result.ok && result.notes[0]).toMatch(/coarse to fine/);
  });

  it.each([
    ['', /Paste at least one row/],
    ['size\tfraction', /Paste at least one row/],
    ['100\t0.5\n100\t0.5', /line 2 has 100 µm after 100 µm/],
    ['100\t0.5\n300\t0.2\n200\t0.3', /Diameters must increase/],
    ['0\t0.5', /diameter must be more than 0/],
    ['100\t-1', /volume fraction must be 0 or more/],
    ['100\t0\n200\t0', /At least one volume fraction must be more than 0/],
    ['100\t0.5\nabc\tdef', /Line 2 \("abc\tdef"\) does not start with two numbers/],
  ])('rejects %j', (text, message) => {
    const result = parsePsdText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it.each([
    ['cumulative % passing, fine to coarse', '100\t10\n200\t40\n300\t80\n400\t100'],
    [
      'cumulative % retained, coarse to fine (a sieve column)',
      '1000\t2.5\n800\t20.5\n500\t60\n200\t100',
    ],
    ['cumulative fractions ending at 1', '50\t0.1\n100\t0.4\n200\t1.0'],
  ])('refuses a column that looks cumulative: %s', (_name, text) => {
    const result = parsePsdText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/looks cumulative/);
  });

  it('accepts monotone columns that are plainly per bin', () => {
    expect(parsePsdText('100\t10\n200\t30\n300\t60').ok).toBe(true);
    expect(parsePsdText('100\t0.3\n200\t0.7').ok).toBe(true);
  });

  it('reads a decimal comma between spaces, and reports a numeric line it cannot read', () => {
    expect(parsePsdText('20 3,5\n40 6,5')).toMatchObject({
      ok: true,
      diameter_um: [20, 40],
      volume_fraction: [3.5, 6.5],
    });
    const bad = parsePsdText('20 3x5\n40 6');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Line 1 /);
  });

  it('limits the number of rows', () => {
    const text = Array.from({ length: MAX_PSD_ROWS + 1 }, (_, i) => `${i + 1}\t1`).join('\n');
    expect(parsePsdText(text)).toEqual({
      ok: false,
      error: `At most ${MAX_PSD_ROWS} rows are accepted.`,
    });
  });

  it('writes a distribution that it reads back unchanged', () => {
    const text = formatPsdText([7.3, 458], [0.2, 0.8]);
    expect(text).toBe('diameter_um\tvolume_fraction\n7.3\t0.2\n458\t0.8');
    expect(parsePsdText(text)).toEqual({
      ok: true,
      diameter_um: [7.3, 458],
      volume_fraction: [0.2, 0.8],
      notes: [],
    });
  });
});
