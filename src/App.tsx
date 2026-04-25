import { createResource, Switch, Match } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import Shell from '~/shell/Shell';
import Bootstrap from '~/blocks/Bootstrap';

interface BootstrapStatus {
  python_resolved: boolean;
  sidecar_version: string | null;
}

export default function App() {
  const [status] = createResource(() =>
    invoke<BootstrapStatus>('bootstrap_status').catch(() => ({
      python_resolved: false,
      sidecar_version: null,
    }))
  );

  return (
    <Switch fallback={<div class="p-4 text-zinc-400">Loading…</div>}>
      <Match when={status()?.python_resolved}>
        <Shell />
      </Match>
      <Match when={status() && !status()!.python_resolved}>
        <Bootstrap onResolved={() => window.location.reload()} />
      </Match>
    </Switch>
  );
}
