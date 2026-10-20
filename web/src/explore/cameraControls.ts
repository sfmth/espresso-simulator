// SPDX-License-Identifier: GPL-2.0-or-later
/** Discrete camera operations; representative particle geometry is unchanged. */
export type CameraAction = 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset';
type Point3 = readonly [number, number, number];
export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export function homeCameraPose(edge: number): CameraPose {
  return { position: [edge * 1.35, edge * 0.9, edge * 1.6], target: [0, 0, 0] };
}

/** Orbit in 15° steps and zoom by 1.2×, within the pointer controls' limits. */
export function moveCamera(
  action: CameraAction,
  position: Point3,
  target: Point3,
  edge: number,
): CameraPose {
  if (action === 'reset') return homeCameraPose(edge);
  const [x, y, z] = position.map((value, i) => value - target[i]);
  let distance = Math.hypot(x, y, z);
  let theta = Math.atan2(x, z);
  let phi = distance > 0 ? Math.acos(Math.max(-1, Math.min(1, y / distance))) : Math.PI / 2;
  const step = Math.PI / 12;
  if (action === 'left') theta -= step;
  if (action === 'right') theta += step;
  if (action === 'up') phi -= step;
  if (action === 'down') phi += step;
  if (action === 'in') distance /= 1.2;
  if (action === 'out') distance *= 1.2;
  distance = Math.max(edge * 0.6, Math.min(edge * 5, distance));
  phi = Math.max(0.001, Math.min(Math.PI - 0.001, phi));
  return {
    position: [
      target[0] + distance * Math.sin(phi) * Math.sin(theta),
      target[1] + distance * Math.cos(phi),
      target[2] + distance * Math.sin(phi) * Math.cos(theta),
    ],
    target: [...target],
  };
}

export function cameraKey(key: string): CameraAction | null {
  switch (key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case '+':
    case '=':
      return 'in';
    case '-':
      return 'out';
    case 'Home':
      return 'reset';
    default:
      return null;
  }
}
