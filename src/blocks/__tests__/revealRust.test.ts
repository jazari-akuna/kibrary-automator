/**
 * 26.5.7-alpha.4 reveal-in-explorer:
 *
 * Structural guards on the Rust side (src-tauri/src/commands/reveal.rs)
 * that don't require a Cargo build to verify. The Rust unit tests cover
 * the argv construction; this spec freezes the SHAPES of the per-OS code
 * paths so a future refactor can't silently lose:
 *
 *   - the macOS `open -R` flag (changes Finder reveal → Finder open-folder)
 *   - the Windows /select, comma quirk (no space, single combined token)
 *   - the FileManager1 D-Bus dest + interface + method names
 *   - the canonicalize-before-spawn safety check
 *
 * Also asserts the command is registered in the invoke_handler in main.rs
 * so the frontend `invoke('reveal_in_explorer', ...)` call lands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const revealRsPath = fileURLToPath(
  new URL('../../../src-tauri/src/commands/reveal.rs', import.meta.url),
);
const mainRsPath = fileURLToPath(
  new URL('../../../src-tauri/src/main.rs', import.meta.url),
);
const modRsPath = fileURLToPath(
  new URL('../../../src-tauri/src/commands/mod.rs', import.meta.url),
);

describe('reveal_in_explorer Rust structural guards', () => {
  it('reveal.rs canonicalises the path before spawning anything', () => {
    const src = readFileSync(revealRsPath, 'utf-8');
    expect(src, 'must canonicalise the user-supplied path').toMatch(
      /std::fs::canonicalize/,
    );
  });

  it('macOS path uses `open -R` (Finder reveal, not just open-folder)', () => {
    const src = readFileSync(revealRsPath, 'utf-8');
    expect(src).toMatch(/"open"/);
    expect(src).toMatch(/"-R"/);
  });

  it('Windows path uses the /select, comma quirk with no space', () => {
    const src = readFileSync(revealRsPath, 'utf-8');
    // The format-string must contain "/select," exactly — no leading or
    // trailing whitespace inside the quirk. We grep for the literal
    // character sequence in the source.
    expect(src).toMatch(/"\/select,\{\}"/);
    expect(src).toMatch(/explorer\.exe/);
  });

  it('Linux path targets the freedesktop FileManager1.ShowItems D-Bus method', () => {
    const src = readFileSync(revealRsPath, 'utf-8');
    expect(src).toMatch(/--dest=org\.freedesktop\.FileManager1/);
    expect(src).toMatch(/\/org\/freedesktop\/FileManager1/);
    expect(src).toMatch(/org\.freedesktop\.FileManager1\.ShowItems/);
  });

  it('Linux path falls back to xdg-open when the D-Bus call fails', () => {
    const src = readFileSync(revealRsPath, 'utf-8');
    expect(src).toMatch(/xdg-open/);
  });

  it('command is exposed as a tauri::command', () => {
    const src = readFileSync(revealRsPath, 'utf-8');
    // The attribute must be on `pub fn reveal_in_explorer`.
    const idx = src.search(/#\[tauri::command\]\s*(pub\s+)?fn\s+reveal_in_explorer/);
    expect(idx, 'reveal_in_explorer must be #[tauri::command]').toBeGreaterThanOrEqual(0);
  });

  it('command is wired into the commands module', () => {
    const src = readFileSync(modRsPath, 'utf-8');
    expect(src).toMatch(/pub mod reveal/);
  });

  it('command is registered in the invoke_handler in main.rs', () => {
    const src = readFileSync(mainRsPath, 'utf-8');
    expect(src).toMatch(/commands::reveal_in_explorer/);
  });
});
