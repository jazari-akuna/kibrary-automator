/**
 * Visual-verify harness — main entry point.
 *
 * Reads e2e/visual-verify/fixtures.json, opens ONE tauri-driver session,
 * and for each fixture:
 *   1. Navigates to Libraries → <lib> → <footprint>.
 *   2. Waits for Model3DViewerGL to load + stabilise (chipNodeCount stable
 *      across 2× 50ms polls; loadCount unchanged for 250ms).
 *   3. Captures BEFORE: screenshot + scene snapshot.
 *   4. Performs the action (clicks fixture.jogButtonSelector; falls back
 *      to direct signal injection if the button isn't in the DOM).
 *   5. Waits 2× requestAnimationFrame, then captures AFTER.
 *   6. Computes diff, runs assertions, writes a per-fixture report.
 *
 * Fails fast on the first FAIL with the diff embedded in the error so a
 * future Claude session can see exactly which axis went wrong.
 *
 * CLI:
 *   node --experimental-strip-types e2e/visual-verify/runner.ts [--fixture NAME] [--debug]
 *
 * --fixture NAME → run only the named fixture.
 * --debug        → keep the WebDriver session alive on first FAIL (lets
 *                  the dev attach to the running app via WebKitWebDriver).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSession,
  deleteSession,
  execAsync,
  execScript,
  elClick,
  findElement,
  jget,
  log,
  takeElementScreenshot,
  waitFor,
} from '../lib/webdriver.ts';
import { buildSnapshotScript, type SceneSnapshot } from './snapshot-scene.ts';
import { computeDiff, runAssertions, type AssertOverrides, type FixtureLike } from './assert.ts';
import { writeReport } from './report.ts';

interface Fixture extends FixtureLike {
  /** Library name as stored in the workspace (e.g. "Existing_KSL"). */
  lib: string;
  /** Component name within that library (e.g. "U_FL_Hirose"). */
  footprint: string;
  /** Human description for the report. */
  action: string;
  /** Expected substrate mesh name; checked at preload. */
  expectedSubstrateName?: string;
  /** CSS selector for the click target (e.g. `[data-testid="jog-z-plus1"]`). */
  jogButtonSelector: string;
  /** Optional: assertion overrides (substrate tolerance, chip range, …). */
  assertOverrides?: AssertOverrides;
}

interface FixturesFile {
  /** App binary path (defaults to /usr/bin/kibrary if absent). */
  app?: string;
  /** Workspace dir to open via __kibraryTest.openWorkspace. */
  workspace?: string;
  fixtures: Fixture[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = 'visual-verify';

interface CliOpts {
  fixtureFilter: string | null;
  debug: boolean;
  outDir: string;
  fixturesPath: string;
}

function parseCli(argv: string[]): CliOpts {
  let fixtureFilter: string | null = null;
  let debug = false;
  let outDir = process.env.VISUAL_VERIFY_OUT || '/out/visual-verify';
  let fixturesPath = join(HERE, 'fixtures.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture' || a === '-f') fixtureFilter = argv[++i];
    else if (a === '--debug') debug = true;
    else if (a === '--out') outDir = argv[++i];
    else if (a === '--fixtures') fixturesPath = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: visual-verify/runner.ts [--fixture NAME] [--debug] [--out DIR] [--fixtures PATH]',
      );
      process.exit(0);
    }
  }
  return { fixtureFilter, debug, outDir, fixturesPath };
}

async function waitForViewerReady(sid: string, initialLoadCount: number): Promise<void> {
  // Stage 1: GL canvas mounts with non-zero drawing buffer.
  await waitFor(
    async () => {
      const r = await execAsync(
        sid,
        `var done = arguments[arguments.length - 1];
         var c = document.querySelector('[data-testid="3d-viewer-gl-canvas"]');
         if (!c) { done(false); return; }
         var gl = c.getContext('webgl2');
         done(!!(gl && gl.drawingBufferWidth > 0));`,
      );
      return r ? true : null;
    },
    20_000,
    300,
    'GL canvas mounts with WebGL2 context',
  );

  // Stage 2: STRICTLY a new GLB load has finished. Pre-fix this checked
  // chipNodeCount > 0 AND substrateName — but those globals persist
  // across viewer remounts (onCleanup only nullifies __model3dGLScene,
  // not these counters). On fixture N+1 the wait passed instantly on
  // fixture N's leftovers and the snapshot caught an empty scene mid-load.
  // The fix: require __model3dGLLoadCount > initialLoadCount captured
  // BEFORE we kicked the navigation. Strict-greater also catches the
  // edge case where Solid's component-list reset clobbers selectedComponent
  // briefly; loadGLB guards on falsy props and would never have bumped
  // the counter, so the wait would still time out (clear failure).
  await waitFor(
    async () => {
      const r = await execScript(
        sid,
        `return {
          chipNodeCount: window.__model3dGLChipNodeCount || 0,
          substrateName: window.__model3dGLSubstrateName || '',
          loadCount: window.__model3dGLLoadCount || 0,
          hasScene: !!window.__model3dGLScene,
          lastError: window.__model3dGLLastError || null,
        };`,
      );
      if (!r) return null;
      // Must have loaded a NEW GLB since the navigation kicked off.
      if (r.loadCount <= initialLoadCount) return null;
      // ...and that load must have populated the runtime state.
      if (!r.hasScene) return null;
      if (r.chipNodeCount <= 0) return null;
      if (!r.substrateName) return null;
      return r;
    },
    25_000,
    300,
    `new GLB loaded (loadCount > ${initialLoadCount}, scene populated, substrate identified)`,
  );

  // Stage 3: stability — chipNodeCount stable across 2 × 50ms polls AND
  // loadCount unchanged for 250ms. Catches the edge case where a second
  // GLB load is mid-flight just as we'd otherwise snapshot. ALSO verifies
  // __model3dGLSubstrateName is non-empty after the wait — if the GLB
  // parsed but findSubstrateMesh returned null we want a clear failure
  // here, not a corrupt diff later.
  await waitFor(
    async () => {
      const r = await execAsync(
        sid,
        `var done = arguments[arguments.length - 1];
         var prevChip = window.__model3dGLChipNodeCount || 0;
         var lc0 = window.__model3dGLLoadCount || 0;
         setTimeout(function(){
           var midChip = window.__model3dGLChipNodeCount || 0;
           if (midChip !== prevChip) { done(false); return; }
           setTimeout(function(){
             var endChip = window.__model3dGLChipNodeCount || 0;
             var lc1 = window.__model3dGLLoadCount || 0;
             done(endChip === prevChip && lc1 === lc0);
           }, 200);
         }, 50);`,
      );
      return r ? true : null;
    },
    10_000,
    100,
    'scene state stable (chipNodeCount + loadCount)',
  );

  // Final assertion: substrate name must be set. If it's empty here,
  // findSubstrateMesh returned null on the new GLB — likely a rendering
  // bug worth a clear error rather than letting an empty diff pass.
  const finalState = await execScript(
    sid,
    `return {
      substrateName: window.__model3dGLSubstrateName || '',
      chipNodeCount: window.__model3dGLChipNodeCount || 0,
      sceneChildCount: window.__model3dGLScene ? window.__model3dGLScene.children.length : -1,
    };`,
  );
  if (!finalState?.substrateName) {
    throw new Error(
      `viewer ready but __model3dGLSubstrateName is empty — GLB likely failed ` +
        `to identify a substrate mesh. State: ${JSON.stringify(finalState)}`,
    );
  }
}

/**
 * After waitForViewerReady (which checks GLB load progress), additionally
 * verify the wrapper element is laid out, on-screen, and has had a brief
 * settle window for `frameCameraTo`.
 *
 * Pre-fix the BEFORE screenshot for u_fl_hirose captured the symbol+footprint
 * preview pane instead of the 3D viewport because the GL canvas hadn't been
 * scrolled into view yet AND the camera was still zoomed-out from the
 * synchronous mount before frameCameraTo refined.
 *
 * If the wrapper isn't laid out we scroll it into view and re-poll once
 * before failing — failing here surfaces the layout regression cleanly
 * instead of silently snapshotting whatever was on top.
 */
const VIEWER_SELECTOR = '[data-testid="3d-viewer-gl-wrapper"]';

async function waitForViewerVisible(sid: string): Promise<void> {
  // Stage 1: wrapper element exists, has non-zero rect, AND is *fully*
  // inside the viewport. Partial overlap is rejected — the W3C "Take
  // Element Screenshot" path on WebKitWebDriver clips to the viewport
  // and the off-screen half of a WebGL canvas comes back as black
  // (initial framebuffer), defeating the whole point of cropping. We
  // also use document.elementFromPoint at the rect centre as a tie-
  // breaker — if some other pane (e.g. the 2D footprint preview) is
  // painted on top, this flags the original u_fl_hirose-style bug.
  await waitFor(
    async () => {
      const r = await execScript(
        sid,
        `var sel = ${JSON.stringify(VIEWER_SELECTOR)};
         var el = document.querySelector(sel);
         if (!el) return { ok: false, reason: 'wrapper not in DOM' };
         var rect = el.getBoundingClientRect();
         var vw = window.innerWidth, vh = window.innerHeight;
         var w = rect.width, h = rect.height;
         if (w <= 0 || h <= 0) return { ok: false, reason: 'zero-size rect' };
         var fullyInView =
           rect.top >= 0 && rect.left >= 0 &&
           rect.bottom <= vh && rect.right <= vw;
         if (!fullyInView) {
           // Use block:'center' so a viewer taller than the viewport
           // still ends up centred (we'll fail the height check on the
           // next poll if it cannot fit at all — clearer than silently
           // capturing a clipped-to-black element screenshot).
           el.scrollIntoView({ block: 'center', inline: 'center' });
           return {
             ok: false,
             reason:
               'wrapper not fully in viewport (rect=' +
               Math.round(rect.left) + ',' + Math.round(rect.top) + ' ' +
               Math.round(w) + 'x' + Math.round(h) +
               ' viewport=' + vw + 'x' + vh + '), scrolled into view',
           };
         }
         var cx = rect.left + w / 2, cy = rect.top + h / 2;
         var top = document.elementFromPoint(cx, cy);
         var coversCentre = !!top && (top === el || el.contains(top));
         if (!coversCentre) {
           return { ok: false, reason: 'wrapper occluded at centre by ' + (top && top.tagName) };
         }
         return { ok: true, w: w, h: h };`,
      );
      if (!r) return null;
      if (!r.ok) {
        log(PREFIX, `viewer not yet visible: ${r.reason} (will retry)`);
        return null;
      }
      log(PREFIX, `viewer fully visible: ${Math.round(r.w)}×${Math.round(r.h)} px`);
      return true;
    },
    8_000,
    250,
    'Model3DViewerGL wrapper fully in viewport and not occluded',
  );

  // Stage 2: scene has children AND a brief 200ms hold so frameCameraTo
  // (which runs on GLTF load completion) settles before we snapshot.
  await waitFor(
    async () => {
      const r = await execScript(
        sid,
        `return window.__model3dGLScene
          ? window.__model3dGLScene.children.length
          : -1;`,
      );
      return typeof r === 'number' && r > 0 ? true : null;
    },
    5_000,
    100,
    '__model3dGLScene.children.length > 0',
  );
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Captures BOTH a full-window PNG (forensics — see surrounding chrome) and
 * a viewer-only PNG cropped to the GL wrapper. Vision agents should read
 * the cropped one; the full grab is kept for debugging "the wrong pane was
 * on top" regressions.
 *
 * Uses the W3C "Take Element Screenshot" endpoint — single round-trip,
 * no Node-side image library required, and tauri-driver's WebKitWebDriver
 * backend already knows the device-pixel rect.
 */
async function grabFullScreenshot(sid: string): Promise<Buffer | null> {
  try {
    const r = await jget(`/session/${sid}/screenshot`);
    return Buffer.from(r.value as string, 'base64');
  } catch (e) {
    log(PREFIX, `full screenshot failed (non-fatal): ${(e as Error).message}`);
    return null;
  }
}

async function grabViewerScreenshot(sid: string): Promise<Buffer | null> {
  const eid = await findElement(sid, VIEWER_SELECTOR);
  if (!eid) {
    log(PREFIX, `viewer-cropped screenshot skipped: wrapper not found via ${VIEWER_SELECTOR}`);
    return null;
  }
  const png = await takeElementScreenshot(sid, eid);
  if (!png) {
    log(PREFIX, 'element screenshot endpoint returned no bytes (non-fatal)');
    return null;
  }
  return png;
}

async function captureSnapshot(sid: string): Promise<SceneSnapshot> {
  const snap = await execScript(sid, `return ${buildSnapshotScript()};`);
  if (!snap || !snap.ok) {
    throw new Error(`scene snapshot failed: ${snap?.reason ?? 'no value returned'}`);
  }
  return snap as SceneSnapshot;
}

/**
 * Snapshot the GLB load counter BEFORE we mutate any selection state.
 * The caller passes this to waitForViewerReady so the wait can demand
 * a strict increment (i.e. "a NEW GLB has actually finished loading").
 * Pre-fix the wait used absolute thresholds (chipNodeCount > 0) which
 * the previous fixture's leftover globals already satisfied — meaning
 * fixtures 2+ snapshotted whatever was in the scene mid-transition.
 */
async function snapshotInitialLoadCount(sid: string): Promise<number> {
  const v = await execScript(sid, `return window.__model3dGLLoadCount || 0;`);
  return typeof v === 'number' ? v : 0;
}

async function navigateToFootprint(sid: string, fixture: Fixture): Promise<void> {
  // Prefer the atomic openComponent helper (added to librariesRoom.ts in
  // the Wave-2 follow-up); fall back to set-lib-then-set-component for
  // older app builds that still ship the original two-call surface.
  const r = await execAsync(
    sid,
    `var done = arguments[arguments.length - 1];
     try {
       if (!window.__kibraryTest) { done({ ok: false, e: '__kibraryTest not exposed' }); return; }
       window.__kibraryTest.setRoom('libraries');
       var lib = ${JSON.stringify(fixture.lib)};
       var fp = ${JSON.stringify(fixture.footprint)};
       function legacyPath() {
         try { window.__kibraryTest.selectLibrary(lib); } catch(e) {}
         setTimeout(function(){
           try { window.__kibraryTest.selectComponent(fp); } catch(e) {}
           done({ ok: true, path: 'legacy' });
         }, 250);
       }
       // Yield once after setRoom so any room-change effect runs before
       // we touch the libraries-room signals (avoids a brief render of
       // the wrong room with the new selection in flight).
       setTimeout(function(){
         if (typeof window.__kibraryTest.openComponent === 'function') {
           Promise.resolve(window.__kibraryTest.openComponent(lib, fp))
             .then(function(){ done({ ok: true, path: 'openComponent' }); })
             .catch(function(e){ done({ ok: false, e: String(e) }); });
         } else {
           legacyPath();
         }
       }, 100);
     } catch (e) { done({ ok: false, e: String(e) }); }`,
  );
  if (!r?.ok) {
    throw new Error(
      `navigateToFootprint failed for ${fixture.lib}/${fixture.footprint}: ${r?.e}`,
    );
  }
}

/**
 * Performs the fixture's action. Returns warnings (if any) for the
 * report — e.g. when we fell back to direct signal injection.
 */
async function performAction(sid: string, fixture: Fixture): Promise<string[]> {
  const warnings: string[] = [];
  const eid = await findElement(sid, fixture.jogButtonSelector);
  if (eid) {
    await elClick(sid, eid);
  } else {
    warnings.push(
      `jogButtonSelector "${fixture.jogButtonSelector}" not found in DOM. ` +
        `Falling back to direct __kibraryTest hook (if exposed). ` +
        `Add a data-testid attribute to the relevant button to remove this fallback.`,
    );
    // Best-effort fallback — defined here in one place so a future
    // PositionerControls refactor knows where the contract lives.
    const r = await execAsync(
      sid,
      `var done = arguments[arguments.length - 1];
       try {
         if (window.__kibraryTest && typeof window.__kibraryTest.jogZ === 'function') {
           window.__kibraryTest.jogZ(1.0);
           done({ ok: true });
         } else {
           done({ ok: false, e: 'no __kibraryTest.jogZ hook either' });
         }
       } catch (e) { done({ ok: false, e: String(e) }); }`,
    );
    if (!r?.ok) {
      throw new Error(
        `performAction failed: button not found AND no jogZ test hook: ${r?.e}. ` +
          `Selector: ${fixture.jogButtonSelector}`,
      );
    }
    warnings.push(`Used __kibraryTest.jogZ(1.0) fallback to drive the action.`);
  }

  // Wait 2× requestAnimationFrame so the OrbitControls + applyLiveDelta
  // tick has run and matrixWorld is current. Use execAsync because rAF
  // is inherently async.
  await execAsync(
    sid,
    `var done = arguments[arguments.length - 1];
     requestAnimationFrame(function(){ requestAnimationFrame(function(){ done(true); }); });`,
  );

  return warnings;
}

async function runFixture(
  sid: string,
  fixture: Fixture,
  outDir: string,
): Promise<{ verdict: 'PASS' | 'FAIL'; reportPath: string; diff: ReturnType<typeof computeDiff> }> {
  log(PREFIX, `--- fixture: ${fixture.name} (${fixture.lib}/${fixture.footprint}) ---`);
  // Capture the GLB load counter BEFORE any selection mutation so the
  // post-nav wait can demand a strict increment. Fixture N+1 inherits
  // fixture N's chipNodeCount/substrateName globals — without this
  // baseline the wait passes instantly on stale state and we snapshot
  // an empty mid-transition scene.
  const initialLoadCount = await snapshotInitialLoadCount(sid);
  log(PREFIX, `initial __model3dGLLoadCount = ${initialLoadCount}`);
  await navigateToFootprint(sid, fixture);
  await waitForViewerReady(sid, initialLoadCount);
  // Layout/visibility gate. Without this u_fl_hirose's BEFORE used to
  // capture the symbol+footprint preview pane (the 3D pane hadn't been
  // scrolled into view yet) — see waitForViewerVisible's docstring.
  await waitForViewerVisible(sid);

  if (
    fixture.expectedSubstrateName &&
    fixture.expectedSubstrateName !==
      (await execScript(sid, `return window.__model3dGLSubstrateName || '';`))
  ) {
    const got = await execScript(sid, `return window.__model3dGLSubstrateName || '';`);
    log(
      PREFIX,
      `WARNING: expectedSubstrateName="${fixture.expectedSubstrateName}" but got "${got}"`,
    );
  }

  // Wave 8-B: tighten the camera onto the chip body so a 1mm Z lift
  // is more than sub-pixel-visible in the 530×320 cropped viewer.
  // The hook is harness-only (installed by Model3DViewerGL onMount,
  // not surfaced in the production UI). If the hook is missing —
  // e.g. an older build — the no-op short-circuit keeps fixtures
  // running with the previous (wider) framing.
  await execScript(
    sid,
    `try {
       if (window.__kibraryTest && typeof window.__kibraryTest.zoomToChip === 'function') {
         window.__kibraryTest.zoomToChip(4);
       }
     } catch (e) { /* swallow — harness must not crash on missing hook */ }
     return true;`,
  );
  await new Promise((r) => setTimeout(r, 150));

  log(PREFIX, 'capturing BEFORE snapshot + screenshot (full + viewer-cropped)');
  const before = await captureSnapshot(sid);
  const beforePng = await grabFullScreenshot(sid);
  const beforeViewerPng = await grabViewerScreenshot(sid);

  log(PREFIX, `performing action via ${fixture.jogButtonSelector}`);
  const warnings = await performAction(sid, fixture);

  log(PREFIX, 'capturing AFTER snapshot + screenshot (full + viewer-cropped)');
  const after = await captureSnapshot(sid);
  const afterPng = await grabFullScreenshot(sid);
  const afterViewerPng = await grabViewerScreenshot(sid);

  const diff = computeDiff(before, after);
  const verdict = runAssertions(diff, fixture);
  const reportPath = writeReport(join(outDir, fixture.name), {
    fixture,
    before,
    after,
    diff,
    verdict,
    beforePng,
    afterPng,
    beforeViewerPng,
    afterViewerPng,
    warnings,
  });
  log(PREFIX, `${verdict.verdict} — report → ${reportPath}`);
  return { verdict: verdict.verdict, reportPath, diff };
}

async function dismissFirstRunIfPresent(sid: string): Promise<void> {
  await execAsync(
    sid,
    `var done = arguments[arguments.length - 1];
     var btns = document.querySelectorAll('button');
     for (var i = 0; i < btns.length; i++) {
       if (/Get started/i.test(btns[i].textContent || '')) { btns[i].click(); break; }
     }
     done(true);`,
  );
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  if (!existsSync(opts.fixturesPath)) {
    throw new Error(`fixtures file not found: ${opts.fixturesPath}`);
  }
  const cfg = JSON.parse(readFileSync(opts.fixturesPath, 'utf8')) as FixturesFile;
  const app = cfg.app ?? '/usr/bin/kibrary';
  // Env var wins so scripts/visual-verify.sh + setup-workspace.sh can keep
  // the workspace path in one place. Falls back to fixtures.json, then to
  // /tmp/visual-verify-workspace (the post-Wave-2 default — distinct from
  // the smoke-ui workspace at /tmp/e2e-workspace).
  const workspace =
    process.env.VISUAL_VERIFY_WORKSPACE || cfg.workspace || '/tmp/visual-verify-workspace';

  const fixtures = opts.fixtureFilter
    ? cfg.fixtures.filter((f) => f.name === opts.fixtureFilter)
    : cfg.fixtures;
  if (fixtures.length === 0) {
    throw new Error(
      `no fixtures to run` +
        (opts.fixtureFilter ? ` (filter "${opts.fixtureFilter}" matched none)` : ''),
    );
  }

  mkdirSync(opts.outDir, { recursive: true });
  log(PREFIX, `out → ${opts.outDir}`);
  log(PREFIX, `fixtures → ${fixtures.map((f) => f.name).join(', ')}`);

  log(PREFIX, `creating WebDriver session against ${app}`);
  const sid = await createSession(app);
  log(PREFIX, `session ${sid}`);

  let firstFail: { fixture: string; diff: ReturnType<typeof computeDiff>; reportPath: string } | null = null;
  try {
    // App shell.
    await waitFor(
      async () => {
        const body = await findElement(sid, 'body');
        return body ? true : null;
      },
      30_000,
      1000,
      'app shell visible',
    );

    log(PREFIX, `opening workspace ${workspace}`);
    const wsResult = await execAsync(
      sid,
      `var done = arguments[arguments.length - 1];
       if (!window.__kibraryTest) { done({ ok: false, e: '__kibraryTest not exposed' }); return; }
       window.__kibraryTest.openWorkspace(${JSON.stringify(workspace)})
         .then(function(){ done({ ok: true }); })
         .catch(function(e){ done({ ok: false, e: String(e) }); });`,
    );
    if (!wsResult?.ok) throw new Error(`workspace_open failed: ${wsResult?.e}`);
    await new Promise((r) => setTimeout(r, 500));
    await dismissFirstRunIfPresent(sid);

    for (const fixture of fixtures) {
      const r = await runFixture(sid, fixture, opts.outDir);
      if (r.verdict === 'FAIL' && !firstFail) {
        firstFail = { fixture: fixture.name, diff: r.diff, reportPath: r.reportPath };
        if (opts.debug) {
          log(PREFIX, `--debug set: stopping on first FAIL, KEEPING SESSION ALIVE`);
          log(PREFIX, `  attach via WebKitWebDriver / inspect /tmp output dir`);
          break;
        }
      }
    }
  } finally {
    if (!opts.debug || !firstFail) {
      await deleteSession(sid);
    }
  }

  if (firstFail) {
    const diffStr = JSON.stringify(firstFail.diff, null, 2);
    throw new Error(
      `visual-verify FAIL: fixture "${firstFail.fixture}" failed.\n` +
        `Report: ${firstFail.reportPath}\n` +
        `Diff:\n${diffStr}`,
    );
  }
  log(PREFIX, `ALL ${fixtures.length} FIXTURES PASSED`);
}

main().catch((e) => {
  log(PREFIX, `FATAL: ${(e as Error).message}`);
  process.exit(1);
});
