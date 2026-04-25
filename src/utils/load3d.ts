/**
 * load3d.ts — helpers for scanning and loading 3D model files.
 *
 * TODO (P3): wire real binary-read via parts.read_file_bytes RPC once T28
 *            adds the method, then pass the bytes to WRMLLoader / GLTFLoader.
 */

import { invoke } from '@tauri-apps/api/core';

/** Supported 3D model extensions in priority order. */
export const MODEL3D_EXTS = ['.step', '.stp', '.wrl', '.glb'] as const;
export type Model3DExt = (typeof MODEL3D_EXTS)[number];

export interface Model3DFile {
  filename: string;
  ext: Model3DExt;
  /** Full path inside the staging dir. */
  path: string;
}

/**
 * Scan `<stagingDir>/<lcsc>/<lcsc>.3dshapes/` and return the first supported
 * 3D model file found, or `null` when none exist.
 *
 * Uses `parts.list_dir` RPC (expected by sidecar).  Falls back to null on any
 * error so the block degrades gracefully without crashing.
 */
export async function findModel3DFile(
  stagingDir: string,
  lcsc: string,
): Promise<Model3DFile | null> {
  const shapesDir = `${stagingDir}/${lcsc}/${lcsc}.3dshapes`;

  let entries: string[] = [];
  try {
    const result = await invoke<{ entries: string[] }>('sidecar_call', {
      method: 'parts.list_dir',
      params: { path: shapesDir },
    });
    entries = result.entries ?? [];
  } catch {
    // Directory doesn't exist or RPC not yet implemented — return null.
    return null;
  }

  for (const ext of MODEL3D_EXTS) {
    const match = entries.find((e) => e.toLowerCase().endsWith(ext));
    if (match) {
      return {
        filename: match,
        ext,
        path: `${shapesDir}/${match}`,
      };
    }
  }

  return null;
}

/**
 * Read raw bytes of a file via `parts.read_file_bytes` RPC.
 *
 * TODO (T28 / P3): this placeholder always throws so callers fall back to the
 *                  placeholder cube.  Replace with a real Tauri invoke once the
 *                  RPC method is registered.
 */
export async function readFileBytes(_path: string): Promise<Uint8Array> {
  // Placeholder — manager will add the RPC in T28.
  throw new Error('parts.read_file_bytes not yet implemented');
}
