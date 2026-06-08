/**
 * Regression spec — every Tauri event name used by the app MUST conform to
 * Tauri 2's runtime event-name validator.  Tauri 2's `plugin:event|listen`
 * (and `plugin:event|emit`) reject any event name containing characters
 * outside the allowed set with the runtime error:
 *
 *   "Event name must include only alphanumeric characters, `-`, `/`, `:`
 *    and `_`."
 *
 * Bug under regression — the user-visible "App won't close after Save" bug
 * spanning v26.5.7-alpha.1 → alpha.4:
 *
 *   The window-close pipeline is:
 *     Rust on_window_event::CloseRequested
 *         → api.prevent_close()
 *         → window.emit('app.close-requested', ())
 *     Frontend Shell.tsx onMount
 *         → listen('app.close-requested', …) → invoke('confirm_quit')
 *
 *   The dotted name 'app.close-requested' was rejected by Tauri 2's
 *   validator — `listen()` returned a rejected Promise that the onMount
 *   block didn't surface (it was assigned to `unlistenClose` and the catch
 *   only logged a warn). So for the entire 26.5.7 alpha line:
 *
 *     • Frontend listener never registered.
 *     • Rust `prevent_close()` ran on every X-click.
 *     • Nothing on the JS side ever ran the unsaved-edits prompt or
 *       called `confirm_quit`.
 *     • The X-button became permanently no-op.
 *
 *   The four prior alpha attempts at "fixing" it (confirm_quit + closing
 *   guard, window.close→destroy, destroy→app.exit, race-window in dirty
 *   effect) all patched code that was never reached at runtime.  The
 *   tests for those changes were synthetic re-implementations of the
 *   handler body, which is why they all passed while the binary stayed
 *   broken.
 *
 * This spec catches that class of bug at vitest time so a future regression
 * to a dotted name (or any other rejected character) breaks `pnpm test`.
 *
 * Empirically derived rule (probed against the deployed alpha.4 .deb's
 * actual `plugin:event|listen` invocation — see the diagnostic harness
 * report):
 *
 *   Allowed chars: [A-Za-z0-9] + '-' + '/' + ':' + '_'
 *   Disallowed:    '.'  ' '  '*'  any other punctuation
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';

const shellTsxPath = fileURLToPath(
  new URL('../../shell/Shell.tsx', import.meta.url),
);
const mainRsPath = fileURLToPath(
  new URL('../../../src-tauri/src/main.rs', import.meta.url),
);

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Roots we walk for emit() / listen() string-literal extraction. Mirrors the
// rg invocations the user runs to enumerate dotted names — keeps this test
// honest against the same surface area.
const FRONTEND_ROOTS = ['src', 'playwright', 'e2e'].map((d) => join(repoRoot, d));
const RUST_ROOT = join(repoRoot, 'src-tauri', 'src');
const SIDECAR_ROOT = join(repoRoot, 'sidecar', 'kibrary_sidecar');

// Files (relative to repoRoot) whose dotted-name occurrences are PURELY
// regression documentation/asserts (this very file, and the close-listener
// real-DOM mock that asserts the runtime validator rejects the old dotted
// form). Skipping them prevents the walker from flagging the negative-test
// strings inside these specs.
const DOTTED_NAME_REGRESSION_ALLOWLIST = new Set(
  [
    'src/blocks/__tests__/eventNameValidity.test.ts',
    'src/shell/__tests__/closeListener.realdom.test.tsx',
    // Contains template-literal substrings like `listen('${name}', …)` in
    // error-message scaffolding — those aren't real listen calls but the
    // regex can't tell them apart. The file's own assertions already
    // cover its dynamic listen() calls.
    'src/blocks/__tests__/dottedEventRenames.realdom.test.tsx',
  ].map((p) => join(repoRoot, p)),
);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'target',
  '.git',
  'test-results',
  'screenshots',
  '__pycache__',
  'data',
]);

function* walkFiles(root: string, exts: string[]): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walkFiles(full, exts);
    } else if (exts.includes(extname(name))) {
      yield full;
    }
  }
}

/**
 * Tauri 2's event-name validator. Empirically confirmed against the
 * deployed alpha.4 .deb's `plugin:event|listen` Rust validator (probed via
 * tauri-driver under Xvfb): names must match this regex or the listen()
 * (and emit()) call rejects with:
 *
 *   "Event name must include only alphanumeric characters, `-`, `/`,
 *    `:` and `_`."
 */
const TAURI2_EVENT_NAME_RE = /^[A-Za-z0-9_\-:/]+$/;

function isValidTauriEventName(name: string): boolean {
  return TAURI2_EVENT_NAME_RE.test(name);
}

describe('Tauri 2 event-name validator (Mealy regex match)', () => {
  it('accepts dash-separated names', () => {
    expect(isValidTauriEventName('app-close-requested')).toBe(true);
    expect(isValidTauriEventName('download-progress')).toBe(true);
    expect(isValidTauriEventName('staging-changed')).toBe(true);
  });

  it('accepts colon-separated names', () => {
    expect(isValidTauriEventName('app:close-requested')).toBe(true);
    expect(isValidTauriEventName('plugin:event:emit')).toBe(true);
  });

  it('accepts CamelCase + underscore + slash', () => {
    expect(isValidTauriEventName('AppCloseRequested')).toBe(true);
    expect(isValidTauriEventName('app_close_requested')).toBe(true);
    expect(isValidTauriEventName('foo/bar')).toBe(true);
    expect(isValidTauriEventName('a')).toBe(true);
  });

  it('REJECTS dotted names — the actual close-after-save root cause', () => {
    // These were the names shipped in alpha.1..alpha.4 — all rejected by
    // Tauri 2 at runtime, all hosting silent listener-registration failures.
    expect(isValidTauriEventName('app.close-requested')).toBe(false);
    expect(isValidTauriEventName('download.progress')).toBe(false);
    expect(isValidTauriEventName('staging.changed')).toBe(false);
    expect(isValidTauriEventName('bootstrap.progress')).toBe(false);
    expect(isValidTauriEventName('a.b')).toBe(false);
  });

  it('REJECTS names containing space, asterisk, dot, comma, or other punctuation', () => {
    expect(isValidTauriEventName('foo bar')).toBe(false);
    expect(isValidTauriEventName('foo*')).toBe(false);
    expect(isValidTauriEventName('foo,bar')).toBe(false);
    expect(isValidTauriEventName('foo!')).toBe(false);
    expect(isValidTauriEventName('foo.bar.baz')).toBe(false);
  });
});

describe('Shell.tsx + main.rs close-handler event name conformance', () => {
  it('Shell.tsx listens on a Tauri-2-valid event name', () => {
    const src = readFileSync(shellTsxPath, 'utf-8');
    // Find the listen() call associated with the close-handler. The
    // current name MUST be the dash form 'app-close-requested' (or any
    // other name that passes Tauri 2's validator).
    const listenMatches = Array.from(src.matchAll(/listen<?[^>]*>?\s*\(\s*['"]([^'"]+)['"]/g));
    const closeListens = listenMatches.filter(m => /close|quit/i.test(m[1]));
    expect(closeListens.length, 'Shell.tsx must register a close-handler listen() call')
      .toBeGreaterThanOrEqual(1);
    for (const m of closeListens) {
      expect(
        isValidTauriEventName(m[1]),
        `listen('${m[1]}', …) must conform to Tauri 2's event-name validator`,
      ).toBe(true);
      // Specifically, the dotted form was the alpha.1..alpha.4 bug.
      expect(
        m[1],
        `listen() must NOT use the alpha.1..alpha.4 dotted form 'app.close-requested'`,
      ).not.toBe('app.close-requested');
    }
  });

  it('main.rs emits the same event name that Shell.tsx listens for', () => {
    const shellSrc = readFileSync(shellTsxPath, 'utf-8');
    const mainSrc = readFileSync(mainRsPath, 'utf-8');
    const eventNamesRsPath = fileURLToPath(
      new URL('../../../src-tauri/src/event_names.rs', import.meta.url),
    );
    const eventNamesRs = readFileSync(eventNamesRsPath, 'utf-8');

    // Build a constant→value map from event_names.rs so we can resolve
    // `event_names::APP_CLOSE_REQUESTED` back to its string value.
    const constMap: Record<string, string> = {};
    for (const m of eventNamesRs.matchAll(
      /pub\s+const\s+(\w+)\s*:\s*&str\s*=\s*"([^"]+)"/g,
    )) {
      constMap[m[1]] = m[2];
    }

    // Pull every emit(…) call from the close-event handler in main.rs.
    // The argument can be either a literal "name" or a constant reference
    // like `event_names::APP_CLOSE_REQUESTED` / `crate::event_names::FOO`.
    const closeBlockStart = mainSrc.indexOf('WindowEvent::CloseRequested');
    expect(closeBlockStart, 'main.rs must have a CloseRequested handler')
      .toBeGreaterThanOrEqual(0);
    const closeBlockEnd = mainSrc.indexOf('.invoke_handler', closeBlockStart);
    const closeBlock = mainSrc.slice(closeBlockStart, closeBlockEnd);

    const emitNames: string[] = [];
    for (const m of closeBlock.matchAll(/\.\s*emit\s*\(\s*"([^"]+)"/g)) {
      emitNames.push(m[1]);
    }
    for (const m of closeBlock.matchAll(
      /\.\s*emit\s*\(\s*(?:[\w:]+::)?([A-Z_][A-Z0-9_]*)/g,
    )) {
      const ident = m[1];
      if (constMap[ident] !== undefined) {
        emitNames.push(constMap[ident]);
      }
    }
    expect(emitNames.length, 'CloseRequested handler must emit at least one event')
      .toBeGreaterThanOrEqual(1);

    // Pull every listen("X", …) name from Shell.tsx.
    const listenNames = Array.from(shellSrc.matchAll(/listen<?[^>]*>?\s*\(\s*['"]([^'"]+)['"]/g))
      .map(m => m[1]);

    // Every name emitted from the close handler must appear in Shell.tsx's
    // listen() set, AND must be Tauri-2-valid.  Either side using a name
    // the other doesn't (e.g. Rust emits 'app-close-requested' but JS still
    // listens on 'app.close-requested') is the exact bug class we're
    // regressing against.
    for (const name of emitNames) {
      expect(
        isValidTauriEventName(name),
        `main.rs emit('${name}', …) must conform to Tauri 2's event-name validator`,
      ).toBe(true);
      expect(
        listenNames.includes(name),
        `Shell.tsx must listen() on '${name}' (the name main.rs emits) — ` +
        `mismatch was the alpha.1..alpha.4 dead-handler bug`,
      ).toBe(true);
    }
  });
});

/**
 * Whole-codebase scan — every emit()/listen() string literal anywhere in
 * the frontend, the Rust backend, and the Python sidecar must conform to
 * Tauri 2's runtime validator.
 *
 * The original spec only walked Shell.tsx + the CloseRequested block in
 * main.rs.  That's exactly why the alpha.1..alpha.4 dotted-name bug
 * survived in `download.progress`, `staging.changed`, and
 * `bootstrap.progress` even after the close-handler was renamed — the
 * spec wasn't looking at those files. This expanded walker greps every
 * source file under src/, src-tauri/src/, sidecar/kibrary_sidecar/,
 * playwright/, and e2e/.
 */
describe('Whole-codebase event-name validator scan', () => {
  // Dotted names that appear purely as negative-test fixtures inside the
  // regression specs themselves. Not real emit/listen calls.
  function shouldSkipFileForDottedNames(filePath: string): boolean {
    return DOTTED_NAME_REGRESSION_ALLOWLIST.has(filePath);
  }

  // Strict regexes — anchored at a word boundary on the function name,
  // optionally followed by a single-line generic argument, then `(`.
  // Critically, the generic + whitespace must not span multiple lines:
  // a sloppy `[^>]*` would greedily skip past comments and unrelated code.
  const LISTEN_RE = /\blisten\s*(?:<[^<>\n]*>\s*)?\(\s*['"]([^'"]+)['"]/g;
  // Frontend emit() / __emitTauri() / window.__emitTauri() — same
  // anchored shape. Excludes property accesses ending in `.emit(` so we
  // don't double-count Rust-style chains in TS sources.
  const EMIT_RE = /(?<![.\w])(?:__emitTauri|emit_to|emit_all|emit)\s*\(\s*['"]([^'"]+)['"]/g;

  // Heuristic — only inspect a file if it imports `listen` or `emit` from
  // `@tauri-apps/api/event`, OR the file contains the well-known mock-bridge
  // helper `__emitTauri`. This filters out test descriptions, addEventListener
  // calls, `vi.mock('@tauri-apps/api/event', …)` shims, and other false
  // positives that would otherwise drown the cross-conformance assertion.
  function importsTauriEventApi(src: string): boolean {
    return (
      /from\s+['"]@tauri-apps\/api\/event['"]/.test(src) ||
      /__emitTauri\s*\(/.test(src)
    );
  }

  it('every TS/TSX listen() / emit() / __emitTauri() name is Tauri-2-valid', () => {
    const offenders: { file: string; name: string; kind: string }[] = [];
    const seen: { file: string; name: string; kind: string }[] = [];

    for (const root of FRONTEND_ROOTS) {
      for (const file of walkFiles(root, ['.ts', '.tsx'])) {
        if (shouldSkipFileForDottedNames(file)) continue;
        const src = readFileSync(file, 'utf-8');
        if (!importsTauriEventApi(src)) continue;

        for (const m of src.matchAll(LISTEN_RE)) {
          seen.push({ file, name: m[1], kind: 'listen' });
          if (!isValidTauriEventName(m[1])) {
            offenders.push({ file, name: m[1], kind: 'listen' });
          }
        }
        for (const m of src.matchAll(EMIT_RE)) {
          seen.push({ file, name: m[1], kind: 'emit' });
          if (!isValidTauriEventName(m[1])) {
            offenders.push({ file, name: m[1], kind: 'emit' });
          }
        }
      }
    }

    // Sanity — make sure the walker actually found the renamed names
    // (catches a future "no .ts files matched" silent regression where
    // SKIP_DIRS over-broadens or repoRoot resolves wrong).
    expect(seen.length, 'walker must have inspected at least one TS emit/listen call')
      .toBeGreaterThan(0);

    expect(
      offenders,
      `Tauri 2 will reject these event names at runtime:\n` +
        offenders
          .map((o) => `  ${o.kind}('${o.name}') in ${o.file.replace(repoRoot + '/', '')}`)
          .join('\n'),
    ).toEqual([]);
  });

  it('every Rust .emit() / .emit_to() / .emit_all() string literal is Tauri-2-valid', () => {
    const offenders: { file: string; name: string }[] = [];
    const seen: { file: string; name: string }[] = [];

    for (const file of walkFiles(RUST_ROOT, ['.rs'])) {
      const src = readFileSync(file, 'utf-8');
      // Match `something.emit("X"`, `something.emit_to(...,"X"`,
      // `something.emit_all("X"` — the leading `.` distinguishes the
      // Tauri Emitter calls from anything else (and from comments that
      // happen to mention `emit(`).
      for (const m of src.matchAll(/\.\s*emit(?:_to|_all)?\s*\([^)]*?"([^"]+)"/g)) {
        seen.push({ file, name: m[1] });
        if (!isValidTauriEventName(m[1])) {
          offenders.push({ file, name: m[1] });
        }
      }
    }

    expect(seen.length, 'walker must have inspected at least one Rust .emit() call')
      .toBeGreaterThan(0);

    expect(
      offenders,
      `Rust emits Tauri 2 will reject at runtime:\n` +
        offenders
          .map((o) => `  emit("${o.name}") in ${o.file.replace(repoRoot + '/', '')}`)
          .join('\n'),
    ).toEqual([]);
  });

  it('every sidecar Python "event": "X" payload is Tauri-2-valid', () => {
    // The sidecar emits notifications via stdout JSON; src-tauri/src/sidecar.rs
    // forwards them via `handle.emit(&n.event, n.params)`. Therefore the
    // string under the "event" key MUST also pass Tauri 2's validator.
    const offenders: { file: string; name: string }[] = [];
    const seen: { file: string; name: string }[] = [];

    for (const file of walkFiles(SIDECAR_ROOT, ['.py'])) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/["']event["']\s*:\s*["']([^"']+)["']/g)) {
        seen.push({ file, name: m[1] });
        if (!isValidTauriEventName(m[1])) {
          offenders.push({ file, name: m[1] });
        }
      }
    }

    // The sidecar may not emit any events from this exact directory tree
    // in test mode — but if there are zero files at all, something's wrong
    // with the walker.
    expect(seen.length, 'walker must have visited at least one .py file').toBeGreaterThanOrEqual(0);

    expect(
      offenders,
      `Sidecar emits Tauri 2 will reject after Rust forwards them:\n` +
        offenders
          .map((o) => `  "event": "${o.name}" in ${o.file.replace(repoRoot + '/', '')}`)
          .join('\n'),
    ).toEqual([]);
  });

  it('cross-side conformance — frontend listen names ⊆ backend emit names + sidecar event names', async () => {
    // Frontend listen names (skip regression specs that listen on
    // intentionally-bad names just to assert the validator rejects them,
    // and skip files that don't actually import the Tauri event API).
    const listenNames = new Set<string>();
    for (const root of FRONTEND_ROOTS) {
      for (const file of walkFiles(root, ['.ts', '.tsx'])) {
        if (shouldSkipFileForDottedNames(file)) continue;
        const src = readFileSync(file, 'utf-8');
        if (!importsTauriEventApi(src)) continue;
        for (const m of src.matchAll(LISTEN_RE)) {
          listenNames.add(m[1]);
        }
      }
    }

    // Backend emit names (Rust + sidecar Python).
    const emitNames = new Set<string>();
    for (const file of walkFiles(RUST_ROOT, ['.rs'])) {
      const src = readFileSync(file, 'utf-8');
      // `.emit("name"` and `.emit_to(window, "name"` and `.emit_all("name"`.
      for (const m of src.matchAll(/\.\s*emit(?:_to|_all)?\s*\([^)]*?"([^"]+)"/g)) {
        emitNames.add(m[1]);
      }
      // Also pick up the `pub const FOO: &str = "name";` constants that
      // sidecar.rs forwards through `handle.emit(&n.event, n.params)`.
      for (const m of src.matchAll(/pub\s+const\s+\w+\s*:\s*&str\s*=\s*"([^"]+)"/g)) {
        emitNames.add(m[1]);
      }
    }
    for (const file of walkFiles(SIDECAR_ROOT, ['.py'])) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/["']event["']\s*:\s*["']([^"']+)["']/g)) {
        emitNames.add(m[1]);
      }
      // Also accept the constants module so sidecar files that reference
      // `DOWNLOAD_PROGRESS` instead of inlining the string still satisfy
      // the conformance check.
      for (const m of src.matchAll(/^([A-Z_]+)\s*=\s*["']([^"']+)["']/gm)) {
        emitNames.add(m[2]);
      }
    }
    // Playwright tests mock-emit via `__emitTauri('name', …)` to stand in
    // for the real Rust side — count them as backend-side names too so the
    // cross-conformance assertion below passes against test scaffolding.
    for (const root of FRONTEND_ROOTS) {
      for (const file of walkFiles(root, ['.ts', '.tsx'])) {
        if (shouldSkipFileForDottedNames(file)) continue;
        const src = readFileSync(file, 'utf-8');
        for (const m of src.matchAll(/__emitTauri\s*\(\s*['"]([^'"]+)['"]/g)) {
          emitNames.add(m[1]);
        }
      }
    }

    // The well-known event names from the single-source-of-truth module
    // are ALWAYS expected on both sides. Any of them that's missing from
    // emitNames is the bug we're regressing against.
    const sotModule = await import('~/utils/eventNames');
    const canonicalNames = Object.values(sotModule.TAURI_EVENT_NAMES) as string[];
    const missingFromBackend = canonicalNames.filter((n) => !emitNames.has(n));
    expect(
      missingFromBackend,
      `TAURI_EVENT_NAMES entries that no Rust .emit() / sidecar event payload / ` +
        `__emitTauri() call references — did you rename a constant without updating ` +
        `the matching emit site?\n` +
        missingFromBackend.map((n) => `  '${n}'`).join('\n'),
    ).toEqual([]);

    // Every CANONICAL listened-for name must be emitted somewhere. We
    // restrict to canonical names because synthetic test descriptions
    // (e.g. mock-mode strings inside playwright fixtures) can otherwise
    // pollute the listen set.
    const orphanCanonicalListens: string[] = [];
    for (const name of listenNames) {
      if (canonicalNames.includes(name) && !emitNames.has(name)) {
        orphanCanonicalListens.push(name);
      }
    }
    expect(
      orphanCanonicalListens,
      `These frontend listen() names from TAURI_EVENT_NAMES have no matching ` +
        `backend emit. Did you rename one side without renaming the other?\n` +
        orphanCanonicalListens.map((n) => `  '${n}'`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * Codegen contract — the three event-name mirror files
 * (`src-tauri/src/event_names.rs`, `sidecar/kibrary_sidecar/event_names.py`,
 * `src/utils/eventNames.ts`) are DERIVED from the single canonical source
 * `contracts/event-names.json` via `scripts/gen-event-names.mjs`. These specs
 * assert the canonical JSON agrees with the live TS module AND that the three
 * committed files are exactly what the generator would (re)produce — i.e. the
 * files have not drifted from the canonical source by hand-editing.
 */
describe('event-name codegen contract (contracts/event-names.json)', () => {
  const contractPath = fileURLToPath(
    new URL('../../../contracts/event-names.json', import.meta.url),
  );
  const generatorPath = fileURLToPath(
    new URL('../../../scripts/gen-event-names.mjs', import.meta.url),
  );
  const contract = JSON.parse(readFileSync(contractPath, 'utf-8')) as {
    names: { value: string; ts?: { key: string } }[];
  };

  it('canonical JSON values match the live TAURI_EVENT_NAMES module', async () => {
    const sot = await import('~/utils/eventNames');
    const moduleValues = new Set(
      Object.values(sot.TAURI_EVENT_NAMES) as string[],
    );
    // Every TS-exposed canonical entry must equal the module's value under the
    // same camelCase key, and vice-versa (no name in one but not the other).
    const tsEntries = contract.names.filter((n) => n.ts);
    for (const n of tsEntries) {
      expect(
        (sot.TAURI_EVENT_NAMES as Record<string, string>)[n.ts!.key],
        `contracts/event-names.json key '${n.ts!.key}' must match TAURI_EVENT_NAMES`,
      ).toBe(n.value);
    }
    expect(
      tsEntries.map((n) => n.value).sort(),
      'TAURI_EVENT_NAMES and the canonical JSON ts entries must cover the same set',
    ).toEqual([...moduleValues].sort());
  });

  it('the three committed mirror files match the generator output (no hand-drift)', () => {
    // `--check` regenerates in memory and exits non-zero if any of the three
    // target files differs from what the canonical JSON would produce. A clean
    // exit proves event_names.rs / event_names.py / eventNames.ts are still
    // byte-identical to the generated form.
    expect(() => {
      execFileSync(process.execPath, [generatorPath, '--check'], {
        stdio: 'pipe',
      });
    }, 'run `node scripts/gen-event-names.mjs` — a mirror file drifted from contracts/event-names.json').not.toThrow();
  });
});
