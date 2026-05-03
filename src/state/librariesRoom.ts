/**
 * Libraries room state.
 *
 * selectedLib       — the library name currently expanded/selected in the tree
 * selectedComponent — the component name currently selected in the component list
 * multiSelected     — the set of component names currently checked (multi-select)
 *
 * toggleSelect adds/removes a name from multiSelected.
 */

import { batch, createSignal } from 'solid-js';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const [selectedLib, setSelectedLib] = createSignal<string | null>(null);
const [selectedComponent, setSelectedComponent] = createSignal<string | null>(null);
const [multiSelected, setMultiSelected] = createSignal<Set<string>>(new Set());

export { selectedLib, setSelectedLib };
export { selectedComponent, setSelectedComponent };
export { multiSelected, setMultiSelected };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Toggle a component name in/out of the multi-select set. */
export function toggleSelect(name: string): void {
  setMultiSelected((prev) => {
    const next = new Set(prev);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    return next;
  });
}

// alpha.18: expose tree+list selection to the smoke harness so it can drive
// to a specific component without LibraryTree / ComponentList testids.
if (typeof window !== 'undefined') {
  const bag = ((window as any).__kibraryTest = (window as any).__kibraryTest ?? {});
  bag.selectLibrary = setSelectedLib;
  bag.selectComponent = setSelectedComponent;
  bag.getSelectedLib = () => selectedLib();
  bag.getSelectedComponent = () => selectedComponent();

  // Wave 6-B fix: switch BOTH signals inside a Solid batch() so resources
  // keyed on (lib, component) — ComponentDetail's library.get_component,
  // SymbolPreview's library.render_symbol_svg, FootprintPreview's
  // library.render_footprint_svg, Model3DPreview's library.get_3d_info —
  // see exactly ONE (oldLib, oldComp) → (newLib, newComp) transition.
  //
  // Pre-fix: `setSelectedLib(newLib); setSelectedComponent(newComp)` ran
  // outside any batch. Solid's reactive graph propagated each set
  // synchronously, so resources briefly observed (newLib, oldComp). When
  // transitioning fixture 2 (USBC_KSL / USB_C_Receptacle…) → fixture 3
  // (SyntheticPCB_KSL / synthetic_pcb_named) the sidecar received
  //     library.get_component(SyntheticPCB_KSL, USB_C_Receptacle…)
  // → KeyError "Component 'USB_C_Receptacle…' not found in library
  // 'SyntheticPCB_KSL'". batch() coalesces both sets into a single
  // graph propagation and resources only see the final pair.
  //
  // Returns a Promise that resolves on the next microtask, after Solid
  // has flushed any synchronous effect triggered by the batch. The
  // harness still polls __model3dGLLoadCount to strict-increase before
  // snapshotting (the GLB fetch is sidecar-bound; we only guarantee the
  // signal transition has been queued and stale-pair fetches have been
  // suppressed).
  bag.openComponent = (lib: string, component: string): Promise<void> => {
    batch(() => {
      setSelectedLib(lib);
      setSelectedComponent(component);
    });
    return Promise.resolve();
  };

  // Optional helper the harness may call AFTER openComponent to wait
  // until the ComponentDetail-side resources have started fetching for
  // the new pair. It's a thin polling shim; the authoritative readiness
  // gate is still __model3dGLLoadCount strict-increase.
  bag.waitForCurrentComponentLoaded = async (timeoutMs = 5000): Promise<void> => {
    const start = Date.now();
    // Loose readiness: the (lib, component) signals match what the caller
    // last requested AND a microtask has run so resources keyed on those
    // signals have queued their fetches.
    while (Date.now() - start < timeoutMs) {
      // Yield to the microtask queue so Solid can flush.
      await Promise.resolve();
      const lib = selectedLib();
      const comp = selectedComponent();
      if (lib && comp) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
}
