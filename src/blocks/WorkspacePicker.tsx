import { Show, For } from 'solid-js';
import { currentWorkspace, recentWorkspaces, openWorkspace, pickAndOpen } from '~/state/workspace';

export default function WorkspacePicker() {
  return (
    <div class="text-sm">
      <Show when={currentWorkspace()} fallback={
        <div class="space-y-1">
          <button class="px-2 py-1 bg-zinc-700 rounded" onClick={pickAndOpen}>Open folder…</button>
          <For each={recentWorkspaces()}>{(p) => (
            <button class="block underline text-zinc-400" onClick={() => openWorkspace(p)}>{p}</button>
          )}</For>
        </div>
      }>
        <span class="text-zinc-300">{currentWorkspace()!.root}</span>
        <button class="ml-2 underline text-zinc-500" onClick={pickAndOpen}>change</button>
      </Show>
    </div>
  );
}
