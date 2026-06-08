#!/usr/bin/env node
/**
 * gen-event-names.mjs — regenerate the three hand-maintained Tauri event-name
 * mirrors from the single canonical source `contracts/event-names.json`.
 *
 *   node scripts/gen-event-names.mjs            # write the three files
 *   node scripts/gen-event-names.mjs --check    # verify they're up to date
 *
 * The generated output is BYTE-IDENTICAL to the committed files: after a plain
 * run, `git diff` for the three targets must be empty. `--check` regenerates in
 * memory and exits non-zero (without writing) if any target would change — use
 * it in CI to assert the mirrors haven't drifted from the JSON.
 *
 * Targets:
 *   - src-tauri/src/event_names.rs
 *   - sidecar/kibrary_sidecar/event_names.py
 *   - src/utils/eventNames.ts
 *
 * Edit event names in contracts/event-names.json, then re-run this script.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(repoRoot, 'contracts', 'event-names.json');
const spec = JSON.parse(readFileSync(specPath, 'utf-8'));

/** Index names by their wire `value` so each file's `order` can resolve them. */
const byValue = new Map(spec.names.map((n) => [n.value, n]));
function ordered(order) {
  return order.map((v) => {
    const n = byValue.get(v);
    if (!n) throw new Error(`order references unknown event value: ${v}`);
    return n;
  });
}

function renderRust() {
  const cfg = spec.rust;
  const lines = [...cfg.header];
  for (const n of ordered(cfg.order)) {
    const r = n.rust;
    lines.push('');
    for (const d of r.doc) lines.push(`/// ${d}`);
    if (r.deadCode) lines.push('#[allow(dead_code)]');
    lines.push(`pub const ${r.const}: &str = "${n.value}";`);
  }
  lines.push(...cfg.footer);
  return lines.join('\n') + '\n';
}

function renderPython() {
  const cfg = spec.python;
  const lines = [...cfg.header];
  const included = ordered(cfg.order).filter((n) => n.python && n.python.include);
  for (const n of included) {
    lines.push('');
    for (const d of n.python.doc) lines.push(`#: ${d}`);
    lines.push(`${n.python.const} = "${n.value}"`);
  }
  lines.push('');
  const all = included.map((n) => `"${n.python.const}"`).join(', ');
  lines.push(`__all__ = [${all}]`);
  lines.push(...cfg.footer);
  return lines.join('\n') + '\n';
}

function renderTs() {
  const cfg = spec.ts;
  const lines = [...cfg.header];
  lines.push('export const TAURI_EVENT_NAMES = {');
  // The object opener is immediately followed by the first entry (no leading
  // blank); entries are then separated by a single blank line.
  ordered(cfg.order).forEach((n, i) => {
    if (i > 0) lines.push('');
    for (const d of n.ts.doc) lines.push(`  /** ${d} */`);
    lines.push(`  ${n.ts.key}: '${n.value}',`);
  });
  lines.push('} as const;');
  lines.push(...cfg.footer);
  return lines.join('\n') + '\n';
}

const targets = [
  { path: spec.rust.path, render: renderRust },
  { path: spec.python.path, render: renderPython },
  { path: spec.ts.path, render: renderTs },
];

const check = process.argv.includes('--check');
let drift = false;
for (const t of targets) {
  const abs = join(repoRoot, t.path);
  const next = t.render();
  if (check) {
    let current = '';
    try {
      current = readFileSync(abs, 'utf-8');
    } catch {
      /* missing → treated as drift below */
    }
    if (current !== next) {
      drift = true;
      console.error(`[gen-event-names] OUT OF DATE: ${t.path}`);
    }
  } else {
    writeFileSync(abs, next);
    console.log(`[gen-event-names] wrote ${t.path}`);
  }
}

if (check && drift) {
  console.error(
    '[gen-event-names] run `node scripts/gen-event-names.mjs` to regenerate.',
  );
  process.exit(1);
}
