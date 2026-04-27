/**
 * FirstRunWizard — three-pane modal shown on the first time a workspace is opened.
 *
 * Spec §9.2:
 *   Pane 1: Library workspace path (already picked — show with checkmark)
 *   Pane 2: Detect KiCad installs, user picks one or skips
 *   Pane 3: Git tracking options; optionally initialize git repo
 *
 * Dismissed by the "[Get started →]" button which calls dismissFirstRun().
 */

import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentWorkspace, dismissFirstRun } from '~/state/workspace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KiCadInstall {
  id: string;
  type: string;
  version: string;
  config_dir: string;
  sym_table: string;
  fp_table: string;
  kicad_bin: string | null;
  eeschema_bin: string | null;
  pcbnew_bin: string | null;
}

type GitChoice = 'auto' | 'manual' | 'disabled';

// ---------------------------------------------------------------------------
// Pane 1: Workspace path
// ---------------------------------------------------------------------------

function PaneWorkspace() {
  const ws = currentWorkspace();
  return (
    <div class="space-y-2">
      <h3 class="font-semibold text-zinc-800 flex items-center gap-2">
        <span class="text-green-600">&#10003;</span>
        Pick library workspace
      </h3>
      <p class="text-sm text-zinc-500 break-all">{ws?.root ?? '—'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pane 2: KiCad detection
// ---------------------------------------------------------------------------

function PaneKiCad(props: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [installs] = createResource<KiCadInstall[]>(() =>
    invoke<{ installs: KiCadInstall[] }>('sidecar_call', {
      method: 'kicad.detect',
      params: {},
    }).then((r) => r.installs ?? [])
  );

  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  // Auto-select the first detected install once the resource resolves, but
  // only if the user hasn't already made a choice. This prevents the user
  // from being stuck on a "Get started" button that *looks* enabled but
  // would skip past KiCad entirely.
  createEffect(() => {
    const list = installs();
    if (!list || list.length === 0) return;
    if (props.selected != null) return;
    void save(list[0].id);
  });

  const save = async (id: string | null) => {
    props.onSelect(id);
    const ws = currentWorkspace();
    if (!ws) return;
    setSaving(true);
    try {
      const settings = { ...ws.settings, kicad_target: id };
      await invoke('sidecar_call', {
        method: 'workspace.set_settings',
        params: { root: ws.root, settings },
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="space-y-3">
      <h3 class="font-semibold text-zinc-800">Detect KiCad install</h3>
      <Show
        when={!installs.loading}
        fallback={<p class="text-sm text-zinc-400">Detecting…</p>}
      >
        <Show
          when={(installs() ?? []).length > 0}
          fallback={<p class="text-sm text-zinc-400">No KiCad installs found.</p>}
        >
          <ul class="space-y-1">
            <For each={installs() ?? []}>
              {(inst) => (
                <li>
                  <label class="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="kicad-install"
                      value={inst.id}
                      checked={props.selected === inst.id}
                      onChange={() => save(inst.id)}
                    />
                    <span class="font-medium text-zinc-700">{inst.version}</span>
                    <span class="text-zinc-400 text-xs">{inst.type}</span>
                    <span class="text-zinc-400 text-xs truncate max-w-xs">{inst.config_dir}</span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <button
          class="text-xs text-zinc-400 underline hover:text-zinc-600 disabled:opacity-50"
          disabled={saving()}
          onClick={() => save(null)}
        >
          Skip
        </button>
        <Show when={saved() && !saving()}>
          <span class="text-xs text-green-600 ml-2">Saved</span>
        </Show>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pane 3: Git tracking
// ---------------------------------------------------------------------------

function PaneGit(props: {
  choice: GitChoice;
  onChoice: (c: GitChoice) => void;
}) {
  const ws = currentWorkspace();
  const [initBusy, setInitBusy] = createSignal(false);
  const [initDone, setInitDone] = createSignal(false);
  const [initErr, setInitErr] = createSignal<string | null>(null);

  const options: { value: GitChoice; label: string }[] = [
    { value: 'auto',     label: 'Auto-commit each save' },
    { value: 'manual',   label: 'Track but commit manually' },
    { value: 'disabled', label: 'Disable git tracking' },
  ];

  const initRepo = async () => {
    if (!ws) return;
    setInitBusy(true);
    setInitErr(null);
    try {
      await invoke('sidecar_call', { method: 'git.init', params: { workspace: ws.root } });
      setInitDone(true);
    } catch (e) {
      setInitErr(String(e));
    } finally {
      setInitBusy(false);
    }
  };

  return (
    <div class="space-y-3">
      <h3 class="font-semibold text-zinc-800">Git tracking</h3>
      <ul class="space-y-1">
        <For each={options}>
          {(opt) => (
            <li>
              <label class="flex items-center gap-2 cursor-pointer text-sm text-zinc-700">
                <input
                  type="radio"
                  name="git-choice"
                  value={opt.value}
                  checked={props.choice === opt.value}
                  onChange={() => props.onChoice(opt.value)}
                />
                {opt.label}
              </label>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.choice !== 'disabled' && !initDone()}>
        <div class="flex items-center gap-3 pt-1">
          <button
            class="px-3 py-1 bg-zinc-700 text-white text-xs rounded hover:bg-zinc-600 disabled:opacity-50"
            onClick={initRepo}
            disabled={initBusy()}
          >
            {initBusy() ? 'Initialising…' : 'Initialize git repo'}
          </button>
          <span class="text-xs text-zinc-400">
            (runs <code>git init</code> if not already a repo)
          </span>
        </div>
      </Show>
      <Show when={initDone()}>
        <p class="text-xs text-green-600">Git repo initialised.</p>
      </Show>
      <Show when={initErr()}>
        <p class="text-xs text-red-500">{initErr()}</p>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard component
// ---------------------------------------------------------------------------

export default function FirstRunWizard() {
  const [kicadSelected, setKicadSelected] = createSignal<string | null>(null);
  const [gitChoice, setGitChoice] = createSignal<GitChoice>('auto');
  const [finishing, setFinishing] = createSignal(false);

  const handleGetStarted = async () => {
    const ws = currentWorkspace();
    if (!ws) { dismissFirstRun(); return; }

    setFinishing(true);
    try {
      const enabled = gitChoice() !== 'disabled';
      const autoCommit = gitChoice() === 'auto';
      const settings = {
        ...ws.settings,
        git: {
          ...(ws.settings?.git ?? {}),
          enabled,
          auto_commit: autoCommit,
        },
      };
      await invoke('sidecar_call', {
        method: 'workspace.set_settings',
        params: { root: ws.root, settings },
      });
    } catch {
      // Best effort — don't block the user from closing the wizard
    } finally {
      setFinishing(false);
      dismissFirstRun();
    }
  };

  return (
    // Backdrop
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      {/* Card */}
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div class="bg-zinc-900 px-6 py-4">
          <h2 class="text-white text-lg font-bold">Welcome to Kibrary</h2>
          <p class="text-zinc-400 text-sm mt-0.5">Let's get you set up in three quick steps.</p>
        </div>

        {/* Panes */}
        <div class="px-6 py-5 space-y-6 divide-y divide-zinc-100">
          <PaneWorkspace />
          <div class="pt-5">
            <PaneKiCad selected={kicadSelected()} onSelect={setKicadSelected} />
          </div>
          <div class="pt-5">
            <PaneGit choice={gitChoice()} onChoice={setGitChoice} />
          </div>
        </div>

        {/* Footer */}
        <div class="px-6 py-4 bg-zinc-50 flex justify-end border-t border-zinc-200">
          <button
            class="px-5 py-2 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-500 disabled:opacity-50 text-sm"
            onClick={handleGetStarted}
            disabled={finishing()}
          >
            {finishing() ? 'Saving…' : 'Get started →'}
          </button>
        </div>
      </div>
    </div>
  );
}
