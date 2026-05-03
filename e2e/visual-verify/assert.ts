/**
 * Pure assertion + diff functions for the visual-verify harness.
 *
 * No I/O, no globals — every input arrives as an argument. Lets the runner
 * (and unit tests, when added) exercise the full diff/verdict logic without
 * spinning up tauri-driver.
 */
import type { MeshRecord, SceneSnapshot } from './snapshot-scene.ts';

/** Per-mesh delta produced by computeDiff. All deltas are AFTER − BEFORE. */
export interface MeshDelta {
  name: string;
  uuid: string;
  isSubstrate: boolean;
  inChipNodes: boolean;
  /** Translation delta of the mesh's world position. Metres. */
  positionDelta: { x: number; y: number; z: number };
  /** Magnitude of positionDelta (Euclidean). Convenience scalar. */
  positionDeltaMag: number;
  /** Per-axis bbox-min delta (after − before). Useful for spotting
   *  rotation that doesn't change the centroid much. */
  bboxMinDelta: { x: number; y: number; z: number };
  /** Per-axis bbox-size delta (after − before). Detects scale changes. */
  bboxSizeDelta: { x: number; y: number; z: number };
}

/** Top-level diff record. */
export interface DiffRecord {
  /** Per-uuid pairings present in BOTH snapshots. */
  matched: MeshDelta[];
  /** Mesh uuids that appeared only in the AFTER snapshot. */
  added: MeshRecord[];
  /** Mesh uuids that disappeared in the AFTER snapshot. */
  removed: MeshRecord[];
  /** True if the GLB load counter changed mid-action (snapshot is stale). */
  reloadDetected: boolean;
  /** Convenience: BEFORE / AFTER load counts. */
  loadCountBefore: number;
  loadCountAfter: number;
}

/**
 * Pairs the two snapshots by uuid, returns deltas. uuid is the
 * Three.js stable identity so a mesh that just moved keeps the same key.
 */
export function computeDiff(before: SceneSnapshot, after: SceneSnapshot): DiffRecord {
  const beforeByUuid = new Map<string, MeshRecord>();
  for (const m of before.meshes) beforeByUuid.set(m.uuid, m);
  const afterByUuid = new Map<string, MeshRecord>();
  for (const m of after.meshes) afterByUuid.set(m.uuid, m);

  const matched: MeshDelta[] = [];
  const added: MeshRecord[] = [];
  const removed: MeshRecord[] = [];

  for (const [uuid, a] of afterByUuid) {
    const b = beforeByUuid.get(uuid);
    if (!b) {
      added.push(a);
      continue;
    }
    const dpx = a.worldPosition.x - b.worldPosition.x;
    const dpy = a.worldPosition.y - b.worldPosition.y;
    const dpz = a.worldPosition.z - b.worldPosition.z;
    matched.push({
      name: a.name,
      uuid,
      isSubstrate: a.isSubstrate,
      inChipNodes: a.inChipNodes,
      positionDelta: { x: dpx, y: dpy, z: dpz },
      positionDeltaMag: Math.sqrt(dpx * dpx + dpy * dpy + dpz * dpz),
      bboxMinDelta: bboxMinDelta(b, a),
      bboxSizeDelta: bboxSizeDelta(b, a),
    });
  }
  for (const [uuid, b] of beforeByUuid) {
    if (!afterByUuid.has(uuid)) removed.push(b);
  }

  return {
    matched,
    added,
    removed,
    reloadDetected: before.loadCount !== after.loadCount,
    loadCountBefore: before.loadCount,
    loadCountAfter: after.loadCount,
  };
}

function bboxMinDelta(b: MeshRecord, a: MeshRecord) {
  if (!a.worldBbox || !b.worldBbox) return { x: 0, y: 0, z: 0 };
  return {
    x: a.worldBbox.min.x - b.worldBbox.min.x,
    y: a.worldBbox.min.y - b.worldBbox.min.y,
    z: a.worldBbox.min.z - b.worldBbox.min.z,
  };
}

function bboxSizeDelta(b: MeshRecord, a: MeshRecord) {
  if (!a.worldBbox || !b.worldBbox) return { x: 0, y: 0, z: 0 };
  return {
    x: a.worldBbox.size.x - b.worldBbox.size.x,
    y: a.worldBbox.size.y - b.worldBbox.size.y,
    z: a.worldBbox.size.z - b.worldBbox.size.z,
  };
}

/** Threshold + expected-direction config for one fixture. */
export interface AssertOverrides {
  /** Substrate may shift up to this many metres on any axis. Default 1e-4. */
  substrateMaxDelta?: number;
  /**
   * Inclusive [min, max] expected Y delta for at least one chip node, in
   * metres. Default for a `jog-z-+1` action: [0.0005, 0.002] m
   * (i.e. roughly +1mm with ±0.5mm slack — covers the alpha.4 fix).
   * Use `null` to skip the chip-Y assertion entirely.
   */
  chipYDeltaRange?: [number, number] | null;
  /** If set, fail unless at least this many chip nodes meet chipYDeltaRange. */
  chipYDeltaMinCount?: number;
  /** Tolerance for "mesh count changed" — usually 0 (no add/remove allowed). */
  maxAddedMeshes?: number;
  maxRemovedMeshes?: number;
}

/** Static defaults for the standard "jog-z-+1mm on a kicad-cli GLB" action. */
export const DEFAULT_OVERRIDES: Required<AssertOverrides> = {
  substrateMaxDelta: 1e-4,
  chipYDeltaRange: [0.0005, 0.002],
  chipYDeltaMinCount: 1,
  maxAddedMeshes: 0,
  maxRemovedMeshes: 0,
};

/** What a fixture entry feeds into runAssertions. */
export interface FixtureLike {
  name: string;
  action: string;
  expectedSubstrateName?: string;
  assertOverrides?: AssertOverrides;
}

export interface Verdict {
  verdict: 'PASS' | 'FAIL';
  failReasons: string[];
  /** Echoed for the report. */
  thresholds: Required<AssertOverrides>;
  /** Useful summary numbers. */
  summary: {
    substrateMaxDelta: number;
    chipsInRange: number;
    biggestChipYDelta: number;
  };
}

/**
 * Pure-function assertions for the standard 3D-fix campaign. Returns
 * verdict + reasons; never throws.
 */
export function runAssertions(diff: DiffRecord, fixture: FixtureLike): Verdict {
  const t: Required<AssertOverrides> = {
    ...DEFAULT_OVERRIDES,
    ...(fixture.assertOverrides ?? {}),
  };
  const fail: string[] = [];

  if (diff.reloadDetected) {
    fail.push(
      `GLB reload mid-action: loadCount went ${diff.loadCountBefore} → ${diff.loadCountAfter}. ` +
        `Snapshot is stale — chip-node identities may have shifted.`,
    );
  }
  if (diff.added.length > t.maxAddedMeshes) {
    fail.push(`unexpected mesh additions: ${diff.added.length} > ${t.maxAddedMeshes}`);
  }
  if (diff.removed.length > t.maxRemovedMeshes) {
    fail.push(`unexpected mesh removals: ${diff.removed.length} > ${t.maxRemovedMeshes}`);
  }

  // Substrate must NOT move (per-axis tolerance).
  let substrateMaxDelta = 0;
  for (const m of diff.matched) {
    if (!m.isSubstrate) continue;
    const ax = Math.max(
      Math.abs(m.positionDelta.x),
      Math.abs(m.positionDelta.y),
      Math.abs(m.positionDelta.z),
    );
    if (ax > substrateMaxDelta) substrateMaxDelta = ax;
    if (ax > t.substrateMaxDelta) {
      fail.push(
        `substrate "${m.name}" moved by ${ax.toExponential(3)} m ` +
          `(threshold ${t.substrateMaxDelta.toExponential(3)} m) — ` +
          `Bug 2 regression: PCB moves instead of chip.`,
      );
    }
  }

  // At least one chip node should have moved within the expected Y range.
  let chipsInRange = 0;
  let biggestChipYDelta = 0;
  if (t.chipYDeltaRange) {
    const [lo, hi] = t.chipYDeltaRange;
    for (const m of diff.matched) {
      if (!m.inChipNodes) continue;
      const dy = m.positionDelta.y;
      if (Math.abs(dy) > Math.abs(biggestChipYDelta)) biggestChipYDelta = dy;
      if (dy >= lo && dy <= hi) chipsInRange++;
    }
    if (chipsInRange < t.chipYDeltaMinCount) {
      fail.push(
        `expected at least ${t.chipYDeltaMinCount} chip node(s) with Y-delta in [${lo}, ${hi}] m; ` +
          `found ${chipsInRange}. Biggest observed chip Y-delta: ${biggestChipYDelta.toExponential(3)} m. ` +
          `Bug 2 regression: chip-node movement missing or wrong magnitude.`,
      );
    }
  }

  return {
    verdict: fail.length === 0 ? 'PASS' : 'FAIL',
    failReasons: fail,
    thresholds: t,
    summary: { substrateMaxDelta, chipsInRange, biggestChipYDelta },
  };
}
