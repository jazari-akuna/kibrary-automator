/**
 * Plain Node.js WebDriver-protocol test. Avoids WebdriverIO's W3C capability
 * negotiation quirks (WDIO 9 wraps capabilities in a way tauri-driver 2.0.5
 * doesn't accept; manual POST with `alwaysMatch` works fine — see the
 * manual-curl probe in the alpha.11 commit history). Drives the running
 * /usr/bin/kibrary via the WebDriver protocol on port 4444.
 *
 * Asserts both DOM state (queue row data-status="ready") and on-disk state
 * (the kicad_sym landed in the right place).
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DRIVER  = 'http://127.0.0.1:4444';
const APP     = '/usr/bin/kibrary';
const WORKSPACE = '/tmp/e2e-workspace';
const STAGING = `${WORKSPACE}/.kibrary/staging`;
const LCSC    = 'C25804';
const OUT     = '/out';

function log(msg: string) {
  console.log(`[smoke-ui] ${msg}`);
}

async function jpost(path: string, body: any): Promise<any> {
  const res = await fetch(`${DRIVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function jget(path: string): Promise<any> {
  const res = await fetch(`${DRIVER}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function jdel(path: string): Promise<any> {
  const res = await fetch(`${DRIVER}${path}`, { method: 'DELETE' });
  const text = await res.text();
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function execScript(sid: string, script: string, args: any[] = []): Promise<any> {
  const r = await jpost(`/session/${sid}/execute/sync`, { script, args });
  return r.value;
}

// /execute/async waits for arguments[arguments.length - 1](result). Required
// for any script whose payload depends on a Promise resolving — using sync
// silently discards the callback and the spec sees `undefined`.
async function execAsync(sid: string, script: string, args: any[] = []): Promise<any> {
  const r = await jpost(`/session/${sid}/execute/async`, { script, args });
  return r.value;
}

async function findElement(sid: string, selector: string): Promise<string | null> {
  try {
    const r = await jpost(`/session/${sid}/element`, {
      using: 'css selector',
      value: selector,
    });
    // W3C: { value: { 'element-6066-11e4-a52e-4f735466cecf': '...' } }
    const v = r.value;
    return v[Object.keys(v)[0]];
  } catch {
    return null;
  }
}

async function findElements(sid: string, selector: string): Promise<string[]> {
  const r = await jpost(`/session/${sid}/elements`, {
    using: 'css selector',
    value: selector,
  });
  return (r.value as any[]).map((v) => v[Object.keys(v)[0]]);
}

async function elText(sid: string, eid: string): Promise<string> {
  const r = await jget(`/session/${sid}/element/${eid}/text`);
  return r.value as string;
}

async function elAttr(sid: string, eid: string, name: string): Promise<string | null> {
  const r = await jget(`/session/${sid}/element/${eid}/attribute/${name}`);
  return r.value as string | null;
}

async function elClick(sid: string, eid: string): Promise<void> {
  await jpost(`/session/${sid}/element/${eid}/click`, {});
}

async function elClear(sid: string, eid: string): Promise<void> {
  await jpost(`/session/${sid}/element/${eid}/clear`, {});
}

async function elType(sid: string, eid: string, text: string): Promise<void> {
  await jpost(`/session/${sid}/element/${eid}/value`, { text });
}

async function screenshot(sid: string, dest: string): Promise<void> {
  try {
    const r = await jget(`/session/${sid}/screenshot`);
    const png = Buffer.from(r.value as string, 'base64');
    writeFileSync(dest, png);
    log(`screenshot saved → ${dest}`);
  } catch (e) {
    log(`screenshot failed (non-fatal): ${(e as Error).message}`);
  }
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timeout: ${label} (after ${timeoutMs}ms)`);
}

async function main() {
  mkdirSync(STAGING, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  log('creating WebDriver session');
  const sessRes = await jpost('/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'wry',
        'tauri:options': { application: APP },
      },
    },
  });
  const sid = sessRes.value.sessionId;
  log(`session ${sid}`);

  let exitCode = 0;
  try {
    // 1. Wait for app shell to render. The body should contain "Add", "Libraries"
    //    or "Open folder" within ~30 s of launch.
    log('waiting for app shell');
    await waitFor(
      async () => {
        const body = await findElement(sid, 'body');
        if (!body) return null;
        const t = await elText(sid, body);
        return /Add|Libraries|Open folder/.test(t) ? true : null;
      },
      30_000, 1_000, 'app shell visible',
    );
    log('app shell rendered');

    // 2. Open a fresh workspace via the test helper (calls openWorkspace
    //    which both invokes Rust workspace_open AND updates the SolidJS
    //    signal — calling invoke('workspace_open') directly bypasses the
    //    signal and leaves currentWorkspace() null, which then blocks
    //    download with the "Open a workspace first" toast).
    log(`opening workspace ${WORKSPACE} via __kibraryTest.openWorkspace`);
    const wsResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      if (!window.__kibraryTest) { done({ ok: false, e: '__kibraryTest not exposed — frontend not rebuilt?' }); return; }
      window.__kibraryTest.openWorkspace(${JSON.stringify(WORKSPACE)})
        .then(function() { done({ ok: true }); })
        .catch(function(e) { done({ ok: false, e: String(e) }); });
    `);
    if (!wsResult?.ok) throw new Error(`workspace_open failed: ${wsResult?.e}`);
    log('workspace opened, signal updated');
    await new Promise((r) => setTimeout(r, 500));

    // 2b. Dismiss the first-run wizard modal if it appeared (workspace is
    //     fresh, so first_run=true and the modal blocks pointer events).
    log('dismissing first-run wizard if present');
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      // Find Get started button via plain DOM walk; the modal renders into
      // the body, not into a portal we can target by selector.
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (/Get started/i.test(btns[i].textContent || '')) { btns[i].click(); done({ clicked: true }); return; }
      }
      // Or the X close button — fallback: dismiss via state hook.
      done({ clicked: false });
    `);
    await new Promise((r) => setTimeout(r, 500));

    // 3. Click Add room button.
    log('navigating to Add room');
    const addBtnId = await waitFor(
      async () => {
        const els = await findElements(sid, 'button');
        for (const e of els) {
          const t = await elText(sid, e);
          if (t.trim() === 'Add') return e;
        }
        return null;
      },
      10_000, 500, 'Add button',
    );
    await elClick(sid, addBtnId as string);
    await new Promise((r) => setTimeout(r, 500));

    // 4. Type LCSC + click Detect (alpha.10 auto-enqueues).
    log(`typing ${LCSC} into intake`);
    const intakeId = await waitFor(
      () => findElement(sid, '[data-testid="intake-textarea"]'),
      10_000, 500, 'intake textarea',
    );
    await elClear(sid, intakeId as string);
    await elType(sid, intakeId as string, LCSC);

    log('clicking Detect');
    const detectId = await waitFor(
      () => findElement(sid, '[data-testid="detect-btn"]'),
      5_000, 500, 'Detect button',
    );
    await elClick(sid, detectId as string);

    // 5. Wait for queue row to appear. WebKitWebDriver's /elements (plural)
    //    endpoint seems to return stale empties even after the element is in
    //    the DOM (verified via execScript dump). /element (singular) works
    //    fine, so use it.
    log('waiting for queue row to appear');
    await waitFor(
      () => findElement(sid, '[data-testid="queue-row"]'),
      10_000, 500, `queue row for ${LCSC}`,
    );

    // 6. Click Download all.
    log('arming download.progress capture');
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__kibraryTest.armProgressCapture()
        .then(function() { done({ ok: true }); })
        .catch(function(e) { done({ ok: false, e: String(e) }); });
    `);

    log('clicking Download all');
    const dlId = await waitFor(
      () => findElement(sid, '[data-testid="download-all-btn"]'),
      5_000, 500, 'Download all button',
    );
    await elClick(sid, dlId as string);

    // 7. Wait up to 90 s for the row to flip to data-status="ready".
    //    There's only one queue row, so findElement (singular) is fine.
    // smoke-real allots 120 s per part for the full JLC + JLC2KiCadLib +
    // kicad-cli pipeline; in a fresh Docker layer with cold pip caches the
    // first-time download is slower. 240 s gives headroom without masking a
    // genuinely-stuck download (status=failed throws immediately).
    log('waiting for status=ready (up to 240 s; real JLC + kicad-cli network)');
    let lastStatus: string | null = null;
    try {
      await waitFor(
        async () => {
          const row = await findElement(sid, '[data-testid="queue-row"]');
          if (!row) return null;
          const status = await elAttr(sid, row, 'data-status');
          if (status !== lastStatus) {
            log(`  status=${status}`);
            lastStatus = status;
          }
          if (status === 'ready') return true;
          if (status === 'failed') {
            await screenshot(sid, `${OUT}/download-all-FAILED.png`);
            const t = await elText(sid, row);
            throw new Error(`Row reached status=failed: ${t}`);
          }
          return null;
        },
        240_000, 2_000,
        `${LCSC} status=ready (alpha.9 "Download all does nothing" symptom)`,
      );
    } catch (e) {
      // Diagnostic: did download.progress events arrive at the webview at all?
      const captured = await execScript(sid, `return JSON.stringify(window.__kibraryTest && window.__kibraryTest.capturedProgress);`);
      log(`DIAG capturedProgress=${captured}`);
      throw e;
    }
    log(`✅ DOM: row ${LCSC} reached status=ready`);

    // 8. Verify on-disk state.
    const sym = join(STAGING, LCSC, `${LCSC}.kicad_sym`);
    if (!existsSync(sym)) throw new Error(`On-disk file missing: ${sym}`);
    const size = statSync(sym).size;
    if (size < 100) throw new Error(`${sym} suspiciously small (${size} bytes)`);
    log(`✅ disk: ${sym} → ${size} bytes`);

    // 9. Bulk-Assign asserts (alpha.12 regression coverage):
    //    - the suggested library MUST be category-derived. C25804 is a
    //      Resistor on JLCPCB so the picker should propose `Resistors_KSL`,
    //      NOT the catch-all `Misc_KSL`. The bug it pins down: alpha.11
    //      and earlier never wrote `category` to meta.json during download,
    //      so library.suggest always got an empty category and fell back to
    //      Misc for every part regardless of what it actually was.
    log('asserting Bulk-Assign suggested library is category-derived');
    const suggested = await waitFor(
      async () => {
        const el = await findElement(sid, '[data-testid="bulk-suggested"]');
        if (!el) return null;
        const t = (await elText(sid, el)).trim();
        // wait until a definitive value lands (skip empty/loading states)
        if (!t || t.toLowerCase() === 'loading…') return null;
        return t;
      },
      30_000, 1_000, 'bulk-suggested cell populated',
    );
    log(`  suggested = ${JSON.stringify(suggested)}`);
    if (/^Misc_KSL/i.test(suggested)) {
      throw new Error(
        `Bulk-Assign suggested "${suggested}" — alpha.11 regression: ` +
        `category not captured during download (expected something like "Resistors_KSL")`,
      );
    }
    log(`✅ Bulk-Assign: category-derived suggestion (${suggested})`);

    // 9b. Regression test for the alpha.12 LibPicker defocus bug — typing
    //     into the picker used to lose focus after each keystroke because
    //     the parent <For> recreated the row's DOM on every state update.
    //     Switching to <Index> kept the input alive across updates. This
    //     test multi-char-types and asserts the full string lands; if focus
    //     were lost after char 1, only char 1 would arrive.
    log('typing multi-char into Bulk-Assign LibPicker (defocus regression)');
    const picker = await waitFor(
      () => findElement(sid, '[data-testid="bulk-row"] input'),
      5_000, 500, 'bulk-assign LibPicker input',
    );
    // Don't try to clear — WebKitWebDriver returns "element not interactable"
    // for the <input>'s clear endpoint. Append instead and verify the suffix
    // landed; if focus were lost after char 1, only char 1 would arrive.
    const valueBefore = await execScript(sid, `
      var el = document.querySelector('[data-testid="bulk-row"] input');
      return el ? el.value : null;
    `) as string | null;
    const SUFFIX = '_v2';
    await elType(sid, picker as string, SUFFIX);
    const valueAfter = await execScript(sid, `
      var el = document.querySelector('[data-testid="bulk-row"] input');
      return el ? el.value : null;
    `) as string | null;
    log(`  before=${JSON.stringify(valueBefore)} after=${JSON.stringify(valueAfter)}`);
    if (valueAfter !== valueBefore + SUFFIX) {
      throw new Error(
        `LibPicker defocus regression: appended "${SUFFIX}" but value went ` +
        `${JSON.stringify(valueBefore)} → ${JSON.stringify(valueAfter)} ` +
        `(expected ${JSON.stringify(valueBefore + SUFFIX)}) — input lost focus mid-type`,
      );
    }
    log('✅ Bulk-Assign LibPicker keeps focus across keystrokes');

    // 9c. Footprint column is populated (alpha.14 added). C25804 lands as
    //     R0603 (or similar) — assert the cell is non-empty.
    log('asserting Bulk-Assign footprint column is populated');
    const footprintEl = await findElement(sid, '[data-testid="bulk-footprint"]');
    if (!footprintEl) throw new Error('bulk-footprint cell not found');
    const footprint = (await elText(sid, footprintEl)).trim();
    log(`  footprint = ${JSON.stringify(footprint)}`);
    if (!footprint || footprint === '—') {
      throw new Error(`Bulk-Assign footprint cell is empty for ${LCSC} — meta.footprint not captured`);
    }
    log(`✅ Bulk-Assign: footprint shown (${footprint})`);

    // 9d. Cancel button deletes staged files + drops the queue row.
    log('clicking Bulk-Assign cancel — should rmtree staging dir + dequeue');
    const cancelBtn = await findElement(sid, '[data-testid="bulk-cancel"]');
    if (!cancelBtn) throw new Error('bulk-cancel button not found');
    await elClick(sid, cancelBtn);
    // Poll for both side effects: bulk-row vanishes AND staging dir is gone.
    await waitFor(
      async () => {
        const stillThere = await findElement(sid, '[data-testid="bulk-row"]');
        const dirGone = !existsSync(join(STAGING, LCSC));
        return stillThere == null && dirGone ? true : null;
      },
      10_000, 500, 'cancel removes row + staging dir',
    );
    log('✅ Bulk-Assign cancel: row + on-disk staging removed');

    // 10. Thumbnail asserts (alpha.12 regression coverage): probe the photo
    //     endpoint via the sidecar to prove the embedded API key works.
    //     alpha.11 shipped with the API key missing its leading `-`, which
    //     authenticated against /api/search but 401'd on /photo. Smoke tests
    //     passed but every thumbnail in the running app rendered as red `!`.
    log('probing search.fetch_photo via sidecar');
    const photo = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'search.fetch_photo',
        params: { lcsc: 'C25804' },
      }).then(function(r) { done({ ok: true, hasUrl: !!(r && r.data_url), error: r && r.error }); })
        .catch(function(e) { done({ ok: false, e: String(e) }); });
    `);
    log(`  fetch_photo result = ${JSON.stringify(photo)}`);
    if (!photo?.ok || !photo.hasUrl) {
      throw new Error(
        `search.fetch_photo failed (error=${photo?.error ?? photo?.e ?? 'no data_url'}) — ` +
        `embedded search.raph.io API key is invalid or revoked`,
      );
    }
    log('✅ thumbnails: search.fetch_photo returned a data URL');

    await screenshot(sid, `${OUT}/download-all.png`);
    log('ALL UI SMOKE TESTS PASSED');
  } catch (e) {
    log(`❌ FAIL: ${(e as Error).message}`);
    await screenshot(sid, `${OUT}/download-all-FAILED.png`).catch(() => {});
    exitCode = 1;
  } finally {
    await jdel(`/session/${sid}`).catch(() => {});
  }

  process.exit(exitCode);
}

main().catch((e) => {
  log(`unhandled: ${(e as Error).message}`);
  process.exit(1);
});
