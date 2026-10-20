// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PuckCameraControls } from './PuckCameraControls';
import type { CameraAction } from './cameraControls';

afterEach(cleanup);

describe('camera keyboard and button equivalence', () => {
  it('provides named native actions and scoped keyboard shortcuts without automatic movement', () => {
    const onAction = vi.fn<(action: CameraAction) => void>();
    render(
      <PuckCameraControls disabled={false} onAction={onAction}>
        <canvas />
      </PuckCameraControls>,
    );
    const region = screen.getByRole('group', { name: '3D representative volume camera' });
    expect(region.tabIndex).toBe(0);
    expect(
      document.getElementById(region.getAttribute('aria-describedby')!)?.textContent,
    ).toContain('arrow keys orbit');
    expect(onAction).not.toHaveBeenCalled();
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', '+', '-', 'Home']) {
      expect(fireEvent.keyDown(region, { key })).toBe(false);
    }
    expect(onAction.mock.calls.map(([action]) => action)).toEqual([
      'right',
      'left',
      'up',
      'down',
      'in',
      'out',
      'reset',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onAction).toHaveBeenLastCalledWith('in');
    fireEvent.click(screen.getByRole('button', { name: 'Reset camera' }));
    expect(onAction).toHaveBeenLastCalledWith('reset');
  });

  it('does not capture Tab, browser shortcuts, or arrow events from nested controls', () => {
    const onAction = vi.fn<(action: CameraAction) => void>();
    render(
      <PuckCameraControls disabled={false} onAction={onAction}>
        <input aria-label="Nested field" />
      </PuckCameraControls>,
    );
    const region = screen.getByRole('group', { name: '3D representative volume camera' });
    expect(fireEvent.keyDown(region, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(region, { key: '+', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByLabelText('Nested field'), { key: 'ArrowLeft' })).toBe(
      true,
    );
    expect(onAction).not.toHaveBeenCalled();
  });

  it('makes unavailable camera actions inert while retaining the graphic alternative', () => {
    const onAction = vi.fn<(action: CameraAction) => void>();
    render(
      <PuckCameraControls disabled onAction={onAction}>
        <p>Cross-section and particle data remain available.</p>
      </PuckCameraControls>,
    );
    const region = screen.getByRole('group', { name: '3D representative volume camera' });
    expect(region.tabIndex).toBe(-1);
    expect(region.getAttribute('aria-disabled')).toBe('true');
    for (const button of screen.getAllByRole<HTMLButtonElement>('button'))
      expect(button.disabled).toBe(true);
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText(/particle data remain available/)).toBeTruthy();
  });
});
