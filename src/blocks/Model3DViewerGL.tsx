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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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
    __model3dGLLastError?: string;
    /**
     * alpha.3-bugfix: surfaces the runtime's actual chipNodes array so
     * smoke probes can verify applyLiveDelta would have nodes to move.
     * The pre-fix bug had chipNodes=[] because findTopLevelAncestor
     * returned the substrate's wrapper node (the only direct child of
     * loadedRoot), and the for-loop skipped it — so applyLiveDelta
     * silently bailed. A probe asserting chipNodes.length >= 1 would
     * have caught the regression. The previous chip-nodes probe only
     * confirmed the GLB *had* chip nodes, not that the runtime found
     * them.
     */
    __model3dGLChipNodeCount?: number;
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
  // alpha.35: applyLiveDelta() targets the CHIP node(s), not loadedRoot.
  // kicad-cli's GLB has loadedRoot containing the substrate AND each
  // chip node as siblings. Moving loadedRoot would drag the substrate
  // and the alpha.33 SVG decal and the alpha.34 axis indicators along
  // with it — that is "controls move everything" the user reported.
  // A single .kicad_mod can have multiple (model …) blocks (the test
  // fixture exercises that), so we apply the delta to all of them.
  // Each entry pairs a node with the matrix it had at load time so
  // (live - saved) is a clean "original × delta" instead of a drift.
  let chipNodes: { node: THREE.Object3D; baseMatrix: THREE.Matrix4 }[] = [];
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
      // glTF PBR pipeline expects linear-space input → sRGB output, with
      // a filmic tone map. Without these two lines metals look black and
      // dielectrics look washed-out / muddy.
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      // alpha.34: alpha.30's 1.0 exposure + key 1.5 + fill 0.8 + ambient
      // 0.3 stacked the IBL irradiance with three direct lights and read
      // as washed-out (the soldermask green came through almost cyan).
      // Drop the exposure first since it's the cheapest knob; lights
      // dialed back below in lock-step.
      renderer.toneMappingExposure = 0.7;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setWebglError(reason);
      props.onWebGLError?.(reason);
      return false;
    }

    scene = new THREE.Scene();
    scene.background = null; // transparent → CSS background of wrapper shows through
    window.__model3dGLScene = scene;

    // Image-based lighting (IBL) — synthesise a neutral studio HDRI from
    // three's bundled RoomEnvironment, prefilter it via PMREMGenerator,
    // and feed it to scene.environment so every PBR material gets proper
    // ambient reflections. This is what makes glTF look like glTF; without
    // it metals appear black and dielectrics look flat. Background stays
    // null so the zinc-tinted CSS wrapper shows through unchanged.
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    const roomEnv = new RoomEnvironment();
    scene.environment = pmremGenerator.fromScene(roomEnv, 0.04).texture;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const rect = containerEl.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1.5;
    // kicad-cli's GLB output is in METRES with Y-up. A typical board is
    // ~4 cm and an IC chip is ~1.6 mm × 0.45 mm. The previous default of
    // (40, 40, 40) was 40 metres from the origin — frame ratio ~1700:1,
    // catastrophically zoomed out before frameCameraTo refines on load.
    // 0.12 m ≈ 12 cm gives comfortable framing for a 4 cm board.
    // Near plane is set very tight (1 µm) to avoid clipping sub-mm
    // component thicknesses at any zoom level. frameCameraTo recomputes
    // both near + far + position once the GLB lands.
    camera = new THREE.PerspectiveCamera(45, aspect, 1e-5, 100);
    camera.position.set(0.12, 0.10, 0.12);
    camera.lookAt(0, 0, 0);

    controls = new OrbitControls(camera, canvasEl);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Right-click pan (default), wheel zoom (default), left-drag orbit.
    // Speed defaults are tuned for the typical kicad-cli output (mm units,
    // boards within a few-cm bounding box).

    // alpha.36: capture wheel events on the canvas so the page doesn't
    // scroll when the cursor is over the 3D viewport. OrbitControls
    // attaches its own wheel handler but doesn't preventDefault by
    // default — we add an explicit listener with `passive: false` so
    // page scroll is suppressed as soon as the wheel fires. The user
    // wanted "click into the viewport then wheel zooms" behaviour;
    // making the canvas *always* swallow wheel achieves that without
    // needing to track click state.
    canvasEl.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });
    // Tabindex makes the canvas keyboard-focusable; combined with the
    // wheel-capture above this gives a clean "click in, scroll, zoom"
    // affordance. Browsers don't auto-focus <canvas> on click without it.
    canvasEl.tabIndex = 0;
    canvasEl.addEventListener('mousedown', () => canvasEl?.focus());

    // Lighting — IBL provides the diffuse ambient now, so we drop the
    // AmbientLight to a low fill and lean on a key/fill directional pair
    // for shape definition. Key from top-front-right, fill from
    // top-back-left at ~half strength so the shadow side reads as
    // "lit by sky" instead of pitch-black.
    // alpha.34: rebalance the trio. IBL still does most of the lifting;
    // the directionals just sharpen the shape on the chip body. With the
    // alpha.30 values the substrate's soldermask green saturated at the
    // top-front corner — looked plasticky and washed out.
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(5, 8, 5);
    keyLight.castShadow = false;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-5, 8, -5);
    fillLight.castShadow = false;
    scene.add(fillLight);

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
    // Guard: Solid effects can fire with falsy props during mount/unmount churn
    // (parent Show gating doesn't always synchronise with our effect schedule).
    // Without this the sidecar throws `Path(None)` → TypeError → silent fail.
    if (!props.libDir || !props.componentName) return;
    setLoading(true);
    const myId = ++loadId;
    window.__model3dGLLoadCount = (window.__model3dGLLoadCount || 0) + 1;

    try {
      const r = await invoke<{
        glb_data_url: string;
        top_layers_svg_data_url?: string;
      }>('sidecar_call', {
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

          // alpha.31 material fix-up — kicad-cli's GLB output uses two
          // PBR encodings that GLTFLoader handles per-spec but render
          // unusable in our scene. Patch them on every successful load
          // BEFORE attaching the root so the very first frame is correct.
          //
          //   (1) PCB substrate + soldermask come through as
          //       alphaMode: BLEND with opacity ≈ 0.83–0.90. GLTFLoader
          //       sets transparent=true, depthWrite=false → deeper
          //       geometry leaks through closer pixels and the dim
          //       blend against the dark backdrop reads as muddy/wrong.
          //       For ≥ 0.7 opacity it's a kicad-cli artifact, not real
          //       transparency — force the material opaque.
          //
          //   (2) OCCT-exported STEP bodies (IC packages) come through
          //       as metalness=1.0 baseColorFactor=(0.5,0.5,0.5) with no
          //       metalnessMap. That's an OCCT default for "unknown
          //       shading", not a real metallic intent: a fully metallic
          //       surface has zero diffuse so without IBL it renders
          //       black, with IBL it renders chrome. Demote to matte
          //       plastic.
          gltf.scene.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!(mesh as THREE.Mesh).isMesh || !mesh.material) return;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            // alpha.36: detect substrate by mesh name so we can apply a
            // separate opacity treatment (chip body stays opaque, board
            // becomes 80 % transparent so internal structure / pads
            // beneath the chip are partially visible).
            const isSubstrate = mesh.name === 'preview_PCB' || /pcb/i.test(mesh.name);
            for (const m of mats) {
              const std = m as THREE.MeshStandardMaterial;

              if (std.transparent && std.opacity >= 0.7) {
                std.transparent = false;
                std.depthWrite = true;
                std.opacity = 1;
                std.alphaTest = 0;
                std.needsUpdate = true;
              }

              if (std.metalness !== undefined && std.metalness > 0.9 && !std.metalnessMap) {
                std.metalness = 0.1;
                std.roughness = Math.max(std.roughness ?? 0.5, 0.6);
                std.needsUpdate = true;
              }

              // alpha.34: damp the IBL contribution per-material. Default
              // envMapIntensity is 1.0 — combined with the tone-mapped
              // RoomEnvironment that's where the "washed out" came from.
              // 0.5 keeps reflections subtle without going matte.
              if (std.envMapIntensity !== undefined) {
                std.envMapIntensity = 0.5;
                std.needsUpdate = true;
              }

              // alpha.36: substrate goes to 80 % opacity so user can
              // see chip leads / pads sitting just beneath it. Applied
              // AFTER the alpha.31 force-opaque pass so it overrides.
              // depthWrite stays true: keeps the chip visible behind
              // the substrate from below-angle views.
              if (isSubstrate) {
                std.transparent = true;
                std.opacity = 0.8;
                std.depthWrite = true;
                std.alphaTest = 0;
                std.needsUpdate = true;
              }
            }
          });

          // alpha.33: capture substrate bbox BEFORE we apply the recenter
          // shift, in loadedRoot-local space (loadedRoot.matrix is still
          // identity at this point — GLTFLoader doesn't pre-transform the
          // root). We use this bbox for two things in lock-step:
          //   (a) the recenter shift (loadedRoot.position.y -= topY)
          //   (b) the SVG decal anchor (attached as loadedRoot child so
          //       it inherits the recenter — local coords = pre-shift
          //       world coords because loadedRoot was identity).
          const substrateMesh = findSubstrateMesh(loadedRoot);
          let substrateBboxLocal: THREE.Box3 | null = null;
          if (substrateMesh) {
            loadedRoot.updateMatrixWorld(true);
            substrateBboxLocal = new THREE.Box3().setFromObject(substrateMesh);
          }

          // Recenter so the substrate TOP sits at world Y=0. kicad-cli's
          // GLB has the substrate at Y=[0, ~1.5mm] with the chip extending
          // UP from there — the user reads the visible side wall as
          // "thickness going up." Standard CAD convention is "model rests
          // on a virtual table at Y=0," so we shift everything down by
          // the substrate top height. The chip body then extends upward
          // from Y=0 and the substrate hangs below, matching the look of
          // a physical board on a workbench.
          if (substrateBboxLocal && isFinite(substrateBboxLocal.max.y) && substrateBboxLocal.max.y !== 0) {
            loadedRoot.position.y -= substrateBboxLocal.max.y;
            loadedRoot.updateMatrix();
            loadedRoot.updateMatrixWorld(true);
          }

          // alpha.3-bugfix: identify the chip node(s) — siblings of the
          // substrate within their actual container, NOT children of
          // loadedRoot. The alpha.35-36 logic assumed loadedRoot.children
          // was [substrate, chip1, chip2, …], but kicad-cli's GLB output
          // is loadedRoot → Scene → [substrate, chip1, chip2, …] (one
          // wrapper between the loader-root and the meshes). Walking up
          // from the substrate to a "top-level ancestor under loadedRoot"
          // returned that single Scene wrapper, the for-loop then saw
          // only one child and skipped it, chipNodes stayed empty, and
          // applyLiveDelta silently bailed → user-reported "position
          // controls do nothing." The fix: iterate the substrate's
          // ACTUAL parent's children, not loadedRoot's.
          //
          // This works for both shapes (substrate-as-direct-child and
          // substrate-inside-Scene-wrapper) because substrate.parent
          // is whichever container actually holds the siblings.
          chipNodes = [];
          const substrateContainer: THREE.Object3D | null =
            substrateMesh?.parent ?? loadedRoot;
          for (const child of substrateContainer.children) {
            if (child === substrateMesh) continue;
            chipNodes.push({ node: child, baseMatrix: child.matrix.clone() });
          }
          window.__model3dGLChipNodeCount = chipNodes.length;

          scene.add(loadedRoot);

          // alpha.33: paint the front-layers SVG decal (pads / copper /
          // silkscreen) onto the substrate top. kicad-cli pcb export glb
          // has no copper layer; without this the user sees an empty
          // green PCB with the chip body floating on top.
          if (substrateBboxLocal && r.top_layers_svg_data_url) {
            void attachTopLayerDecal(loadedRoot, substrateBboxLocal, r.top_layers_svg_data_url);
          }

          // alpha.34: ±X / ±Y / ±Z axis indicators. Anchored under
          // loadedRoot so they move with positioner deltas — gives the
          // user a fixed reference frame even mid-orbit. Sized to
          // substrate diagonal × 1.4 so labels sit clear of the board.
          if (substrateBboxLocal) {
            attachAxisIndicators(loadedRoot, substrateBboxLocal);
          }

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
          window.__model3dGLLastError = `GLTFLoader.parse: ${err instanceof Error ? err.message : String(err)}`;
          setWebglError('GLB parse failed');
          setLoading(false);
        },
      );
    } catch (e) {
      if (myId !== loadId) return;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn('[3D viewer GL] GLB fetch failed:', e);
      window.__model3dGLLastError = `GLB fetch: ${reason}`;
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
    if (!chipNodes.length) return;

    // alpha.34: positioner emits MILLIMETRES; kicad-cli's GLB unit is
    // METRES. /1000 keeps a 1 mm slider tick from becoming a 1 m fly-away.
    //
    // alpha.35: positioner emits values in KICAD PCB SPACE — +X right,
    // +Y "back" along the layout sheet, +Z up out of the board. Three.js
    // GLB output from kicad-cli is Y-UP (+Y = world up = KiCad +Z, +Z
    // world = depth ≈ KiCad +Y, +X world = KiCad +X). So we swap the
    // two non-X components when feeding into the matrix. Without the
    // swap, dragging "+Z" (up) made the chip slide sideways in world
    // depth — the user's "controls are mixed" report. Same swap applies
    // to rotation (axis remap follows the basis change).
    const dxKicad = (props.offset[0] - lastSavedOffset[0]) / 1000;
    const dyKicad = (props.offset[1] - lastSavedOffset[1]) / 1000;
    const dzKicad = (props.offset[2] - lastSavedOffset[2]) / 1000;
    const dxWorld = dxKicad;
    const dyWorld = dzKicad;       // KiCad +Z (up) → world +Y
    const dzWorld = dyKicad;       // KiCad +Y (back) → world +Z

    const drxKicad = (props.rotation[0] - lastSavedRotation[0]) * Math.PI / 180;
    const dryKicad = (props.rotation[1] - lastSavedRotation[1]) * Math.PI / 180;
    const drzKicad = (props.rotation[2] - lastSavedRotation[2]) * Math.PI / 180;
    const drxWorld = drxKicad;
    const dryWorld = drzKicad;
    const drzWorld = dryKicad;

    // Scale delta is a multiplier (live/saved). Scale axes follow the
    // same KiCad → world swap so a "scale Z" slider stretches the chip
    // in its tall axis even though kicad-cli's GLB calls that world Y.
    const sxK = lastSavedScale[0] !== 0 ? props.scale[0] / lastSavedScale[0] : 1;
    const syK = lastSavedScale[1] !== 0 ? props.scale[1] / lastSavedScale[1] : 1;
    const szK = lastSavedScale[2] !== 0 ? props.scale[2] / lastSavedScale[2] : 1;
    const sxW = sxK;
    const syW = szK;
    const szW = syK;

    const delta = new THREE.Matrix4().compose(
      new THREE.Vector3(dxWorld, dyWorld, dzWorld),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(drxWorld, dryWorld, drzWorld, 'XYZ')),
      new THREE.Vector3(sxW, syW, szW),
    );

    // Apply to every chip node (a single .kicad_mod can have multiple
    // (model …) blocks — secondary models like a mounting post should
    // move in lock-step). Substrate / decal / axis indicators are
    // siblings, not children, so they stay anchored.
    for (const { node, baseMatrix } of chipNodes) {
      const m = baseMatrix.clone().multiply(delta);
      node.matrix.copy(m);
      node.matrixAutoUpdate = false;
      node.matrixWorldNeedsUpdate = true;
    }
  }

  // ---------------------------------------------------------------
  // Auto-frame the camera to the loaded model's bounding box. Called
  // once per successful load — the user can re-frame manually with
  // OrbitControls afterwards.
  // ---------------------------------------------------------------

  function frameCameraTo(obj: THREE.Object3D) {
    if (!camera || !controls) return;

    // Walk every Mesh under the loaded root. A typical kicad-cli GLB
    // contains the board as one large mesh and each component as a
    // smaller mesh. Framing to the WHOLE-board bbox makes a 1.6 mm chip
    // project to ~3 px on a 320 px canvas — the user perceives "no
    // chip / no footprint". Frame to the COMPONENT (smallest mesh)
    // instead so the chip is visibly resolved.
    const meshes: THREE.Mesh[] = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // alpha.34: skip axis indicator helpers (ArrowHelper sub-meshes
      // and the SVG decal). Their bbox would corrupt the
      // smallest-mesh = component heuristic — a 3 mm arrow cone is
      // smaller than any chip body and would yank the camera onto
      // itself, hiding the actual part.
      if (m.name === 'preview_PCB_top_decal') return;
      let p: THREE.Object3D | null = m.parent;
      while (p) {
        if (p.name === 'axis_indicators') return;
        p = p.parent;
      }
      meshes.push(m);
    });
    if (!meshes.length) return;

    const meshMaxDim = (m: THREE.Mesh): number => {
      const b = new THREE.Box3().setFromObject(m);
      if (b.isEmpty()) return 0;
      const s = new THREE.Vector3();
      b.getSize(s);
      return Math.max(s.x, s.y, s.z);
    };
    const meshMinDim = (m: THREE.Mesh): number => {
      const b = new THREE.Box3().setFromObject(m);
      if (b.isEmpty()) return 0;
      const s = new THREE.Vector3();
      b.getSize(s);
      // Only consider non-zero axes — a perfectly flat plate would
      // otherwise return 0 and zero out the near plane.
      const dims = [s.x, s.y, s.z].filter((d) => d > 0);
      return dims.length ? Math.min(...dims) : 0;
    };

    // Sort by max dimension; smallest non-trivial mesh = component,
    // largest = board.
    const sorted = meshes
      .map((m) => ({ m, dim: meshMaxDim(m) }))
      .filter((e) => isFinite(e.dim) && e.dim > 0)
      .sort((a, b) => a.dim - b.dim);
    if (!sorted.length) return;

    const compDim = sorted[0].dim;
    const boardDim = sorted[sorted.length - 1].dim;
    const haveComponent = sorted.length >= 2;
    const targetDim = haveComponent ? compDim : boardDim;

    // 6× the component's max dim leaves clear margin around the chip;
    // 3× the board's max dim is the legacy whole-board fallback. The
    // 0.02 m (2 cm) floor keeps us from over-zooming when the
    // component bbox is sub-mm and the board would disappear entirely.
    const dist = Math.max(targetDim * (haveComponent ? 6 : 3), 0.02);

    // Center on the OVERALL bbox so the board is still visible — we
    // just frame the camera tighter so the chip is resolved.
    const overallBox = new THREE.Box3().setFromObject(obj);
    if (overallBox.isEmpty()) return;
    const center = new THREE.Vector3();
    overallBox.getCenter(center);

    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    camera.lookAt(center);

    // Near/far derived from real model scale. The smallest feature we
    // need to render unclipped is roughly the smallest non-zero
    // dimension of the component (chip thickness ~0.45 mm). We divide
    // by 4 for a safety margin and by another 100 for the actual near
    // plane — well below sub-mm features so wheel zoom never clips
    // the component out.
    const minFeatureSize = haveComponent
      ? meshMinDim(sorted[0].m) || compDim / 4
      : compDim / 4;
    camera.near = Math.max(minFeatureSize / 100, 1e-5);
    camera.far = Math.max(boardDim * 100, 100);
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
    // Free the prefiltered IBL cubemap so we don't leak a GPU texture
    // across viewer remounts (parent toggles us in/out of the DOM).
    if (scene?.environment) {
      scene.environment.dispose();
      scene.environment = null;
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

// alpha.36: walk up from `node` until reaching the direct child of
// `root`. Used to identify which loadedRoot child contains the substrate
// mesh — any other top-level child is then treated as a chip-bearing
// node by applyLiveDelta. Defensive against future kicad-cli renames /
// hierarchy changes (we already saw the GLB structure shift between
// releases).
function findTopLevelAncestor(node: THREE.Object3D, root: THREE.Object3D): THREE.Object3D {
  let cur: THREE.Object3D = node;
  while (cur.parent && cur.parent !== root) {
    cur = cur.parent;
  }
  return cur;
}

// alpha.33: kicad-cli's GLB names the extruded board mesh "preview_PCB".
// We need to identify it post-load so we can (a) compute its top-Y for
// the world-recenter shift and (b) anchor the SVG decal plane on top.
// Falls back to the largest-bbox mesh if the name doesn't match — defends
// against future kicad-cli renames.
function findSubstrateMesh(root: THREE.Object3D): THREE.Mesh | null {
  let named: THREE.Mesh | null = null;
  let largest: THREE.Mesh | null = null;
  let largestVolume = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.name === 'preview_PCB' || /pcb/i.test(m.name)) named = m;
    const b = new THREE.Box3().setFromObject(m);
    if (b.isEmpty()) return;
    const s = new THREE.Vector3();
    b.getSize(s);
    const vol = s.x * s.y * s.z;
    if (vol > largestVolume) {
      largestVolume = vol;
      largest = m;
    }
  });
  return named || largest;
}

// alpha.33: rasterise the front-layers SVG and attach it as a thin decal
// plane sitting just above the substrate's top face. We don't modify the
// substrate's own geometry/material — the decal is a separate plane the
// scene-graph hangs off the same parent so it inherits the recenter.
//
// Why a separate plane: the substrate has 6 primitives sharing one
// material (top + bottom + 4 sides). Painting a texture on the shared
// material would smear the SVG onto the side walls too. A plane decal
// is one quad with a clean UV mapping and no surprise side-effects.
async function attachTopLayerDecal(
  rootGroup: THREE.Object3D,
  substrateBboxLocal: THREE.Box3,
  svgDataUrl: string,
): Promise<void> {
  // Parse the SVG's viewBox so the decal is sized to the actual board
  // extents kicad-cli plotted (typically very close to the substrate's
  // XZ bbox but not identical — KiCad pads the page slightly).
  const svgText = await fetch(svgDataUrl).then((r) => r.text()).catch(() => '');
  const vbMatch = svgText.match(/viewBox="([\d.\-eE]+)\s+([\d.\-eE]+)\s+([\d.\-eE]+)\s+([\d.\-eE]+)"/);
  if (!vbMatch) return;
  const vbW_mm = parseFloat(vbMatch[3]);
  const vbH_mm = parseFloat(vbMatch[4]);
  if (!isFinite(vbW_mm) || !isFinite(vbH_mm) || vbW_mm <= 0 || vbH_mm <= 0) return;

  // Substrate bbox is captured PRE-RECENTER in loadedRoot-local space.
  // Decal is parented under loadedRoot, so its local position equals
  // those pre-recenter coords and the recenter shift propagates through
  // the scene-graph automatically.
  const sx = substrateBboxLocal.max.x - substrateBboxLocal.min.x;
  const sz = substrateBboxLocal.max.z - substrateBboxLocal.min.z;
  const cx = (substrateBboxLocal.min.x + substrateBboxLocal.max.x) / 2;
  const cz = (substrateBboxLocal.min.z + substrateBboxLocal.max.z) / 2;
  const topY = substrateBboxLocal.max.y;

  // Rasterise the SVG via an Image → CanvasTexture round-trip. SVGs in
  // <img> are decoded by the browser without needing three's SVGLoader.
  // 1024x1024 is enough for visibly crisp pads on the typical 320px
  // viewer; we letterbox to preserve aspect on non-square boards.
  const TARGET = 1024;
  const aspect = vbW_mm / vbH_mm;
  const canvasW = aspect >= 1 ? TARGET : Math.round(TARGET * aspect);
  const canvasH = aspect >= 1 ? Math.round(TARGET / aspect) : TARGET;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('SVG decal image failed to load'));
    img.src = svgDataUrl;
  }).catch((e) => {
    console.warn('[3D viewer GL] decal rasterise failed:', e);
  });
  if (!img.complete || img.naturalWidth === 0) return;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Transparent base so the substrate green shows between pads (the SVG
  // itself has no background fill — only stroked / filled paths).
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.drawImage(img, 0, 0, canvasW, canvasH);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  // Decal plane: kicad-cli's SVG uses Y-down (screen coords). Three.js
  // PlaneGeometry has the texture's V-axis pointing up, so we flip the
  // plane around X by rotating it -90° to lie flat on XZ AND apply the
  // negative-Z scale so the texture's screen-Y maps to world-Z without
  // mirroring the pads (LGA pin numbering would otherwise be reversed).
  // Width/height match the SVG viewBox extent in mm → metres conversion
  // is implicit (substrate is already in metres, viewBox is in mm so we
  // divide by 1000).
  const planeGeom = new THREE.PlaneGeometry(vbW_mm / 1000, vbH_mm / 1000);
  const planeMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const decal = new THREE.Mesh(planeGeom, planeMat);
  decal.name = 'preview_PCB_top_decal';
  decal.rotation.x = -Math.PI / 2; // lie flat on XZ, normal +Y
  decal.position.set(cx, topY + 1e-5, cz); // 10µm above substrate top
  // Stretch to actually cover the substrate XZ extents (board outline
  // could differ from plot viewBox by a few mm — we trust the substrate
  // mesh as the "truth" for positioning, and scale the SVG texture to
  // fill it). The plane's local X = world X, local Y = world -Z post-rot.
  if (sx > 0 && sz > 0) {
    decal.scale.set(sx / (vbW_mm / 1000), 1, sz / (vbH_mm / 1000));
  }

  // Parent under loadedRoot so the recenter shift moves the decal too.
  rootGroup.add(decal);
}

// alpha.34: attach axis indicators around the PCB so the user has a
// fixed reference frame mid-orbit. alpha.35: labels in KICAD convention
// (+X right, +Y back, +Z up out of board) — three.js's world Y is what
// kicad calls Z, so the +Z / -Z labels go on world ±Y. Vertical axes
// stand off 10 cm above and below the substrate so they never sit in
// front of the chip body. Horizontal axes (+X / -X / +Y / -Y) hug the
// substrate edge.
function attachAxisIndicators(rootGroup: THREE.Object3D, substrateBboxLocal: THREE.Box3): void {
  const halfX = (substrateBboxLocal.max.x - substrateBboxLocal.min.x) / 2;
  const halfZ = (substrateBboxLocal.max.z - substrateBboxLocal.min.z) / 2;
  const padX = halfX * 0.4;
  const padZ = halfZ * 0.4;
  // alpha.35: vertical stand-off in metres. The user explicitly asked
  // for "10 cm above and below" so they don't occlude the chip view.
  const Z_STANDOFF = 0.10;

  const arrows = new THREE.Group();
  arrows.name = 'axis_indicators';

  type Spec = {
    label: string;          // KiCad-convention axis name shown to the user
    dir: THREE.Vector3;     // arrow direction in WORLD space
    tip: THREE.Vector3;     // label position in WORLD space (substrate-local)
    yLift: number;          // 0 = on substrate plane; small lift to avoid z-fight
    color: number;
  };
  const specs: Spec[] = [
    // KiCad +X / -X — same axis as world X. Hug the board edge.
    { label: '+X', dir: new THREE.Vector3(1, 0, 0),  tip: new THREE.Vector3(halfX + padX, 0, 0),  yLift: 0.0005, color: 0xe04a4a },
    { label: '-X', dir: new THREE.Vector3(-1, 0, 0), tip: new THREE.Vector3(-halfX - padX, 0, 0), yLift: 0.0005, color: 0xe04a4a },
    // KiCad +Y / -Y — kicad-cli rotates layout-Y onto world Z. Hug the
    // board edge along world Z.
    { label: '+Y', dir: new THREE.Vector3(0, 0, 1),  tip: new THREE.Vector3(0, 0, halfZ + padZ),  yLift: 0.0005, color: 0x4ae04a },
    { label: '-Y', dir: new THREE.Vector3(0, 0, -1), tip: new THREE.Vector3(0, 0, -halfZ - padZ), yLift: 0.0005, color: 0x4ae04a },
    // KiCad +Z / -Z — vertical (out of board). 10 cm above/below so
    // they don't fight the chip body for screen space. Arrow base sits
    // on the substrate plane (y=0 post-recenter); tip + label at ±10cm.
    { label: '+Z', dir: new THREE.Vector3(0, 1, 0),  tip: new THREE.Vector3(0, Z_STANDOFF, 0),  yLift: 0,        color: 0x4a8de0 },
    { label: '-Z', dir: new THREE.Vector3(0, -1, 0), tip: new THREE.Vector3(0, -Z_STANDOFF, 0), yLift: 0,        color: 0x4a8de0 },
  ];

  for (const s of specs) {
    // alpha.36: drop the ArrowHelper line + cone combo and use just a
    // cone tip. The shafts (especially the 10 cm vertical ±Z lines)
    // dragged thin colored streaks across the canvas and obstructed
    // the chip body. A standalone cone at the tip keeps the directional
    // cue without the visual noise. The label sprite sits just past
    // the cone tip along the same axis.
    const headLen = Math.max(s.tip.length() * 0.10, 0.002);
    const headRad = headLen * 0.45;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(headRad, headLen, 16),
      new THREE.MeshBasicMaterial({ color: s.color, depthWrite: false, transparent: true, opacity: 0.95 }),
    );
    // ConeGeometry's local +Y is its long axis. Orient toward s.dir.
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.dir.clone().normalize());
    // Position cone so its base sits at the tip point (label will sit just past).
    const tipBase = s.tip.clone().add(s.dir.clone().normalize().multiplyScalar(-headLen / 2));
    cone.position.set(tipBase.x, tipBase.y + s.yLift, tipBase.z);
    arrows.add(cone);

    const label = makeAxisLabelSprite(s.label, s.color);
    const labelPos = s.tip.clone().add(s.dir.clone().normalize().multiplyScalar(headLen * 0.4));
    label.position.set(labelPos.x, labelPos.y + s.yLift + 0.0008, labelPos.z);
    arrows.add(label);
  }

  rootGroup.add(arrows);
}

// Build a small sprite-mapped text label. CanvasTexture + SpriteMaterial
// gives us a billboard label that always faces the camera with no extra
// font dependency.
function makeAxisLabelSprite(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.font = 'bold 80px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  // Subtle outline so labels read against both light and dark backgrounds.
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(text, 64, 64);
  ctx.fillText(text, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  // alpha.35: sprite world size dropped from 0.006 → 0.004 so the labels
  // don't dominate the canvas at typical viewer dimensions (alpha.34's
  // labels were nearly half the chip's apparent size).
  sprite.scale.set(0.004, 0.004, 1);
  return sprite;
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
