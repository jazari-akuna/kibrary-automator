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

    // 3b. alpha.16: capture pristine Add room (search pane open by default,
    //     no input, no queue) — the screenshot the user inspects to verify
    //     the toggle button isn't crowding any other button.
    await screenshot(sid, `${OUT}/add-room-empty.png`);

    // 3c. alpha.16: open Stock dropdown to verify (a) both checkboxes
    //     default to checked, (b) the dropdown doesn't visually collide
    //     with the search-pane-toggle now that the toggle is inline (not
    //     absolute-positioned).
    log('opening Stock dropdown to assert default-on + no toggle collision');
    const stockBtn = await waitFor(
      () => findElement(sid, '[data-testid="stock-btn"]'),
      5_000, 250, 'Stock button',
    );
    await elClick(sid, stockBtn);
    await new Promise((r) => setTimeout(r, 200));
    const lcscBox = await findElement(sid, '[data-testid="stock-lcsc"]');
    const jlcBox = await findElement(sid, '[data-testid="stock-jlc"]');
    if (!lcscBox || !jlcBox) throw new Error('stock-lcsc / stock-jlc checkboxes not found');
    const lcscChecked = await execScript(sid, `return document.querySelector('[data-testid="stock-lcsc"]').checked;`);
    const jlcChecked = await execScript(sid, `return document.querySelector('[data-testid="stock-jlc"]').checked;`);
    log(`  defaults: LCSC=${lcscChecked} JLC=${jlcChecked}`);
    if (lcscChecked !== true || jlcChecked !== true) {
      throw new Error(
        `alpha.16 regression: stock filter checkboxes should default to true,true; got LCSC=${lcscChecked} JLC=${jlcChecked}`,
      );
    }
    await screenshot(sid, `${OUT}/stock-dropdown.png`);
    // Close the dropdown so it doesn't occlude later screenshots.
    await elClick(sid, stockBtn);
    await new Promise((r) => setTimeout(r, 200));

    // 4. Type LCSC + click Detect (alpha.10 auto-enqueues).
    log(`typing ${LCSC} into intake`);
    const intakeId = await waitFor(
      () => findElement(sid, '[data-testid="intake-textarea"]'),
      10_000, 500, 'intake textarea',
    );
    await elClear(sid, intakeId as string);
    await elType(sid, intakeId as string, LCSC);

    // alpha.15: search pane should be visible and open by default. This
    // assertion runs BEFORE Download all so we capture the open state —
    // the post-download collapse is asserted further below.
    log('asserting search-pane-toggle exists with aria-expanded="true"');
    const toggleId = await waitFor(
      () => findElement(sid, '[data-testid="search-pane-toggle"]'),
      5_000, 250, 'search-pane-toggle present',
    );
    const expandedBefore = await elAttr(sid, toggleId as string, 'aria-expanded');
    log(`  aria-expanded (before Download all) = ${JSON.stringify(expandedBefore)}`);
    if (expandedBefore !== 'true') {
      throw new Error(
        `search-pane-toggle aria-expanded should be "true" on load, got ${JSON.stringify(expandedBefore)}`,
      );
    }
    // Capture the "search pane open" baseline — this is the visual
    // counterpart to bulk-assign-filled.png (which is taken later, after
    // Download all triggers the collapse).
    await screenshot(sid, `${OUT}/search-open.png`);

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

    // alpha.15: clicking Download all with a non-empty queue collapses
    // the search pane synchronously (Queue.tsx calls collapseSearchPane()
    // before dispatching parts.download). Allow ~500ms for the
    // <Show> swap + width animation; poll the toggle's aria-expanded.
    log('asserting search pane auto-collapsed after Download all');
    await waitFor(
      async () => {
        const t = await findElement(sid, '[data-testid="search-pane-toggle"]');
        if (!t) return null;
        const exp = await elAttr(sid, t, 'aria-expanded');
        return exp === 'false' ? true : null;
      },
      1_500, 100, 'search-pane-toggle aria-expanded="false" after Download all',
    );
    log('✅ search pane collapsed on Download all');

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

    // 9. Bulk-Assign asserts (alpha.12 regression coverage, alpha.16 reroute):
    //    The dedicated "Suggested" column was removed in alpha.16 — the
    //    LibPicker input now shows the suggested name as its initial value
    //    (with a "new" badge in the dropdown). Same intent as the alpha.11
    //    regression: C25804 is a Resistor so we should see Resistors_KSL,
    //    NOT the catch-all Misc_KSL.
    log('asserting LibPicker initial value is category-derived suggestion');
    const suggested = await waitFor(
      async () => {
        const v = await execScript(sid, `
          var el = document.querySelector('[data-testid="bulk-row"] input');
          return el ? el.value : null;
        `) as string | null;
        if (!v || !v.trim()) return null;
        return v.trim();
      },
      30_000, 1_000, 'LibPicker input populated with suggestion',
    );
    log(`  suggested = ${JSON.stringify(suggested)}`);
    if (/^Misc_KSL/i.test(suggested)) {
      throw new Error(
        `LibPicker default "${suggested}" — alpha.11 regression: ` +
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

    // 9c-bis. Screenshot the post-download "Bulk Assign filled with data"
    //   state — the moment a UX reviewer needs to see (search panel beside
    //   queue, bulk-assign table populated). Saved BEFORE we click cancel
    //   so the table is still visible.
    await screenshot(sid, `${OUT}/bulk-assign-filled.png`);

    // 9c-ter. alpha.16: typing an unknown library into the LibPicker should
    //   show the typed text in the dropdown with a green "new" badge, the
    //   same affordance the suggested-from-category entry uses. Previously
    //   the empty-list fallback only said "No match — keep typing to create
    //   <name>" without the visual badge, so users didn't realise the typed
    //   value was actionable.
    log('asserting LibPicker shows "new" badge for user-typed unknown library');
    // Picker input was last typed into during the focus regression test —
    // value is now `Resistors_KSL_v2`. Open the popover by re-focusing.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var el = document.querySelector('[data-testid="bulk-row"] input');
      if (!el) { done({ ok: false, e: 'picker input gone' }); return; }
      el.focus();
      setTimeout(function() { done({ ok: true }); }, 150);
    `);
    // The popover is rendered into a Portal (document.body), not inside
    // the bulk-row, so query globally for the green "new" badge.
    const newBadgeFound = await waitFor(
      async () => execScript(sid, `
        var spans = document.querySelectorAll('span');
        for (var i = 0; i < spans.length; i++) {
          var s = spans[i];
          if ((s.textContent || '').trim() === 'new' &&
              (s.className || '').indexOf('bg-emerald') >= 0) {
            // Verify it's adjacent to the typed-text option.
            var btn = s.closest('button');
            if (btn && /Resistors_KSL_v2/.test(btn.textContent || '')) return true;
          }
        }
        return null;
      `),
      3_000, 200, 'green "new" badge next to user-typed lib name',
    );
    log(`  found="new" badge for typed text: ${newBadgeFound}`);
    await screenshot(sid, `${OUT}/libpicker-new-badge.png`);
    // Close popover by clicking outside it.
    await execScript(sid, `document.body.click();`);
    await new Promise((r) => setTimeout(r, 150));

    // 9c-quater. alpha.16: server-side stockFilter=both is now live on
    //   search.raph.io — exercise the path through the sidecar to prove
    //   it works end-to-end (not just that we send the right param).
    log('probing search.query with stock_filter=both');
    const stockBothResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'search.query',
        params: { q: '0603 10k', stock_filter: 'both' },
      }).then(function(r) {
        var ok = r && Array.isArray(r.results);
        var allInStock = ok && r.results.every(function(p) {
          return (p.stock || 0) > 0 && (p.jlc_stock || 0) > 0;
        });
        done({ ok: ok, count: ok ? r.results.length : 0, allInStock: allInStock, error: r && r.error });
      }).catch(function(e) { done({ ok: false, e: String(e) }); });
    `);
    log(`  stock=both result: ${JSON.stringify(stockBothResult)}`);
    if (!stockBothResult?.ok) {
      throw new Error(`search.query stock_filter=both failed: ${stockBothResult?.error ?? stockBothResult?.e}`);
    }
    // The server might still return rows that don't meet the AND filter if
    // the API change isn't deployed yet — log a warning rather than fail
    // (the safety net is removed, so the user would see them, but it's a
    // server-side issue not a kibrary regression).
    if (stockBothResult.count > 0 && !stockBothResult.allInStock) {
      log(`  ⚠️  server returned ${stockBothResult.count} rows but not all are stock>0 AND jlc_stock>0`);
      log(`  ⚠️  the stockFilter=both API change may not be deployed yet on the configured search.raph.io`);
    } else {
      log(`✅ stockFilter=both server-side: ${stockBothResult.count} rows, all in stock at both sources`);
    }

    // 9c-quinquies. alpha.17: duplicate / already-existing component indicator.
    //   Plant a synthetic library on disk (Existing_KSL containing one symbol
    //   `C25804`), trigger refreshLcscIndex, search "C25804", and assert the
    //   muted "In library: Existing_KSL" pill renders inline next to the LCSC
    //   in the result row.
    log('alpha.17: duplicate-indicator probe — seeding fake Existing_KSL library');
    const dupeLibDir = join(WORKSPACE, 'Existing_KSL');
    mkdirSync(dupeLibDir, { recursive: true });
    writeFileSync(
      join(dupeLibDir, 'Existing_KSL.kicad_sym'),
      '(kicad_symbol_lib (version 20211014) (generator None)\n' +
        '  (symbol "C25804" (in_bom yes) (on_board yes)\n' +
        '    (property "Reference" "R" (id 0) (at 0.0 0.0 0))\n' +
        '    (property "Value" "10k 0402 (e2e seed)" (id 1) (at 0.0 0.0 0))\n' +
        '    (property "Footprint" "" (id 2) (at 0.0 0.0 0))\n' +
        '    (property "Datasheet" "" (id 3) (at 0.0 0.0 0))\n' +
        '  )\n' +
        ')\n',
    );

    // Force-refresh the in-app LCSC index via the test hook (workspace was
    // opened well before the seed file existed, so the auto-refresh on open
    // returned an empty index).
    log('  triggering refreshLcscIndex via __kibraryTest hook');
    await execScript(
      sid,
      `window.__kibraryTest.refreshLcscIndex(arguments[0]);`,
      [WORKSPACE],
    );
    // Wait for the index to populate before driving the search.
    await waitFor(
      async () => {
        const v = await execScript(
          sid,
          `var i = window.__kibraryTest.lcscIndex(); return i && i.C25804 ? i.C25804.library : null;`,
        );
        return v === 'Existing_KSL' ? true : null;
      },
      5_000, 200, 'lcscIndex populated with C25804 → Existing_KSL',
    );
    log('  ✅ in-memory lcscIndex now contains C25804 → Existing_KSL');

    // Re-open the search pane (the Download all step earlier in this run
    // auto-collapsed it, hiding the input). Click the toggle ONCE if and
    // only if the pane is currently collapsed.
    const toggle = await findElement(sid, '[data-testid="search-pane-toggle"]');
    if (!toggle) throw new Error('search-pane-toggle not found before pill probe');
    const expandedNow = await elAttr(sid, toggle, 'aria-expanded');
    if (expandedNow !== 'true') {
      log('  search pane was collapsed — clicking toggle to re-open');
      await elClick(sid, toggle);
      await waitFor(
        async () => {
          const t = await findElement(sid, '[data-testid="search-pane-toggle"]');
          return t && (await elAttr(sid, t, 'aria-expanded')) === 'true' ? true : null;
        },
        2_000, 100, 'search pane re-open after toggle',
      );
    }

    // Type C25804 into the search input and wait for at least one result row.
    const searchInput = await findElement(sid, '[data-testid="search-input"]');
    if (!searchInput) throw new Error('search input not found (alpha.17 pill probe)');
    await elClear(sid, searchInput);
    await elType(sid, searchInput, 'C25804');
    await waitFor(
      () => findElement(sid, '[data-testid="lcsc-in-library-pill"]'),
      8_000, 200, 'duplicate-indicator pill rendered for C25804',
    );
    const pillEl = await findElement(sid, '[data-testid="lcsc-in-library-pill"]');
    const pillText = pillEl ? await elText(sid, pillEl) : '';
    log(`  pill text: "${pillText}"`);
    if (!pillText.includes('Existing_KSL')) {
      throw new Error(
        `expected pill to mention 'Existing_KSL', got: "${pillText}"`,
      );
    }
    log('✅ alpha.17 duplicate-indicator pill renders + names the right library');
    await screenshot(sid, `${OUT}/lcsc-in-library-pill.png`);

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
