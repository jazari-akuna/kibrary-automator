/**
 * Report writer for the visual-verify harness. Given a fixture's
 * BEFORE/AFTER snapshots + diff + verdict (and screenshot bytes), produces:
 *
 *   <outDir>/<fixture>/before.png            ← full-window (forensics)
 *   <outDir>/<fixture>/after.png             ← full-window (forensics)
 *   <outDir>/<fixture>/before-viewer.png     ← cropped to GL wrapper
 *   <outDir>/<fixture>/after-viewer.png      ← cropped to GL wrapper
 *   <outDir>/<fixture>/before.json
 *   <outDir>/<fixture>/after.json
 *   <outDir>/<fixture>/diff.json
 *   <outDir>/<fixture>/REPORT.md
 *
 * Vision agents should read the *-viewer.png pair — they're cropped to
 * the 3D pane so neighbouring symbol/footprint preview content can't
 * leak in as "magenta artefacts". The full-window grabs are kept for
 * debugging "the wrong pane was on top" regressions.
 *
 * The REPORT.md is the single human-readable artefact a future Claude
 * session reads to decide "did the fix work, or do I escalate?"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SceneSnapshot } from './snapshot-scene.ts';
import type { DiffRecord, Verdict, FixtureLike } from './assert.ts';

export interface ReportInputs {
  fixture: FixtureLike;
  before: SceneSnapshot;
  after: SceneSnapshot;
  diff: DiffRecord;
  verdict: Verdict;
  /** Raw full-window PNG bytes (or null if screenshot grab failed). */
  beforePng: Buffer | null;
  afterPng: Buffer | null;
  /** PNG bytes cropped to the GL viewer wrapper (W3C element screenshot).
   *  These are the artefacts vision agents should read; the full-window
   *  grabs above stay for forensics. */
  beforeViewerPng?: Buffer | null;
  afterViewerPng?: Buffer | null;
  /** Open warnings the runner wants surfaced (e.g. "fell back to direct
   *  signal injection because jogButtonSelector wasn't found"). */
  warnings?: string[];
}

export function writeReport(outDir: string, inputs: ReportInputs): string {
  mkdirSync(outDir, { recursive: true });
  if (inputs.beforePng) writeFileSync(join(outDir, 'before.png'), inputs.beforePng);
  if (inputs.afterPng) writeFileSync(join(outDir, 'after.png'), inputs.afterPng);
  if (inputs.beforeViewerPng) {
    writeFileSync(join(outDir, 'before-viewer.png'), inputs.beforeViewerPng);
  }
  if (inputs.afterViewerPng) {
    writeFileSync(join(outDir, 'after-viewer.png'), inputs.afterViewerPng);
  }
  writeFileSync(join(outDir, 'before.json'), JSON.stringify(inputs.before, null, 2));
  writeFileSync(join(outDir, 'after.json'), JSON.stringify(inputs.after, null, 2));
  writeFileSync(join(outDir, 'diff.json'), JSON.stringify(inputs.diff, null, 2));
  const md = renderMarkdown(inputs);
  const reportPath = join(outDir, 'REPORT.md');
  writeFileSync(reportPath, md);
  return reportPath;
}

function renderMarkdown(i: ReportInputs): string {
  const banner = i.verdict.verdict === 'PASS'
    ? '## PASS\n\nAll assertions met.'
    : '## FAIL\n\n' + i.verdict.failReasons.map((r) => `- ${r}`).join('\n');

  const warnings = (i.warnings && i.warnings.length > 0)
    ? '\n### Warnings\n\n' + i.warnings.map((w) => `- ${w}`).join('\n') + '\n'
    : '';

  const meta = [
    `- **Fixture:** \`${i.fixture.name}\``,
    `- **Action:** ${i.fixture.action}`,
    `- **Expected substrate name:** \`${i.fixture.expectedSubstrateName ?? '(any)'}\``,
    `- **Captured substrate name:** \`${i.before.substrateName || '(empty)'}\``,
    `- **chipNodeCount (runtime):** before=${i.before.chipNodeCount}, after=${i.after.chipNodeCount}`,
    `- **GLB loadCount:** before=${i.before.loadCount}, after=${i.after.loadCount}` +
      (i.diff.reloadDetected ? '  ⚠️ RELOAD DETECTED' : ''),
    `- **Last error (browser-side):** ${i.before.lastError ?? i.after.lastError ?? 'none'}`,
  ].join('\n');

  const thr = i.verdict.thresholds;
  const thresholds = [
    `- substrateMaxDelta = ${thr.substrateMaxDelta} m`,
    `- chipYDeltaRange = ${
      thr.chipYDeltaRange ? `[${thr.chipYDeltaRange[0]}, ${thr.chipYDeltaRange[1]}] m` : 'disabled'
    }`,
    `- chipYDeltaMinCount = ${thr.chipYDeltaMinCount}`,
    `- maxAddedMeshes = ${thr.maxAddedMeshes}`,
    `- maxRemovedMeshes = ${thr.maxRemovedMeshes}`,
  ].join('\n');

  const sum = i.verdict.summary;
  const summary = [
    `- substrateMaxDelta observed: ${sum.substrateMaxDelta.toExponential(3)} m`,
    `- chip nodes in expected Y range: ${sum.chipsInRange}`,
    `- biggest chip Y-delta observed: ${sum.biggestChipYDelta.toExponential(3)} m`,
  ].join('\n');

  return [
    `# Visual-verify report — ${i.fixture.name}`,
    '',
    banner,
    '',
    '## Metadata',
    '',
    meta,
    '',
    warnings,
    '## Thresholds',
    '',
    thresholds,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Per-mesh deltas',
    '',
    renderMeshTable(i.diff),
    '',
    '## Classifier debug',
    '',
    renderClassifierDebug(i.before, i.after),
    '',
    '## chipMeshNames',
    '',
    renderChipMeshNames(i.before, i.after),
    '',
    '## substrateBbox',
    '',
    renderSubstrateBbox(i.before, i.after),
    '',
    '## Artefacts',
    '',
    '- **`before-viewer.png` / `after-viewer.png`** — cropped to the 3D viewer pane (read these for visual QA)',
    '- `before.png` / `after.png` — full-window WebDriver screenshots (forensics: "was the wrong pane on top?")',
    '- `before.json` / `after.json` — full SceneSnapshot',
    '- `diff.json` — DiffRecord (per-mesh deltas)',
    '',
  ].join('\n');
}

/** Pretty-print the (opaque) classifier-debug payload from each snapshot.
 *  Falls back to "(not set)" when the runtime hasn't published one yet. */
function renderClassifierDebug(before: SceneSnapshot, after: SceneSnapshot): string {
  const fmtOne = (label: string, payload: Record<string, unknown> | null): string => {
    if (!payload) return `### ${label}\n\n_not set — \`window.__model3dGLClassifierDebug\` was undefined._`;
    return `### ${label}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  };
  return [fmtOne('before', before.classifierDebug), '', fmtOne('after', after.classifierDebug)].join('\n');
}

/** Compare the chip-mesh-name lists between snapshots. They should match;
 *  any drift implies the GLB reloaded between BEFORE and AFTER. */
function renderChipMeshNames(before: SceneSnapshot, after: SceneSnapshot): string {
  const b = before.chipMeshNames ?? [];
  const a = after.chipMeshNames ?? [];
  const sameLen = b.length === a.length;
  const sameContent = sameLen && b.every((n, idx) => n === a[idx]);
  const verdict = sameContent
    ? `_identical (${b.length} entries)._`
    : `**DIFF** — before has ${b.length}, after has ${a.length}; GLB likely reloaded mid-action.`;
  const list = (label: string, names: string[]): string => {
    if (names.length === 0) return `### ${label}\n\n_(empty list)_`;
    return `### ${label}\n\n${names.map((n) => `- \`${escapeMd(n) || '(unnamed)'}\``).join('\n')}`;
  };
  return [verdict, '', list('before', b), '', list('after', a)].join('\n');
}

/** Show the pre-recenter substrate bbox in millimetres (×1000 from metres).
 *  Both BEFORE and AFTER are reported so a stale-bbox bug stands out. */
function renderSubstrateBbox(before: SceneSnapshot, after: SceneSnapshot): string {
  const fmtOne = (label: string, bb: SceneSnapshot['substrateBbox']): string => {
    if (!bb) return `### ${label}\n\n_not set — \`window.__model3dGLSubstrateBbox\` was undefined._`;
    const mm = (n: number) => (n * 1000).toFixed(3);
    const sx = bb.maxX - bb.minX;
    const sy = bb.maxY - bb.minY;
    const sz = bb.maxZ - bb.minZ;
    return [
      `### ${label}`,
      '',
      '| axis | min (mm) | max (mm) | size (mm) |',
      '|------|---------:|---------:|----------:|',
      `| x | ${mm(bb.minX)} | ${mm(bb.maxX)} | ${mm(sx)} |`,
      `| y | ${mm(bb.minY)} | ${mm(bb.maxY)} | ${mm(sy)} |`,
      `| z | ${mm(bb.minZ)} | ${mm(bb.maxZ)} | ${mm(sz)} |`,
    ].join('\n');
  };
  return [fmtOne('before', before.substrateBbox), '', fmtOne('after', after.substrateBbox)].join('\n');
}

function renderMeshTable(diff: DiffRecord): string {
  if (diff.matched.length === 0) {
    return '_no matched meshes — both snapshots empty or all uuids changed._';
  }
  const rows = diff.matched
    .slice()
    // Substrate first, then chips, then others. Largest |delta| wins ties.
    .sort((a, b) => {
      const rank = (m: typeof a) => (m.isSubstrate ? 0 : m.inChipNodes ? 1 : 2);
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return b.positionDeltaMag - a.positionDeltaMag;
    })
    .map((m) => {
      const role = m.isSubstrate ? 'substrate' : m.inChipNodes ? 'chip' : 'other';
      return `| \`${escapeMd(m.name) || '(unnamed)'}\` | ${role} | ${fmt(m.positionDelta.x)} | ${fmt(m.positionDelta.y)} | ${fmt(m.positionDelta.z)} | ${fmt(m.positionDeltaMag)} |`;
    });
  return [
    '| name | role | Δx (m) | Δy (m) | Δz (m) | |Δ| (m) |',
    '|------|------|-------:|-------:|-------:|------:|',
    ...rows,
  ].join('\n');
}

function fmt(n: number): string {
  if (!isFinite(n)) return String(n);
  if (n === 0) return '0';
  if (Math.abs(n) < 1e-3) return n.toExponential(3);
  return n.toFixed(6);
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/`/g, '\\`');
}
