// SPDX-License-Identifier: GPL-2.0-or-later
/** Instanced sphere impostors keep particle count independent of triangle count. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { datedName, downloadJson } from '../shot/download';
import { PuckCameraControls } from './PuckCameraControls';
import {
  createBenchmark,
  createGpuTimer,
  orbitPoseAt,
  readWebGLInfo,
  type BenchmarkAccumulator,
  type BenchmarkCancelReason,
  type BenchmarkResult,
  type GpuTimer,
} from './benchmark';
import { homeCameraPose, moveCamera, type CameraAction } from './cameraControls';
import type { buildMicrostructure } from './microstructure';
import { buildContainmentIndex, containmentDepthFactor } from './renderMath';

type Model = ReturnType<typeof buildMicrostructure>;
interface RenderBenchmarkResult extends BenchmarkResult {
  renderObservations: {
    implementation: string;
    containmentCandidateCount: number;
    containedParticleCount: number;
    containmentBuildMs: number;
    containmentMarginMm: number;
    duplicateRafCallbacks: number;
    clockFailure?: string;
  };
}
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
attribute vec4 containingSphere;
uniform float cutZ;
uniform mat4 projectionInverse;
uniform vec2 cameraRange;
uniform float occlusionDepthFactor;
uniform float containmentMargin;
varying vec3 viewCentre;
varying vec3 rayPoint;
varying float particleRadius;
varying vec3 color;
void main() {
  color = tint;
  vec4 view = modelViewMatrix * vec4(centre, 1.0);
  viewCentre = view.xyz;
  particleRadius = radius;
  float d = -view.z;
  bool occluded = false;
  if (containingSphere.w > 0.0 && containingSphere.z <= cutZ) {
    vec3 parentView = (modelViewMatrix * vec4(containingSphere.xyz, 1.0)).xyz;
    float parentRadius = containingSphere.w;
    float parentDepth = -parentView.z;
    float gap = parentRadius - radius - length(centre - containingSphere.xyz);
    float depthSafety = occlusionDepthFactor * (parentDepth + parentRadius) * (parentDepth + parentRadius);
    occluded = dot(parentView, parentView) > parentRadius * parentRadius
      && parentDepth - parentRadius > cameraRange.x + containmentMargin
      && parentDepth + parentRadius < cameraRange.y - containmentMargin
      && gap > containmentMargin + depthSafety;
  }
  if (occluded || centre.z > cutZ || d + radius < cameraRange.x || d - radius > cameraRange.y) {
    rayPoint = vec3(0.0, 0.0, -1.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    vec2 lo = vec2(-1.0);
    vec2 hi = vec2(1.0);
    if (d > radius) {
      // Axis-aligned tangent bounds of the projected sphere, not its much
      // larger enclosing cube. Keep a small Float32 rounding margin.
      float denominator = d * d - radius * radius;
      vec2 tangent = radius * sqrt(view.xy * view.xy + vec2(denominator));
      vec2 scale = vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
      vec2 offset = projectionMatrix[2].xy;
      lo = scale * (view.xy * d - tangent) / denominator - offset - vec2(0.000002);
      hi = scale * (view.xy * d + tangent) / denominator - offset + vec2(0.000002);
    }
    if (lo.x > 1.0 || hi.x < -1.0 || lo.y > 1.0 || hi.y < -1.0) {
      rayPoint = vec3(0.0, 0.0, -1.0);
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    } else {
      vec2 ndc = mix(max(lo, vec2(-1.0)), min(hi, vec2(1.0)), position.xy * 0.5 + 0.5);
      vec4 nearPoint = projectionInverse * vec4(ndc, -1.0, 1.0);
      rayPoint = nearPoint.xyz / nearPoint.w;
      gl_Position = vec4(ndc, 0.0, 1.0);
    }
  }
}`;
const fragmentShader = `
precision highp float;
uniform mat4 cameraProjection;
varying vec3 viewCentre;
varying vec3 rayPoint;
varying float particleRadius;
varying vec3 color;
void main() {
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
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const measureButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const latest = useRef(props);
  const update = useRef<(() => void) | null>(null);
  const measure = useRef<(() => void) | null>(null);
  const cancelMeasure = useRef<(() => void) | null>(null);
  const controlCamera = useRef<((action: CameraAction) => void) | null>(null);
  const [fallback, setFallback] = useState(false);
  const [report, setReport] = useState<RenderBenchmarkResult | null>(null);
  const [benchmarkPhase, setBenchmarkPhase] = useState<'warmup' | 'sample'>('warmup');
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
    setReport(null);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#111a24');
    const edge = model.domainMm;
    const home = homeCameraPose(edge);
    const camera = new THREE.PerspectiveCamera(40, 1, edge / 1000, edge * 20);
    camera.position.fromArray(home.position);
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
    const containmentStart = performance.now();
    const containment = buildContainmentIndex(model.positionsMm, model.radiiMm, edge);
    const containmentBuildMs = performance.now() - containmentStart;
    geometry.setAttribute(
      'containingSphere',
      new THREE.InstancedBufferAttribute(containment.parentSphere, 4),
    );
    const depthBits = Number(renderer.getContext().getParameter(renderer.getContext().DEPTH_BITS));
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
        cameraRange: { value: new THREE.Vector2(camera.near, camera.far) },
        containmentMargin: { value: containment.marginMm },
        occlusionDepthFactor: { value: 1e20 },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    scene.add(mesh);
    const bufferSize = new THREE.Vector2();
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
    let benchmark: BenchmarkAccumulator | null = null;
    let gpuTimer: GpuTimer | null = null;
    let sampleOrbitStart = 0;
    let gpuFrame = 0;
    let gpuDisjoint = false;
    let gpuPending = 0;
    let gpuSamples: number[] = [];
    let clockFailure: string | undefined;
    let lastRafClock: number | null = null;
    let duplicateRafCallbacks = 0;
    let consecutiveDuplicateRafCallbacks = 0;
    const initialPosition = home.position;
    const targetPosition = home.target;
    let measuredConfiguration: {
      ey: Float32Array | null;
      selection: number;
      cut: number;
      network: boolean;
    } | null = null;
    let previousEy: Float32Array | null | undefined;
    let previousSelection = -1;
    const publishCamera = () => {
      viewRef.current?.setAttribute(
        'data-camera-position',
        JSON.stringify(camera.position.toArray()),
      );
      viewRef.current?.setAttribute(
        'data-camera-target',
        JSON.stringify(controls.target.toArray()),
      );
    };
    const draw = () => {
      if (disposed || document.hidden) return;
      renderer.render(scene, camera);
    };
    const sync = () => {
      const p = latest.current;
      if (
        benchmark &&
        measuredConfiguration &&
        (measuredConfiguration.ey !== p.particleEy ||
          measuredConfiguration.selection !== p.selectedParticle ||
          measuredConfiguration.cut !== p.cut ||
          measuredConfiguration.network !== p.showNetwork)
      )
        stopBenchmark('configuration-changed');
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
      if (benchmark) stopBenchmark('configuration-changed');
      // Crisp on HiDPI screens without multiplying a 150k view by 9× pixels.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      material.uniforms.occlusionDepthFactor.value = containmentDepthFactor(
        {
          scaleX: camera.projectionMatrix.elements[0],
          scaleY: camera.projectionMatrix.elements[5],
          near: camera.near,
          far: camera.far,
        },
        depthBits,
      );
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const controlledDraw = () => {
      if (benchmark) stopBenchmark('interrupted');
      publishCamera();
      draw();
    };
    controls.addEventListener('change', controlledDraw);
    const pollGpu = () => {
      if (!gpuTimer) return;
      const status = gpuTimer.poll();
      gpuSamples.push(...status.samples.map((sample) => sample.elapsedMs));
      gpuDisjoint ||= status.disjoint;
      gpuPending = status.pending;
    };
    const stopBenchmark = (reason?: BenchmarkCancelReason) => {
      const restoreFocus =
        !disposed &&
        !document.hidden &&
        cancelButtonRef.current !== null &&
        document.activeElement === cancelButtonRef.current;
      cancelAnimationFrame(frame);
      if (benchmark) {
        if (reason) benchmark.cancel(reason);
        pollGpu();
        setReport({
          ...benchmark.finish({
            supported: gpuTimer?.supported ?? false,
            disjoint: gpuDisjoint,
            everyFrames: gpuTimer?.everyFrames ?? 4,
            samplesMs: gpuSamples,
            pending: gpuPending,
          }),
          renderObservations: {
            implementation:
              'tight analytic tangent bounds, vertex cut/frustum culling, conservative fully contained-sphere culling',
            containmentCandidateCount: containment.candidateCount,
            containedParticleCount: containment.containedCount,
            containmentBuildMs,
            containmentMarginMm: containment.marginMm,
            duplicateRafCallbacks,
            ...(clockFailure ? { clockFailure } : {}),
          },
        });
      }
      benchmark = null;
      gpuTimer?.dispose();
      gpuTimer = null;
      measuredConfiguration = null;
      setMeasuring(false);
      if (restoreFocus) measureButtonRef.current?.focus();
      publishCamera();
    };
    cancelMeasure.current = () => stopBenchmark('interrupted');
    controlCamera.current = (action) => {
      if (disposed || document.hidden) return;
      if (benchmark) stopBenchmark('interrupted');
      const next = moveCamera(action, camera.position.toArray(), controls.target.toArray(), edge);
      camera.position.fromArray(next.position);
      controls.target.fromArray(next.target);
      controls.update();
      publishCamera();
      draw();
    };
    const tick = (now: number) => {
      if (!benchmark || disposed || document.hidden) {
        stopBenchmark(disposed ? 'disposed' : 'tab-hidden');
        return;
      }
      if (benchmark.progress().phase === 'idle') benchmark.start(now);
      // Some Chromium startup callbacks share the previous frame timestamp.
      // Do not submit or count a second render without a new clock observation.
      if (lastRafClock !== null && now === lastRafClock) {
        duplicateRafCallbacks++;
        consecutiveDuplicateRafCallbacks++;
        if (consecutiveDuplicateRafCallbacks < 60) {
          frame = requestAnimationFrame(tick);
          return;
        }
      }
      if (lastRafClock !== null && now <= lastRafClock) {
        // Preserve the helper's diagnostic without submitting another frame or
        // moving the orbit with a timestamp that predates the previous frame.
        try {
          benchmark.recordFrame(now);
        } catch (error) {
          clockFailure = error instanceof Error ? error.message : String(error);
        }
        stopBenchmark('clock-discontinuity');
        return;
      }
      lastRafClock = now;
      consecutiveDuplicateRafCallbacks = 0;
      const phase = benchmark.progress().phase;
      const startsSample = benchmark.willStartSample(now);
      if (startsSample) sampleOrbitStart = now;
      camera.position.fromArray(
        phase === 'sample' || startsSample
          ? orbitPoseAt(initialPosition, targetPosition, now - sampleOrbitStart)
          : initialPosition,
      );
      camera.lookAt(controls.target);
      pollGpu();
      const queried =
        (phase === 'sample' || startsSample) && (gpuTimer?.begin(gpuFrame++) ?? false);
      const cpuStart = performance.now();
      draw();
      const cpuRenderMs = performance.now() - cpuStart;
      if (queried) gpuTimer?.end();
      const progress = benchmark.recordFrame(now, cpuRenderMs);
      if (progress.phase === 'sample' && phase !== 'sample') {
        sampleOrbitStart = now;
        setBenchmarkPhase('sample');
      }
      if (progress.phase !== 'complete') frame = requestAnimationFrame(tick);
      else stopBenchmark();
    };
    measure.current = () => {
      if (benchmark || document.hidden) return;
      camera.position.fromArray(initialPosition);
      controls.target.fromArray(targetPosition);
      camera.lookAt(controls.target);
      controls.update();
      draw();
      const rect = canvas.getBoundingClientRect();
      renderer.getDrawingBufferSize(bufferSize);
      const p = latest.current;
      measuredConfiguration = {
        ey: p.particleEy,
        selection: p.selectedParticle,
        cut: p.cut,
        network: p.showNetwork,
      };
      const environment = {
        particleCount: model.radiiMm.length,
        renderPath: 'analytic-exact',
        sphereQuality: 'exact sphere silhouette and surface depth',
        networkVisible: p.showNetwork,
        cutFraction: p.cut,
        cssWidthPx: rect.width,
        cssHeightPx: rect.height,
        drawingBufferWidthPx: bufferSize.x,
        drawingBufferHeightPx: bufferSize.y,
        devicePixelRatio: window.devicePixelRatio || 1,
        rendererPixelRatio: renderer.getPixelRatio(),
        camera: {
          position: initialPosition,
          target: targetPosition,
          verticalFovDeg: camera.fov,
          orbitRadiansPerSecond: 0.36,
        },
        webgl: readWebGLInfo(renderer.getContext()),
        extraQuality: {
          markerParticle: p.selectedParticle,
          modelSeed: model.seed,
          warmupCamera: 'fixed canonical pose; sampled orbit starts at zero',
          viewportWidthPx: window.innerWidth,
          viewportHeightPx: window.innerHeight,
        },
      };
      benchmark = createBenchmark({ environment, targetFps: window.innerWidth <= 700 ? 30 : 60 });
      gpuTimer = createGpuTimer(renderer.getContext() as WebGL2RenderingContext, {
        everyFrames: 4,
      });
      gpuSamples = [];
      gpuDisjoint = false;
      gpuPending = 0;
      gpuFrame = 0;
      clockFailure = undefined;
      lastRafClock = null;
      duplicateRafCallbacks = 0;
      consecutiveDuplicateRafCallbacks = 0;
      setReport(null);
      setBenchmarkPhase('warmup');
      setMeasuring(true);
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      if (document.hidden) stopBenchmark('tab-hidden');
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
      stopBenchmark('context-lost');
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('webglcontextlost', lost);
    resize();
    sync();
    publishCamera();
    return () => {
      disposed = true;
      stopBenchmark('disposed');
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
      cancelMeasure.current = null;
      controlCamera.current = null;
    };
  }, [model, active]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const cancelMeasurement = () => {
    cancelMeasure.current?.();
    measureButtonRef.current?.focus();
  };
  return (
    <div
      ref={viewRef}
      className="puck-view"
      data-render-benchmark={report ? JSON.stringify(report) : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && measuring) {
          event.preventDefault();
          cancelMeasurement();
        }
      }}
    >
      <PuckCameraControls
        disabled={fallback || !active}
        onAction={(action) => controlCamera.current?.(action)}
      >
        <canvas
          ref={canvasRef}
          className="puck-canvas"
          role="img"
          aria-label={`3D representative volume with ${model.radiiMm.length.toLocaleString()} particles. Select a particle here or with the particle number control; exact particle extraction and shell data are in the particle inspector.`}
          hidden={fallback}
        />
      </PuckCameraControls>
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
          ref={measureButtonRef}
          type="button"
          className="button"
          onClick={() => {
            if (!measuring) measure.current?.();
          }}
          disabled={fallback || !active}
          aria-disabled={measuring || undefined}
        >
          {measuring
            ? benchmarkPhase === 'warmup'
              ? 'Warming up…'
              : 'Measuring…'
            : 'Measure frame rate'}
        </button>
        {measuring && (
          <button
            ref={cancelButtonRef}
            type="button"
            className="button"
            onClick={cancelMeasurement}
          >
            Cancel measurement
          </button>
        )}
        <output aria-live="polite" data-benchmark={report ? JSON.stringify(report) : undefined}>
          {report === null
            ? 'WebGL2 · WebGPU not required'
            : report.status === 'complete' && report.stats.meanFps !== null
              ? `${report.stats.meanFps.toFixed(1)} fps · median ${report.stats.frameIntervalMs?.median.toFixed(1)} ms · p95 ${report.stats.frameIntervalMs?.p95.toFixed(1)} ms · RAF cadence proxy`
              : `Benchmark ${report.status}: ${report.reason === 'clock-discontinuity' ? 'browser clock changed; measure again' : report.reason}`}
        </output>
      </div>
      <p className="note">
        The benchmark uses a fixed camera pose for warmup (at least 1.5 s and 30 frames), then the
        same time-based 5 s orbit. RAF intervals are a scheduling proxy; GPU timer queries are
        reported when available. Neither proves compositor presentation.
      </p>
      {report && (
        <details className="spec-json">
          <summary>
            Frame timing report ·{' '}
            {report.environment.webgl.unmaskedRenderer ??
              report.environment.webgl.renderer ??
              'renderer unavailable'}
          </summary>
          <p>
            {report.environment.particleCount.toLocaleString()} particles ·{' '}
            {report.environment.drawingBufferWidthPx} × {report.environment.drawingBufferHeightPx}{' '}
            drawing-buffer pixels · DPR {report.environment.devicePixelRatio} / renderer{' '}
            {report.environment.rendererPixelRatio} · {report.environment.renderPath}
          </p>
          <p>
            GPU timing:{' '}
            {report.gpuTiming.elapsedMs
              ? `median ${report.gpuTiming.elapsedMs.median.toFixed(2)} ms, p95 ${report.gpuTiming.elapsedMs.p95.toFixed(2)} ms (${report.gpuTiming.validSampleCount} valid samples)`
              : report.gpuTiming.supported
                ? 'no resolved, non-disjoint samples'
                : 'unavailable'}
            ; {report.gpuTiming.pendingQueries} pending. Estimated missed target-budget slots:{' '}
            {report.stats.estimatedDroppedFrames}; observed over-budget intervals:{' '}
            {report.stats.overBudgetFrames}.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => downloadJson(datedName('render-benchmark', 'json'), report)}
          >
            Download benchmark JSON
          </button>
          <pre data-testid="render-benchmark-json">{JSON.stringify(report, null, 2)}</pre>
        </details>
      )}
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
