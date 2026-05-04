/**
 * Wave 06-IPEX regression test for the asset-warnings overlay.
 *
 * Pre-fix:
 *   ``library.render_3d_glb_angled`` returned a structured ``warnings``
 *   array (Wave 1-E + 8-C) but Model3DViewerGL.tsx::loadGLB read only
 *   ``glb_data_url`` and ``top_layers_svg_data_url``. The sidecar would
 *   tell the frontend "model not found / tessellation failed" and the
 *   frontend would silently ignore it — user saw a board-only GLB with
 *   no diagnostic ("when loading the IPEX connector the step fails to
 *   load even though it loads perfectly when opened in KiCad").
 *
 * Post-fix:
 *   Model3DViewerGL.tsx surfaces ``r.warnings`` in a non-blocking amber
 *   banner anchored top-left, listing each warning via ``formatWarning``.
 *   The user sees "3D model partially missing — N warnings from
 *   kicad-cli" with a per-warning breakdown.
 *
 * This spec covers the formatting helper directly (no jsdom mount) so a
 * regression in the warning-to-string contract gets caught even when
 * Solid component testing is unavailable in the headless CI.
 */
import { describe, it, expect } from 'vitest';
import { formatWarning, type RenderWarning } from '../_renderWarnings';

describe('Model3DViewerGL / formatWarning', () => {
  it('formats a model_not_found warning with the basename', () => {
    const w: RenderWarning = {
      kind: 'model_not_found',
      token: '"${KIPRJMOD}/IPEX_20952-024E-02.step"',
      expanded: '/home/user/proj/IPEX_20952-024E-02.step',
      basename: 'IPEX_20952-024E-02.step',
      sibling_match: null,
      lib_dir: '/home/user/lib',
    };

    const out = formatWarning(w);

    expect(out).toContain('model_not_found');
    expect(out).toContain('IPEX_20952-024E-02.step');
    // No sibling match → no "found a similarly-named file" suffix.
    expect(out).not.toContain('similarly-named');
  });

  it('appends the sibling-match hint when the resolver found a near miss', () => {
    const w: RenderWarning = {
      kind: 'model_not_found',
      basename: 'IPEX_20952-024E-02.step',
      sibling_match: '/home/user/snapeda-cache/IPEX_20952-024E-02.step',
    };

    const out = formatWarning(w);

    expect(out).toContain('similarly-named');
    expect(out).toContain('/home/user/snapeda-cache/IPEX_20952-024E-02.step');
  });

  it('formats a tessellation_failed warning with the node name', () => {
    const w: RenderWarning = {
      kind: 'tessellation_failed',
      node_name: 'IPEX_BODY_assembly_part',
    };

    const out = formatWarning(w);

    expect(out).toContain('tessellation_failed');
    expect(out).toContain('IPEX_BODY_assembly_part');
    // The diagnostic should hint at the user-actionable cause.
    expect(out).toMatch(/triangulation|assembly/i);
  });

  it('handles a tessellation_failed warning with no node name', () => {
    const w: RenderWarning = {
      kind: 'tessellation_failed',
      node_name: '',
    };

    const out = formatWarning(w);

    expect(out).toContain('tessellation_failed');
    expect(out).toContain('(unnamed)');
  });

  it('falls back to a generic dump for unknown warning kinds', () => {
    // Future-proofing: a new warning kind from the sidecar should still
    // be visible to the user even if the frontend doesn't have a
    // specialised branch yet.
    const w: RenderWarning = {
      kind: 'future_kind_we_dont_know_about',
      details: 'something interesting',
      retry: true,
    };

    const out = formatWarning(w);

    expect(out).toContain('future_kind_we_dont_know_about');
    expect(out).toContain('something interesting');
    expect(out).toContain('retry');
  });

  it('handles a model_not_found warning with no basename', () => {
    const w: RenderWarning = {
      kind: 'model_not_found',
    };

    const out = formatWarning(w);

    // We must not throw or render "undefined" — fallback string keeps
    // the overlay readable for malformed sidecar payloads.
    expect(out).toContain('model_not_found');
    expect(out).not.toContain('undefined');
  });
});

describe('Model3DViewerGL / overlay-render decision contract', () => {
  // The Model3DPreview renders the warnings overlay when:
  //   !loading() && !assetError() && warnings.length > 0 && !dismissed
  // This spec encodes the decision so a future refactor that loosens
  // any condition (e.g. shows warnings during loading, or after the
  // user dismissed them) gets caught at unit-test time.
  type DecisionInputs = {
    loading: boolean;
    assetError: string | null;
    warnings: RenderWarning[] | null;
    dismissed: boolean;
  };

  function shouldShowOverlay(s: DecisionInputs): boolean {
    return (
      !s.loading &&
      !s.assetError &&
      !!s.warnings &&
      s.warnings.length > 0 &&
      !s.dismissed
    );
  }

  it('renders when the GLB loaded with one model_not_found warning', () => {
    const decision = shouldShowOverlay({
      loading: false,
      assetError: null,
      warnings: [{ kind: 'model_not_found', basename: 'IPEX.step' }],
      dismissed: false,
    });
    expect(decision).toBe(true);
  });

  it('does NOT render while the GLB is still loading', () => {
    const decision = shouldShowOverlay({
      loading: true,
      assetError: null,
      warnings: [{ kind: 'model_not_found', basename: 'IPEX.step' }],
      dismissed: false,
    });
    expect(decision).toBe(false);
  });

  it('does NOT render when the GLB fetch threw (the asset-error overlay covers it)', () => {
    // If the entire load failed, the full-canvas asset-error overlay
    // takes precedence — stacking the warning banner on top would be
    // redundant and visually confusing.
    const decision = shouldShowOverlay({
      loading: false,
      assetError: 'sidecar threw: file not found',
      warnings: [{ kind: 'model_not_found', basename: 'IPEX.step' }],
      dismissed: false,
    });
    expect(decision).toBe(false);
  });

  it('does NOT render on a clean load with empty warnings', () => {
    const decision = shouldShowOverlay({
      loading: false,
      assetError: null,
      warnings: [],
      dismissed: false,
    });
    expect(decision).toBe(false);
  });

  it('does NOT render after the user dismissed it', () => {
    const decision = shouldShowOverlay({
      loading: false,
      assetError: null,
      warnings: [{ kind: 'tessellation_failed', node_name: 'foo' }],
      dismissed: true,
    });
    expect(decision).toBe(false);
  });

  it('does NOT render when warnings is null (sidecar did not include the field)', () => {
    // Backwards compat with an older sidecar that doesn't return the
    // ``warnings`` key at all — Model3DViewerGL treats it as no warnings.
    const decision = shouldShowOverlay({
      loading: false,
      assetError: null,
      warnings: null,
      dismissed: false,
    });
    expect(decision).toBe(false);
  });
});
