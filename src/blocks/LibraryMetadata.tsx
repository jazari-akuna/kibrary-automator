/**
 * LibraryMetadata — form for editing a library's metadata.json.
 *
 * Props:
 *   libDir   — absolute path to the library folder on disk
 *   libName  — human-readable library name (derived from folder name; read-only)
 *   metadata — pre-loaded metadata dict (caller is responsible for the read path)
 *   onSaved? — optional callback invoked after a successful save
 *
 * TODO(read-path): once `library.get_metadata` RPC is wired in methods.py,
 *   replace the caller-supplied `metadata` prop with an internal
 *   `createResource(() => invoke('sidecar_call', { method: 'library.get_metadata',
 *     params: { lib_dir: props.libDir } }))` and remove the prop.
 *
 * Save path: calls `library.update_metadata` RPC with the full merged metadata object.
 */

import { createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VersionEntry {
  version: string;
  date?: string;
  notes?: string;
}

interface MetadataAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/** Shape of metadata.json (all fields optional to handle missing/partial files). */
interface LibraryMetadataShape {
  name?: string;
  description?: string;
  license?: string;
  author?: MetadataAuthor;
  maintainer?: MetadataAuthor;
  versions?: VersionEntry[];
  [key: string]: unknown;
}

export interface LibraryMetadataProps {
  libDir: string;
  libName: string;
  /** Pre-loaded metadata.json contents passed in by the caller. May be partial or {}. */
  metadata: LibraryMetadataShape;
  onSaved?: () => void;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Parse a semver string into [major, minor, patch], defaulting missing parts to 0. */
function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function formatSemver(major: number, minor: number, patch: number): string {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(current: string, kind: 'major' | 'minor' | 'patch'): string {
  const [major, minor, patch] = parseSemver(current);
  if (kind === 'major') return formatSemver(major + 1, 0, 0);
  if (kind === 'minor') return formatSemver(major, minor + 1, 0);
  return formatSemver(major, minor, patch + 1);
}

type SaveStatus = 'idle' | 'saving' | 'saved' | { error: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LibraryMetadata(props: LibraryMetadataProps) {
  const meta = props.metadata ?? {};

  // Derive the latest version string from the versions array, fallback to '0.1.0'.
  const latestVersion = (): string => {
    const versions = meta.versions;
    if (Array.isArray(versions) && versions.length > 0) {
      return versions[versions.length - 1]?.version ?? '0.1.0';
    }
    return '0.1.0';
  };

  const [description, setDescription] = createSignal<string>(meta.description ?? '');
  const [license, setLicense] = createSignal<string>(meta.license ?? 'CC-BY-SA-4.0');
  const [authorName, setAuthorName] = createSignal<string>(meta.author?.name ?? '');
  const [maintainerName, setMaintainerName] = createSignal<string>(meta.maintainer?.name ?? '');
  const [version, setVersion] = createSignal<string>(latestVersion());
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>('idle');

  const bump = (kind: 'major' | 'minor' | 'patch') => {
    setVersion((v) => bumpVersion(v, kind));
  };

  const buildMetadata = (): LibraryMetadataShape => {
    // Start from the incoming metadata to preserve unknown fields.
    const base = { ...meta };

    base.name = props.libName;
    base.description = description();
    base.license = license();
    base.author = { ...(meta.author ?? {}), name: authorName() };
    base.maintainer = { ...(meta.maintainer ?? {}), name: maintainerName() };

    // Update the last versions entry (or create one) with the current version string.
    const existingVersions: VersionEntry[] = Array.isArray(meta.versions)
      ? [...meta.versions]
      : [];

    const today = new Date().toISOString().slice(0, 10);
    if (existingVersions.length === 0) {
      existingVersions.push({ version: version(), date: today });
    } else {
      existingVersions[existingVersions.length - 1] = {
        ...existingVersions[existingVersions.length - 1],
        version: version(),
      };
    }
    base.versions = existingVersions;

    return base;
  };

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      await invoke('sidecar_call', {
        method: 'library.update_metadata',
        params: {
          lib_dir: props.libDir,
          metadata: buildMetadata(),
        },
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
      props.onSaved?.();
    } catch (e) {
      setSaveStatus({ error: String(e) });
    }
  };

  const statusText = (): string => {
    const s = saveStatus();
    if (s === 'saving') return 'Saving…';
    if (s === 'saved') return 'Saved ✓';
    if (typeof s === 'object' && 'error' in s) return `Save failed: ${s.error}`;
    return '';
  };

  return (
    <div class="space-y-4 max-w-xl">
      {/* Header */}
      <div class="flex items-center justify-between">
        <h2 class="text-base font-medium text-zinc-200">Library Metadata</h2>
        <Show when={statusText()}>
          <span
            class={`text-xs ${
              typeof saveStatus() === 'object' ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {statusText()}
          </span>
        </Show>
      </div>

      {/* Name (read-only) */}
      <label class="block">
        <span class="text-sm text-zinc-400">Name</span>
        <input
          type="text"
          value={props.libName}
          disabled
          class="block w-full bg-zinc-900 px-2 py-1 rounded mt-1 text-sm text-zinc-500 cursor-not-allowed"
        />
      </label>

      {/* Description */}
      <label class="block">
        <span class="text-sm text-zinc-400">Description</span>
        <input
          type="text"
          value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)}
          class="block w-full bg-zinc-800 px-2 py-1 rounded mt-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        />
      </label>

      {/* License */}
      <label class="block">
        <span class="text-sm text-zinc-400">License</span>
        <input
          type="text"
          value={license()}
          onInput={(e) => setLicense(e.currentTarget.value)}
          class="block w-full bg-zinc-800 px-2 py-1 rounded mt-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        />
      </label>

      {/* Author */}
      <label class="block">
        <span class="text-sm text-zinc-400">Author</span>
        <input
          type="text"
          value={authorName()}
          onInput={(e) => setAuthorName(e.currentTarget.value)}
          placeholder="Author name"
          class="block w-full bg-zinc-800 px-2 py-1 rounded mt-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        />
      </label>

      {/* Maintainer */}
      <label class="block">
        <span class="text-sm text-zinc-400">Maintainer</span>
        <input
          type="text"
          value={maintainerName()}
          onInput={(e) => setMaintainerName(e.currentTarget.value)}
          placeholder="Maintainer name"
          class="block w-full bg-zinc-800 px-2 py-1 rounded mt-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        />
      </label>

      {/* Version */}
      <div>
        <span class="text-sm text-zinc-400">Version</span>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-sm font-mono text-zinc-100 bg-zinc-800 px-2 py-1 rounded min-w-[80px] text-center">
            {version()}
          </span>
          <button
            type="button"
            onClick={() => bump('patch')}
            class="px-2 py-1 bg-zinc-700 rounded text-xs hover:bg-zinc-600"
            title="Bump patch (x.y.Z)"
          >
            +patch
          </button>
          <button
            type="button"
            onClick={() => bump('minor')}
            class="px-2 py-1 bg-zinc-700 rounded text-xs hover:bg-zinc-600"
            title="Bump minor (x.Y.0)"
          >
            +minor
          </button>
          <button
            type="button"
            onClick={() => bump('major')}
            class="px-2 py-1 bg-zinc-700 rounded text-xs hover:bg-zinc-600"
            title="Bump major (X.0.0)"
          >
            +major
          </button>
        </div>
      </div>

      {/* Save */}
      <button
        type="button"
        onClick={handleSave}
        disabled={saveStatus() === 'saving'}
        class="px-4 py-1.5 bg-emerald-600 rounded text-sm hover:bg-emerald-500 disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}
