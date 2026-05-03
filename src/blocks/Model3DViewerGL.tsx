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
  /**
   * Surfaced on viewer failure so the parent can decide what to do.
   *
   *  - kind: 'webgl_unavailable' — WebGL2 itself is missing or the renderer
   *    cannot be constructed. The GPU/browser cannot render any GLB, so the
   *    parent should permanently fall back to the PNG viewer.
   *
   *  - kind: 'asset_load_failed' — the WebGL pipeline is fine but THIS
   *    asset (component) failed to fetch / parse. Per-footprint, transient.
   *    The parent should NOT flip the global renderer; the inline error UI
   *    inside the GL viewer surfaces the problem for this asset only and
   *    the next footprint preview retries with WebGL.
   */
  onWebGLError?: (
    reason: string,
    kind: 'webgl_unavailable' | 'asset_load_failed',
  ) => void;
  /**
   * alpha.5-axes-shrink: opt-in ±X / ±Y / ±Z axis indicators. Default
   * false because the cones + sprite labels visually dominated the
   * canvas (vision-agent flagged them as covering the chip). The
   * Model3DPositioner UI can later surface a checkbox to flip this on.
   */
  showAxisIndicators?: boolean;
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
    /**
     * alpha.4-bugfix: surfaces the name of the mesh chosen as the
     * substrate. The pre-fix bug had findSubstrateMesh's loop with no
     * `break` — every mesh name matching /pcb/i overwrote the previous
     * pick, so connector meshes named "*_PCB_*" won and the real
     * substrate ended up in chipNodes (user reported "PCB moves down,
     * part stays"). For kicad-cli output the canonical name is
     * `preview_PCB` exactly; the smoke probe asserts this match.
     */
    __model3dGLSubstrateName?: string;
    /**
     * Wave 3-B: surfaces the names of the top-level chip ancestors
     * picked by the new whole-scene classifier. Lets the visual-verify
     * harness assert that real chip body Groups (e.g. `UFL_Hirose_*`)
     * are the ones being translated, NOT the substrate's `preview_PCB_*`
     * siblings. Empty string is allowed (Three.js Object3D.name defaults
     * to '' on anonymous Groups exported by OCCT).
     */
    __model3dGLChipMeshNames?: string[];
    /**
     * Wave 3-B: substrate's local-space bbox at load time (pre-recenter).
     * Lets the harness correlate "is this mesh classified as chip?" with
     * "where does it sit relative to the board top?" without re-deriving
     * the bbox from world-space snapshots.
     */
    __model3dGLSubstrateBbox?: {
      minX: number; minY: number; minZ: number;
      maxX: number; maxY: number; maxZ: number;
    };
    /**
     * Wave 4-C: classifier debug aid. Surfaces the wrapper layer the
     * walk-up loop terminates at, the substrate's parent Group (which
     * must NEVER be classified as a chip), and the candidate ancestor
     * names before/after dedup. If the harness sees substrate moving,
     * this tells us in one snapshot whether the wrapper detection or
     * the candidate filtering is at fault.
     */
    __model3dGLClassifierDebug?: {
      sceneWrapperName: string;
      sceneWrapperIsLoadedRoot: boolean;
      substrateContainerName: string;
      candidateNamesBeforeDedup: string[];
      candidateNamesAfterDedup: string[];
    };
  }
}

export default function Model3DViewerGL(props: Props) {
  // webglError = WebGL2/init failure → renders the full-panel fallback
  //   placeholder (parent will swap us out for the PNG viewer once it
  //   processes onWebGLError(... 'webgl_unavailable')).
  // assetError = per-asset GLB fetch/parse failure → renders an inline
  //   error overlay over the canvas. The WebGL pipeline is fine; the
  //   next footprint preview retries with WebGL. The parent does NOT
  //   fall back permanently for this kind.
  const [webglError, setWebglError] = createSignal<string | null>(null);
  const [assetError, setAssetError] = createSignal<string | null>(null);
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
      props.onWebGLError?.('WebGL2 not available', 'webgl_unavailable');
      return false;
    }

    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: true,
      });
      // alpha.5-visual-parity: cap pixel ratio at 2 — on a 4K HiDPI monitor
      // dpr can be 3, tripling fragment cost while running at 320px height
      // for zero visible benefit. 2 is the standard three.js practice.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
      // alpha.5-visual-parity: 0.7 → 0.95. The 0.7 was tuned with
      // envMapIntensity=0.5 stacking; once envMap goes back up to 0.85
      // the global exposure can come up too. 0.95 (just under 1.0) keeps
      // ACES highlight rolloff without the muddy midtones.
      renderer.toneMappingExposure = 0.95;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setWebglError(reason);
      // WebGLRenderer constructor failure = the browser/GPU cannot create
      // a WebGL2 context (driver, blacklist, OOM at init). Permanent
      // fallback is appropriate — every subsequent GLB load would trip
      // the same wall.
      props.onWebGLError?.(reason, 'webgl_unavailable');
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
    // alpha.5-visual-parity: rebalance — opaque substrate + 0.85 envMap
    // means we can lift ambient (0.15→0.25) and ease the key down
    // (0.8→0.55) so the side-rake highlight doesn't blow out the
    // top-front-right of the chip. Key position pulled more overhead
    // (5,8,5 → 3,10,3) for less side rake. Fill nudged 0.4→0.35 to keep
    // the relative key/fill ratio.
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.55);
    keyLight.position.set(3, 10, 3);
    keyLight.castShadow = false;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
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
    // Clear any prior per-asset error — the user navigated to a new
    // footprint (or hit Save), so the inline "GLB load failed" message
    // from the previous component should not stick.
    setAssetError(null);
    const myId = ++loadId;
    window.__model3dGLLoadCount = (window.__model3dGLLoadCount || 0) + 1;
    // 3d-fix-journal Wave-2 follow-up: zero out per-load probe state so
    // the visual-verify harness (and any future polling consumer) can
    // distinguish "this load has finished" from "previous load's leftover
    // values are still here." Without this reset a wait that polled
    // chipNodeCount > 0 + substrateName would pass instantly on the
    // previous fixture's globals while the new GLB is still mid-fetch
    // — exactly what produced empty BEFORE snapshots for fixtures 2+.
    window.__model3dGLChipNodeCount = 0;
    window.__model3dGLSubstrateName = '';
    window.__model3dGLLastError = undefined;

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

              // alpha.5-visual-parity: smarter metalness demote. The
              // alpha.4 blanket "metalness>0.9 → 0.1" rule correctly fixes
              // OCCT's "unknown shading" default (metalness=1,
              // baseColor≈(0.5,0.5,0.5), no metalnessMap) but also
              // flattens legitimately-metallic parts (USB shells, gold
              // pads, mounting hardware). Detect the OCCT grey-default
              // case specifically: r,g,b all ≈ 0.5 (within 0.05). Any
              // other base color → assume the metalness was set
              // intentionally and preserve it.
              if (std.metalness !== undefined && std.metalness > 0.9 && !std.metalnessMap) {
                const c = std.color;
                const isOcctGrey =
                  !!c
                  && Math.abs(c.r - c.g) < 0.05
                  && Math.abs(c.g - c.b) < 0.05
                  && c.r > 0.4 && c.r < 0.6;
                if (isOcctGrey) {
                  std.metalness = 0.1;
                  std.roughness = Math.max(std.roughness ?? 0.5, 0.6);
                  std.needsUpdate = true;
                }
                // else: keep — likely intentional (USB shell, gold finger, etc.)
              }

              // alpha.34: damp the IBL contribution per-material. Default
              // envMapIntensity is 1.0 — combined with the tone-mapped
              // RoomEnvironment that's where the "washed out" came from.
              // alpha.5-visual-parity: 0.5 → 0.85. The 0.5 was correct
              // when the substrate was also 0.8-opacity (double-darkening);
              // once the board is opaque the 0.5 reads as "dead matte
              // plastic." 0.85 keeps highlights from blowing out while
              // letting the IBL actually contribute.
              if (std.envMapIntensity !== undefined) {
                std.envMapIntensity = 0.85;
                std.needsUpdate = true;
              }

              // alpha.5-visual-parity: replace alpha.36's 80%-transparent
              // substrate with an opaque saturated KiCad-green override.
              // The PNG fallback shows a deep `#1f4234` opaque board; the
              // 0.8 transparency made the WebGL viewer's substrate read
              // as a pale plastic toy with edges bleeding through itself.
              // OCCT-emitted soldermask is too desaturated even when
              // opaque, so clamp the color to kicad-cli's default green
              // (RGB 0.05/0.20/0.10) and a matte-but-not-flat finish.
              if (isSubstrate) {
                std.color.setRGB(0.05, 0.20, 0.10);
                std.roughness = 0.55;
                std.metalness = 0;
                std.transparent = false;
                std.opacity = 1;
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
          window.__model3dGLSubstrateName = substrateMesh?.name ?? '';

          // Wave 3-B: whole-scene chip classifier. The previous "siblings
          // of substrate" logic broke for connector footprints whose GLB
          // hierarchy is:
          //   loadedRoot → Scene wrapper → [
          //     preview_PCB,           ← the substrate (kept still)
          //     preview_PCB_1..N,      ← silk/pads/mask layers (also still)
          //     <chip Group>           ← contains the real chip sub-meshes
          //   ]
          // The substrate's "siblings" then included preview_PCB_1..N
          // (translated as if they were chip parts → user saw "the PCB
          // is stretching") AND skipped the actual chip Group's deeper
          // sub-meshes. Net effect: substrate stays still (good), other
          // PCB layers translate (BAD), real chip body stays still (BAD).
          //
          // New algorithm (Wave 4-C revision):
          //   1. Treat anything named /^preview_PCB(_|$)/i as substrate-
          //      related — never translate.
          //   2. For every other mesh, check whether it sits ABOVE the
          //      substrate top (bbox.max.y > substrate.bbox.max.y - 0.5mm
          //      tolerance). Anything below is bottom-side artwork or a
          //      buried artefact — skip.
          //   3. For each surviving "above the board" mesh, walk UP the
          //      tree until we hit the direct child of the SCENE WRAPPER
          //      (loadedRoot.children[0] for kicad-cli output, or
          //      loadedRoot itself for flatter hierarchies). That
          //      ancestor is one chip body — translate it as a unit so
          //      an OCCT-exploded assembly with N sub-meshes still moves
          //      rigidly. Walking to substrateMesh.parent (Wave 3-B's
          //      target) overshoots past the chip's own Group because
          //      the substrate's parent is a SIBLING Group, not the
          //      shared wrapper.
          //   4. Reject ancestor candidates that are the substrate's
          //      own parent Group, the wrapper, or loadedRoot — those
          //      contain the board.
          //   5. Deduplicate: many sub-meshes share the same top-level
          //      ancestor.
          chipNodes = [];
          // Wave 4-C: Wave 3-B assumed that walking up from a chip mesh
          // until ancestor.parent === substrateMesh.parent would land on
          // a sibling Group that contained only chip geometry. For
          // kicad-cli's actual GLB hierarchy that's wrong: the substrate
          // and the chip live under separate sibling Groups inside an
          // outer "Scene wrapper" (Node 0 in the bug journal). The
          // substrate's parent is itself just one of those sibling
          // Groups (Node 2 — `=>[0:1:1:3]`). Walking up from a chip
          // mesh therefore overshoots past the chip's own Group, all
          // the way to loadedRoot, and the defensive `break` adds
          // loadedRoot to the candidate set. applyLiveDelta then
          // translates loadedRoot, dragging the substrate along.
          //
          // Fix: terminate the walk one level shallower. The "scene
          // wrapper" is the level at which top-level scene objects
          // live. For kicad-cli output that's `loadedRoot.children[0]`
          // (the unnamed wrapper); for flatter hierarchies it's
          // `loadedRoot` itself. We stop when ancestor.parent IS the
          // sceneWrapper — so ancestor is a direct child of the
          // wrapper (the chip's own top-level Group). Then we explicitly
          // skip the substrate's parent Group (a SIBLING under the
          // wrapper, not a chip) and skip the wrapper / loadedRoot
          // themselves (translating those would move everything).
          const substrateContainer: THREE.Object3D =
            substrateMesh?.parent ?? loadedRoot;
          const sceneWrapper: THREE.Object3D =
            loadedRoot.children.length === 1 &&
            loadedRoot.children[0] &&
            !(loadedRoot.children[0] as THREE.Mesh).isMesh
              ? loadedRoot.children[0]
              : loadedRoot;

          // substrateBboxLocal was captured pre-recenter; substrate top
          // in local space is its max.y. Tolerance: 0.5 mm (=5e-4 m)
          // catches OCCT-rounded sub-meshes that touch the substrate top
          // but extend slightly below the nominal top plane.
          const substrateTopY = substrateBboxLocal
            ? substrateBboxLocal.max.y
            : -Infinity;
          const Y_TOL = 5e-4; // metres — kicad-cli emits in metres
          const PCB_NAME_RE = /^preview_PCB(_|$)/i;
          const AXIS_NAME_RE = /^axis_/i;

          const candidates = new Set<THREE.Object3D>();
          const candidatesBeforeDedup: string[] = [];
          loadedRoot.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            // (1) Substrate-related by name → skip.
            if (PCB_NAME_RE.test(mesh.name)) return;
            // Skip our own decal/axis helpers — they're added later but
            // belt-and-braces in case classifier ever runs after.
            if (mesh.name === 'preview_PCB_top_decal') return;
            if (AXIS_NAME_RE.test(mesh.name)) return;
            if (mesh.name.toLowerCase().includes('decal')) return;
            let p: THREE.Object3D | null = mesh.parent;
            while (p) {
              if (p.name === 'axis_indicators') return;
              p = p.parent;
            }
            // (2) bbox-Y filter. Compute in local-loadedRoot space (same
            // frame substrateBboxLocal lives in — both pre-recenter).
            const b = new THREE.Box3().setFromObject(mesh);
            if (b.isEmpty()) return;
            // Below the board top minus tolerance → bottom-side stuff.
            if (b.max.y < substrateTopY - Y_TOL) return;
            // (3) Walk up to the ancestor that's a direct child of the
            // sceneWrapper. The loop terminates when ancestor.parent
            // IS the wrapper — so ancestor is the chip's top-level
            // Group inside the wrapper.
            let ancestor: THREE.Object3D = mesh;
            while (ancestor.parent && ancestor.parent !== sceneWrapper) {
              ancestor = ancestor.parent;
            }
            // (4) Filter the suspects.
            // - substrateContainer is the substrate's parent Group, a
            //   sibling of the chip Group under the wrapper. NEVER a
            //   chip — translating it drags the board.
            // - loadedRoot / sceneWrapper themselves: walk hit the top
            //   without finding a wrapper-level child (e.g. the mesh
            //   IS a direct child of loadedRoot in a flat hierarchy
            //   where sceneWrapper === loadedRoot). Translating either
            //   would move the entire scene.
            // - substrateMesh itself: the mesh-level name check above
            //   should already have filtered it, but cheap to guard.
            if (ancestor === substrateContainer) return;
            if (ancestor === loadedRoot) return;
            if (ancestor === sceneWrapper) return;
            if (ancestor === substrateMesh) return;
            candidatesBeforeDedup.push(ancestor.name || '(unnamed)');
            candidates.add(ancestor);
          });

          // (5) Deduplicate and freeze base matrices.
          for (const node of candidates) {
            chipNodes.push({ node, baseMatrix: node.matrix.clone() });
          }
          window.__model3dGLChipNodeCount = chipNodes.length;
          window.__model3dGLChipMeshNames = chipNodes.map(
            (c) => c.node.name || '(unnamed)',
          );
          window.__model3dGLClassifierDebug = {
            sceneWrapperName: sceneWrapper.name || '(unnamed)',
            sceneWrapperIsLoadedRoot: sceneWrapper === loadedRoot,
            substrateContainerName: substrateContainer.name || '(unnamed)',
            candidateNamesBeforeDedup: candidatesBeforeDedup,
            candidateNamesAfterDedup: chipNodes.map(
              (c) => c.node.name || '(unnamed)',
            ),
          };
          // (6) Defensive: if the classifier picks up nothing, log a
          // warning. Don't fall back to translating loadedRoot — better
          // to translate nothing than translate the wrong thing (which
          // is exactly the Wave 3-B bug we're fixing).
          if (chipNodes.length === 0) {
            console.warn(
              '[3D viewer GL] classifier found no chip groups — applyLiveDelta will be a no-op',
            );
            window.__model3dGLLastError = 'classifier found no chip groups';
          }
          if (substrateBboxLocal) {
            window.__model3dGLSubstrateBbox = {
              minX: substrateBboxLocal.min.x,
              minY: substrateBboxLocal.min.y,
              minZ: substrateBboxLocal.min.z,
              maxX: substrateBboxLocal.max.x,
              maxY: substrateBboxLocal.max.y,
              maxZ: substrateBboxLocal.max.z,
            };
          } else {
            window.__model3dGLSubstrateBbox = undefined;
          }

          // Recenter so the substrate TOP sits at world Y=0. kicad-cli's
          // GLB has the substrate at Y=[0, ~1.5mm] with the chip extending
          // UP from there — the user reads the visible side wall as
          // "thickness going up." Standard CAD convention is "model rests
          // on a virtual table at Y=0," so we shift everything down by
          // the substrate top height. The chip body then extends upward
          // from Y=0 and the substrate hangs below, matching the look of
          // a physical board on a workbench.
          //
          // Wave 3-B: deferred until AFTER the chip classifier so the
          // bbox-Y comparison is in the same (pre-recenter) frame as
          // substrateBboxLocal. The classifier captures node baseMatrix
          // values that don't include this loadedRoot.position shift —
          // applyLiveDelta operates on those base matrices and the
          // recenter propagates through the parent transform, so per-
          // node deltas don't need to know about the recenter.
          if (substrateBboxLocal && isFinite(substrateBboxLocal.max.y) && substrateBboxLocal.max.y !== 0) {
            loadedRoot.position.y -= substrateBboxLocal.max.y;
            loadedRoot.updateMatrix();
            loadedRoot.updateMatrixWorld(true);
          }

          scene.add(loadedRoot);

          // alpha.33: paint the front-layers SVG decal (pads / copper /
          // silkscreen) onto the substrate top. kicad-cli pcb export glb
          // has no copper layer; without this the user sees an empty
          // green PCB with the chip body floating on top.
          if (substrateBboxLocal && r.top_layers_svg_data_url) {
            void attachTopLayerDecal(loadedRoot, substrateBboxLocal, r.top_layers_svg_data_url, renderer);
          }

          // alpha.34: ±X / ±Y / ±Z axis indicators. Anchored under
          // loadedRoot so they move with positioner deltas — gives the
          // user a fixed reference frame even mid-orbit. Sized to
          // substrate diagonal × 1.4 so labels sit clear of the board.
          // alpha.5-axes-shrink: default-off (vision-agent flagged the
          // cones + labels as dominating the canvas). Caller opts in
          // via showAxisIndicators=true.
          if (substrateBboxLocal && props.showAxisIndicators) {
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
          const parseReason = err instanceof Error ? err.message : String(err);
          console.warn('[3D viewer GL] GLTFLoader.parse failed:', err);
          window.__model3dGLLastError = `GLTFLoader.parse: ${parseReason}`;
          // Per-asset failure — show inline, do NOT permanently fall back.
          // The next footprint may parse cleanly with the same WebGL ctx.
          setAssetError(`GLB parse failed: ${parseReason}`);
          props.onWebGLError?.(parseReason, 'asset_load_failed');
          setLoading(false);
        },
      );
    } catch (e) {
      if (myId !== loadId) return;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn('[3D viewer GL] GLB fetch failed:', e);
      window.__model3dGLLastError = `GLB fetch: ${reason}`;
      // Per-asset failure (sidecar render_3d_glb_angled threw, e.g. STEP
      // file missing on disk). The WebGL context is fine — surface inline
      // for THIS footprint and stay on the GL viewer for the next one.
      // Bug 4 fix: previously this called onWebGLError with no kind, the
      // parent flipped useGL=false permanently, and one missing IPEX STEP
      // dragged the entire session onto the slow PNG renderer.
      setAssetError(reason);
      props.onWebGLError?.(reason, 'asset_load_failed');
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
  // Wave 8-B test hook: zoom the camera onto the chip body for the
  // visual-verify harness. The default frameCameraTo zoom keeps the
  // whole substrate visible so app users see context, but at the
  // 530×320 cropped viewer size the chip body is only ~30 px wide —
  // sub-pixel changes (a 1mm Z lift) can't be evidenced. This hook
  // collapses the camera distance toward the chip union bbox without
  // touching the production framing path.
  //
  //   window.__kibraryTest.zoomToChip(factor=4)
  //
  //  - reads `chipNodes` (already populated by the GLB classifier)
  //  - computes union bbox of all chip Groups
  //  - sets controls.target to that bbox center
  //  - moves camera to (target + (camera - target) / factor), keeping
  //    the existing orbit angle but shrinking the distance
  //  - updates near/far so the tighter framing doesn't clip the chip
  // ---------------------------------------------------------------
  function zoomToChip(factor = 4): boolean {
    if (!camera || !controls) return false;
    if (!chipNodes.length) return false;
    const f = Number.isFinite(factor) && factor > 0 ? factor : 4;

    const union = new THREE.Box3();
    let any = false;
    for (const { node } of chipNodes) {
      const b = new THREE.Box3().setFromObject(node);
      if (b.isEmpty()) continue;
      union.union(b);
      any = true;
    }
    if (!any || union.isEmpty()) return false;

    const center = new THREE.Vector3();
    union.getCenter(center);
    const size = new THREE.Vector3();
    union.getSize(size);
    const chipDim = Math.max(size.x, size.y, size.z);

    // Pull the camera toward the chip while preserving its current
    // orbit direction. (camera - oldTarget) is the orbit ray; we
    // shrink it by `factor` and re-anchor at the new chip-centric
    // target.
    const oldTarget = controls.target.clone();
    const ray = new THREE.Vector3().subVectors(camera.position, oldTarget);
    ray.divideScalar(f);

    // Floor the distance so a sub-mm chip doesn't pull the camera
    // inside the geometry. ~3× the chip's max dim keeps margin.
    const minDist = Math.max(chipDim * 3, 1e-4);
    if (ray.length() < minDist) {
      ray.setLength(minDist);
    }

    camera.position.copy(center).add(ray);

    // Tighten near plane proportional to the new framing so the chip
    // body never clips when the user wheel-zooms further in.
    const minFeature = Math.max(
      Math.min(size.x || chipDim, size.y || chipDim, size.z || chipDim),
      1e-5,
    );
    camera.near = Math.max(minFeature / 100, 1e-6);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    return true;
  }

  // ---------------------------------------------------------------
  // Lifecycle wiring.
  // ---------------------------------------------------------------

  onMount(() => {
    if (!initWebGL()) return; // error already surfaced
    // Install the harness-only zoom hook on the existing __kibraryTest
    // bag (already populated by workspace.ts / lcscIndex.ts / etc.).
    // Closes over the component-scoped `chipNodes` / `camera` /
    // `controls` so it always sees the live values at call time.
    const w = window as unknown as { __kibraryTest?: Record<string, unknown> };
    w.__kibraryTest = w.__kibraryTest ?? {};
    (w.__kibraryTest as Record<string, unknown>).zoomToChip = (factor?: number) =>
      zoomToChip(typeof factor === 'number' ? factor : 4);
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
    // Drop the Wave 8-B harness hook so it doesn't keep the closure
    // (and the disposed renderer) alive after unmount.
    const w = window as unknown as { __kibraryTest?: Record<string, unknown> };
    if (w.__kibraryTest && 'zoomToChip' in w.__kibraryTest) {
      delete (w.__kibraryTest as Record<string, unknown>).zoomToChip;
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
        {/*
          Per-asset load-failure overlay. Stays inside the GL viewer (we
          do NOT fall back to the PNG renderer for this) so the user can
          see exactly which footprint failed without losing the session's
          interactive renderer for the next preview.
        */}
        <Show when={!loading() && assetError()}>
          <div
            data-testid="3d-viewer-gl-asset-error"
            class="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-amber-700 dark:text-amber-300 bg-zinc-100/85 dark:bg-zinc-900/85"
          >
            <div class="space-y-1">
              <p class="font-medium">3D model failed to load for this footprint</p>
              <p class="font-mono text-[11px] opacity-80 break-words">{assetError()}</p>
            </div>
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
//
// alpha.4-bugfix: previous implementation matched ALL meshes whose name
// contained /pcb/i and kept overwriting `named` on each match — so for
// connector footprints with chip meshes named like "J1_PCB_Edge" or
// "Connector_PCB_Pad", the LAST matching mesh (a chip body) won. The
// real substrate then ended up in chipNodes and got translated by
// applyLiveDelta — user reported this as "PCB moves down, part stays."
//
// New strategy:
//   1. Exact-match `preview_PCB` first — kicad-cli's canonical name.
//   2. If no exact match, fall back to the LARGEST-XY-area mesh, which
//      is reliably the board (substrate is wide+flat, chip bodies are
//      small). XY-area not 3D-volume — chip body STEPs sometimes have
//      a larger Z extent than the thin substrate.
function findSubstrateMesh(root: THREE.Object3D): THREE.Mesh | null {
  let exactMatch: THREE.Mesh | null = null;
  let largestXY: THREE.Mesh | null = null;
  let largestArea = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.name === 'preview_PCB' && exactMatch === null) {
      exactMatch = m;
    }
    const b = new THREE.Box3().setFromObject(m);
    if (b.isEmpty()) return;
    const s = new THREE.Vector3();
    b.getSize(s);
    const area = s.x * s.z; // X-by-Z is the board face in three.js Y-up world
    if (area > largestArea) {
      largestArea = area;
      largestXY = m;
    }
  });
  return exactMatch || largestXY;
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
  renderer: THREE.WebGLRenderer | null,
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
  // alpha.5-visual-parity: TARGET 1024 → 2048. The pad+silk decal is the
  // load-bearing detail; at 1024 the silkscreen "REF**" pixelates on a
  // 320 px viewer when zoomed in. 2048 quadruples texture memory (~16
  // MB) — acceptable for one-shot per load (we dispose on swap).
  const TARGET = 2048;
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
  // alpha.5-visual-parity: max anisotropy sharpens the decal at grazing
  // angles (the isometric default view is exactly that). Falls back to
  // the texture's default (1) if the renderer isn't available.
  if (renderer) {
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
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
  // alpha.5-decal-fix: full "decal on opaque mesh" three.js recipe.
  // Wave 2-B made the substrate fully opaque (depthWrite=true, opacity=1)
  // — pre-alpha.5 the substrate was 80 % transparent so depth-buffer
  // contention with the decal didn't matter. Now it does, and the
  // decal disappears under the substrate's depth writes unless we:
  //   (1) lift the plane geometrically above substrate.max.y by 50 µm
  //       (visually invisible, beats sub-mm depth precision wobble),
  //   (2) bias the polygons toward the camera in NDC via polygonOffset
  //       (negative factor/units = closer to camera in OpenGL),
  //   (3) skip writing the decal's depth so transparent regions don't
  //       mask the substrate behind them, and
  //   (4) discard sub-threshold alpha via alphaTest so the SVG's
  //       transparent background never paints over the green PCB,
  //   (5) `toneMapped: false` so the SVG sRGB colors render at
  //       authoring intent (kicad-cli emits saturated silkscreen
  //       white / pad copper that ACES would otherwise desaturate).
  const planeMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    alphaTest: 0.01,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const decal = new THREE.Mesh(planeGeom, planeMat);
  decal.name = 'preview_PCB_top_decal';
  decal.rotation.x = -Math.PI / 2; // lie flat on XZ, normal +Y
  // alpha.5-decal-fix: 10 µm → 50 µm. With opaque substrate the
  // 10 µm lift was within depth-buffer precision noise on some GPUs
  // (the visual harness still passes but the user reports the decal
  // looks washed out / partially missing on their hardware). 50 µm
  // is still well below human-visible separation but solidly outside
  // the 24-bit depth wobble for a 0.5 m-far ortho-ish camera.
  decal.position.set(cx, topY + 5e-5, cz);
  // alpha.5-decal-fix: render decal AFTER the substrate so depth-test
  // wins are sticky on transparent boundaries (renderOrder>0 also keeps
  // it visually layered above any equally-positioned chip primitive).
  decal.renderOrder = 1;
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
  // alpha.5-axes-shrink: 0.10 → 0.04 m. The 10 cm offset still towered
  // over a 0603 chip (~0.8 mm tall) and made the +Z / -Z cones the
  // dominant on-canvas element. 4 cm keeps the directional cue
  // legible without dwarfing the subject.
  const Z_STANDOFF = 0.04;

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
  // alpha.5-axes-shrink: 0.004 → 0.0025 — vision-agent confirmed the
  // labels still read as oversized on a 0603 chip. Smaller font keeps
  // them visible without competing with the substrate / decal.
  sprite.scale.set(0.0025, 0.0025, 1);
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
