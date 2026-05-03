/**
 * Browser-injectable scene snapshot generator.
 *
 * `buildSnapshotScript()` returns a string that — when fed to WebDriver's
 * /execute/sync endpoint — walks the live `__model3dGLScene`, updates
 * matrixWorld, and returns a JSON-able SceneSnapshot describing every
 * Mesh's world position + world-space bounding box, with flags for
 * substrate vs chip-node membership.
 *
 * Why a string-builder (not a colocated browser module): the WebView
 * has no module loader; the only way to ferry code over the WebDriver
 * protocol is `execute/sync` with a single JS source string. We assemble
 * the whole snapshot logic as one IIFE so any shared helper (e.g.
 * `bboxOf`) is in scope at the same nesting.
 */

/** A snapshot record for one Mesh in the scene. World-space throughout. */
export interface MeshRecord {
  /** Mesh.name (Three.js); empty string if unset. */
  name: string;
  /** UUID — stable identity across snapshots within a single run. */
  uuid: string;
  /** Object's world position (after `updateMatrixWorld(true)`). Metres. */
  worldPosition: { x: number; y: number; z: number };
  /** World-space bounding box, computed via THREE.Box3.setFromObject. */
  worldBbox: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    /** Convenience: max − min, per axis. */
    size: { x: number; y: number; z: number };
  };
  /** True if this mesh.name === window.__model3dGLSubstrateName. */
  isSubstrate: boolean;
  /** True if this mesh sits next to the substrate (i.e. is a chip node).
   *  Defined as: !isSubstrate AND parent === substrate.parent. */
  inChipNodes: boolean;
}

export interface SceneSnapshot {
  /** ISO timestamp captured browser-side (perf.now-aligned). */
  capturedAt: number;
  /** Best-effort substrate name surfaced by Model3DViewerGL.tsx. */
  substrateName: string;
  /** Number of chip nodes seen by the runtime (for cross-checking). */
  chipNodeCount: number;
  /** Monotonic GLB load counter at capture time (used to detect reload). */
  loadCount: number;
  /** Last error string, if any. */
  lastError: string | null;
  /** All Mesh nodes encountered during traversal. */
  meshes: MeshRecord[];
  /** Names of meshes the runtime classified as chips (Wave 3-B diagnostic).
   *  Empty array if `window.__model3dGLChipMeshNames` was not set. */
  chipMeshNames: string[];
  /** Pre-recenter substrate bbox in scene-local units (metres). null if
   *  `window.__model3dGLSubstrateBbox` was not set. */
  substrateBbox: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
  /** Wave 5-A chip-classifier debug payload. Shape is owned by
   *  Model3DViewerGL.tsx; we treat it as opaque pretty-printable JSON. */
  classifierDebug: Record<string, unknown> | null;
  /** Top-level diagnostic on whether the scene was actually present. */
  ok: boolean;
  /** When ok=false, why. */
  reason?: string;
}

/**
 * Returns the JS source string that produces a SceneSnapshot when run
 * via WebDriver `execute/sync`. The script is synchronous: it returns
 * the snapshot object directly, no Promise/callback wiring needed.
 *
 * Caller pattern:
 *   const snap = await execScript(sid, buildSnapshotScript());
 *   if (!snap.ok) throw new Error(snap.reason);
 */
export function buildSnapshotScript(): string {
  // Plain-string IIFE. NO TS, NO modern syntax that strip-types would
  // need to transform — this string is evaluated by the WebView verbatim.
  return `(function(){
    var s = window.__model3dGLScene;
    if (!s) {
      return { ok: false, reason: 'window.__model3dGLScene is undefined',
               capturedAt: Date.now(), meshes: [],
               substrateName: window.__model3dGLSubstrateName || '',
               chipNodeCount: window.__model3dGLChipNodeCount || 0,
               loadCount: window.__model3dGLLoadCount || 0,
               lastError: window.__model3dGLLastError || null,
               chipMeshNames: window.__model3dGLChipMeshNames || [],
               substrateBbox: window.__model3dGLSubstrateBbox || null,
               classifierDebug: window.__model3dGLClassifierDebug || null };
    }
    s.updateMatrixWorld(true);
    var substrateName = window.__model3dGLSubstrateName || '';
    // The runtime's classifier (Model3DViewerGL.tsx) walks up to find
    // the chip's top-level Group ancestor under the GLB scene wrapper.
    // The names of those ancestors land in __model3dGLChipMeshNames.
    // A mesh "is in chipNodes" iff one of its ancestors has a matching
    // name. The earlier "parent === substrateParent" check was wrong
    // for kicad-cli output where the chip Group is a SIBLING of the
    // substrate's parent Group (not its child).
    var chipAncestorNames = window.__model3dGLChipMeshNames || [];
    var chipAncestorSet = {};
    for (var ci = 0; ci < chipAncestorNames.length; ci++) {
      chipAncestorSet[chipAncestorNames[ci]] = true;
    }
    function isUnderChipAncestor(mesh) {
      var p = mesh.parent;
      while (p) {
        if (p.name && chipAncestorSet[p.name]) return true;
        p = p.parent;
      }
      return false;
    }

    // Helper: world-space bbox via THREE.Box3.setFromObject. We rely
    // on three.js exposing Box3 through any mesh's THREE namespace —
    // since geometry.boundingBox is local, we compute world-space by
    // baking matrixWorld into corner vertices.
    function worldBbox(mesh) {
      var geom = mesh.geometry;
      if (!geom) return null;
      if (!geom.boundingBox) geom.computeBoundingBox();
      var b = geom.boundingBox;
      // 8 corners in local space.
      var corners = [
        [b.min.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.min.z],
        [b.min.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.min.z],
        [b.min.x, b.min.y, b.max.z], [b.max.x, b.min.y, b.max.z],
        [b.min.x, b.max.y, b.max.z], [b.max.x, b.max.y, b.max.z],
      ];
      mesh.updateMatrixWorld(true);
      var e = mesh.matrixWorld.elements;
      var minX = Infinity, minY = Infinity, minZ = Infinity;
      var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (var i = 0; i < corners.length; i++) {
        var x = corners[i][0], y = corners[i][1], z = corners[i][2];
        var wx = e[0]*x + e[4]*y + e[8]*z + e[12];
        var wy = e[1]*x + e[5]*y + e[9]*z + e[13];
        var wz = e[2]*x + e[6]*y + e[10]*z + e[14];
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
      return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      };
    }

    function worldPos(mesh) {
      // matrixWorld already updated above; translation is e[12..14].
      var e = mesh.matrixWorld.elements;
      return { x: e[12], y: e[13], z: e[14] };
    }

    var meshes = [];
    s.traverse(function(o){
      if (!o.isMesh) return;
      var isSub = !!(substrateName && o.name === substrateName);
      var inChip = !isSub && isUnderChipAncestor(o);
      var bbox = worldBbox(o);
      meshes.push({
        name: o.name || '',
        uuid: o.uuid,
        worldPosition: worldPos(o),
        worldBbox: bbox,
        isSubstrate: isSub,
        inChipNodes: inChip,
      });
    });

    return {
      ok: true,
      capturedAt: Date.now(),
      substrateName: substrateName,
      chipNodeCount: window.__model3dGLChipNodeCount || 0,
      loadCount: window.__model3dGLLoadCount || 0,
      lastError: window.__model3dGLLastError || null,
      meshes: meshes,
      chipMeshNames: window.__model3dGLChipMeshNames || [],
      substrateBbox: window.__model3dGLSubstrateBbox || null,
      classifierDebug: window.__model3dGLClassifierDebug || null,
    };
  })()`;
}
