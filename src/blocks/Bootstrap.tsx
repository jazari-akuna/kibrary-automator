/**
 * Bootstrap — shown when the sidecar is not reachable on app start.
 *
 * Renders an info screen explaining how to install `kibrary_sidecar` and
 * provides a "Re-detect" button (reloads the window so App.tsx re-queries
 * bootstrap_status).
 *
 * The "Install automatically" option calls `bootstrap_install_direct` on the
 * Rust side.  On success it shows a confirmation message and reloads; on error
 * it surfaces a real error toast so the user knows what went wrong.
 */

import { createSignal, Show, For, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InstallMode = 'auto' | 'manual' | 'specify';

interface BootstrapResult {
  python_path: string;
  sidecar_version: string;
}

interface BootstrapProgress {
  step: string;
  message: string;
}

interface Props {
  onResolved: () => void;
}

// ---------------------------------------------------------------------------
// OS detection helpers
// ---------------------------------------------------------------------------

function detectOS(): 'windows' | 'macos' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

function manualInstructions(): { intro: string; commands: string[]; note: string } {
  const os = detectOS();
  // The kibrary_sidecar wheel is not on PyPI — we ship it bundled inside
  // the app. Manual install means: install pipx (which manages an isolated
  // venv per package) and point it at the bundled wheel.
  if (os === 'windows') {
    return {
      intro: 'Run the following in PowerShell, then click Re-detect:',
      commands: [
        'py -m pip install --user pipx',
        'py -m pipx ensurepath',
        // Wheel ships inside the install. Default install dir on Windows is C:\Program Files\Kibrary\resources\
        'pipx install "C:\\Program Files\\Kibrary\\resources\\kibrary_sidecar-26.4.26a1-py3-none-any.whl"',
      ],
      note: 'pipx avoids "externally-managed environment" errors and keeps kibrary_sidecar isolated from your system Python.',
    };
  }
  if (os === 'macos') {
    return {
      intro: 'Run the following in Terminal, then click Re-detect:',
      commands: [
        'brew install pipx',
        'pipx install /Applications/Kibrary.app/Contents/Resources/resources/kibrary_sidecar-26.4.26a1-py3-none-any.whl',
      ],
      note: 'pipx isolates kibrary_sidecar in its own venv — required because macOS Homebrew Python is "externally managed" (PEP 668).',
    };
  }
  // Linux
  return {
    intro: 'Run the following in your terminal, then click Re-detect:',
    commands: [
      'sudo apt install -y pipx   # Debian/Ubuntu  —  or: sudo dnf install pipx (Fedora)',
      'pipx ensurepath',
      'pipx install /usr/lib/Kibrary/resources/kibrary_sidecar-26.4.26a1-py3-none-any.whl',
    ],
    note: 'pipx isolates kibrary_sidecar in its own venv — required because Ubuntu 24.04+ Python is "externally managed" (PEP 668), so plain `pip install` is rejected.',
  };
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function ManualPanel() {
  const m = manualInstructions();
  return (
    <div class="space-y-3">
      <p class="text-sm text-zinc-600">{m.intro}</p>
      <pre class="bg-zinc-100 rounded px-3 py-2 text-xs font-mono text-zinc-800 select-all whitespace-pre-wrap break-all">
        {m.commands.join('\n')}
      </pre>
      <p class="text-xs text-zinc-500">{m.note}</p>
    </div>
  );
}

function SpecifyPanel(props: {
  pythonPath: string;
  onPathChange: (p: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div class="space-y-2">
      <p class="text-sm text-zinc-600">
        Provide the path to a Python binary that has{' '}
        <code class="bg-zinc-100 px-1 rounded text-xs">kibrary_sidecar</code>{' '}
        installed:
      </p>
      <div class="flex gap-2">
        <input
          type="text"
          class="flex-1 border border-zinc-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          placeholder="/usr/bin/python3"
          value={props.pythonPath}
          onInput={(e) => props.onPathChange(e.currentTarget.value)}
        />
        <button
          class="px-3 py-1 bg-zinc-100 border border-zinc-300 rounded text-sm hover:bg-zinc-200"
          onClick={props.onBrowse}
        >
          Browse…
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Bootstrap(props: Props) {
  const [mode, setMode] = createSignal<InstallMode>('auto');
  const [pythonPath, setPythonPath] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal<string | null>(null);
  const [isError, setIsError] = createSignal(false);
  const [installedVersion, setInstalledVersion] = createSignal<string | null>(null);

  // Subscribe to live progress events emitted by bootstrap_install_direct.
  // The unlisten handle is cleaned up when this component is unmounted.
  let unlistenProgress: (() => void) | undefined;
  listen<BootstrapProgress>('bootstrap.progress', (event) => {
    setStatusMsg(event.payload.message);
    setIsError(false);
  }).then((unlisten) => {
    unlistenProgress = unlisten;
  });
  onCleanup(() => unlistenProgress?.());

  const options: { value: InstallMode; label: string; hint: string }[] = [
    {
      value: 'auto',
      label: 'Install automatically',
      hint: 'Recommended — installs the bundled wheel into a managed venv',
    },
    {
      value: 'manual',
      label: "I'll install it myself",
      hint: 'Shows the pip command; click Re-detect when done',
    },
    {
      value: 'specify',
      label: 'Specify a Python path',
      hint: 'Point to a Python binary that already has kibrary_sidecar installed',
    },
  ];

  const handleBrowse = async () => {
    try {
      // Use Tauri dialog plugin to pick a file
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: false, directory: false });
      if (typeof selected === 'string') setPythonPath(selected);
    } catch {
      // dialog plugin not available — let the user type manually
    }
  };

  const handlePrimary = async () => {
    setStatusMsg(null);
    setIsError(false);

    if (mode() === 'manual') {
      // Nothing to do — just reload so the detection runs again
      props.onResolved();
      return;
    }

    if (mode() === 'specify') {
      const p = pythonPath().trim();
      if (!p) {
        setStatusMsg('Please enter or browse to a Python path.');
        setIsError(true);
        return;
      }
      setBusy(true);
      setStatusMsg('Re-detecting with specified path…');
      try {
        await invoke('sidecar_call', {
          method: 'bootstrap.detect',
          params: { candidate_paths: [p] },
        });
        setStatusMsg('Sidecar found — reloading…');
        setTimeout(() => props.onResolved(), 800);
      } catch (e) {
        setStatusMsg(`Detection failed: ${e}`);
        setIsError(true);
      } finally {
        setBusy(false);
      }
      return;
    }

    // mode === 'auto'
    setBusy(true);
    setStatusMsg('Starting automatic install…');
    setInstalledVersion(null);
    try {
      // python_path defaults to 'python3'; the Rust side will use it to create
      // the venv.  wheel_filename is omitted so Rust auto-detects the bundled
      // wheel from the resource directory.
      const result = await invoke<BootstrapResult>('bootstrap_install_direct', {
        pythonPath: 'python3',
        wheelFilename: null,
      });
      setInstalledVersion(result.sidecar_version);
      // Cache the resolved python path as a localStorage hint (the canonical
      // cache is already written on disk by the Rust side).
      try {
        localStorage.setItem('kibrary.python_path', result.python_path);
      } catch {
        // localStorage may be unavailable in some Tauri configurations.
      }
      setStatusMsg(`Installed v${result.sidecar_version} — reloading…`);
      setIsError(false);
      setTimeout(() => props.onResolved(), 1200);
    } catch (e) {
      setStatusMsg(`Install failed: ${e}`);
      setIsError(true);
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel = () => {
    if (mode() === 'manual') return 'Re-detect';
    if (mode() === 'specify') return busy() ? 'Detecting…' : 'Re-detect';
    return busy() ? 'Installing…' : 'Install';
  };

  return (
    <div class="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">

        {/* Header */}
        <div class="bg-zinc-900 px-6 py-5">
          <h1 class="text-white text-lg font-bold">Kibrary needs a Python sidecar to run.</h1>
          <p class="text-zinc-400 text-sm mt-1">
            The sidecar provides all library management features. Choose how
            you'd like to install it.
          </p>
        </div>

        {/* Options */}
        <div class="px-6 pt-5 space-y-3">
          <For each={options}>
            {(opt) => (
              <label class="flex items-start gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="install-mode"
                  class="mt-1 accent-emerald-600"
                  value={opt.value}
                  checked={mode() === opt.value}
                  onChange={() => setMode(opt.value)}
                />
                <div>
                  <span class="text-sm font-medium text-zinc-800 group-hover:text-emerald-700">
                    {opt.label}
                  </span>
                  <p class="text-xs text-zinc-500 mt-0.5">{opt.hint}</p>
                </div>
              </label>
            )}
          </For>
        </div>

        {/* Detail panel for current mode */}
        <div class="px-6 py-4">
          <Show when={mode() === 'manual'}>
            <ManualPanel />
          </Show>
          <Show when={mode() === 'specify'}>
            <SpecifyPanel
              pythonPath={pythonPath()}
              onPathChange={setPythonPath}
              onBrowse={handleBrowse}
            />
          </Show>
        </div>

        {/* Status message */}
        <Show when={statusMsg()}>
          <div class={`mx-6 mb-2 px-3 py-2 rounded text-sm ${
            isError()
              ? 'bg-red-50 text-red-700 border border-red-200'
              : installedVersion()
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-blue-50 text-blue-700 border border-blue-200'
          }`}>
            {statusMsg()}
          </div>
        </Show>

        {/* Footer */}
        <div class="px-6 py-4 bg-zinc-50 border-t border-zinc-200 flex items-center justify-between">
          <a
            href="https://github.com/sagan/kibrary#installation"
            target="_blank"
            rel="noreferrer"
            class="text-xs text-zinc-400 underline hover:text-zinc-600"
          >
            View install docs
          </a>
          <button
            class="px-5 py-2 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-500 disabled:opacity-50 text-sm"
            disabled={busy()}
            onClick={handlePrimary}
          >
            {primaryLabel()}
          </button>
        </div>

      </div>
    </div>
  );
}
