/**
 * Wave 06-IPEX: standalone formatter for sidecar render warnings.
 *
 * Pulled into its own module because the consumer (Model3DViewerGL.tsx)
 * imports `solid-js/web`, which touches `window` at module-eval time.
 * That breaks the vitest-node environment used by our other UI specs.
 * Keeping the formatter here lets `Model3DViewerGL.warnings.test.ts`
 * exercise the contract without booting jsdom.
 *
 * The contract is: take a structured warning emitted by
 * `library.render_3d_glb_angled` (Wave 1-E + Wave 8-C) and return a
 * single human-readable line for the asset-warnings overlay banner.
 *
 * Known kinds get specialised formatting that surfaces the action a
 * user can take:
 *   - model_not_found → "the .step is missing — drop it into ${path}"
 *   - tessellation_failed → "kicad-cli skipped this assembly node —
 *     re-export from KiCad's STEP exporter"
 * Unknown kinds fall through to a generic JSON dump so we never
 * silently swallow a future warning kind.
 */

export interface ComponentAssets {
  symbol: boolean;
  footprint: boolean;
  model_3d: boolean;
}

export type RenderWarning =
  | {
      kind: 'model_not_found';
      token?: string;
      expanded?: string;
      basename?: string;
      sibling_match?: string | null;
      lib_dir?: string;
    }
  | {
      kind: 'tessellation_failed';
      node_name?: string;
    }
  | {
      // C6037812-class: easyeda.com had no design data for this LCSC,
      // download produced ZERO files. Surfaces in the Queue + bulk-assign
      // UI so the user sees "X not found" instead of a silent failure.
      kind: 'component_load_failed';
      lcsc?: string;
      missing?: string[];
      assets?: ComponentAssets;
      reason?: string;
    }
  | {
      // Download succeeded but at least one of symbol/footprint/3D is
      // absent (rare — JLC normally returns the full trio, but we've
      // seen footprint-only or 3D-only responses for newer parts).
      kind: 'component_load_partial';
      lcsc?: string;
      missing?: string[];
      assets?: ComponentAssets;
    }
  | { kind: string; [k: string]: unknown };

export function formatWarning(w: RenderWarning): string {
  if (w.kind === 'model_not_found') {
    const basename = w.basename || '(no path)';
    const sibling = w.sibling_match
      ? ` — found a similarly-named file at ${w.sibling_match}`
      : '';
    return `model_not_found: ${basename}${sibling}`;
  }
  if (w.kind === 'tessellation_failed') {
    const node = w.node_name || '(unnamed)';
    return `tessellation_failed: kicad-cli skipped node '${node}' (assembly STEP without pre-computed triangulation)`;
  }
  if (w.kind === 'component_load_failed') {
    const lcsc = (w as { lcsc?: string }).lcsc || '(unknown LCSC)';
    const reason = (w as { reason?: string }).reason || 'no data in source library';
    return `${lcsc}: not found — ${reason}`;
  }
  if (w.kind === 'component_load_partial') {
    const lcsc = (w as { lcsc?: string }).lcsc || '(unknown LCSC)';
    const missing = (w as { missing?: string[] }).missing || [];
    const list = missing.length ? missing.join(', ') : 'unknown asset';
    return `${lcsc}: missing ${list} — partial download`;
  }
  // Unknown kind — dump everything except `kind` itself.
  const { kind, ...rest } = w as Record<string, unknown> & { kind: string };
  return `${kind}: ${JSON.stringify(rest)}`;
}
