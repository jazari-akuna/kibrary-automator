/**
 * 26.5.6-alpha.5 regression: kicad-cli's GLB exports the substrate plate
 * as six sibling meshes (top face, bottom face, 4 edge faces) named
 * preview_PCB / preview_PCB_1 / .../ preview_PCB_5. The pre-fix code
 * computed substrate bbox via `setFromObject(findSubstrateMesh(root))`,
 * which only saw ONE mesh — for the canonical `preview_PCB` (+Z edge
 * face, with Z=[+20,+20] single-valued), giving Z centre = +20mm instead
 * of 0. The SVG decal then landed +20mm off the substrate centre,
 * producing the user-reported "pads floating off the corner" on
 * asymmetric footprints (IPEX 20952-024E-02). Symmetric fixtures
 * (U.FL, USB-C) hid the bug because the half-shifted decal still
 * looked roughly aligned.
 *
 * This spec recreates the exact 6-mesh substrate hierarchy via direct
 * three.js construction (no GLB loader needed) and asserts the unioned
 * bbox returns the full plate extents — Z range [-20, +20], centre 0.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { findSubstrateMesh, computeSubstrateBboxLocal } from '../_substrateBbox';

// Build a 6-mesh substrate hierarchy mimicking kicad-cli's GLB output
// for our 40×40×1.51 mm empty PCB template.
function buildKicadCliStyleSubstrate(): THREE.Group {
  const root = new THREE.Group();
  // Helper: a box mesh in metres (kicad-cli's GLB unit).
  const face = (
    name: string,
    minX: number, maxX: number,
    minY: number, maxY: number,
    minZ: number, maxZ: number,
  ) => {
    const sx = Math.max(maxX - minX, 1e-6);
    const sy = Math.max(maxY - minY, 1e-6);
    const sz = Math.max(maxZ - minZ, 1e-6);
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
    mesh.name = name;
    mesh.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    return mesh;
  };
  // +Z edge: kicad-cli emits this one as the canonical "preview_PCB".
  root.add(face('preview_PCB',   -0.02, 0.02, -0.00151, 0,    0.02, 0.02));
  // -X edge
  root.add(face('preview_PCB_1', -0.02, -0.02, -0.00151, 0,  -0.02, 0.02));
  // -Z edge
  root.add(face('preview_PCB_2', -0.02, 0.02, -0.00151, 0,  -0.02, -0.02));
  // +X edge
  root.add(face('preview_PCB_3',  0.02, 0.02, -0.00151, 0,  -0.02, 0.02));
  // bottom face
  root.add(face('preview_PCB_4', -0.02, 0.02, -0.00151, -0.00151, -0.02, 0.02));
  // top face
  root.add(face('preview_PCB_5', -0.02, 0.02,  0,        0,        -0.02, 0.02));
  return root;
}

describe('_substrateBbox / kicad-cli 6-mesh substrate', () => {
  it('findSubstrateMesh exact-matches the canonical preview_PCB', () => {
    const root = buildKicadCliStyleSubstrate();
    root.updateMatrixWorld(true);
    const mesh = findSubstrateMesh(root);
    expect(mesh).not.toBeNull();
    expect(mesh!.name).toBe('preview_PCB');
  });

  it('computeSubstrateBboxLocal unions all six faces into the full plate', () => {
    const root = buildKicadCliStyleSubstrate();
    root.updateMatrixWorld(true);
    const mesh = findSubstrateMesh(root)!;
    const bbox = computeSubstrateBboxLocal(root, mesh);

    // Tolerance accounts for floating-point drift from BoxGeometry
    // tessellation; 1 µm is well under decal placement precision (50 µm).
    const eps = 1e-6;
    expect(bbox.min.x).toBeCloseTo(-0.02, 5);
    expect(bbox.max.x).toBeCloseTo( 0.02, 5);
    expect(bbox.min.y).toBeCloseTo(-0.00151, 5);
    expect(bbox.max.y).toBeCloseTo( 0,       5);
    expect(bbox.min.z).toBeCloseTo(-0.02, 5);
    expect(bbox.max.z).toBeCloseTo( 0.02, 5);

    // The actual regression: pre-fix code saw cz = +0.02 (one-face bbox).
    const cz = (bbox.min.z + bbox.max.z) / 2;
    expect(Math.abs(cz)).toBeLessThan(eps);
  });

  it('ignores the SVG decal plane named preview_PCB_top_decal', () => {
    const root = buildKicadCliStyleSubstrate();
    // Decal plane is wider than substrate (kicad-cli pads viewBox by
    // ~0.04 mm) and sits 0.05 mm above the top face. If our union
    // incorrectly included it, max.x and max.y would shift.
    const decalGeom = new THREE.PlaneGeometry(0.04008, 0.04008);
    const decal = new THREE.Mesh(decalGeom, new THREE.MeshBasicMaterial());
    decal.name = 'preview_PCB_top_decal';
    decal.position.set(0, 5e-5, 0);
    decal.rotation.x = -Math.PI / 2;
    root.add(decal);
    root.updateMatrixWorld(true);

    const mesh = findSubstrateMesh(root)!;
    const bbox = computeSubstrateBboxLocal(root, mesh);
    expect(bbox.max.x).toBeCloseTo(0.02, 5);   // not 0.02004
    expect(bbox.max.y).toBeCloseTo(0,    5);   // not 5e-5
  });

  it('falls back to single-mesh bbox if no preview_PCB* meshes exist', () => {
    const root = new THREE.Group();
    const orphan = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.00151, 0.04),
      new THREE.MeshBasicMaterial(),
    );
    orphan.name = 'oddly_named_substrate';
    root.add(orphan);
    root.updateMatrixWorld(true);
    const bbox = computeSubstrateBboxLocal(root, orphan);
    expect(bbox.min.x).toBeCloseTo(-0.02, 5);
    expect(bbox.max.x).toBeCloseTo( 0.02, 5);
  });
});
