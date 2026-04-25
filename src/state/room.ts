import { createSignal } from 'solid-js';
export type Room = 'add' | 'libraries' | 'settings';
export const [room, setRoom] = createSignal<Room>('add');
