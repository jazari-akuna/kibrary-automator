/**
 * Model3DViewerGL — alpha.28 30fps three.js / WebGL2 3D viewer.
 *
 * Replaces the per-frame ``kicad-cli pcb render`` PNG path
 * (Model3DViewer.tsx) with a one-shot ``kicad-cli pcb export glb`` call
 * + interactive WebGL rendering via three.js. Once the GLB lands the
 * scene runs at native 60fps with mouse orbit, wheel zoom, and right-click
 * pan all handled by OrbitControls — no more sidecar calls until the user
 * commits a transform change (Save button bumps `savedRev`).
 *
 * Live transform tweaks during a slider drag (offset/rotation/scale) are
 * applied as a Matrix4 on the loaded mesh — no GLB re-export. The delta
 * is `(live - saved)` because kicad-cli bakes the (model …) transform
 * into the exported geometry, so the saved values are the identity for
 * the loaded mesh and the live values are what we have to apply on top.
 *
 * Fallback: WebGL2 init is feature-tested on mount; if it fails (e.g.
 * older WebKitGTK without WebGL2) we surface an error via `onWebGLError`
 * so Model3DPreview can fall back to the PNG viewer.
 */

import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type Triple = [number, number, number];

interface Props {
  libDir: string;
  componentName: string;
  /** Live (possibly unsaved) transform — applied as a Matrix4 delta on
   *  the loaded mesh without re-exporting the GLB. */
  offset: Triple;
  rotation: Triple;
  scale: Triple;
  /** Bumped on positioner Save — triggers a fresh GLB fetch (the saved
   *  values are now the new baseline; the live delta resets to identity). */
  savedRev: number;
  /** Surfaced on WebGL2 init / GLB fetch failure so the parent can fall
   *  back to the PNG viewer. */
  onWebGLError?: (reason: string) => void;
}

// Light test harness: expose the active scene + a counter of in-flight
// `library.render_3d_glb_angled` invocations so Playwright can assert
// (i) the GLB landed in the scene and (ii) drag does not fire sidecar
// calls. Always installed — the surface is small, the cost is zero, and
// production builds don't pay any extra bytes for it.
declare global {
  interface Window {
    __model3dGLScene?: THREE.Scene;
    __model3dGLLoadCount?: number;
  }
}

export default function Model3DViewerGL(props: Props) {
  const [webglError, setWebglError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  let containerEl: HTMLDivElement | undefined;
  let canvasEl: HTMLCanvasElement | undefined;

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let resizeObs: ResizeObserver | null = null;
  let rafHandle = 0;

  // The currently mounted GLB scene (gltf.scene) — replaced wholesale on
  // each successful load. We hold a reference so we can dispose its
  // geometries / materials before swapping.
  let loadedRoot: THREE.Object3D | null = null;
  // Snapshot of the original local matrix at load time so we can express
  // each frame as `original × delta` cleanly (instead of accumulating).
  let loadedRootBaseMatrix: THREE.Matrix4 | null = null;
  // The (offset/rotation/scale) values that were SAVED at the time of
  // the most recent successful GLB load. The live delta we apply on
  // every transform tick is `(live - saved)` — kicad-cli bakes the
  // (model …) transform into the geometry, so the loaded mesh already
  // includes the saved transform.
  let lastSavedOffset: Triple = [0, 0, 0];
  let lastSavedRotation: Triple = [0, 0, 0];
  let lastSavedScale: Triple = [1, 1, 1];

  // Discard stale GLB load promises by id — a fast Save→Save sequence
  // could otherwise paint an older model on top of a newer one.
  let loadId = 0;

  // ---------------------------------------------------------------
  // Three.js scene init.
  // ---------------------------------------------------------------

  function initWebGL(): boolean {
    if (!canvasEl || !containerEl) return false;

    // Feature-test WebGL2 explicitly. The constructor below would also
    // throw, but a clean getContext() probe gives us a deterministic
    // fall-back path before any three.js machinery is initialised.
    const probe = canvasEl.getContext('webgl2');
    if (!probe) {
      setWebglError('WebGL2 not available');
      props.onWebGLError?.('WebGL2 not available');
      return false;
    }

    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(window.devicePixelRatio);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setWebglError(reason);
      props.onWebGLError?.(reason);
      return false;
    }

    scene = new THREE.Scene();
    scene.background = null; // transparent → CSS background of wrapper shows through
    window.__model3dGLScene = scene;

    const rect = containerEl.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1.5;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
    camera.position.set(40, 40, 40);
    camera.lookAt(0, 0, 0);

    controls = new OrbitControls(camera, canvasEl);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Right-click pan (default), wheel zoom (default), left-drag orbit.
    // Speed defaults are tuned for the typical kicad-cli output (mm units,
    // boards within a few-cm bounding box).

    // Lighting — soft ambient + a top-iso directional gives the same
    // "PCB sitting on a desk" feel the kicad-cli render produced.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(50, 80, 50);
    scene.add(sun);

    // Resize-aware: when the wrapper changes size (responsive grid in
    // ComponentDetail.tsx), keep the camera aspect + renderer in sync.
    resizeObs = new ResizeObserver(() => {
      if (!containerEl || !renderer || !camera) return;
      const r = containerEl.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    });
    resizeObs.observe(containerEl);

    // Initial size sync — ResizeObserver may not fire immediately on mount.
    if (rect.width > 0 && rect.height > 0) {
      renderer.setSize(rect.width, rect.height, false);
    }

    // Render loop. OrbitControls.enableDamping needs an update each frame
    // to advance the inertia, so we always tick — three.js culls the
    // draw call if the scene has nothing to redraw.
    const tick = () => {
      if (!renderer || !scene || !camera) return;
      controls?.update();
      renderer.render(scene, camera);
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);

    return true;
  }

  // ---------------------------------------------------------------
  // GLB load — sidecar RPC, decode base64, parse via GLTFLoader, swap
  // the previous mesh.
  // ---------------------------------------------------------------

  async function loadGLB() {
    if (!scene) return;
    setLoading(true);
    const myId = ++loadId;
    window.__model3dGLLoadCount = (window.__model3dGLLoadCount || 0) + 1;

    try {
      const r = await invoke<{ glb_data_url: string }>('sidecar_call', {
        method: 'library.render_3d_glb_angled',
        params: {
          lib_dir: props.libDir,
          component_name: props.componentName,
          offset: props.offset,
          rotation: props.rotation,
          scale: props.scale,
        },
      });
      if (myId !== loadId) return; // user moved on, discard

      // Snapshot the saved-at-load-time values so the live-delta path
      // can compute (live - saved) instead of accumulating drift.
      lastSavedOffset = [...props.offset] as Triple;
      lastSavedRotation = [...props.rotation] as Triple;
      lastSavedScale = [...props.scale] as Triple;

      const buf = decodeDataUrl(r.glb_data_url);
      const loader = new GLTFLoader();
      loader.parse(
        buf,
        '',
        (gltf) => {
          if (myId !== loadId || !scene) return;
          // Dispose the previous mesh so the GPU doesn't accumulate
          // geometries on every Save.
          if (loadedRoot) {
            scene.remove(loadedRoot);
            disposeObject(loadedRoot);
            loadedRoot = null;
          }

          loadedRoot = gltf.scene;
          loadedRootBaseMatrix = loadedRoot.matrix.clone();
          scene.add(loadedRoot);

          // Apply any pending live delta (props may have changed since
          // we kicked the fetch off; even a no-op call gets the
          // identity matrix correctly seated).
          applyLiveDelta();
          frameCameraTo(loadedRoot);
          setLoading(false);
        },
        (err) => {
          if (myId !== loadId) return;
          console.warn('[3D viewer GL] GLTFLoader.parse failed:', err);
          setWebglError('GLB parse failed');
          setLoading(false);
        },
      );
    } catch (e) {
      if (myId !== loadId) return;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn('[3D viewer GL] GLB fetch failed:', e);
      setWebglError(reason);
      props.onWebGLError?.(reason);
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------
  // Live transform delta — applied to loadedRoot every time the
  // positioner offset/rotation/scale changes WITHOUT a `savedRev` bump.
  //
  // We don't accumulate: each tick computes `original × delta` from
  // the snapshot taken at load time, so a slider that moves back to
  // the saved values returns to the exact baked-in pose.
  // ---------------------------------------------------------------

  function applyLiveDelta() {
    if (!loadedRoot || !loadedRootBaseMatrix) return;

    // Delta = (live - saved). offset is mm (kicad-cli's GLB unit is mm).
    // rotation is degrees XYZ in KiCad's intrinsic order — three.js
    // Euler defaults to 'XYZ' which matches.
    const dx = props.offset[0] - lastSavedOffset[0];
    const dy = props.offset[1] - lastSavedOffset[1];
    const dz = props.offset[2] - lastSavedOffset[2];
    const drx = (props.rotation[0] - lastSavedRotation[0]) * Math.PI / 180;
    const dry = (props.rotation[1] - lastSavedRotation[1]) * Math.PI / 180;
    const drz = (props.rotation[2] - lastSavedRotation[2]) * Math.PI / 180;
    // Scale delta is a multiplier (live/saved). Guard against zero saved
    // scale (impossible in practice but cheap).
    const sx = lastSavedScale[0] !== 0 ? props.scale[0] / lastSavedScale[0] : 1;
    const sy = lastSavedScale[1] !== 0 ? props.scale[1] / lastSavedScale[1] : 1;
    const sz = lastSavedScale[2] !== 0 ? props.scale[2] / lastSavedScale[2] : 1;

    const delta = new THREE.Matrix4().compose(
      new THREE.Vector3(dx, dy, dz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(drx, dry, drz, 'XYZ')),
      new THREE.Vector3(sx, sy, sz),
    );

    const m = loadedRootBaseMatrix.clone().multiply(delta);
    // Decompose back into pos/quat/scale so three.js auto-update keeps
    // working as the user drags OrbitControls.
    loadedRoot.matrix.copy(m);
    loadedRoot.matrixAutoUpdate = false;
    loadedRoot.matrixWorldNeedsUpdate = true;
  }

  // ---------------------------------------------------------------
  // Auto-frame the camera to the loaded model's bounding box. Called
  // once per successful load — the user can re-frame manually with
  // OrbitControls afterwards.
  // ---------------------------------------------------------------

  function frameCameraTo(obj: THREE.Object3D) {
    if (!camera || !controls) return;
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!isFinite(maxDim) || maxDim <= 0) return;
    // ~3× the largest dimension gives a comfortable iso-ish view that
    // shows the whole board without clipping the silkscreen layers.
    const dist = maxDim * 3;
    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    camera.near = Math.max(maxDim / 1000, 0.01);
    camera.far = Math.max(maxDim * 100, 1000);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }

  // ---------------------------------------------------------------
  // Lifecycle wiring.
  // ---------------------------------------------------------------

  onMount(() => {
    if (!initWebGL()) return; // error already surfaced
    void loadGLB();
  });

  // Re-fetch the GLB whenever savedRev increments OR the targeted
  // component / library changes. Use `on()` with `defer:true` to skip
  // the initial-mount fire (onMount handles that).
  createEffect(
    on(
      () => [props.libDir, props.componentName, props.savedRev],
      () => {
        if (!scene) return; // not yet initialised — onMount will pick up
        void loadGLB();
      },
      { defer: true },
    ),
  );

  // Live transform delta — fires on every offset/rotation/scale change
  // even between savedRev bumps. Cheap (matrix multiply, no fetch).
  createEffect(() => {
    // Track each component so SolidJS re-runs on any change.
    props.offset[0]; props.offset[1]; props.offset[2];
    props.rotation[0]; props.rotation[1]; props.rotation[2];
    props.scale[0]; props.scale[1]; props.scale[2];
    applyLiveDelta();
  });

  onCleanup(() => {
    loadId++; // discard any in-flight load
    if (rafHandle) cancelAnimationFrame(rafHandle);
    resizeObs?.disconnect();
    controls?.dispose();
    if (loadedRoot) {
      scene?.remove(loadedRoot);
      disposeObject(loadedRoot);
      loadedRoot = null;
    }
    renderer?.dispose();
    if (window.__model3dGLScene === scene) {
      window.__model3dGLScene = undefined;
    }
    renderer = null;
    scene = null;
    camera = null;
    controls = null;
  });

  return (
    <Show
      when={!webglError()}
      fallback={
        <div
          data-testid="3d-viewer-gl-error"
          class="rounded bg-zinc-200 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 flex items-center justify-center"
          style={{ width: '100%', height: '320px' }}
        >
          WebGL unavailable — falling back…
        </div>
      }
    >
      <div
        ref={containerEl}
        data-testid="3d-viewer-gl-wrapper"
        class="rounded overflow-hidden bg-white dark:bg-zinc-950 relative"
        style={{ width: '100%', height: '320px' }}
      >
        <canvas
          ref={canvasEl}
          data-testid="3d-viewer-gl-canvas"
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        <Show when={loading()}>
          <div
            class="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-200/40 dark:bg-zinc-800/40 pointer-events-none"
          >
            Loading 3D model…
          </div>
        </Show>
      </div>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Helpers — kept module-private; small enough not to warrant their own file.
// ---------------------------------------------------------------------------

function decodeDataUrl(url: string): ArrayBuffer {
  const comma = url.indexOf(',');
  const b64 = comma >= 0 ? url.slice(comma + 1) : url;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
    else if (m) m.dispose();
  });
}
