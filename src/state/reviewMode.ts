import { createSignal } from 'solid-js';

export type ReviewMode = 'sequential' | 'pick' | 'bulk';

const [mode, setMode] = createSignal<ReviewMode>('bulk');

export { mode as reviewMode, setMode as setReviewMode };
