import { createSignal } from 'solid-js';
export type Room = 'add' | 'libraries' | 'settings';
export const [room, setRoom] = createSignal<Room>('add');

// alpha.18: expose room navigation to the smoke harness so it can drive the
// app between rooms without depending on LeftRail DOM selectors. The
// existing __kibraryTest test bag (workspace.ts, lcscIndex.ts) is the
// shared bus for this kind of hook — merge into it instead of overwriting.
if (typeof window !== 'undefined') {
  const bag = ((window as any).__kibraryTest = (window as any).__kibraryTest ?? {});
  bag.setRoom = setRoom;
  bag.getRoom = () => room();
}
