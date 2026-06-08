/**
 * _chipClassification — pure decision helper extracted from
 * Model3DViewerGL.tsx.
 *
 * After the GLB chip/substrate classifier runs it produces an array of
 * "chip nodes" (the movable part(s) of the model). If that array is empty
 * the position/rotation jogs become a silent no-op — the model renders but
 * the dials do nothing and the user gets no feedback. This helper maps the
 * classifier's chip-node count onto the "movable part could not be
 * identified" warning state so the viewer can surface a visible overlay
 * instead of only `console.warn`-ing.
 */

/**
 * Returns true when classification yielded zero chip nodes — i.e. the model
 * has no identifiable movable part and position editing must be disabled.
 */
export function classifierFoundNoChips(chipNodeCount: number): boolean {
  return chipNodeCount <= 0;
}
