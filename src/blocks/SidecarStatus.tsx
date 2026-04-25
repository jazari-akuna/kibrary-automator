import { createResource, Show } from 'solid-js';
import { sidecar } from '~/api/sidecar';

export default function SidecarStatus() {
  const [v] = createResource(() => sidecar.version());
  return (
    <div class="text-xs text-zinc-400">
      sidecar:&nbsp;
      <Show when={v()} fallback="…">{`v${v()!.version} ✓`}</Show>
    </div>
  );
}
