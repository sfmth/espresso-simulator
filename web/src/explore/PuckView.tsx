// SPDX-License-Identifier: GPL-2.0-or-later
/** Instanced sphere impostors keep particle count independent of triangle count. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { buildMicrostructure } from './microstructure';

type Model = ReturnType<typeof buildMicrostructure>;
export interface PuckViewProps {
  model: Model;
  particleEy: Float32Array | null;
  selectedParticle: number;
  onSelect: (index: number) => void;
  active: boolean;
  cut: number;
  showNetwork: boolean;
}

const vertexShader = `
attribute vec3 centre;
attribute float radius;
attribute vec3 tint;
uniform float cutZ;
uniform mat4 projectionInverse;
varying vec3 viewCentre;
varying vec3 rayPoint;
varying float particleRadius;
varying vec3 color;
varying float visible;
void main() {
  color = tint;
  visible = step(centre.z, cutZ);
  vec4 view = modelViewMatrix * vec4(centre, 1.0);
  viewCentre = view.xyz;
  particleRadius = radius;
  if (view.z - radius >= 0.0) {
    // Entirely behind the eye: collapse outside the clip volume.
    rayPoint = vec3(0.0, 0.0, -1.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else if (view.z + radius >= -0.001) {
    // A sphere crossing the eye/near plane needs a conservative full-screen
    // quad; the exact fragment intersection rejects its unused pixels.
    vec4 nearPoint = projectionInverse * vec4(position.xy, -1.0, 1.0);
    rayPoint = nearPoint.xyz / nearPoint.w;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  } else {
    // Projecting a sphere's enclosing cube onto its centre plane gives this
    // conservative bound, including the off-axis perspective displacement.
    float extent = radius * (-view.z + length(view.xy)) / (-view.z - radius);
    rayPoint = view.xyz + vec3(position.xy * extent, 0.0);
    gl_Position = projectionMatrix * vec4(rayPoint, 1.0);
  }
}`;
const fragmentShader = `
precision highp float;
uniform mat4 cameraProjection;
varying vec3 viewCentre;
varying vec3 rayPoint;
varying float particleRadius;
varying vec3 color;
varying float visible;
void main() {
  if (visible < 0.5) discard;
  vec3 direction = normalize(rayPoint);
  float b = dot(direction, viewCentre);
  // This form avoids subtracting two bed-scale squares for a tiny fine.
  vec3 perpendicular = viewCentre - b * direction;
  float discriminant = particleRadius * particleRadius - dot(perpendicular, perpendicular);
  if (discriminant < 0.0) discard;
  float root = sqrt(discriminant);
  float distance = b - root;
  if (distance <= 0.0) distance = b + root;
  if (distance <= 0.0) discard;
  vec3 hit = distance * direction;
  vec4 clip = cameraProjection * vec4(hit, 1.0);
  float depth = 0.5 * (clip.z / clip.w) + 0.5;
  if (depth < 0.0 || depth > 1.0) discard;
  gl_FragDepth = depth;
  vec3 normal = normalize(hit - viewCentre);
  float shade = 0.35 + 0.65 * max(0.0, dot(normal, normalize(vec3(-0.4, 0.7, 1.0))));
  gl_FragColor = vec4(color * shade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Extraction fraction → sequential, colour-blind-friendly dark purple / gold. */
export function extractionColor(ey: number | null): [number, number, number] {
  if (ey === null || !Number.isFinite(ey)) return [0.44, 0.34, 0.24];
  const t = Math.min(1, Math.max(0, ey / 0.3));
  return [0.24 + 0.72 * t, 0.12 + 0.72 * t, 0.4 - 0.23 * t];
}

export function PuckView(props: PuckViewProps) {
  const { model, active } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  const update = useRef<(() => void) | null>(null);
  const measure = useRef<(() => void) | null>(null);
  const [fallback, setFallback] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    latest.current = props;
    update.current?.();
  }, [props]);
  // WebGL capability is known only after allocating the external renderer.
  /* eslint-disable react-hooks/set-state-in-effect -- Reflect the external renderer's allocation result. */
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      const context = canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
      if (!context) {
        setFallback(true);
        return;
      }
      // Avoid an inline canvas style: the application ships with a strict CSP.
      renderer = new THREE.WebGLRenderer({
        canvas,
        context,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      setFallback(true);
      return;
    }
    setFallback(false);
    setFps(null);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#111a24');
    const edge = model.domainMm;
    const camera = new THREE.PerspectiveCamera(40, 1, edge / 1000, edge * 20);
    camera.position.set(edge * 1.35, edge * 0.9, edge * 1.6);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.minDistance = edge * 0.6;
    controls.maxDistance = edge * 5;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('centre', new THREE.InstancedBufferAttribute(model.positionsMm, 3));
    geometry.setAttribute('radius', new THREE.InstancedBufferAttribute(model.radiiMm, 1));
    const colors = new Float32Array(model.radiiMm.length * 3);
    const tint = new THREE.InstancedBufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('tint', tint);
    geometry.instanceCount = model.radiiMm.length;
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        cutZ: { value: edge / 2 },
        cameraProjection: { value: camera.projectionMatrix },
        projectionInverse: { value: camera.projectionMatrixInverse },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const boxSource = new THREE.BoxGeometry(edge, edge, edge);
    const boxGeometry = new THREE.EdgesGeometry(boxSource);
    boxSource.dispose();
    const boxMaterial = new THREE.LineBasicMaterial({
      color: '#738797',
      transparent: true,
      opacity: 0.6,
    });
    scene.add(new THREE.LineSegments(boxGeometry, boxMaterial));

    const net = model.network;
    const networkPositions = new Float32Array(net.edges.length * 3);
    const networkColors = new Float32Array(net.edges.length * 3);
    for (let i = 0; i < net.edges.length; i++) {
      const node = net.edges[i];
      networkPositions.set(net.positionsMm.subarray(node * 3, node * 3 + 3), i * 3);
      const p = Math.max(0, Math.min(1, net.pressure[node]));
      networkColors.set([0.1 + p * 0.8, 0.7, 1 - p * 0.6], i * 3);
    }
    const networkGeometry = new THREE.BufferGeometry();
    networkGeometry.setAttribute('position', new THREE.BufferAttribute(networkPositions, 3));
    networkGeometry.setAttribute('color', new THREE.BufferAttribute(networkColors, 3));
    const networkMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.65,
    });
    const network = new THREE.LineSegments(networkGeometry, networkMaterial);
    network.renderOrder = 2;
    scene.add(network);
    // Aggregate directional arrows into one draw call. Length is schematic;
    // colour encodes relative edge flux, never physical liquid velocity.
    const strongest = Array.from(net.flow, (flow, index) => ({ flow, index }))
      .filter(({ flow }) => Number.isFinite(flow) && Math.abs(flow) > 1e-12)
      .sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow))
      .slice(0, 200);
    const arrowPositions: number[] = [];
    const arrowColors: number[] = [];
    const largestFlow = Math.abs(strongest[0]?.flow ?? 1);
    for (const { flow, index } of strongest) {
      const a = net.edges[2 * index + (flow < 0 ? 1 : 0)];
      const b = net.edges[2 * index + (flow < 0 ? 0 : 1)];
      const from = new THREE.Vector3().fromArray(net.positionsMm, a * 3);
      const to = new THREE.Vector3().fromArray(net.positionsMm, b * 3);
      const direction = to.clone().sub(from).normalize();
      const length = from.distanceTo(to);
      const tail = from.clone().lerp(to, 0.2);
      const tip = from.clone().lerp(to, 0.8);
      const head = tip.clone().addScaledVector(direction, -0.2 * length);
      const basis =
        Math.abs(direction.z) < 0.8 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const side = direction
        .clone()
        .cross(basis)
        .normalize()
        .multiplyScalar(0.09 * length);
      const other = direction
        .clone()
        .cross(side)
        .normalize()
        .multiplyScalar(0.09 * length);
      const strength = Math.sqrt(Math.abs(flow) / largestFlow);
      const color = [1, 0.45 + 0.5 * strength, 0.12 + 0.2 * (1 - strength)];
      const segment = (start: THREE.Vector3, end: THREE.Vector3) => {
        arrowPositions.push(start.x, start.y, start.z, end.x, end.y, end.z);
        arrowColors.push(...color, ...color);
      };
      segment(tail, tip);
      segment(tip, head.clone().add(side));
      segment(tip, head.clone().sub(side));
      segment(tip, head.clone().add(other));
      segment(tip, head.clone().sub(other));
    }
    const arrowsGeometry = new THREE.BufferGeometry();
    arrowsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(arrowPositions, 3));
    arrowsGeometry.setAttribute('color', new THREE.Float32BufferAttribute(arrowColors, 3));
    const arrowsMaterial = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    const arrows = new THREE.LineSegments(arrowsGeometry, arrowsMaterial);
    arrows.renderOrder = 3;
    scene.add(arrows);
    const markerGeometry = new THREE.SphereGeometry(1, 12, 8);
    const markerMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      wireframe: true,
      depthTest: false,
    });
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    marker.renderOrder = 3;
    scene.add(marker);
    let disposed = false;
    let frame = 0;
    let benchmarkStart = 0;
    let benchmarkFrames = 0;
    let previousEy: Float32Array | null | undefined;
    let previousSelection = -1;
    const draw = () => {
      if (disposed || document.hidden) return;
      renderer.render(scene, camera);
    };
    const sync = () => {
      const p = latest.current;
      material.uniforms.cutZ.value = (p.cut - 0.5) * edge;
      network.visible = p.showNetwork;
      arrows.visible = p.showNetwork;
      if (previousEy !== p.particleEy || previousSelection !== p.selectedParticle) {
        for (let i = 0; i < model.radiiMm.length; i++) {
          colors.set(
            i === p.selectedParticle ? [1, 1, 1] : extractionColor(p.particleEy?.[i] ?? null),
            i * 3,
          );
        }
        tint.needsUpdate = true;
        previousEy = p.particleEy;
        previousSelection = p.selectedParticle;
      }
      const j = p.selectedParticle;
      marker.position.fromArray(model.positionsMm, j * 3);
      marker.scale.setScalar(model.radiiMm[j] * 1.15);
      marker.visible = model.positionsMm[j * 3 + 2] <= material.uniforms.cutZ.value;
      draw();
    };
    update.current = sync;
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      // Crisp on HiDPI screens without multiplying a 150k view by 9× pixels.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    controls.addEventListener('change', draw);
    const stopBenchmark = () => {
      cancelAnimationFrame(frame);
      if (benchmarkStart)
        setFps((benchmarkFrames * 1000) / Math.max(1, performance.now() - benchmarkStart));
      benchmarkStart = 0;
      setMeasuring(false);
    };
    const tick = (now: number) => {
      if (disposed || document.hidden) {
        stopBenchmark();
        return;
      }
      if (!benchmarkStart) benchmarkStart = now;
      camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.006);
      camera.lookAt(controls.target);
      draw();
      benchmarkFrames++;
      if (now - benchmarkStart < 3000) frame = requestAnimationFrame(tick);
      else stopBenchmark();
    };
    measure.current = () => {
      if (benchmarkStart || document.hidden) return;
      benchmarkFrames = 0;
      setMeasuring(true);
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      if (document.hidden) stopBenchmark();
      else resize();
    };
    document.addEventListener('visibilitychange', visibility);
    const pointerStart = { x: 0, y: 0 };
    const down = (event: PointerEvent) => {
      pointerStart.x = event.clientX;
      pointerStart.y = event.clientY;
    };
    const raycaster = new THREE.Raycaster();
    const sphere = new THREE.Sphere();
    const hit = new THREE.Vector3();
    const viewHit = new THREE.Vector3();
    const up = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          1 - ((event.clientY - rect.top) / rect.height) * 2,
        ),
        camera,
      );
      let closest = Infinity;
      let selected = -1;
      for (let i = 0; i < model.radiiMm.length; i++) {
        sphere.center.fromArray(model.positionsMm, i * 3);
        if (sphere.center.z > material.uniforms.cutZ.value) continue;
        sphere.radius = model.radiiMm[i];
        if (raycaster.ray.intersectSphere(sphere, hit)) {
          viewHit.copy(hit).applyMatrix4(camera.matrixWorldInverse);
          if (-viewHit.z < camera.near || -viewHit.z > camera.far) continue;
          const distance = hit.distanceToSquared(raycaster.ray.origin);
          if (distance < closest) {
            closest = distance;
            selected = i;
          }
        }
      }
      if (selected >= 0) latest.current.onSelect(selected);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      setFallback(true);
      stopBenchmark();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('webglcontextlost', lost);
    resize();
    sync();
    return () => {
      disposed = true;
      stopBenchmark();
      observer.disconnect();
      controls.dispose();
      document.removeEventListener('visibilitychange', visibility);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('webglcontextlost', lost);
      geometry.dispose();
      material.dispose();
      boxGeometry.dispose();
      boxMaterial.dispose();
      networkGeometry.dispose();
      networkMaterial.dispose();
      arrowsGeometry.dispose();
      arrowsMaterial.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      renderer.dispose();
      update.current = null;
      measure.current = null;
    };
  }, [model, active]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="puck-view">
      <canvas
        ref={canvasRef}
        className="puck-canvas"
        aria-label={`3D representative volume with ${model.radiiMm.length.toLocaleString()} particles. Drag to orbit, scroll to zoom. Select a particle here or with the particle number control.`}
        hidden={fallback}
      />
      {fallback && (
        <div className="puck-fallback" role="status">
          <p>
            3D rendering is unavailable in this browser. The cross-section, timeline and particle
            inspector below remain available.
          </p>
          <svg
            viewBox="0 0 300 220"
            role="img"
            aria-label="Representative volume, front projection of up to 800 particles"
          >
            {Array.from({ length: Math.min(800, model.radiiMm.length) }, (_, i) => (
              <circle
                key={i}
                cx={150 + (model.positionsMm[i * 3] / model.domainMm) * 200}
                cy={110 - (model.positionsMm[i * 3 + 1] / model.domainMm) * 200}
                r={Math.max(0.7, (model.radiiMm[i] / model.domainMm) * 200)}
                fill={`rgb(${extractionColor(props.particleEy?.[i] ?? null)
                  .map((v) => Math.round(v * 255))
                  .join(',')})`}
              />
            ))}
          </svg>
          <p className="note">
            Front projection; 800-particle display limit. All particles remain available to inspect.
          </p>
        </div>
      )}
      <div className="explore-render-status">
        <span>
          {model.radiiMm.length.toLocaleString()} particles · {model.domainMm.toFixed(2)} mm cube
        </span>
        <button
          type="button"
          className="button"
          onClick={() => measure.current?.()}
          disabled={fallback || measuring || !active}
        >
          {measuring ? 'Measuring…' : 'Measure frame rate'}
        </button>
        <output aria-live="polite">
          {fps === null
            ? 'WebGL2 · WebGPU not required'
            : `${fps.toFixed(1)} fps · this device, current view`}
        </output>
      </div>
      <p className="note">
        Drag to orbit · scroll or pinch to zoom · click to inspect. Gold = more extracted (0–30%
        scale); brown = no coupled data. Sphere shading is illustrative. The cutaway hides particle
        centres beyond the selected plane.
      </p>
      {props.showNetwork && (
        <p className="note">
          Blue-to-orange lines show dimensionless node potential (inlet 1, outlet 0). Arrows show
          the direction of up to 200 strongest lattice fluxes; brighter yellow means greater
          relative flux. Arrow length is schematic, not physical velocity.
        </p>
      )}
    </div>
  );
}
