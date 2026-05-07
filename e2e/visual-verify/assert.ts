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

/**
 * Substrate centre (XZ plane) — union of all preview_PCB(_<n>)? meshes.
 * Returns null if no substrate-named meshes are present.
 */
function computeSubstrateCentre(snap: SceneSnapshot): { x: number; z: number } | null {
  let minX = +Infinity, maxX = -Infinity, minZ = +Infinity, maxZ = -Infinity;
  let any = false;
  for (const m of snap.meshes) {
    if (m.name === 'preview_PCB_top_decal') continue;
    if (!/^preview_PCB(_\d+)?$/.test(m.name)) continue;
    if (!m.worldBbox) continue;
    if (m.worldBbox.min.x < minX) minX = m.worldBbox.min.x;
    if (m.worldBbox.max.x > maxX) maxX = m.worldBbox.max.x;
    if (m.worldBbox.min.z < minZ) minZ = m.worldBbox.min.z;
    if (m.worldBbox.max.z > maxZ) maxZ = m.worldBbox.max.z;
    any = true;
  }
  if (!any) return null;
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
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
  /**
   * 26.5.8 — alongside the legacy chipY range, fixtures can pin chip-X
   * or chip-Z world-space deltas. Used by `synthetic_jog_plus_x`
   * (assert chip moves in world +X) and `synthetic_jog_plus_y` (assert
   * world +Z, since KiCad +Y → world +Z). Set to null to skip.
   */
  chipXDeltaRange?: [number, number] | null;
  chipXDeltaMinCount?: number;
  chipZDeltaRange?: [number, number] | null;
  chipZDeltaMinCount?: number;
  /**
   * 26.5.8 screen-projection assertion. The dial wedges promise screen-
   * relative motion ("+Y wedge → chip moves screen-up"). Project each
   * chip's world delta onto the camera basis (camera fixed at
   * (0.12, 0.10, 0.12) looking at origin) and require at least one chip
   * to move with screenRight delta in this range (positive ⇒ chip
   * appears to move toward screen-right). Set to null to skip.
   */
  chipScreenRightRange?: [number, number] | null;
  /** Same idea for screen-up; positive ⇒ chip appears to move up on screen. */
  chipScreenUpRange?: [number, number] | null;
  /** Tolerance for "mesh count changed" — usually 0 (no add/remove allowed). */
  maxAddedMeshes?: number;
  maxRemovedMeshes?: number;
  /**
   * 26.5.6-alpha.4 regression: max distance (metres, per axis) between
   * the SVG-decal mesh centre and the substrate XZ centre, measured on
   * the BEFORE snapshot. Pre-fix value was ~0.02 m (the decal was
   * centred at world Z=+20mm because findSubstrateMesh + setFromObject
   * saw only the substrate's +Z edge face). Default 5e-4 (0.5 mm) — the
   * decal should sit within half a millimetre of true centre after the
   * fix. Set to null to disable (e.g. fixtures without a decal plane).
   */
  decalAlignmentMaxDelta?: number | null;
}

/** Static defaults for the standard "jog-z-+1mm on a kicad-cli GLB" action. */
export const DEFAULT_OVERRIDES: Required<AssertOverrides> = {
  substrateMaxDelta: 1e-4,
  chipYDeltaRange: [0.0005, 0.002],
  chipYDeltaMinCount: 1,
  chipXDeltaRange: null,
  chipXDeltaMinCount: 1,
  chipZDeltaRange: null,
  chipZDeltaMinCount: 1,
  chipScreenRightRange: null,
  chipScreenUpRange: null,
  maxAddedMeshes: 0,
  maxRemovedMeshes: 0,
  decalAlignmentMaxDelta: 5e-4,
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
export function runAssertions(
  diff: DiffRecord,
  fixture: FixtureLike,
  before?: SceneSnapshot,
): Verdict {
  const t: Required<AssertOverrides> = {
    ...DEFAULT_OVERRIDES,
    ...(fixture.assertOverrides ?? {}),
  };
  const fail: string[] = [];

  // 26.5.6-alpha.4 regression: decal must sit at substrate XZ centre.
  // Static check on the BEFORE snapshot (alignment is a state property,
  // not a delta). Bug pre-fix: decal world Z = +0.02 m (the substrate's
  // canonical "preview_PCB" mesh is the +Z edge face only, so its bbox
  // collapses Z to a single value and cz=+20mm).
  if (before && t.decalAlignmentMaxDelta !== null) {
    const decal = before.meshes.find((m) => m.name === 'preview_PCB_top_decal');
    const substrateCentre = computeSubstrateCentre(before);
    if (!decal) {
      fail.push(
        `BEFORE snapshot has no preview_PCB_top_decal mesh — the SVG decal ` +
          `did not attach. Was attachTopLayerDecal short-circuited?`,
      );
    } else if (substrateCentre) {
      const dx = Math.abs(decal.worldPosition.x - substrateCentre.x);
      const dz = Math.abs(decal.worldPosition.z - substrateCentre.z);
      const dmax = Math.max(dx, dz);
      if (dmax > t.decalAlignmentMaxDelta) {
        fail.push(
          `decal misaligned: world position (x=${decal.worldPosition.x.toFixed(5)}, ` +
            `z=${decal.worldPosition.z.toFixed(5)}) vs substrate centre ` +
            `(x=${substrateCentre.x.toFixed(5)}, z=${substrateCentre.z.toFixed(5)}) — ` +
            `max-axis delta ${dmax.toExponential(3)} m exceeds ${t.decalAlignmentMaxDelta.toExponential(3)} m. ` +
            `26.5.6-alpha.4 regression: pads + silk float off the substrate.`,
        );
      }
    }
  }

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

  // 26.5.8 — chip X / Z world-axis range checks. Same shape as the
  // legacy chipYDeltaRange. We surface a `chipsInAxisRange` map for the
  // report.
  function checkAxisRange(
    label: 'X' | 'Y' | 'Z',
    range: [number, number] | null,
    minCount: number,
    pickDelta: (d: { x: number; y: number; z: number }) => number,
  ): { count: number; biggest: number } {
    if (!range) return { count: 0, biggest: 0 };
    const [lo, hi] = range;
    let count = 0;
    let biggest = 0;
    for (const m of diff.matched) {
      if (!m.inChipNodes) continue;
      const d = pickDelta(m.positionDelta);
      if (Math.abs(d) > Math.abs(biggest)) biggest = d;
      if (d >= lo && d <= hi) count++;
    }
    if (count < minCount) {
      fail.push(
        `expected at least ${minCount} chip node(s) with ${label}-delta in [${lo}, ${hi}] m; ` +
          `found ${count}. Biggest observed chip ${label}-delta: ${biggest.toExponential(3)} m. ` +
          `Bug 1 (26.5.8) regression: dial wedge label disagrees with chip world-axis motion.`,
      );
    }
    return { count, biggest };
  }
  const xRes = checkAxisRange('X', t.chipXDeltaRange, t.chipXDeltaMinCount, (d) => d.x);
  const zRes = checkAxisRange('Z', t.chipZDeltaRange, t.chipZDeltaMinCount, (d) => d.z);

  // 26.5.8 screen-projection check. Camera basis fixed at the static
  // viewer pose: eye (0.12, 0.10, 0.12), target origin, up (0,1,0).
  // screenRight ≈ (0.7071, 0, -0.7071); screenUp ≈ (-0.359, 0.862, -0.359).
  const SCREEN_RIGHT = { x: 0.7071067811865475, y: 0, z: -0.7071067811865475 };
  const SCREEN_UP    = { x: -0.358979079308869, y: 0.8615497903412858, z: -0.358979079308869 };
  function dot3(a: { x: number; y: number; z: number }, b: typeof SCREEN_RIGHT): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }
  function checkScreenRange(
    label: 'screenRight' | 'screenUp',
    range: [number, number] | null,
    basis: typeof SCREEN_RIGHT,
  ): number {
    if (!range) return 0;
    const [lo, hi] = range;
    let any = false;
    let biggest = 0;
    for (const m of diff.matched) {
      if (!m.inChipNodes) continue;
      const proj = dot3(m.positionDelta, basis);
      if (Math.abs(proj) > Math.abs(biggest)) biggest = proj;
      if (proj >= lo && proj <= hi) any = true;
    }
    if (!any) {
      fail.push(
        `expected at least one chip node with ${label} delta in [${lo}, ${hi}] m; ` +
          `biggest observed: ${biggest.toExponential(3)} m. ` +
          `Bug 1 (26.5.8): the dial promised screen-relative motion but the ` +
          `chip moved opposite (or not at all) along ${label}.`,
      );
    }
    return biggest;
  }
  const screenRightBiggest = checkScreenRange(
    'screenRight',
    t.chipScreenRightRange,
    SCREEN_RIGHT,
  );
  const screenUpBiggest = checkScreenRange('screenUp', t.chipScreenUpRange, SCREEN_UP);
  // Side-effect: silence "unused var" if the verdict consumer ignores them.
  void xRes; void zRes; void screenRightBiggest; void screenUpBiggest;

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
