/**
 * Model3DPreview — Task 26 Solid block.
 *
 * Props: { stagingDir: string; lcsc: string }
 *
 * On mount, scans <stagingDir>/<lcsc>/<lcsc>.3dshapes/ for a supported 3D
 * model file (.step, .stp, .wrl, .glb).
 *
 * P1 SCOPE REDUCTION:
 *   - STEP/STP files: full parsing via occt-import-js is ~10 MB; skipped for
 *     P1.  A placeholder cube is rendered with a text label showing the
 *     filename instead.
 *   - WRL/GLB files: loaders (WRMLLoader / GLTFLoader from three-stdlib) are
 *     detected and selected by format, but the actual binary-read RPC
 *     (parts.read_file_bytes) is not yet implemented (T28).  Callers fall back
 *     to the placeholder cube automatically.
 *   - OrbitControls are wired and working so the user can rotate the cube.
 *
 * TODO (P3):
 *   1. Implement parts.read_file_bytes in the sidecar (T28).
 *   2. For .wrl: pass bytes → WRMLLoader → add parsed object to scene.
 *   3. For .glb: pass bytes → GLTFLoader → add parsed scene to scene.
 *   4. Consider occt-import-js for STEP/STP in P3 polish if size budget allows.
 */

import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import * as THREE from 'three';
import { OrbitControls } from 'three-stdlib';
import { findModel3DFile } from '~/utils/load3d';

interface Props {
  stagingDir: string;
  lcsc: string;
}

export default function Model3DPreview(props: Props) {
  let canvasRef: HTMLCanvasElement | undefined;

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  const [modelFile, setModelFile] = createSignal<string | null>(null);
  const [scanDone, setScanDone] = createSignal(false);

  // --------------------------------------------------------------------------
  // Scan for 3D model file on mount / when lcsc changes
  // --------------------------------------------------------------------------

  createEffect(() => {
    const { stagingDir, lcsc } = props;
    setScanDone(false);
    setModelFile(null);

    findModel3DFile(stagingDir, lcsc)
      .then((file) => {
        setModelFile(file ? file.filename : null);
      })
      .catch(() => {
        setModelFile(null);
      })
      .finally(() => {
        setScanDone(true);
      });
  });

  // --------------------------------------------------------------------------
  // Three.js scene
  // --------------------------------------------------------------------------

  createEffect(() => {
    if (!canvasRef) return;

    // Re-run when scanDone flips so we have the label text ready.
    const done = scanDone();
    if (!done) return;

    const canvas = canvasRef;
    const W = canvas.clientWidth || 320;
    const H = canvas.clientHeight || 240;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(W, H, false);
    renderer.setPixelRatio(window.devicePixelRatio ?? 1);
    renderer.setClearColor(0x1c1c1e);

    // Scene + camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(2.5, 2, 3.5);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(5, 8, 5);
    scene.add(dir);

    // Placeholder cube
    const geo = new THREE.BoxGeometry(1.2, 0.3, 1.8);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      roughness: 0.4,
      metalness: 0.3,
    });
    const cube = new THREE.Mesh(geo, mat);
    scene.add(cube);

    // Wireframe overlay
    const wireGeo = new THREE.EdgesGeometry(geo);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
    scene.add(new THREE.LineSegments(wireGeo, wireMat));

    // Grid helper
    const grid = new THREE.GridHelper(6, 12, 0x444444, 0x333333);
    grid.position.y = -0.4;
    scene.add(grid);

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1;
    controls.maxDistance = 20;

    // Resize observer
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    // Render loop
    let rafId: number;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Cleanup
    onCleanup(() => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      geo.dispose();
      mat.dispose();
      wireGeo.dispose();
      wireMat.dispose();
    });
  });

  // --------------------------------------------------------------------------
  // Edit button handler (T28 handoff)
  // --------------------------------------------------------------------------

  const handleEdit = () => {
    console.log('3D editor handoff — wired in T28');
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div class="flex flex-col gap-2">
      {/* Header row */}
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">
          3D Preview — {props.lcsc}
        </span>
        <button
          onClick={handleEdit}
          class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
        >
          Open in KiCad
        </button>
      </div>

      {/* Canvas */}
      <div class="relative rounded overflow-hidden bg-zinc-900" style={{ height: '240px' }}>
        <canvas
          ref={canvasRef}
          class="w-full h-full block"
        />

        {/* Overlay label — shown until scan is done, then shows filename or "no preview" */}
        <Show when={!scanDone()}>
          <div class="absolute inset-0 flex items-center justify-center">
            <span class="text-xs text-zinc-500">Scanning…</span>
          </div>
        </Show>

        <Show when={scanDone()}>
          <div class="absolute bottom-1 left-0 right-0 flex justify-center pointer-events-none">
            <span class="text-xs text-zinc-400 bg-zinc-900/70 px-2 py-0.5 rounded">
              {modelFile()
                ? `3D model: ${modelFile()} (placeholder — loader wired in P3)`
                : 'No 3D model found — placeholder cube'}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
}
