import { createResource, createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { type Update } from '@tauri-apps/plugin-updater';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { theme, setTheme, type Theme } from '~/state/theme';
import { checkForUpdate, downloadAndInstall, quitApp } from '~/api/updater';
import { pushToast } from '~/state/toasts';
import Dropdown from '~/blocks/Dropdown';

interface Settings {
  theme: string;
  search_raph_io: { enabled: boolean; base_url: string };
  concurrency: number;
  kicad_install: string | null;
}

interface KiCadInstall {
  id: string;
  type: string;
  version: string;
  config_dir: string;
  sym_table: string;
  fp_table: string;
  kicad_bin: string;
}

// ---------------------------------------------------------------------------
// Versions card — Bug 9.
//
// Shows the three independent version stamps that make up a Kibrary install:
//   1. Frontend bundle  (compile-time injected via Vite `define:`)
//   2. Tauri shell      (Rust crate package version, via `app_version` command)
//   3. Python sidecar   (over JSON-RPC `system.version`; may be `0.0.0+unknown`
//                        in PyInstaller bundles — that's expected and tracked
//                        separately, render whatever the sidecar reports.)
//
// Failures are non-fatal: we render an em-dash instead of crashing the room.
// ---------------------------------------------------------------------------
function VersionsCard() {
  const frontend = __APP_VERSION__;
  const [tauriVersion] = createResource(() =>
    invoke<string>('app_version').catch(() => '—'),
  );
  const [sidecarVersion] = createResource(() =>
    invoke<{ version: string }>('sidecar_call', {
      method: 'system.version',
      params: {},
    })
      .then((r) => r?.version ?? '—')
      .catch(() => '—'),
  );

  return (
    <div class="rounded border border-zinc-300 dark:border-zinc-700 p-3 space-y-1 text-sm">
      <h3 class="font-semibold mb-1">Versions</h3>
      <div>
        <span class="text-zinc-600 dark:text-zinc-400">Frontend:</span>{' '}
        <span data-testid="version-frontend">{frontend}</span>
      </div>
      <div>
        <span class="text-zinc-600 dark:text-zinc-400">Tauri shell:</span>{' '}
        <span data-testid="version-tauri">{tauriVersion() ?? '…'}</span>
      </div>
      <div>
        <span class="text-zinc-600 dark:text-zinc-400">Sidecar:</span>{' '}
        <span data-testid="version-sidecar">{sidecarVersion() ?? '…'}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KiCad install picker (alpha.18).
//
// Lists every detected KiCad install and lets the user pick which one
// kibrary should auto-link new libraries against (sym-lib-table /
// fp-lib-table). Mirrors the predecessor CLI's behaviour of "use the first
// install detected" — but exposes the selection so users with multiple
// KiCad versions side-by-side (e.g. flatpak + system) can choose.
// ---------------------------------------------------------------------------
function KiCadInstallCard() {
  const [data, { refetch, mutate }] = createResource(() =>
    invoke<{ installs: KiCadInstall[]; active: string | null }>('sidecar_call', {
      method: 'kicad.detect',
      params: {},
    }).catch(() => ({ installs: [] as KiCadInstall[], active: null })),
  );

  const setActive = async (id: string) => {
    await invoke('sidecar_call', {
      method: 'kicad.set_active',
      params: { id },
    });
    await refetch();
  };

  // alpha.28: Browse for a custom KiCad install. Opens the OS file dialog,
  // hands the picked path to the sidecar's `kicad.register_custom_install`
  // method, and on success refreshes the install list with the newly
  // registered install pre-selected.
  const browseForInstall = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        title: 'Select KiCad launcher binary',
        multiple: false,
        // Minimal filters — Linux binaries have no extension, Windows uses
        // .exe, and macOS bundles a .app folder. Letting the user pick
        // anything is friendlier than over-constraining the filter.
        filters: [{ name: 'KiCad executable', extensions: ['*', 'exe', 'app'] }],
      });
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Couldn't open file dialog: ${reason}` });
      return;
    }
    if (typeof picked !== 'string') return; // user cancelled

    try {
      const result = await invoke<{ install: KiCadInstall; all_installs: KiCadInstall[] }>(
        'sidecar_call',
        {
          method: 'kicad.register_custom_install',
          params: { path: picked },
        },
      );
      // Optimistically update the cached resource so the dropdown shows the
      // new install immediately, then refetch to stay in sync with sidecar.
      mutate({ installs: result.all_installs, active: result.install.id });
      pushToast({
        kind: 'success',
        message: `Registered KiCad install: ${result.install.id}`,
      });
      await refetch();
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Couldn't register: ${reason}` });
    }
  };

  return (
    <div class="rounded border border-zinc-300 dark:border-zinc-700 p-3 space-y-2 text-sm">
      <h3 class="font-semibold mb-1">KiCad install</h3>
      <p class="text-xs text-zinc-600 dark:text-zinc-400">
        New libraries are auto-linked to this install's sym-lib-table and
        fp-lib-table so they appear in eeschema/pcbnew without manual
        editing.
      </p>
      <Show
        when={data() && data()!.installs.length > 0}
        fallback={
          <div class="space-y-2">
            <p class="text-amber-600 dark:text-amber-400" data-testid="kicad-none">
              No KiCad install detected. Install KiCad and restart kibrary, or
              browse for a custom install location.
            </p>
            <button
              type="button"
              data-testid="kicad-browse"
              class="px-3 py-1 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 rounded text-xs font-semibold"
              onClick={browseForInstall}
            >
              Browse for your own…
            </button>
          </div>
        }
      >
        <Dropdown
          testId="kicad-install-select"
          value={data()!.active ?? ''}
          options={data()!.installs.map((ins) => ({
            value: ins.id,
            label: `${ins.type} ${ins.version} (${ins.kicad_bin})`,
          }))}
          onChange={(id) => setActive(id)}
          extraItem={{
            label: 'Browse for your own…',
            onSelect: browseForInstall,
            testId: 'kicad-browse',
          }}
        />
        <Show when={data()!.active}>
          <p class="text-xs text-zinc-500 dark:text-zinc-500 font-mono break-all">
            sym-lib-table: {data()!.installs.find((i) => i.id === data()!.active)?.sym_table}
          </p>
        </Show>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Check-for-updates card — Bug 10.
//
// Manual trigger for the same updater flow that runs automatically on app
// launch via UpdatePrompt. Three visible states:
//   - idle          : button + (after first run) "Up to date" / "Update found"
//   - checking      : button disabled, "Checking…"
//   - update found  : message + "Install now" button, click → install + restart
//   - error         : red text below button
// ---------------------------------------------------------------------------
type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; update: Update }
  | { kind: 'installing'; update: Update }
  | { kind: 'installed'; update: Update }
  | { kind: 'error'; message: string };

function UpdateCard() {
  const [status, setStatus] = createSignal<UpdateStatus>({ kind: 'idle' });

  const handleCheck = async () => {
    setStatus({ kind: 'checking' });
    try {
      const update = await checkForUpdate();
      if (update) {
        setStatus({ kind: 'available', update });
      } else {
        setStatus({ kind: 'up-to-date' });
      }
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleInstall = async () => {
    const s = status();
    if (s.kind !== 'available') return;
    setStatus({ kind: 'installing', update: s.update });
    try {
      await downloadAndInstall(s.update);
      setStatus({ kind: 'installed', update: s.update });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleQuit = async () => {
    try {
      await quitApp();
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div class="rounded border border-zinc-300 dark:border-zinc-700 p-3 space-y-2 text-sm">
      <h3 class="font-semibold">Updates</h3>
      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 rounded text-xs font-semibold disabled:opacity-50"
          onClick={handleCheck}
          disabled={status().kind === 'checking' || status().kind === 'installing'}
        >
          {status().kind === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>

        <Show when={status().kind === 'up-to-date'}>
          <span class="text-zinc-600 dark:text-zinc-400">
            You're up to date (v{__APP_VERSION__})
          </span>
        </Show>

        <Show when={status().kind === 'available'}>
          {(_) => {
            const s = status() as { kind: 'available'; update: Update };
            return (
              <>
                <span class="text-green-600 dark:text-green-400">
                  Update available: v{s.update.version}
                </span>
                <button
                  class="px-3 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-semibold"
                  onClick={handleInstall}
                >
                  Install now
                </button>
              </>
            );
          }}
        </Show>

        <Show when={status().kind === 'installing'}>
          <span class="text-zinc-600 dark:text-zinc-400">Installing…</span>
        </Show>

        <Show when={status().kind === 'installed'}>
          {(_) => {
            const s = status() as { kind: 'installed'; update: Update };
            return (
              <>
                <span class="text-green-600 dark:text-green-400">
                  v{s.update.version} installed. Quit and re-open Kibrary to apply.
                </span>
                <button
                  class="px-3 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-semibold"
                  onClick={handleQuit}
                >
                  Quit Kibrary
                </button>
              </>
            );
          }}
        </Show>
      </div>

      <Show when={status().kind === 'error'}>
        {(_) => {
          const s = status() as { kind: 'error'; message: string };
          return <p class="text-red-600 dark:text-red-400 text-xs">{s.message}</p>;
        }}
      </Show>
    </div>
  );
}

export default function RoomSettings() {
  const [data, { mutate }] = createResource(() =>
    invoke<{ settings: Settings }>('sidecar_call', { method: 'settings.get', params: {} })
  );

  const save = async (s: Settings) => {
    await invoke('sidecar_call', { method: 'settings.set', params: { settings: s } });
    mutate({ settings: s });
  };

  return (
    <Show when={data()}>{(d) => {
      const s = d().settings;
      return (
        <div class="max-w-xl space-y-4">
          <h2 class="text-xl">Settings</h2>
          <label class="block">
            <span class="text-sm">Theme</span>
            <Dropdown<Theme>
              testId="theme-select"
              value={theme()}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={(v) => setTheme(v)}
            />
          </label>
          <label class="block">
            <span class="text-sm text-zinc-600 dark:text-zinc-400">Concurrency</span>
            <input type="number" min="1" max="16" value={s.concurrency}
              class="block bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded mt-1"
              onChange={(e) => save({ ...s, concurrency: +e.currentTarget.value })}/>
          </label>
          <KiCadInstallCard />
          <VersionsCard />
          <UpdateCard />
        </div>
      );
    }}</Show>
  );
}
