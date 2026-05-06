// Substrate-related helpers for the GL 3D viewer.
//
// kicad-cli's GLB export splits the 40×40mm PCB substrate plate into SIX
// separate meshes (top face, bottom face, 4 edge faces) sharing the
// `preview_PCB(_<n>)?` naming pattern. Earlier code matched the canonical
// `preview_PCB` mesh and used `setFromObject(mesh)` to compute its bbox —
// but that mesh is just the +Z edge face with z=[+20,+20] (a single
// value), giving cz=+20mm instead of 0 and offsetting the SVG decal by
// +20mm relative to the substrate centre. Asymmetric footprints (the
// IPEX 20952-024E-02 with 24 pads along one edge) exposed the bug;
// radially symmetric ones (U.FL, USB-C) hid it because the half-shifted
// decal looks roughly correct at a glance.
import * as THREE from 'three';

const SUBSTRATE_NAME_RE = /^preview_PCB(_\d+)?$/;
const DECAL_NAME = 'preview_PCB_top_decal';

// Pre-Wave-06 logic: exact-match `preview_PCB` first, fall back to the
// largest XY-area mesh. Kept verbatim because it's also used as the
// identity for chip-classifier bookkeeping (window.__model3dGLSubstrateName)
// and the node-tree never moves.
export function findSubstrateMesh(root: THREE.Object3D): THREE.Mesh | null {
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
    const area = s.x * s.z;
    if (area > largestArea) {
      largestArea = area;
      largestXY = m;
    }
  });
  return exactMatch || largestXY;
}

// Compute the full substrate bbox by unioning every `preview_PCB(_<n>)?`
// mesh under root (excluding the SVG decal plane, which uses the same
// prefix). Falls back to the single-mesh bbox if no name-matched meshes
// are found — that path keeps backward compatibility with hypothetical
// alternative GLB outputs that don't split the plate.
export function computeSubstrateBboxLocal(
  root: THREE.Object3D,
  fallbackMesh: THREE.Mesh,
): THREE.Box3 {
  const bbox = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.name === DECAL_NAME) return;
    if (SUBSTRATE_NAME_RE.test(m.name)) {
      bbox.expandByObject(m);
    }
  });
  if (bbox.isEmpty()) {
    return new THREE.Box3().setFromObject(fallbackMesh);
  }
  return bbox;
}
