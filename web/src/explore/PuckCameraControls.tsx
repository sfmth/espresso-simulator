// SPDX-License-Identifier: GPL-2.0-or-later
import { useId, type ReactNode } from 'react';
import { cameraKey, type CameraAction } from './cameraControls';

const ACTIONS: readonly [CameraAction, string][] = [
  ['left', 'Rotate left'],
  ['right', 'Rotate right'],
  ['up', 'Rotate up'],
  ['down', 'Rotate down'],
  ['in', 'Zoom in'],
  ['out', 'Zoom out'],
  ['reset', 'Reset camera'],
];

export function PuckCameraControls({
  disabled,
  onAction,
  children,
}: {
  disabled: boolean;
  onAction: (action: CameraAction) => void;
  children: ReactNode;
}) {
  const helpId = useId();
  return (
    <>
      <div
        className="puck-camera-region"
        role="group"
        aria-label="3D representative volume camera"
        aria-describedby={helpId}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (
            disabled ||
            event.target !== event.currentTarget ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const action = cameraKey(event.key);
          if (!action) return;
          event.preventDefault();
          onAction(action);
        }}
      >
        {children}
      </div>
      <p id={helpId} className="note">
        Focus the 3D view: arrow keys orbit, + / − zoom, Home resets the camera. You can also use
        the camera buttons below. Drag to orbit; scroll or pinch to zoom.
      </p>
      <div className="explore-controls" role="group" aria-label="Camera actions">
        {ACTIONS.map(([action, label]) => (
          <button
            key={action}
            type="button"
            className="button button-small"
            disabled={disabled}
            onClick={() => onAction(action)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
