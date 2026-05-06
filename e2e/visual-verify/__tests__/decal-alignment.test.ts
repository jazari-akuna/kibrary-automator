/**
 * 26.5.6-alpha.4 regression: decal-alignment assertion.
 *
 * Validates that runAssertions correctly flags the pre-fix state where
 * the SVG decal lands at world Z=+20mm because findSubstrateMesh +
 * setFromObject only saw the substrate's +Z edge face. This test seeds
 * a synthetic SceneSnapshot (no GLB loader, no WebDriver) and exercises
 * just the assertion logic.
 */
import { describe, it, expect } from 'vitest';
import { computeDiff, runAssertions } from '../assert.ts';
import type { MeshRecord, SceneSnapshot } from '../snapshot-scene.ts';

function bbox(min: [number, number, number], max: [number, number, number]) {
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
  };
}

function mesh(
  name: string,
  pos: [number, number, number],
  bb: ReturnType<typeof bbox>,
  flags: Partial<MeshRecord> = {},
): MeshRecord {
  return {
    name,
    uuid: `uuid-${name}`,
    worldPosition: { x: pos[0], y: pos[1], z: pos[2] },
    worldBbox: bb,
    isSubstrate: false,
    inChipNodes: false,
    ...flags,
  };
}

function buildSnapshot(
  meshes: MeshRecord[],
  loadCount = 1,
): SceneSnapshot {
  return {
    capturedAt: 0,
    substrateName: 'preview_PCB',
    chipNodeCount: 0,
    loadCount,
    lastError: null,
    meshes,
    chipMeshNames: [],
    substrateBbox: null,
    classifierDebug: null,
    ok: true,
  };
}

// Six-mesh substrate (kicad-cli style). Plate spans X=[-0.02,+0.02],
// Y=[-0.00151,0], Z=[-0.02,+0.02]. Centre = (0, *, 0).
function sixMeshSubstrate(): MeshRecord[] {
  return [
    mesh('preview_PCB',   [0, -0.000755,  0.02], bbox([-0.02, -0.00151, 0.02], [0.02, 0, 0.02]), { isSubstrate: true }),
    mesh('preview_PCB_1', [-0.02, -0.000755, 0], bbox([-0.02, -0.00151, -0.02], [-0.02, 0, 0.02])),
    mesh('preview_PCB_2', [0, -0.000755, -0.02], bbox([-0.02, -0.00151, -0.02], [0.02, 0, -0.02])),
    mesh('preview_PCB_3', [0.02, -0.000755, 0], bbox([0.02, -0.00151, -0.02], [0.02, 0, 0.02])),
    mesh('preview_PCB_4', [0, -0.00151, 0],     bbox([-0.02, -0.00151, -0.02], [0.02, -0.00151, 0.02])),
    mesh('preview_PCB_5', [0, 0, 0],            bbox([-0.02, 0, -0.02], [0.02, 0, 0.02])),
  ];
}

describe('runAssertions / decalAlignmentMaxDelta', () => {
  const fixture = {
    name: 'ipex_user',
    action: 'static decal alignment check',
    expectedSubstrateName: 'preview_PCB',
    assertOverrides: {
      // Disable the dynamic checks so we isolate the alignment one.
      chipYDeltaRange: null as null,
      decalAlignmentMaxDelta: 0.0005,
    },
  };

  it('PASSES when decal centre matches substrate centre', () => {
    const meshes = sixMeshSubstrate();
    meshes.push(mesh(
      'preview_PCB_top_decal',
      [0, 5e-5, 0],
      bbox([-0.02004, 5e-5, -0.02004], [0.02004, 5e-5, 0.02004]),
    ));
    const snap = buildSnapshot(meshes);
    const diff = computeDiff(snap, snap);
    const v = runAssertions(diff, fixture, snap);
    expect(v.verdict).toBe('PASS');
  });

  it('FAILS when decal centre is +20mm off in Z (the alpha.3 regression)', () => {
    const meshes = sixMeshSubstrate();
    meshes.push(mesh(
      'preview_PCB_top_decal',
      [0, 5e-5, 0.02],
      bbox([-0.02004, 5e-5, 0], [0.02004, 5e-5, 0.04]),
    ));
    const snap = buildSnapshot(meshes);
    const diff = computeDiff(snap, snap);
    const v = runAssertions(diff, fixture, snap);
    expect(v.verdict).toBe('FAIL');
    expect(v.failReasons.join(' ')).toMatch(/decal misaligned/i);
  });

  it('FAILS when no decal mesh is present (attachTopLayerDecal short-circuited)', () => {
    const snap = buildSnapshot(sixMeshSubstrate());
    const diff = computeDiff(snap, snap);
    const v = runAssertions(diff, fixture, snap);
    expect(v.verdict).toBe('FAIL');
    expect(v.failReasons.join(' ')).toMatch(/no preview_PCB_top_decal mesh/i);
  });

  it('SKIPS the alignment check when decalAlignmentMaxDelta is null', () => {
    const meshes = sixMeshSubstrate();
    // No decal — would fail otherwise.
    const snap = buildSnapshot(meshes);
    const diff = computeDiff(snap, snap);
    const v = runAssertions(diff, {
      ...fixture,
      assertOverrides: { ...fixture.assertOverrides, decalAlignmentMaxDelta: null },
    }, snap);
    // Other static checks should not flag, no chip jog asserted.
    expect(v.verdict).toBe('PASS');
  });
});
