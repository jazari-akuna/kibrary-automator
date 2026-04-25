import { For } from 'solid-js';
import { room, setRoom, type Room } from '~/state/room';

const items: { id: Room; label: string }[] = [
  { id: 'add', label: 'Add' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'settings', label: 'Settings' },
];

export default function LeftRail() {
  return (
    <nav class="w-32 bg-zinc-900 p-2 space-y-1">
      <For each={items}>{(it) => (
        <button
          class={`block w-full text-left px-2 py-1 rounded ${
            room() === it.id ? 'bg-zinc-700 text-white' : 'text-zinc-300 hover:bg-zinc-800'
          }`}
          onClick={() => setRoom(it.id)}
        >{it.label}</button>
      )}</For>
    </nav>
  );
}
