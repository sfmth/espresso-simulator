// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { HelpField } from './HelpButton';
import { TextField } from '../shot/fields';

afterEach(cleanup);
it('keeps an explicit field target and exact label while providing measurement help', () => {
  render(
    <HelpField term="dose" label="My dose">
      <input id="saved-shot-dose" defaultValue="18" />
    </HelpField>,
  );
  const input = screen.getByRole('textbox', { name: 'My dose' });
  expect(input.id).toBe('saved-shot-dose');
  fireEvent.click(screen.getByRole('button', { name: 'Help for My dose' }));
  const dialog = screen.getByRole('dialog', { name: 'My dose help' });
  expect(document.activeElement).toBe(dialog);
  expect(within(dialog).getByText(/More coffee makes a deeper bed/)).toBeTruthy();
  fireEvent.click(within(dialog).getByText('Useful measuring tools'));
  expect(
    within(dialog)
      .getByRole('link', { name: /Greater Goods/ })
      .getAttribute('href'),
  ).toContain('greatergoods.com');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Help for My dose' }));
  expect(screen.getByRole('textbox', { name: 'My dose' })).toBe(input);
});
it('provides shared illustrated/editor field help without exposing its technical hint until requested', () => {
  render(
    <TextField
      path="grinder.rpm"
      label="Burr speed"
      value="900"
      onChange={() => {}}
      hint="From the equipment specification."
    />,
  );
  expect(screen.queryByText('From the equipment specification.')).toBeNull();
  const button = screen.getByRole('button', { name: 'What is Grinder specification?' });
  fireEvent.click(button);
  const region = screen.getByRole('region', { name: 'Grinder specification help' });
  expect(
    within(region).getByText(/does not add an independently calibrated physical effect/),
  ).toBeTruthy();
  expect(within(region).getByText('From the equipment specification.')).toBeTruthy();
  fireEvent.keyDown(region, { key: 'Escape' });
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole('region')).toBeNull();
});
