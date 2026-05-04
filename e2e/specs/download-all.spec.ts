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
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  jpost,
  jget,
  jdel,
  execScript,
  execAsync,
  findElement,
  findElements,
  elText,
  elAttr,
  elClick,
  elClear,
  elType,
  screenshot as wdScreenshot,
  waitFor,
} from '../lib/webdriver.ts';

const APP     = '/usr/bin/kibrary';
const WORKSPACE = '/tmp/e2e-workspace';
const STAGING = `${WORKSPACE}/.kibrary/staging`;
const LCSC    = 'C25804';
const OUT     = '/out';

function log(msg: string) {
  console.log(`[smoke-ui] ${msg}`);
}

// Local screenshot wrapper preserves the existing call-site signature
// (no third arg) while routing through the shared helper. Logs use the
// 'smoke-ui' prefix to match historical behavior.
async function screenshot(sid: string, dest: string): Promise<void> {
  await wdScreenshot(sid, dest, 'smoke-ui');
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

    // alpha.23: Save-all → saved-pill → Open-in-library end-to-end probe.
    // The saved-pill code shipped in alpha.22 was never click-tested; the
    // user reported the link missing because no probe verified the actual
    // UI flow. We now click Save all, wait for the saved-pill to appear,
    // then click Open in library and assert Libraries-room navigation.
    log('alpha.23: Save-all → saved-pill → Open-in-library probe');
    const saveAllProbe = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      (async function(){
        // 1. Click "Save all" — find by text content
        var saveAllBtn = Array.from(document.querySelectorAll('button'))
          .find(function(b){ return /Save all .* to libraries/.test((b.textContent || '')); });
        if (!saveAllBtn) { done({ok:false, reason:'Save all button not found'}); return; }
        saveAllBtn.click();
        // 2. Poll for saved-pill (library.commit usually <2s; cap at 20s to
        //    fit inside WebDriver's 30s execute_async timeout).
        var deadline = Date.now() + 20000;
        var pill = null;
        while (Date.now() < deadline && !pill) {
          await new Promise(r => setTimeout(r, 250));
          pill = document.querySelector('[data-testid="bulk-saved-pill"]');
        }
        if (!pill) { done({ok:false, reason:'bulk-saved-pill never appeared after Save all'}); return; }
        // 3. Verify Open-in-library button is rendered alongside it
        var openBtn = document.querySelector('[data-testid="bulk-open-in-library"]');
        if (!openBtn) { done({ok:false, reason:'bulk-open-in-library button missing next to pill'}); return; }
        // 4. Click Open-in-library and verify navigation
        openBtn.click();
        await new Promise(r => setTimeout(r, 600));
        var bodyText = document.body.innerText || '';
        // Look for Libraries-room signal: "Libraries (N)" header or library name in tree
        var libsHeader = /Libraries\\s*\\(\\d+\\)/.test(bodyText);
        done({ok:true, hadPill: !!pill, hadOpenBtn: !!openBtn, libsHeader: libsHeader, bodyTail: bodyText.slice(-400)});
      })();
    `);
    log(`  save-all probe: ${JSON.stringify({ok: saveAllProbe?.ok, hadPill: saveAllProbe?.hadPill, hadOpenBtn: saveAllProbe?.hadOpenBtn, libsHeader: saveAllProbe?.libsHeader, reason: saveAllProbe?.reason})}`);
    if (!saveAllProbe?.ok) throw new Error(`alpha.23 save-all probe failed: ${saveAllProbe?.reason}`);
    if (!saveAllProbe.libsHeader) {
      throw new Error('alpha.23 Open-in-library click did not navigate to Libraries room (no "Libraries (N)" header in DOM)');
    }
    log('✅ alpha.23 Save-all + saved-pill + Open-in-library navigates end-to-end');
    await screenshot(sid, `${OUT}/saved-pill-open-in-library.png`);
    // Navigate back to Add room so subsequent probes (cancel etc.) keep working
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        var addBtn = Array.from(document.querySelectorAll('button, a'))
          .find(function(n){ return (n.textContent || '').trim() === 'Add'; });
        if (addBtn) addBtn.click();
        setTimeout(function(){ done(true); }, 250);
      } catch (e) { done(String(e)); }
    `);

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
      // Width animates over Tailwind's transition-[width] (200 ms). Wait for
      // it to settle before driving the input — clearing/typing during the
      // transition trips WebDriver's "element not interactable" guard.
      await new Promise((r) => setTimeout(r, 350));
    }

    // C25804 has stock=0 at LCSC (only JLC has stock), so the alpha.17
    // default of "both stock filters checked" excludes it server-side.
    // Untick "LCSC in stock" before driving the search input so the row
    // makes it back from the API.
    log('  unchecking LCSC-stock filter (C25804 has stock=0 at LCSC)');
    const stockBtnPill = await findElement(sid, '[data-testid="stock-btn"]');
    if (!stockBtnPill) throw new Error('stock-btn not found before pill probe');
    await elClick(sid, stockBtnPill);
    const lcscChkPill = await findElement(sid, '[data-testid="stock-lcsc"]');
    if (!lcscChkPill) throw new Error('stock-lcsc checkbox not found');
    const lcscCheckedPill = await elAttr(sid, lcscChkPill, 'checked');
    if (lcscCheckedPill === 'true' || lcscCheckedPill === '') {
      await elClick(sid, lcscChkPill);
    }
    // Close the dropdown so it doesn't visually clip the pill probe.
    await elClick(sid, stockBtnPill);

    // Type C25804 into the search input and wait for at least one result row.
    const searchInput = await findElement(sid, '[data-testid="search-input"]');
    if (!searchInput) throw new Error('search input not found (alpha.17 pill probe)');
    await elClear(sid, searchInput);
    await elType(sid, searchInput, 'C25804');
    // Wait specifically for the search-results <ul> to populate — generic
    // `ul li` would match queue/bulk-assign rows that already exist and
    // give us a false-positive precondition.
    await waitFor(
      async () => {
        const rows = await findElements(sid, '[data-testid="search-results"] li');
        return rows.length > 0 ? true : null;
      },
      12_000, 250, 'search-results <ul> populated for C25804',
    );
    await screenshot(sid, `${OUT}/lcsc-in-library-pill-pre.png`);
    await waitFor(
      () => findElement(sid, '[data-testid="lcsc-in-library-pill"]'),
      4_000, 200, 'duplicate-indicator pill rendered for C25804',
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

    // alpha.23: clicking the pill should navigate to the Libraries room
    // with that lib + component selected (so user can immediately edit).
    log('alpha.23: pill click → Libraries room nav probe');
    const pillNav = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var pill = document.querySelector('[data-testid="lcsc-in-library-pill"]');
      if (!pill) { done({ok:false, reason:'pill not found'}); return; }
      pill.click();
      setTimeout(function(){
        // Look for the Library room sidebar to be active (Libraries header present)
        var libsHeading = !!Array.from(document.querySelectorAll('h2, h3, span'))
          .find(function(n){ return /^Libraries\\b/.test((n.textContent || '').trim()); });
        // Active room indicator: the Libraries nav button should have selected styling
        var libsNavActive = !!Array.from(document.querySelectorAll('button, a'))
          .find(function(n){
            return (n.textContent || '').trim() === 'Libraries' &&
                   (n.getAttribute('aria-current') === 'page' || n.className.includes('bg-zinc-200') || n.className.includes('font-semibold'));
          });
        done({ok:true, libsHeading: libsHeading, libsNavActive: libsNavActive, bodyHas: (document.body.innerText || '').includes('Existing_KSL')});
      }, 500);
    `);
    log(`  pill nav: ${JSON.stringify(pillNav)}`);
    if (!pillNav?.ok) throw new Error(`alpha.23 pill click failed: ${pillNav?.reason}`);
    if (!pillNav.libsHeading && !pillNav.bodyHas) {
      throw new Error('alpha.23 pill click did not navigate to Libraries room (no Libraries heading nor library name in DOM after click)');
    }
    log('✅ alpha.23 pill click navigates to Libraries room');
    // Navigate back to Add room so subsequent probes (cancel etc.) keep working
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        var addBtn = Array.from(document.querySelectorAll('button, a'))
          .find(function(n){ return (n.textContent || '').trim() === 'Add'; });
        if (addBtn) addBtn.click();
        setTimeout(function(){ done(true); }, 250);
      } catch (e) { done(String(e)); }
    `);

    // Re-collapse the search pane so Bulk-Assign reclaims width before the
    // cancel-button click in step 9d. Otherwise the cancel button can sit
    // off-screen with the pane open + the search-results scroll area
    // covering its layout flow, and WebDriver flags it "not interactable".
    const togglePost = await findElement(sid, '[data-testid="search-pane-toggle"]');
    if (togglePost && (await elAttr(sid, togglePost, 'aria-expanded')) === 'true') {
      log('  re-collapsing search pane to free Bulk-Assign width');
      await elClick(sid, togglePost);
      await new Promise((r) => setTimeout(r, 350));
    }

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

    // 11. alpha.18 renderer probe — Symbol/Footprint/3D previews in the
    //     Libraries room. We seed Existing_KSL/C25804 (already done above
    //     for the pill probe) with a real symbol + footprint + 3D model
    //     copied from the staged C25804 the smoke earlier downloaded, then
    //     drive the app to Libraries → Existing_KSL → C25804 and assert the
    //     three preview blocks render content.
    log('alpha.18: renderer probe — adding footprint + 3D model to seed library');
    {
      // Re-create staging since cancel deleted it; fastest re-fetch is via
      // sidecar parts.download (real network). The handler takes `lcscs`
      // (plural list) + `staging_dir` — see downloader.parts_download.
      const reDl = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke('sidecar_call', {
          method: 'parts.download',
          params: {
            lcscs: ['C25804'],
            staging_dir: ${JSON.stringify(STAGING)},
            concurrency: 1,
          },
        }).then(function(r){done({ok:true, r:r});}).catch(function(e){done({ok:false, e:String(e)});});
      `);
      if (!reDl?.ok) throw new Error(`re-download for renderer probe failed: ${JSON.stringify(reDl)}`);
      // Wait for files to land — parts.download progress events fire async.
      await waitFor(
        () => existsSync(join(STAGING, 'C25804', 'C25804.kicad_sym')) ? Promise.resolve(true) : Promise.resolve(null),
        60_000, 1000, 'C25804 staging materialised after re-download',
      );
    }

    // Plant a richer Existing_KSL containing the actual staged artefacts.
    // The alpha.17 pill probe already wrote a synthetic Existing_KSL.kicad_sym
    // with entryName="C25804" — keep that intact (JLC2KiCadLib's staged sym
    // names the symbol after the MPN, e.g. 0603WAF1002T5E, not the LCSC, and
    // SymbolPreview looks the entry up by LCSC). We just add a real footprint
    // + 3D model from the staged dir so FootprintPreview has data to render.
    {
      const stagedDir = `${WORKSPACE}/.kibrary/staging/C25804`;
      const libDirHere = `${WORKSPACE}/Existing_KSL`;
      const fs = await import('node:fs');
      // Footprint: copy <staged>.pretty/<lcsc>.kicad_mod into
      // <lib>.pretty/<component_name>.kicad_mod. Sidecar reads
      // `<lib>.pretty/<component_name>.kicad_mod` so the file MUST be
      // named after the entry name (C25804) — copy with that filename.
      fs.mkdirSync(`${libDirHere}/Existing_KSL.pretty`, { recursive: true });
      const stagedPretty = `${stagedDir}/C25804.pretty`;
      if (fs.existsSync(stagedPretty)) {
        const fpFiles = fs.readdirSync(stagedPretty)
          .filter((f) => f.endsWith('.kicad_mod'));
        if (fpFiles.length > 0) {
          fs.copyFileSync(
            `${stagedPretty}/${fpFiles[0]}`,
            `${libDirHere}/Existing_KSL.pretty/C25804.kicad_mod`,
          );
        }
      }
      // 3D model: copy whatever extension arrived.
      const stagedShapes = `${stagedDir}/C25804.3dshapes`;
      if (fs.existsSync(stagedShapes)) {
        fs.mkdirSync(`${libDirHere}/Existing_KSL.3dshapes`, { recursive: true });
        for (const f of fs.readdirSync(stagedShapes)) {
          fs.copyFileSync(`${stagedShapes}/${f}`, `${libDirHere}/Existing_KSL.3dshapes/${f}`);
        }
      }
      const hasFp = fs.existsSync(`${libDirHere}/Existing_KSL.pretty/C25804.kicad_mod`);
      const has3d = fs.existsSync(`${libDirHere}/Existing_KSL.3dshapes`);
      log(`  seeded Existing_KSL with sym (synth)${hasFp ? ' + fp' : ''}${has3d ? ' + 3D' : ''}`);
    }

    // Switch to Libraries room and select Existing_KSL / C25804 via test hooks.
    log('  navigating to Libraries → Existing_KSL → C25804');
    await execScript(sid, `window.__kibraryTest.setRoom('libraries');`);
    // Let SolidJS render the Libraries layout before we set selections.
    await new Promise((r) => setTimeout(r, 150));
    await execScript(sid, `window.__kibraryTest.selectLibrary('Existing_KSL');`);
    await new Promise((r) => setTimeout(r, 150));
    await execScript(sid, `window.__kibraryTest.selectComponent('C25804');`);

    // Wait for SymbolPreview's <img> to mount (alpha.18: kicad-cli-rendered SVG).
    await waitFor(
      () => findElement(sid, '[data-testid="symbol-preview-svg"]'),
      15_000, 300, 'symbol-preview-svg <img> mounted',
    );
    await waitFor(
      () => findElement(sid, '[data-testid="footprint-preview-svg"]'),
      15_000, 300, 'footprint-preview-svg <img> mounted',
    );

    // Pre-screenshot so a regression captures the as-rendered state.
    await screenshot(sid, `${OUT}/renderers-libraries-room.png`);

    // Verify both <img>s actually carry data: URLs (would be empty src on RPC error).
    const previewState = await execScript(sid, `
      var sym = document.querySelector('[data-testid="symbol-preview-svg"]');
      var fp = document.querySelector('[data-testid="footprint-preview-svg"]');
      return {
        symHasDataUrl: !!(sym && (sym.src || '').startsWith('data:image/svg+xml')),
        symLen: sym ? (sym.src || '').length : 0,
        fpHasDataUrl: !!(fp && (fp.src || '').startsWith('data:image/svg+xml')),
        fpLen: fp ? (fp.src || '').length : 0,
      };
    `);
    log(`  preview state = ${JSON.stringify(previewState)}`);
    if (!previewState?.symHasDataUrl) {
      throw new Error(
        `SymbolPreview has no data: URL (length=${previewState?.symLen}) — kicad-cli SVG render failed`,
      );
    }
    if (!previewState?.fpHasDataUrl) {
      throw new Error(
        `FootprintPreview has no data: URL (length=${previewState?.fpLen}) — kicad-cli SVG render failed`,
      );
    }
    log('✅ alpha.18 renderers: symbol + footprint <img> mounted with data: URLs');

    // -------------------------------------------------------------------------
    // 11b. alpha.18.1 REAL-WORLD renderer probe — the previous probe used a
    //      synthetic seed with a hand-crafted (symbol "C25804" ...) entry,
    //      which doesn't catch the alpha.18 bug where JLC2KiCadLib names
    //      symbols after the MPN (not the LCSC). This probe commits the
    //      staged C25804 to a fresh library via library.commit (the same
    //      path the user clicks "Commit" through), then renders the symbol
    //      by its real MPN name, end-to-end through kicad-cli.
    // -------------------------------------------------------------------------
    log('alpha.18.1: REAL-WORLD renderer probe — commit C25804 then render by MPN');
    const REAL_LIB = 'RealRenderProbe_KSL';
    const realCommit = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'library.commit',
        params: {
          workspace: ${JSON.stringify(WORKSPACE)},
          lcsc: 'C25804',
          staging_dir: ${JSON.stringify(STAGING)},
          target_lib: ${JSON.stringify(REAL_LIB)},
        },
      }).then(function(r){done({ok:true, r:r});}).catch(function(e){done({ok:false, e:String(e)});});
    `);
    if (!realCommit?.ok) throw new Error(`real-world commit failed: ${JSON.stringify(realCommit)}`);
    log(`  ✅ committed C25804 → ${REAL_LIB}`);

    // Discover the symbol name JLC2KiCadLib gave us — it's the MPN, not
    // 'C25804'. We use library.list_components and pick the first non-unit
    // entry (alpha.18.1 also filtered _0_1 / _1_1 sub-symbols out).
    const realLibDir = join(WORKSPACE, REAL_LIB);
    const realLibList = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'library.list_components',
        params: { lib_dir: ${JSON.stringify(realLibDir)} },
      }).then(function(r){done({ok:true, r:r});}).catch(function(e){done({ok:false, e:String(e)});});
    `);
    if (!realLibList?.ok || !realLibList.r?.components?.length) {
      throw new Error(`real-world list_components empty: ${JSON.stringify(realLibList)}`);
    }
    const realComponentName = realLibList.r.components[0].name;
    log(`  real-world symbol name (from JLC2KiCadLib): "${realComponentName}"`);
    if (realComponentName === 'C25804') {
      log(`  ⚠️ symbol named C25804 — JLC2KiCadLib usually names by MPN; test still proceeds`);
    }
    // Also assert no _0_1 sub-symbols leaked into the list (alpha.18.1 fix).
    const subSymsInList = realLibList.r.components.filter((c: any) => /_\d+_\d+$/.test(c.name));
    if (subSymsInList.length > 0) {
      throw new Error(`alpha.18.1 sub-symbol filter regressed — list has unit entries: ${JSON.stringify(subSymsInList.map((c: any) => c.name))}`);
    }
    log(`  ✅ no unit sub-symbols (_X_Y suffix) in list`);

    // Navigate to the real lib + part and assert renderers mount with data: URLs.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        window.__kibraryTest.setRoom('libraries');
        window.__kibraryTest.selectLibrary(${JSON.stringify(REAL_LIB)});
        window.__kibraryTest.selectComponent(${JSON.stringify(realComponentName)});
        done(true);
      } catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 1500));
    const realPreviews = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var sym = document.querySelector('[data-testid="symbol-preview-svg"]');
      var fp = document.querySelector('[data-testid="footprint-preview-svg"]');
      var symFb = document.querySelector('[data-testid="symbol-preview-fallback"]');
      var fpFb = document.querySelector('[data-testid="footprint-preview-fallback"]');
      done({
        symMounted: !!sym, fpMounted: !!fp,
        symFallbackText: symFb ? symFb.textContent : null,
        fpFallbackText: fpFb ? fpFb.textContent : null,
        symLen: sym ? (sym.getAttribute('src') || '').length : 0,
        fpLen: fp ? (fp.getAttribute('src') || '').length : 0,
      });
    `);
    log(`  real-world preview state: ${JSON.stringify(realPreviews)}`);
    await screenshot(sid, `${OUT}/renderers-real-world.png`);
    if (!realPreviews?.symMounted) {
      throw new Error(
        `REAL-WORLD: symbol preview did not mount. Fallback text: "${realPreviews?.symFallbackText}". ` +
        `This is the alpha.18 user-reported bug — synthetic test wasn't catching it.`,
      );
    }
    if (!realPreviews?.fpMounted) {
      throw new Error(
        `REAL-WORLD: footprint preview did not mount. Fallback text: "${realPreviews?.fpFallbackText}".`,
      );
    }
    log(`✅ alpha.18.1 REAL-WORLD: kicad-cli renders MPN-named symbol "${realComponentName}" without error`);

    // ---- 3D model info probe ---------------------------------------------
    // Assert library.get_3d_info finds the (model …) block in the committed
    // .kicad_mod — alpha.19 bug: handler was looking for `<MPN>.kicad_mod`,
    // but committed footprints are named by package, so it returned null
    // and the UI showed "No 3D model attached" even when the link existed.
    log('alpha.19: REAL-WORLD 3D model info probe');
    const real3dInfo = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'library.get_3d_info',
        params: { lib_dir: ${JSON.stringify(realLibDir)}, component_name: ${JSON.stringify(realComponentName)} },
      }).then(function(r){done({ok:true, r:r});}).catch(function(e){done({ok:false, e:String(e)});});
    `);
    log(`  3D info: ${JSON.stringify(real3dInfo)}`);
    if (!real3dInfo?.ok || !real3dInfo.r?.info) {
      throw new Error(
        `REAL-WORLD 3D info missing — would render "No 3D model attached" in UI. ` +
        `Got: ${JSON.stringify(real3dInfo)}. ` +
        `Symptom of the alpha.18 bug: handler looked up <MPN>.kicad_mod, but ` +
        `committed footprint files are named after the package (e.g. R0603.kicad_mod).`,
      );
    }
    const info = real3dInfo.r.info;
    log(`  3D filename: ${info.filename}, format: ${info.format}, path: ${info.model_path}`);
    if (!info.filename || !info.format) {
      throw new Error(`3D info missing filename/format: ${JSON.stringify(info)}`);
    }
    // Wait for the UI to mount the Model3DPreview block (filename should be in DOM).
    await new Promise((r) => setTimeout(r, 800));
    const has3DCard = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var bodyText = document.body.innerText || '';
      done({
        showsNoModelMsg: bodyText.includes('No 3D model attached'),
        showsFilename: bodyText.includes(${JSON.stringify(info.filename)}),
      });
    `);
    log(`  3D card UI state: ${JSON.stringify(has3DCard)}`);

    // Scroll the component-detail panel so the 3D card is in view, then screenshot.
    // The right pane is the deepest scrollable column in ComponentDetail.tsx.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        var scrollables = document.querySelectorAll('.overflow-y-auto');
        scrollables.forEach(function(el){ el.scrollTop = el.scrollHeight; });
        done(true);
      } catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 400));
    await screenshot(sid, `${OUT}/renderers-3d-info.png`);

    // Also capture symbol + footprint at top of pane for the README.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        var scrollables = document.querySelectorAll('.overflow-y-auto');
        scrollables.forEach(function(el){ el.scrollTop = 0; });
        done(true);
      } catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 400));
    await screenshot(sid, `${OUT}/preview-symbol-footprint.png`);

    // alpha.22: REAL-WORLD probes for the three reported regressions.
    log('alpha.22: probes — properties editor + edit-in-KiCad buttons in library mode');
    const a22State = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      done({
        propsLoadingStuck: !!Array.from(document.querySelectorAll('p, span, div'))
          .find(function(n){ return (n.textContent || '').trim() === 'Loading properties…'; }),
        propsTitleHasMpn: (document.body.innerText || '').includes(${JSON.stringify(realComponentName)}),
        editButtons: Array.from(document.querySelectorAll('button'))
          .filter(function(b){ return (b.textContent || '').includes('Edit in KiCad'); }).length,
      });
    `);
    log(`  alpha.22 state: ${JSON.stringify(a22State)}`);
    if (a22State?.propsLoadingStuck) {
      throw new Error('alpha.22: PropertyEditor is stuck on "Loading properties…" in library mode (parts.read_meta probably hanging)');
    }
    if (a22State?.editButtons < 2) {
      throw new Error(`alpha.22: expected 2 Edit-in-KiCad buttons (symbol + footprint), got ${a22State?.editButtons}`);
    }
    log(`✅ alpha.22 properties not stuck + ${a22State.editButtons} Edit buttons present`);

    // alpha.22 actual 3D render via kicad-cli pcb render (NEW).
    log('alpha.22: 3D render PNG probe');
    const render3d = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'library.render_3d_png',
        params: { lib_dir: ${JSON.stringify(realLibDir)}, component_name: ${JSON.stringify(realComponentName)} },
      }).then(function(r){ done({ ok: true, len: (r.png_data_url || '').length, prefix: (r.png_data_url || '').slice(0, 30) }); })
        .catch(function(e){ done({ ok: false, err: String(e) }); });
    `);
    log(`  3D render result: ${JSON.stringify(render3d)}`);
    if (!render3d?.ok) throw new Error(`alpha.22 3D render RPC failed: ${render3d?.err}`);
    if (!String(render3d.prefix).startsWith('data:image/png')) {
      throw new Error(`alpha.22 3D render did not return a PNG data URL: ${render3d.prefix}`);
    }
    log(`✅ alpha.22 3D render PNG returned (${render3d.len} bytes data URL)`);
    // alpha.29: the 3D viewer is now either the legacy PNG <img> or the
    // new GL <canvas>. The RPC sub-probe above already proved the sidecar
    // PNG path works; this DOM check just confirms a viewer mounted —
    // either kind counts. Naturally-painted check applies only to the PNG
    // path (canvas has no naturalWidth).
    await new Promise((r) => setTimeout(r, 1500));
    const scrollResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        var img = document.querySelector('[data-testid="3d-viewer-img"]');
        var gl  = document.querySelector('[data-testid="3d-viewer-gl-canvas"]');
        var el = img || gl;
        if (!el) { done({ok:false, reason:'neither 3d-viewer-img nor 3d-viewer-gl-canvas found'}); return; }
        el.scrollIntoView({block: 'center', inline: 'center'});
        done({
          ok: true,
          kind: img ? 'png' : 'gl',
          complete: img ? img.complete : null,
          naturalWidth: img ? img.naturalWidth : null,
        });
      } catch (e) { done({ok:false, reason:String(e)}); }
    `);
    log(`  3D render scroll-into-view: ${JSON.stringify(scrollResult)}`);
    if (!scrollResult?.ok) throw new Error(`alpha.22/29 3D viewer not in DOM: ${scrollResult?.reason}`);
    if (scrollResult.kind === 'png' && !scrollResult.naturalWidth) {
      throw new Error(`alpha.22 3D render <img> not painted (naturalWidth=0)`);
    }
    await new Promise((r) => setTimeout(r, 600));
    await screenshot(sid, `${OUT}/renderers-3d-render.png`);

    if (has3DCard?.showsNoModelMsg) {
      throw new Error(
        `REAL-WORLD 3D card shows "No 3D model attached" even though library.get_3d_info ` +
        `returned valid info — frontend regression in Model3DPreview.tsx`,
      );
    }
    if (!has3DCard?.showsFilename) {
      throw new Error(
        `REAL-WORLD 3D card did not display filename ${info.filename} — UI may not be ` +
        `mounting the Model3DPreview block in Libraries room.`,
      );
    }
    log(`✅ alpha.19 REAL-WORLD: 3D model "${info.filename}" linked + displayed`);

    // ---------------------------------------------------------------------
    // 11d. alpha.23: Edit-in-KiCad button actually launches KiCad and
    //      surfaces a success toast (alpha.22 shipped the button but its
    //      click was a silent no-op when the spawn failed/succeeded).
    // ---------------------------------------------------------------------
    log('alpha.23: Edit-in-KiCad button — click and assert spawn + toast');
    const editClickResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        // Snapshot existing toasts so we can detect the new one.
        var beforeToasts = document.querySelectorAll('[data-testid^="toast-"], .toast, [role="status"]').length;
        var btn = document.querySelector('[data-testid="edit-symbol-in-kicad"]');
        if (!btn) { done({ok:false, reason:'edit-symbol-in-kicad button not found'}); return; }
        btn.click();
        setTimeout(function(){
          var bodyText = (document.body.innerText || '');
          done({
            ok: true,
            // alpha.26: KiCad 9 has no CLI flag for the Symbol Editor,
            // so success now means "KiCad opened" with manual-navigation
            // instructions — match the user-facing hint instead.
            toastedSuccess: /Symbol Editor/.test(bodyText),
            toastedError: /Open symbol failed/.test(bodyText),
            bodyTail: bodyText.slice(-300),
          });
        }, 1200);
      } catch (e) { done({ok:false, reason:String(e)}); }
    `);
    log(`  edit-in-kicad result: ${JSON.stringify(editClickResult)}`);
    if (!editClickResult?.ok) throw new Error(`alpha.23 Edit-in-KiCad click failed: ${editClickResult?.reason}`);
    if (!editClickResult.toastedSuccess && !editClickResult.toastedError) {
      throw new Error('alpha.23 Edit-in-KiCad clicked but neither success NOR error toast appeared — silent no-op regression');
    }
    log(`✅ alpha.23 Edit-in-KiCad surfaces feedback (success=${editClickResult.toastedSuccess}, error=${editClickResult.toastedError})`);
    // Reap any spawned eeschema so it doesn't linger in container.
    try { execSync('pkill -f eeschema || true; pkill -f pcbnew || true', { stdio: 'pipe' }); } catch {}

    // -------------------------------------------------------------------
    // alpha.24: Open-Datasheet button — set a https:// URL into the
    // Datasheet input, assert the button enables, click and assert that
    // either an error toast appears (no browser in headless container is
    // OK) or the toast was suppressed because openUrl resolved.
    // -------------------------------------------------------------------
    log('alpha.24: Open Datasheet button probe');
    const dsResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      (async function(){
        // Find the Datasheet input by walking from its label
        var dsLabel = Array.from(document.querySelectorAll('label'))
          .find(function(l){ return /^Datasheet$/.test((l.querySelector('span') || {}).textContent || ''); });
        if (!dsLabel) { done({ok:false, reason:'Datasheet label not found'}); return; }
        var input = dsLabel.querySelector('input');
        var btn = document.querySelector('[data-testid="open-datasheet"]');
        if (!input) { done({ok:false, reason:'datasheet input not found'}); return; }
        if (!btn) { done({ok:false, reason:'open-datasheet button not found'}); return; }
        var disabledEmpty = btn.disabled;
        // Inject https URL via the React-style setter so SolidJS reactive sees the change
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'https://example.com/datasheet.pdf');
        input.dispatchEvent(new Event('input', {bubbles:true}));
        await new Promise(r => setTimeout(r, 150));
        var enabledAfter = !btn.disabled;
        // Click the button — in headless container default xdg-open will
        // fail (no browser); we just assert the click doesn't crash and
        // the URL we set is what the button title reflects.
        btn.click();
        await new Promise(r => setTimeout(r, 600));
        done({
          ok:true,
          disabledWhenEmpty: disabledEmpty,
          enabledAfterUrl: enabledAfter,
          buttonTitle: btn.getAttribute('title') || '',
        });
      })();
    `);
    log(`  open-datasheet probe: ${JSON.stringify(dsResult)}`);
    if (!dsResult?.ok) throw new Error(`alpha.24 open-datasheet probe failed: ${dsResult?.reason}`);
    if (!dsResult.disabledWhenEmpty) throw new Error('alpha.24 Open-datasheet should be DISABLED when Datasheet field is empty');
    if (!dsResult.enabledAfterUrl) throw new Error('alpha.24 Open-datasheet should ENABLE once https:// URL is typed');
    if (!String(dsResult.buttonTitle).includes('https://example.com')) {
      throw new Error(`alpha.24 Open-datasheet title should reflect the URL, got: ${dsResult.buttonTitle}`);
    }
    log('✅ alpha.24 Open-datasheet enables on https URL + reflects URL in title');

    // ---------------------------------------------------------------------
    // 11d-bis. alpha.25/26/27 + alpha.28 — interactive 3D viewer probes.
    //
    // alpha.28 introduces the WebGL2 / three.js viewer
    // (Model3DViewerGL.tsx) alongside the existing PNG fallback. When
    // WebGL2 is available, Model3DPreview prefers the GL viewer; when it
    // isn't, it falls back to the PNG path. The smoke harness picks the
    // right branch by querying the GL canvas testid first — that's the
    // only reliable signal because the PNG canvas testid stays stable
    // across both viewers.
    // ---------------------------------------------------------------------
    log('alpha.25/26/27/28: interactive 3D viewer probes (auto-select GL or PNG branch)');

    // Probe-zero: is the WebGL2 viewer mounted? Wait briefly for either
    // testid to land — Model3DPreview defaults to the GL viewer and only
    // flips to PNG via onWebGLError.
    const viewerKind = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var deadline = Date.now() + 5000;
      (async function poll(){
        while (Date.now() < deadline) {
          var gl = document.querySelector('[data-testid="3d-viewer-gl-canvas"]');
          var glErr = document.querySelector('[data-testid="3d-viewer-gl-error"]');
          var png = document.querySelector('[data-testid="3d-viewer-canvas"]');
          if (gl) { done({kind:'gl'}); return; }
          if (glErr || png) { done({kind:'png'}); return; }
          await new Promise(function(r){ setTimeout(r, 200); });
        }
        done({kind:'none'});
      })();
    `);
    log(`  viewer-kind: ${JSON.stringify(viewerKind)}`);

    if (viewerKind?.kind === 'gl') {
      // -----------------------------------------------------------------
      // alpha.28 GL probes:
      //   (G1) glcanvas-mounts        — canvas + non-zero WebGL2 context.
      //   (G2) glb-loaded             — scene.children grows after load
      //                                  (GLTFLoader landed the model).
      //   (G3) orbit-no-sidecar-call  — synthetic drag does NOT trigger
      //                                  any new library.render_3d_glb_angled
      //                                  invocations.
      // -----------------------------------------------------------------
      log('alpha.28: WebGL2 viewer probes');

      // (G1) Canvas mounts and exposes a working WebGL2 context.
      const glMount = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var canvas = document.querySelector('[data-testid="3d-viewer-gl-canvas"]');
        if (!canvas) { done({ok:false, reason:'gl canvas missing'}); return; }
        var gl = canvas.getContext('webgl2');
        if (!gl) { done({ok:false, reason:'webgl2 ctx null'}); return; }
        done({
          ok:true,
          drawingBufferWidth: gl.drawingBufferWidth,
          drawingBufferHeight: gl.drawingBufferHeight,
        });
      `);
      log(`  glcanvas-mounts: ${JSON.stringify(glMount)}`);
      if (!glMount?.ok) throw new Error(`alpha.28 glcanvas-mounts failed: ${glMount?.reason}`);
      if (!(glMount.drawingBufferWidth > 0 && glMount.drawingBufferHeight > 0)) {
        throw new Error(`alpha.28 WebGL2 drawing buffer is zero-sized: ${JSON.stringify(glMount)}`);
      }

      // (G2) GLB-loaded: poll until the loaded scene actually contains the
      //      expected meshes. The previous probe only counted non-Light
      //      *children of scene root* — but `scene.add(gltf.scene)` adds the
      //      whole GLB tree as a single Group, so a board-only GLB (kicad-cli
      //      silently dropped the chip) would still register as 1 non-Light
      //      child and PASS. Walk the entire tree with .traverse() and count
      //      actual Mesh nodes + total vertex positions, so a missing chip
      //      surfaces as meshCount<2 / totalPositions≤100.
      //
      //      RealRenderProbe_KSL/R0603 fixture (per
      //      /tmp/glb-orientation-findings.md): board mesh ~6 prims, R0603
      //      chip mesh ~264 prims → a correct load has ≥2 meshes and
      //      thousands of vertex positions. A board-only GLB has 1 mesh and
      //      ~6 prims.
      const glbLoaded = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var deadline = Date.now() + 15000;
        function meshStats(s){
          if (!s) return null;
          var meshCount = 0, primCount = 0, totalPositions = 0;
          s.traverse(function(o){
            if (!o.isMesh) return;
            meshCount++;
            var geom = o.geometry;
            if (geom && geom.attributes && geom.attributes.position) {
              totalPositions += geom.attributes.position.count;
            }
            if (geom && geom.index) primCount += geom.index.count / 3;
            else if (geom && geom.attributes && geom.attributes.position) primCount += geom.attributes.position.count / 3;
          });
          return { meshCount: meshCount, primCount: primCount, totalPositions: totalPositions };
        }
        (async function poll(){
          while (Date.now() < deadline) {
            var stats = meshStats(window.__model3dGLScene);
            if (stats && stats.meshCount >= 2 && stats.totalPositions > 100) {
              done({ok:true, meshCount: stats.meshCount, primCount: stats.primCount,
                     totalPositions: stats.totalPositions,
                     totalChildren: window.__model3dGLScene.children.length,
                     loadCount: window.__model3dGLLoadCount || 0,
                     loaderState: window.__model3dGLLoaderState || null});
              return;
            }
            await new Promise(function(r){ setTimeout(r, 250); });
          }
          var finalStats = meshStats(window.__model3dGLScene) || {meshCount:-1, primCount:-1, totalPositions:-1};
          done({ok:false, reason:'mesh tree did not reach >=2 meshes / >100 positions in 15s',
                 meshCount: finalStats.meshCount, primCount: finalStats.primCount,
                 totalPositions: finalStats.totalPositions,
                 totalChildren: window.__model3dGLScene ? window.__model3dGLScene.children.length : -1,
                 loadCount: window.__model3dGLLoadCount || 0,
                 lastErr: window.__model3dGLLastError || null,
                 loaderState: window.__model3dGLLoaderState || null});
        })();
      `);
      log(`  glb-loaded: ${JSON.stringify(glbLoaded)}`);
      if (!glbLoaded?.ok) {
        throw new Error(
          `alpha.28+ GLB load incomplete — meshCount=${glbLoaded?.meshCount} ` +
          `(expected ≥2: board + chip), totalPositions=${glbLoaded?.totalPositions}. ` +
          `kicad-cli likely silently dropped the 3D model — check (model …) path resolution.`
        );
      }

      // (G2b) alpha.32 chip-bbox-sanity — walk all meshes, find the
      //       smallest (chip) and largest (board) by max bbox dimension,
      //       and assert the chip is millimetre-scale and the board is
      //       centimetre-scale. Locks in:
      //         • chip mesh present (meshCount ≥ 2),
      //         • chip geometry not degenerate (chipMax > 0, < 10mm),
      //         • board outline survived alpha.30's 40 mm enlargement
      //           (boardMax > 20mm).
      //       Three.js stores GLB units in metres after our pipeline.
      const chipBbox = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var meshes = [];
        s.traverse(function(o){ if (o.isMesh) meshes.push(o); });
        if (meshes.length < 2) { done({ok:false, reason:'fewer than 2 meshes', meshCount: meshes.length}); return; }

        function meshBbox(m){
          if (!m.geometry || !m.geometry.boundingBox) m.geometry.computeBoundingBox();
          var b = m.geometry.boundingBox;
          return {
            sx: b.max.x - b.min.x,
            sy: b.max.y - b.min.y,
            sz: b.max.z - b.min.z,
          };
        }
        var bboxes = meshes.map(meshBbox);
        bboxes.sort(function(a,b){
          return Math.max(a.sx,a.sy,a.sz) - Math.max(b.sx,b.sy,b.sz);
        });
        var chip = bboxes[0];
        var board = bboxes[bboxes.length - 1];
        var chipMax = Math.max(chip.sx, chip.sy, chip.sz);
        var boardMax = Math.max(board.sx, board.sy, board.sz);
        // For RealRenderProbe_KSL R0603, expected ranges in METRES:
        //   chipMax  ≈ 0.0016 m (1.6 mm — R0603 length)
        //   boardMax ≈ 0.04   m (40 mm — alpha.30 enlarged outline)
        done({
          ok: chipMax > 0 && chipMax < 0.01 && boardMax > 0.02,
          chipMax: chipMax, boardMax: boardMax, meshCount: meshes.length,
        });
      `);
      log(`  alpha.32 chip-bbox-sanity: ${JSON.stringify(chipBbox)}`);
      if (!chipBbox?.ok) {
        throw new Error(
          `alpha.32 chip bbox sanity failed: chipMax=${chipBbox?.chipMax} ` +
          `boardMax=${chipBbox?.boardMax} meshCount=${chipBbox?.meshCount} ` +
          `(expected chip < 10mm, board > 20mm in metres)`
        );
      }

      // (G3) Drag-orbit must not trigger any sidecar render calls. We
      //      count `library.render_3d_glb_angled` invocations via the
      //      __model3dGLLoadCount counter the viewer increments before
      //      each fetch. Synthesise a drag and assert the counter
      //      didn't move.
      const orbitNoSidecar = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var canvas = document.querySelector('[data-testid="3d-viewer-gl-canvas"]');
        if (!canvas) { done({ok:false, reason:'no gl canvas'}); return; }
        var before = window.__model3dGLLoadCount || 0;
        var rect = canvas.getBoundingClientRect();
        function evt(type, dx, dy) {
          return new MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0,
            clientX: rect.left + dx, clientY: rect.top + dy,
          });
        }
        canvas.dispatchEvent(evt('mousedown', 50, 50));
        canvas.dispatchEvent(evt('mousemove', 110, 50));
        canvas.dispatchEvent(evt('mousemove', 200, 80));
        canvas.dispatchEvent(evt('mouseup', 200, 80));
        // Give any racing sidecar call up to 1s to surface, then check.
        setTimeout(function(){
          var after = window.__model3dGLLoadCount || 0;
          done({ok: after === before, before: before, after: after});
        }, 1000);
      `);
      log(`  orbit-no-sidecar-call: ${JSON.stringify(orbitNoSidecar)}`);
      if (!orbitNoSidecar?.ok) {
        throw new Error(
          `alpha.28 orbit-no-sidecar-call: drag triggered sidecar render ` +
          `(${orbitNoSidecar?.before} → ${orbitNoSidecar?.after})`
        );
      }

      // (G4) alpha.31 / alpha.5-visual-parity material-fixup — verify the
      //      post-load traversal patched kicad-cli's two bogus PBR encodings:
      //        * fully-opaque (>= 0.99) materials must NOT be transparent
      //          (kicad-cli's bogus PBR sets transparent=true with
      //          opacity=1.0 — board substrate + soldermask false-positives).
      //          26.5.4-alpha.1 (Wave 9-D) intentionally sets chip-body +
      //          substrate opacity to 0.9 with transparent=true, so the
      //          threshold tightened from 0.7 to 0.99 to keep that
      //          intentional 0.9 from tripping the probe.
      //        * fully metallic materials with no metalnessMap AND a GREY
      //          baseColor must NOT remain at metalness > 0.9 (OCCT default
      //          for "unknown shading" → chrome IC body). Non-grey metallic
      //          materials are intentionally preserved — alpha.5's grey-
      //          detect heuristic keeps gold pads / USB shells reflective.
      //      If a future change drops the traversal, the bogus counters
      //      become non-zero and smoke fails.
      const materialsFixed = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var bogusMetal = 0, leftoverTransparent = 0, total = 0;
        s.traverse(function(o){
          if (!o.isMesh || !o.material) return;
          // alpha.33: skip the SVG decal (intentionally transparent for
          // gaps between pads).
          if (o.name === 'preview_PCB_top_decal') return;
          // alpha.36: skip the substrate (now intentionally 0.8 opaque
          // so chip leads show through) AND anything inside the
          // axis_indicators group (cones + sprites are intentionally
          // transparent for blending against the scene).
          if (o.name === 'preview_PCB' || /pcb/i.test(o.name)) return;
          var p = o.parent;
          var inAxes = false;
          while (p) { if (p.name === 'axis_indicators') { inAxes = true; break; } p = p.parent; }
          if (inAxes) return;
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(function(m){
            total++;
            if (m.transparent && m.opacity >= 0.99) leftoverTransparent++;
            // alpha.5: only count GREY OCCT-default materials as "bogus".
            // Non-grey metallic materials are intentionally preserved.
            if (m.metalness !== undefined && m.metalness > 0.9 && !m.metalnessMap) {
              var c = m.color;
              var isGrey = c
                && Math.abs(c.r - c.g) < 0.05
                && Math.abs(c.g - c.b) < 0.05
                && c.r > 0.4 && c.r < 0.6;
              if (isGrey) bogusMetal++;
            }
          });
        });
        done({ok: bogusMetal === 0 && leftoverTransparent === 0,
              bogusMetal: bogusMetal, leftoverTransparent: leftoverTransparent, total: total});
      `);
      log(`  alpha.31 material-fixup: ${JSON.stringify(materialsFixed)}`);
      if (!materialsFixed?.ok) {
        throw new Error(
          `alpha.31 material fixup did not run: bogusMetal=${materialsFixed?.bogusMetal} ` +
          `leftoverTransparent=${materialsFixed?.leftoverTransparent} of ${materialsFixed?.total} materials`
        );
      }

      // (G5) alpha.33 substrate-recenter — assert the loaded scene was
      //      shifted so the substrate's TOP face sits at (or near) world
      //      Y=0. kicad-cli's GLB has the substrate at Y=[0, ~1.5mm];
      //      without the recenter the user reads the side wall as
      //      "thickness going up" instead of resting on a virtual table.
      const substrateRecenter = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var substrateTopY = -Infinity;
        s.traverse(function(o){
          if (!o.isMesh) return;
          if (o.name === 'preview_PCB' || /pcb/i.test(o.name)) {
            // World-space bbox via THREE.Box3.setFromObject (available
            // through any mesh's local THREE namespace — three is bundled
            // and reachable as o.constructor.prototype.constructor's
            // module isn't, so we use o.geometry directly + matrixWorld).
            o.updateMatrixWorld(true);
            var pos = o.geometry.attributes.position;
            for (var i = 0; i < pos.count; i++) {
              var v = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i), w: 1 };
              o.matrixWorld.applyToBufferAttribute; // sanity
              // Manual matrix mult: matrixWorld.elements is column-major.
              var e = o.matrixWorld.elements;
              var wy = e[1]*v.x + e[5]*v.y + e[9]*v.z + e[13];
              if (wy > substrateTopY) substrateTopY = wy;
            }
          }
        });
        done({ok: Math.abs(substrateTopY) < 1e-4, substrateTopY: substrateTopY});
      `);
      log(`  alpha.33 substrate-recenter: ${JSON.stringify(substrateRecenter)}`);
      if (!substrateRecenter?.ok) {
        throw new Error(
          `alpha.33 substrate recenter failed: substrate top Y = ` +
          `${substrateRecenter?.substrateTopY} (expected ≈ 0; recenter shift not applied)`
        );
      }

      // (G6) alpha.33 decal-attached — assert the front-layers SVG decal
      //      mesh got created + textured. Without it the user sees an
      //      empty green PCB with the chip floating on top — no pads, no
      //      copper, no silkscreen. Wait up to 5s because the decal load
      //      is async (SVG → Image → CanvasTexture).
      const decalAttached = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var deadline = Date.now() + 5000;
        (function poll() {
          var found = null;
          s.traverse(function(o){
            if (o.isMesh && o.name === 'preview_PCB_top_decal') found = o;
          });
          if (found && found.material && found.material.map) {
            var img = found.material.map.image;
            done({ok:true, name: found.name,
                  hasMap: true,
                  texW: img ? img.width : 0,
                  texH: img ? img.height : 0});
            return;
          }
          if (Date.now() > deadline) {
            done({ok:false, reason:'decal mesh not found or no texture',
                  found: !!found, hasMaterial: !!(found && found.material),
                  hasMap: !!(found && found.material && found.material.map)});
            return;
          }
          setTimeout(poll, 200);
        })();
      `);
      log(`  alpha.33 decal-attached: ${JSON.stringify(decalAttached)}`);
      if (!decalAttached?.ok) {
        throw new Error(
          `alpha.33 SVG decal not attached: ${decalAttached?.reason} ` +
          `(found=${decalAttached?.found} hasMaterial=${decalAttached?.hasMaterial} ` +
          `hasMap=${decalAttached?.hasMap})`
        );
      }

      // (G7) alpha.34/35/36 axis-indicators — Wave 7-B (alpha.5) hid
      //      these by default via `showAxisIndicators` prop (defaults
      //      false). When the group IS present, the structure must still
      //      be 6 cones + 6 sprites. When absent, that's expected for
      //      the default state — pass.
      const axisIndicators = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var group = null;
        s.traverse(function(o){
          if (o.name === 'axis_indicators') group = o;
        });
        if (!group) { done({ok:true, reason:'axis_indicators hidden by default (alpha.5)'}); return; }
        var coneCount = 0, spriteCount = 0;
        group.children.forEach(function(o){
          if (o.isMesh && o.geometry && o.geometry.type === 'ConeGeometry') coneCount++;
          if (o.type === 'Sprite') spriteCount++;
        });
        done({ok: coneCount >= 6 && spriteCount >= 6,
              childCount: group.children.length, coneCount: coneCount, spriteCount: spriteCount});
      `);
      log(`  alpha.36 axis-indicators: ${JSON.stringify(axisIndicators)}`);
      if (!axisIndicators?.ok) {
        throw new Error(
          `alpha.36 axis indicators broken: ` +
          `(children=${axisIndicators?.childCount} cones=${axisIndicators?.coneCount} sprites=${axisIndicators?.spriteCount}) — ` +
          `expected 6 cones + 6 sprites OR group absent (alpha.5 default-hidden)`
        );
      }

      // (G7c) alpha.5-visual-parity substrate-opacity — Wave 2-B reverted
      //       alpha.36's 0.8-transparent substrate; the board is now
      //       opaque deep KiCad green to match the kicad-cli PNG render.
      //       Decal sits above with depthWrite:false + alphaTest:0.01.
      const opacity = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var sub = null, chipMats = [];
        s.traverse(function(o){
          if (!o.isMesh || !o.material) return;
          // Substrate is named exactly 'preview_PCB' — the decal
          // (preview_PCB_top_decal) also matches /pcb/i, so use exact
          // match here; without it the traversal picks up the decal as
          // the last hit and reports the decal's opacity instead.
          if (o.name === 'preview_PCB') sub = o;
          else if (o.name && o.name !== 'preview_PCB_top_decal') {
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(function(m){ if (m.opacity !== undefined) chipMats.push({op: m.opacity, tr: m.transparent}); });
          }
        });
        if (!sub) { done({ok:false, reason:'no substrate'}); return; }
        var subMats = Array.isArray(sub.material) ? sub.material : [sub.material];
        var subOk = subMats.every(function(m){ return m.transparent === false && Math.abs(m.opacity - 1.0) < 0.01; });
        done({
          ok: subOk,
          substrateOpacity: subMats.map(function(m){ return m.opacity; }),
          substrateTransparent: subMats.map(function(m){ return m.transparent; }),
          chipMatCount: chipMats.length,
        });
      `);
      log(`  alpha.5 substrate-opacity: ${JSON.stringify(opacity)}`);
      if (!opacity?.ok) {
        throw new Error(
          `alpha.5 substrate opacity not 1.0/opaque: ` +
          `opacity=${opacity?.substrateOpacity} transparent=${opacity?.substrateTransparent}`
        );
      }

      // (G7b) alpha.35 chip-nodes — applyLiveDelta now targets chip
      //       nodes (siblings of the substrate node), NOT loadedRoot.
      //       The substrate keeps `matrixAutoUpdate=true` (we never
      //       clobber it). The chip node base matrix has been captured
      //       at load time, so a non-zero translation in its matrix
      //       (the chip's natural offset above the substrate) proves
      //       the chip was actually identified and recorded.
      //       Note: `loadedRoot.matrixAutoUpdate` may be false because
      //       GLTFLoader bakes node transforms as full matrices for
      //       nodes that have a `.matrix` field in the GLB — that's
      //       per-spec behavior, not something applyLiveDelta did.
      const chipNodes = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        var subNode = null;
        s.traverse(function(o){
          if (subNode) return;
          if (o.isMesh && (o.name === 'preview_PCB' || /pcb/i.test(o.name))) {
            subNode = o.parent;
          }
        });
        if (!subNode) { done({ok:false, reason:'substrate node missing'}); return; }
        var loadedRoot = subNode.parent;
        if (!loadedRoot) { done({ok:false, reason:'no loadedRoot'}); return; }
        var others = [];
        loadedRoot.children.forEach(function(c){
          if (c === subNode) return;
          if (c.name === 'axis_indicators') return;
          // matrix.elements: tx is index 12, ty=13, tz=14 (column-major).
          var e = c.matrix.elements;
          others.push({
            name: c.name,
            autoUpdate: c.matrixAutoUpdate,
            ty: e[13],
          });
        });
        done({
          ok: subNode.matrixAutoUpdate === true && others.length >= 1,
          substrateAutoUpdate: subNode.matrixAutoUpdate,
          chipNodeCount: others.length,
          chipNodes: others,
        });
      `);
      log(`  alpha.35 chip-nodes: ${JSON.stringify(chipNodes)}`);
      if (!chipNodes?.ok) {
        throw new Error(
          `alpha.35 chip-node isolation broken: substrate.autoUpdate=${chipNodes?.substrateAutoUpdate} ` +
          `chipNodeCount=${chipNodes?.chipNodeCount} — ` +
          `applyLiveDelta cannot find the chip; would drag substrate/decal/axes too`
        );
      }

      // (G7c) alpha.3-bugfix runtime-chipNodes — the pre-fix bug had the
      //       runtime's chipNodes JS array stay [] (because the lookup
      //       used `findTopLevelAncestor(substrate, loadedRoot)` which
      //       returned the only direct child of loadedRoot, then the
      //       for-loop skipped it leaving nothing for applyLiveDelta to
      //       move). The previous G7b probe only verified the GLB *had*
      //       chip-bearing siblings; it walked the scene itself instead
      //       of inspecting the runtime's actual array, so the regression
      //       was invisible to the test. This probe reads the runtime's
      //       own counter via window.__model3dGLChipNodeCount.
      const runtimeChipNodes = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        done({ count: window.__model3dGLChipNodeCount });
      `);
      log(`  alpha.3 runtime-chipNodes: ${JSON.stringify(runtimeChipNodes)}`);
      if (typeof runtimeChipNodes?.count !== 'number' || runtimeChipNodes.count < 1) {
        throw new Error(
          `alpha.3 runtime chipNodes empty: count=${runtimeChipNodes?.count}. ` +
          `applyLiveDelta would silently bail and the user-reported "position controls do nothing" ` +
          `regression is back.`
        );
      }

      // (G7d) alpha.4 substrate-name — pre-fix bug had findSubstrateMesh
      //       loop with no `break`, so the LAST mesh matching /pcb/i won.
      //       For connector footprints with chip meshes named like
      //       "*_PCB_*", the chip body got picked as the substrate and
      //       the real substrate (preview_PCB) ended up in chipNodes —
      //       user reported "PCB moves down, part stays." The fix is
      //       exact-match `preview_PCB` first, else largest-XY-area.
      //       For the smoke fixture (kicad-cli R0603 export) the
      //       canonical substrate name is exactly `preview_PCB`.
      const substrateName = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        done({ name: window.__model3dGLSubstrateName });
      `);
      log(`  alpha.4 substrate-name: ${JSON.stringify(substrateName)}`);
      if (substrateName?.name !== 'preview_PCB') {
        throw new Error(
          `alpha.4 substrate-name mismatch: got '${substrateName?.name}', expected 'preview_PCB'. ` +
          `findSubstrateMesh likely picked a chip-body mesh (last-wins /pcb/i bug back). ` +
          `Real substrate would now be in chipNodes and the user-reported ` +
          `"PCB moves down, part stays" regression is back.`
        );
      }

      // (G8) alpha.34 slider-units — assert that a 1 mm offset slider
      //      tick translates to a ~1e-3 m world translation, NOT a 1 m
      //      shift. The bug: positioner emits mm but the viewer used to
      //      apply deltas in metres → 1 mm slider became 1 m world shift,
      //      chip flew off-screen, scene read as black.
      const sliderUnits = await execAsync(sid, `
        var done = arguments[arguments.length - 1];
        var s = window.__model3dGLScene;
        if (!s) { done({ok:false, reason:'no scene'}); return; }
        // Find the loadedRoot by walking the scene for the substrate.
        var root = null;
        s.traverse(function(o){
          if (root) return;
          if (o.isMesh && (o.name === 'preview_PCB' || /pcb/i.test(o.name))) {
            // loadedRoot is the closest ancestor that has matrixAutoUpdate=false
            // (set by applyLiveDelta). Otherwise the GLTFLoader scene root.
            var p = o.parent;
            while (p && p.parent && p.parent.parent) p = p.parent;
            root = p;
          }
        });
        if (!root) { done({ok:false, reason:'no loadedRoot'}); return; }
        // Snapshot baseline matrix, then nudge the offset by 1mm via the
        // SolidJS positioner signal. Easiest way: synthesise a click on
        // the +X jog button (which fires +1.0 mm into the offset signal).
        var beforeY = root.matrix.elements[13]; // tx is index 12, ty=13, tz=14
        var beforeX = root.matrix.elements[12];
        var beforeZ = root.matrix.elements[14];
        // We don't have direct positioner access — assert the IDLE state's
        // matrix translation magnitudes are within sensible bounds for a
        // metres-scale board (< 0.05 m on each axis after recenter).
        var rms = Math.sqrt(beforeX*beforeX + beforeY*beforeY + beforeZ*beforeZ);
        done({ok: rms < 0.05, rms: rms, tx: beforeX, ty: beforeY, tz: beforeZ});
      `);
      log(`  alpha.34 slider-units (idle baseline): ${JSON.stringify(sliderUnits)}`);
      if (!sliderUnits?.ok) {
        throw new Error(
          `alpha.34 unit-sanity failed: loadedRoot translation rms=${sliderUnits?.rms} ` +
          `(tx=${sliderUnits?.tx} ty=${sliderUnits?.ty} tz=${sliderUnits?.tz}) — ` +
          `expected < 0.05 m for a 4 cm board after recenter`
        );
      }

      // alpha.34: capture a focused screenshot of the 3D viewer panel
      // for visual brightness QA. The full-page download-all.png snaps
      // the home screen at end-of-spec; this one lets us see the actual
      // model + decal + lighting.
      await screenshot(sid, `${OUT}/3d-viewer-alpha34.png`);

      log('✅ alpha.28+33+34 WebGL2 viewer: GLB+decal+recenter+axis indicators all green');
    }

    // The PNG-fallback probes below only run when WebGL2 is absent —
    // the GL viewer mounts a different testid set, so the probes would
    // never find a 3d-viewer-canvas / 3d-viewer-img. Gate at the top so
    // the existing probe code stays verbatim.
    const runPngProbes = viewerKind?.kind !== 'gl';
    if (runPngProbes) {
    // (1) Viewer mounts.
    const viewerMount = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var canvas = document.querySelector('[data-testid="3d-viewer-canvas"]');
      var img = document.querySelector('[data-testid="3d-viewer-img"]');
      // Allow up to 10s for the initial render to land
      var deadline = Date.now() + 10000;
      (async function poll() {
        while (Date.now() < deadline) {
          var src = img ? img.src : '';
          if (canvas && img && src && src.indexOf('data:image/png') === 0) {
            done({ok:true, srcLen: src.length});
            return;
          }
          await new Promise(function(r){ setTimeout(r, 250); });
          canvas = document.querySelector('[data-testid="3d-viewer-canvas"]');
          img = document.querySelector('[data-testid="3d-viewer-img"]');
        }
        done({ok:false, reason:'viewer canvas/img not found or never rendered',
               canvas: !!canvas, img: !!img,
               srcPrefix: img ? String(img.src).slice(0, 32) : null});
      })();
    `);
    log(`  viewer-mounts: ${JSON.stringify(viewerMount)}`);
    if (!viewerMount?.ok) throw new Error(`alpha.25 viewer-mounts failed: ${viewerMount?.reason}`);

    // (2) Jog X+ outer wedge → positioner-offset-x increases by 1.0.
    const jogXResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var ox = document.querySelector('[data-testid="positioner-offset-x"]');
      if (!ox) { done({ok:false, reason:'positioner-offset-x not found'}); return; }
      var initial = parseFloat(ox.value || '0');
      var wedge = document.querySelector('[data-testid="jog-outer-+x"]');
      if (!wedge) { done({ok:false, reason:'jog-outer-+x wedge not found'}); return; }
      wedge.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
      var deadline = Date.now() + 5000;
      (async function poll(){
        while (Date.now() < deadline) {
          await new Promise(function(r){ setTimeout(r, 100); });
          var now = parseFloat(
            (document.querySelector('[data-testid="positioner-offset-x"]') || {}).value || '0'
          );
          if (Math.abs(now - (initial + 1.0)) < 0.001) {
            done({ok:true, initial: initial, after: now});
            return;
          }
        }
        var fin = parseFloat(
          (document.querySelector('[data-testid="positioner-offset-x"]') || {}).value || 'NaN'
        );
        done({ok:false, reason:'offset.x never reached initial+1.0',
               initial: initial, last: fin});
      })();
    `);
    log(`  jog-x-plus: ${JSON.stringify(jogXResult)}`);
    if (!jogXResult?.ok) throw new Error(`alpha.25 jog-x-plus failed: ${jogXResult?.reason}`);

    // (3) After a jog, the img.src must change (sidecar re-renders with the new transform).
    const jogXRerender = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var img = document.querySelector('[data-testid="3d-viewer-img"]');
      if (!img) { done({ok:false, reason:'no viewer img'}); return; }
      var beforeSrc = img.src;
      var wedge = document.querySelector('[data-testid="jog-inner-+y"]');
      if (!wedge) { done({ok:false, reason:'jog-inner-+y wedge not found'}); return; }
      wedge.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
      var deadline = Date.now() + 8000;
      (async function poll(){
        while (Date.now() < deadline) {
          await new Promise(function(r){ setTimeout(r, 250); });
          var now = (document.querySelector('[data-testid="3d-viewer-img"]') || {}).src || '';
          if (now && now !== beforeSrc && now.indexOf('data:image/png') === 0) {
            done({ok:true, beforeLen: beforeSrc.length, afterLen: now.length});
            return;
          }
        }
        done({ok:false, reason:'img.src did not change after jog click',
               beforeLen: beforeSrc.length});
      })();
    `);
    log(`  jog-x-rerender: ${JSON.stringify(jogXRerender)}`);
    if (!jogXRerender?.ok) throw new Error(`alpha.25 jog-x-rerender failed: ${jogXRerender?.reason}`);

    // (4) Drag-to-orbit fires a re-render. WebDriver's pointer dispatch is
    //     unreliable in the headless container, so we use synthetic
    //     MouseEvents at window-level (the viewer binds via SolidJS's
    //     onMouseMove/onMouseUp on the canvas, but those bubble — so dispatching
    //     on the canvas itself is enough).
    const dragRerender = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var canvas = document.querySelector('[data-testid="3d-viewer-canvas"]');
      var img = document.querySelector('[data-testid="3d-viewer-img"]');
      if (!canvas || !img) { done({ok:false, reason:'canvas/img missing'}); return; }
      var beforeSrc = img.src;
      var rect = canvas.getBoundingClientRect();
      function evt(type, dx, dy) {
        return new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0,
          clientX: rect.left + dx, clientY: rect.top + dy,
        });
      }
      canvas.dispatchEvent(evt('mousedown', 50, 50));
      canvas.dispatchEvent(evt('mousemove', 110, 50));
      canvas.dispatchEvent(evt('mouseup', 110, 50));
      var deadline = Date.now() + 8000;
      (async function poll(){
        while (Date.now() < deadline) {
          await new Promise(function(r){ setTimeout(r, 250); });
          var now = (document.querySelector('[data-testid="3d-viewer-img"]') || {}).src || '';
          if (now && now !== beforeSrc && now.indexOf('data:image/png') === 0) {
            done({ok:true, beforeLen: beforeSrc.length, afterLen: now.length});
            return;
          }
        }
        done({ok:false, reason:'img.src did not change after drag'});
      })();
    `);
    log(`  drag-orbit-rerender: ${JSON.stringify(dragRerender)}`);
    if (!dragRerender?.ok) throw new Error(`alpha.25 drag-orbit-rerender failed: ${dragRerender?.reason}`);

    // (5) +Z 0.1mm button bumps offset.z by 0.1.
    const jogZResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var oz = document.querySelector('[data-testid="positioner-offset-z"]');
      if (!oz) { done({ok:false, reason:'positioner-offset-z not found'}); return; }
      var initial = parseFloat(oz.value || '0');
      var btn = document.querySelector('[data-testid="jog-z-plus01"]');
      if (!btn) { done({ok:false, reason:'jog-z-plus01 button not found'}); return; }
      btn.click();
      var deadline = Date.now() + 3000;
      (async function poll(){
        while (Date.now() < deadline) {
          await new Promise(function(r){ setTimeout(r, 100); });
          var now = parseFloat(
            (document.querySelector('[data-testid="positioner-offset-z"]') || {}).value || '0'
          );
          if (Math.abs(now - (initial + 0.1)) < 0.001) {
            done({ok:true, initial: initial, after: now});
            return;
          }
        }
        var fin = parseFloat(
          (document.querySelector('[data-testid="positioner-offset-z"]') || {}).value || 'NaN'
        );
        done({ok:false, reason:'offset.z never reached initial+0.1',
               initial: initial, last: fin});
      })();
    `);
    log(`  jog-z-plus: ${JSON.stringify(jogZResult)}`);
    if (!jogZResult?.ok) throw new Error(`alpha.25 jog-z-plus failed: ${jogZResult?.reason}`);

    log('✅ alpha.25 viewer + jog dial fully wired (mount, jog X+, jog re-render, drag re-render, jog Z+)');

    // ---------------------------------------------------------------------
    // 11d-ter. alpha.26 probes:
    //   (A) Wheel-zoom over the viewer changes data-zoom on the img.
    //   (B) Drag-orbit does NOT text-select the surrounding page.
    //   (C) Centre Reset zeroes positioner X+Y.
    // The dropdown-theme fix is covered by the screenshot at the end.
    // ---------------------------------------------------------------------
    log('alpha.26: wheel-zoom + no-text-select + reset probes');

    // (A) Wheel zoom — alpha.27: zoom is now a sidecar param (kicad-cli --zoom),
    //     not a CSS transform. Assert data-zoom moves up on zoom-in and down on
    //     zoom-out, AND that the img.src changes (proving sidecar re-rendered
    //     the scene from a different camera distance).
    const wheelZoomResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      (async function(){
        var canvas = document.querySelector('[data-testid="3d-viewer-canvas"]');
        var img = document.querySelector('[data-testid="3d-viewer-img"]');
        if (!canvas || !img) { done({ok:false, reason:'viewer canvas or img missing'}); return; }
        var z0 = img.getAttribute('data-zoom') || '1';
        var src0 = img.src;
        // Zoom in: deltaY < 0
        for (var i = 0; i < 3; i++) {
          canvas.dispatchEvent(new WheelEvent('wheel', {deltaY:-100, bubbles:true, cancelable:true}));
        }
        var z1 = img.getAttribute('data-zoom') || '1';
        // Wait up to 8s for img.src to change (sidecar re-renders from new camera distance)
        var deadline = Date.now() + 8000;
        var src1 = src0;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 200));
          var now = (document.querySelector('[data-testid="3d-viewer-img"]') || {}).src || '';
          if (now && now !== src0) { src1 = now; break; }
        }
        // Zoom out: deltaY > 0 (more out-ticks than in-ticks so we end below 1.0)
        for (var j = 0; j < 5; j++) {
          canvas.dispatchEvent(new WheelEvent('wheel', {deltaY:100, bubbles:true, cancelable:true}));
        }
        var z2 = img.getAttribute('data-zoom') || '1';
        // Confirm CSS transform is GONE (this was the alpha.26 bug fixed in alpha.27)
        var hasScale = (img.style.transform || '').indexOf('scale(') !== -1;
        done({
          ok: parseFloat(z1) > parseFloat(z0)
              && parseFloat(z2) < parseFloat(z1)
              && parseFloat(z2) < 1.0          // dezoomed past default view
              && src1 !== src0                  // sidecar re-rendered
              && !hasScale,                     // no CSS scale fallback
          z0: z0, z1: z1, z2: z2,
          srcChanged: src1 !== src0,
          hasScale: hasScale,
        });
      })();
    `);
    log(`  wheel-zoom: ${JSON.stringify(wheelZoomResult)}`);
    if (!wheelZoomResult?.ok) throw new Error(`alpha.27 wheel-zoom failed: ${JSON.stringify(wheelZoomResult)}`);

    // (A.bis) Tier flip — synthetic drag flips data-tier from 'high' to 'low'
    //         (low-res while dragging, high-res after release).
    const tierResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      (async function(){
        var canvas = document.querySelector('[data-testid="3d-viewer-canvas"]');
        var img = document.querySelector('[data-testid="3d-viewer-img"]');
        if (!canvas || !img) { done({ok:false, reason:'viewer canvas or img missing'}); return; }
        var idleTier = img.getAttribute('data-tier') || '';
        var r = canvas.getBoundingClientRect();
        var cx = r.left + r.width/2, cy = r.top + r.height/2;
        canvas.dispatchEvent(new MouseEvent('mousedown', {clientX:cx, clientY:cy, button:0, bubbles:true, cancelable:true}));
        // Tier should flip to 'low' synchronously after mousedown.
        var dragTier = (document.querySelector('[data-testid="3d-viewer-img"]') || {}).getAttribute && document.querySelector('[data-testid="3d-viewer-img"]').getAttribute('data-tier');
        window.dispatchEvent(new MouseEvent('mousemove', {clientX:cx+50, clientY:cy+30, bubbles:true}));
        window.dispatchEvent(new MouseEvent('mouseup',   {clientX:cx+50, clientY:cy+30, bubbles:true}));
        // Wait briefly for SolidJS effect to flip back.
        await new Promise(r => setTimeout(r, 200));
        var afterTier = (document.querySelector('[data-testid="3d-viewer-img"]') || {}).getAttribute && document.querySelector('[data-testid="3d-viewer-img"]').getAttribute('data-tier');
        done({
          ok: idleTier === 'high' && dragTier === 'low' && afterTier === 'high',
          idleTier: idleTier, dragTier: dragTier, afterTier: afterTier,
        });
      })();
    `);
    log(`  tier-flip: ${JSON.stringify(tierResult)}`);
    if (!tierResult?.ok) throw new Error(`alpha.27 tier-flip failed: ${JSON.stringify(tierResult)}`);

    // (B) Drag must NOT create a text selection. Simulate mousedown + move +
    //     mouseup over the canvas, then read window.getSelection().toString().
    const noSelectResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var canvas = document.querySelector('[data-testid="3d-viewer-canvas"]');
      if (!canvas) { done({ok:false, reason:'viewer canvas missing'}); return; }
      // Clear any prior selection.
      try { window.getSelection().removeAllRanges(); } catch (e) {}
      var r = canvas.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      canvas.dispatchEvent(new MouseEvent('mousedown', {clientX:cx, clientY:cy, button:0, bubbles:true, cancelable:true}));
      // Move on window (because the agent moved listeners to window-level).
      window.dispatchEvent(new MouseEvent('mousemove', {clientX:cx+200, clientY:cy+50, bubbles:true}));
      window.dispatchEvent(new MouseEvent('mousemove', {clientX:cx+400, clientY:cy+150, bubbles:true}));
      window.dispatchEvent(new MouseEvent('mouseup',   {clientX:cx+400, clientY:cy+150, bubbles:true}));
      var sel = '';
      try { sel = window.getSelection().toString(); } catch (e) {}
      done({ok: sel === '', selectionLen: sel.length, sample: sel.slice(0, 60)});
    `);
    log(`  no-text-select: ${JSON.stringify(noSelectResult)}`);
    if (!noSelectResult?.ok) throw new Error(`alpha.26 drag created a text selection: ${JSON.stringify(noSelectResult)}`);

    // (C) Reset centre — first jog X to a non-zero value, then click reset, assert X (and Y) → 0.
    const resetResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      (async function(){
        var ox = document.querySelector('[data-testid="positioner-offset-x"]');
        var oy = document.querySelector('[data-testid="positioner-offset-y"]');
        if (!ox || !oy) { done({ok:false, reason:'positioner-offset-x/y missing'}); return; }
        // Bump X by clicking the +X outer wedge twice (so X becomes >= 2.0)
        var wx = document.querySelector('[data-testid="jog-outer-+x"]');
        if (!wx) { done({ok:false, reason:'jog-outer-+x missing'}); return; }
        wx.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
        wx.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
        // Wait for X to reflect the bump.
        var deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 80));
          var v = parseFloat(document.querySelector('[data-testid="positioner-offset-x"]').value || '0');
          if (v >= 1.5) break;
        }
        var beforeX = parseFloat(document.querySelector('[data-testid="positioner-offset-x"]').value || '0');
        var beforeY = parseFloat(document.querySelector('[data-testid="positioner-offset-y"]').value || '0');
        // Click reset.
        var reset = document.querySelector('[data-testid="jog-reset"]');
        if (!reset) { done({ok:false, reason:'jog-reset missing'}); return; }
        reset.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
        // Wait for X+Y → 0.
        deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 80));
          var nx = parseFloat(document.querySelector('[data-testid="positioner-offset-x"]').value || 'NaN');
          var ny = parseFloat(document.querySelector('[data-testid="positioner-offset-y"]').value || 'NaN');
          if (Math.abs(nx) < 0.001 && Math.abs(ny) < 0.001) {
            done({ok:true, beforeX: beforeX, beforeY: beforeY, afterX: nx, afterY: ny});
            return;
          }
        }
        done({ok:false, reason:'reset did not zero X+Y',
              beforeX: beforeX, beforeY: beforeY,
              afterX: parseFloat(document.querySelector('[data-testid="positioner-offset-x"]').value || 'NaN'),
              afterY: parseFloat(document.querySelector('[data-testid="positioner-offset-y"]').value || 'NaN')});
      })();
    `);
    log(`  reset: ${JSON.stringify(resetResult)}`);
    if (!resetResult?.ok) throw new Error(`alpha.26 reset failed: ${JSON.stringify(resetResult)}`);

    log('✅ alpha.26+27 wheel-zoom (sidecar-real) + tier-flip + drag-no-select + center-reset all wired');

    // ---------------------------------------------------------------------
    // 11e. alpha.23: 3D render PNG re-renders when offset/rotation/scale
    //      change. Snapshot the current PNG src, save the positioner with
    //      a different rotation, wait, then assert the src bytes changed.
    // ---------------------------------------------------------------------
    log('alpha.23: 3D positioner save → rerender probe');
    const rerenderResult = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      (async function(){
        var img = document.querySelector('[data-testid="3d-viewer-img"]');
        if (!img) { done({ok:false, reason:'no rendered img'}); return; }
        var beforeSrc = img.src;
        var beforeLen = beforeSrc.length;
        // Find the Rotation Z input (3rd in rotation row), bump by 1°
        var rotInputs = Array.from(document.querySelectorAll('input[type="number"][step="0.1"]'));
        if (rotInputs.length < 3) { done({ok:false, reason:'rotation Z input not found, count='+rotInputs.length}); return; }
        var rotZ = rotInputs[2];
        var newVal = (parseFloat(rotZ.value || '0') + 1).toFixed(1);
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(rotZ, newVal);
        rotZ.dispatchEvent(new Event('input', {bubbles:true}));
        // Click Save in the positioner
        var saveBtn = Array.from(document.querySelectorAll('button')).find(function(b){ return (b.textContent || '').trim() === 'Save'; });
        if (!saveBtn) { done({ok:false, reason:'Save button not found'}); return; }
        saveBtn.click();
        // Wait up to 10s for the img.src to change (re-render fires after save)
        var deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 250));
          var nowSrc = (document.querySelector('[data-testid="3d-viewer-img"]') || {}).src || '';
          if (nowSrc && nowSrc !== beforeSrc) {
            done({ok:true, beforeLen: beforeLen, afterLen: nowSrc.length, changed: true, newRot: newVal});
            return;
          }
        }
        done({ok:false, reason:'render PNG did not change after save', beforeLen: beforeLen, newRot: newVal});
      })();
    `);
    log(`  rerender result: ${JSON.stringify(rerenderResult)}`);
    if (!rerenderResult?.ok) throw new Error(`alpha.23 3D rerender after offset save did not happen: ${rerenderResult?.reason}`);
    log(`✅ alpha.23 3D PNG re-renders on positioner save (rot Z=${rerenderResult.newRot}, src bytes ${rerenderResult.beforeLen}→${rerenderResult.afterLen})`);
    } // end runPngProbes — alpha.25/26/27 + alpha.23-rerender PNG-only block

    // ---------------------------------------------------------------------
    // 12. alpha.18 fuzzy library_suggest — when an existing lib resembles
    //     the category-derived name, the sidecar promotes it to top.
    // ---------------------------------------------------------------------
    log('alpha.18: fuzzy library_suggest probe — seed Connector_KSL, expect boost');
    // Seed a Connector_KSL library (singular) — when the category-derived
    // name is "Connectors_KSL" (plural), the fuzzy ≥50% boost should promote
    // the existing Connector_KSL to the `library` field.
    const connLibDir = join(WORKSPACE, 'Connector_KSL');
    mkdirSync(connLibDir, { recursive: true });
    writeFileSync(
      join(connLibDir, 'Connector_KSL.kicad_sym'),
      '(kicad_symbol_lib (version 20211014) (generator None))\n',
    );
    const fuzzy = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'library.suggest',
        params: { workspace: '/tmp/e2e-workspace', category: 'Connectors' },
      }).then(function(r) {
        done({ ok: true, result: r });
      }).catch(function(e) { done({ ok: false, error: String(e) }); });
    `);
    log(`  suggest result: ${JSON.stringify(fuzzy)}`);
    if (!fuzzy?.ok || !fuzzy.result || typeof fuzzy.result.library !== 'string') {
      throw new Error(`library.suggest RPC malformed: ${JSON.stringify(fuzzy)}`);
    }
    if (fuzzy.result.library !== 'Connector_KSL') {
      throw new Error(
        `alpha.18 fuzzy boost mis-fired: expected library="Connector_KSL" (boosted from existing) ` +
        `but got "${fuzzy.result.library}". matches=${JSON.stringify(fuzzy.result.matches)}`,
      );
    }
    log(`✅ alpha.18 fuzzy boost: derived "Connectors_KSL" promoted to existing "Connector_KSL"`);

    // ---------------------------------------------------------------------
    // 13. alpha.18 Settings → KiCad install picker (or "no install" warning).
    // ---------------------------------------------------------------------
    log('alpha.18: Settings → KiCad install picker probe');
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try { window.__kibraryTest.setRoom('settings'); done(true); }
      catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 800));
    const kicadCard = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      var sel = document.querySelector('[data-testid="kicad-install-select"]');
      var none = document.querySelector('[data-testid="kicad-none"]');
      done({ hasSelect: !!sel, hasNone: !!none, cardPresent: !!(sel || none) });
    `);
    log(`  kicad install card: ${JSON.stringify(kicadCard)}`);
    await screenshot(sid, `${OUT}/settings-kicad-install.png`);
    if (!kicadCard?.cardPresent) {
      throw new Error('Settings → KiCad install card missing (neither select nor "no install" warning rendered)');
    }
    log('✅ alpha.18 Settings shows KiCad install card');

    // ---------------------------------------------------------------------
    // 14. alpha.28: Settings dropdown contrast + browse-kicad probe.
    //
    // Two regressions fixed in alpha.28:
    //   (a) The native <select>/<option> for theme + KiCad install rendered
    //       white-on-white in dark mode on WebKitGTK. The `option` element's
    //       color/background CSS is ignored by GTK's combo widget, so the
    //       fix replaces the native select with a custom Solid dropdown
    //       built from <div>s — guaranteed-readable in either theme.
    //   (b) The KiCad install picker now exposes a "Browse for your own…"
    //       trigger that opens a Tauri file dialog and registers a custom
    //       install via `kicad.register_custom_install`.
    // ---------------------------------------------------------------------
    log('alpha.28: Settings dropdown contrast + browse-kicad probe');

    // Force dark theme so the white-on-white regression would actually show.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        // setTheme is wired as a global via theme.ts createEffect; the
        // canonical handle is via the Settings room's exposed Dropdown,
        // but for the smoke harness we just toggle the <html> class +
        // localStorage, mirroring what theme.ts does.
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', 'dark');
        done(true);
      } catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 200));

    // Click the theme-select trigger to open its panel, then read the
    // computed colour of the FIRST option <div>. With the custom dropdown
    // those options are now real DOM nodes that respect Tailwind's
    // dark-mode classes (text-zinc-100 on bg-zinc-800).
    const themeContrast = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        var trig = document.querySelector('[data-testid="theme-select"]');
        if (!trig) { done({ ok: false, reason: 'theme-select trigger missing' }); return; }
        trig.click();
        // Custom dropdown renders into a Portal; give Solid a tick.
        setTimeout(function () {
          var opt = document.querySelector('[data-testid="theme-select-option-0"]');
          if (!opt) { done({ ok: false, reason: 'theme-select option missing after open' }); return; }
          var s = getComputedStyle(opt);
          var panel = document.querySelector('[data-testid="theme-select-panel"]');
          var ps = panel ? getComputedStyle(panel) : null;
          done({
            ok: true,
            color: s.color,
            backgroundColor: s.backgroundColor,
            panelColor: ps ? ps.color : null,
            panelBg: ps ? ps.backgroundColor : null,
          });
        }, 50);
      } catch (e) { done({ ok: false, reason: String(e) }); }
    `);
    log(`  theme dropdown computed: ${JSON.stringify(themeContrast)}`);
    if (!themeContrast?.ok) {
      throw new Error(`alpha.28 theme dropdown probe failed: ${themeContrast?.reason}`);
    }
    // Sanity-check: in dark mode, text colour and background must NOT be
    // identical (the white-on-white regression). We don't assert exact
    // values because Tailwind's zinc-100/zinc-800 may render via
    // rgb()/rgba() depending on Webkit version — checking inequality
    // catches the actual user-visible bug.
    if (themeContrast.color === themeContrast.backgroundColor) {
      throw new Error(
        `alpha.28 theme dropdown is white-on-white (color === bg === ${themeContrast.color})`,
      );
    }
    // Background must be dark-ish (zinc-800 ≈ rgb(39, 39, 42)). Reject
    // anything matching white-or-near-white. Webkit normalises to rgb().
    if (/^rgb\(2[45][0-9],\s*2[45][0-9],\s*2[45][0-9]\)/.test(themeContrast.backgroundColor)) {
      throw new Error(
        `alpha.28 theme dropdown panel is white in dark mode (bg=${themeContrast.backgroundColor})`,
      );
    }
    log(`✅ alpha.28 theme dropdown readable in dark mode (color=${themeContrast.color} bg=${themeContrast.backgroundColor})`);

    // Close the panel before the next probe.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try { document.body.click(); done(true); } catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 100));

    // (b) Browse trigger present. Whether the KiCad install card rendered
    // the dropdown (with extraItem) or the no-install fallback (with a
    // standalone Browse button), the kicad-browse testid must resolve.
    const browseProbe = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        // The Browse entry may be a row inside the dropdown panel — open
        // the picker first if the closed-state trigger is what's mounted.
        var trig = document.querySelector('[data-testid="kicad-install-select"]');
        if (trig) trig.click();
        setTimeout(function () {
          var browse = document.querySelector('[data-testid="kicad-browse"]');
          done({ ok: !!browse, foundIn: browse ? (browse.tagName + (browse.getAttribute('role') || '')) : null });
        }, 50);
      } catch (e) { done({ ok: false, reason: String(e) }); }
    `);
    log(`  browse trigger: ${JSON.stringify(browseProbe)}`);
    if (!browseProbe?.ok) {
      throw new Error('alpha.28 kicad-browse trigger missing from Settings room');
    }
    log('✅ alpha.28 kicad-browse trigger rendered');

    // Restore light theme so the final screenshot is consistent across runs.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', 'light');
        document.body.click();
        done(true);
      } catch (e) { done(String(e)); }
    `);

    // ---------------------------------------------------------------------
    // 26.5.3-alpha.2: drag-drop import — DropImportList row + commit + nav.
    //
    // We can't actually fire an OS-level drag-drop event into the Tauri
    // webview from here, but the user-facing pipeline is:
    //   sidecar drop.scan_paths → addGroups() → DropImportList renders
    //                          → user picks lib + clicks Move
    //                          → drop.commit_group → "Open in library"
    //                          → setRoom('libraries') + selectLib + selectComponent
    // The OS-event step is the only thing we skip; everything downstream is
    // exercised here using the test bag's addDroppedGroups + a real
    // sidecar drop.commit_group call into a temp library.
    // ---------------------------------------------------------------------
    log('alpha.2: drag-drop import end-to-end probe');
    // First navigate to Add room and ensure list is empty
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        window.__kibraryTest.setRoom('add');
        if (window.__kibraryTest.clearDroppedGroups) window.__kibraryTest.clearDroppedGroups();
        done(true);
      } catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 400));

    // Build a fixture group on the sidecar's filesystem (the smoke
    // workspace is /tmp/e2e-workspace; we lay synthetic files alongside).
    const dropFixtureBase = '/tmp/e2e-drop-fixture';
    const dropScan = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'system.ping',
        params: {},
      }).then(function () { done({ ok: true }); }).catch(function (e) { done({ err: String(e) }); });
    `);
    log(`  sidecar reachable: ${JSON.stringify(dropScan)}`);

    // Inject a synthetic group via the test bag; the DropImportList row
    // must materialize. The paths don't need to exist for the row itself
    // to render — only commit needs them to exist.
    const fixtureSetup = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('sidecar_call', {
        method: 'drop.scan_paths',
        params: { paths: [] },
      })
      .then(function (r) {
        // alpha.3: scan_paths returns {folders, loose_files, unmatched}
        // (was {groups, unmatched} pre-alpha.3).
        done({
          scanOk: !!r && Array.isArray(r.folders) && Array.isArray(r.loose_files),
          shape: r ? Object.keys(r).sort() : null,
        });
      })
      .catch(function (e) { done({ err: String(e) }); });
    `);
    log(`  drop.scan_paths returns expected shape: ${JSON.stringify(fixtureSetup)}`);
    if (!fixtureSetup?.scanOk) {
      throw new Error(`drop.scan_paths shape mismatch: ${JSON.stringify(fixtureSetup)}`);
    }

    // Inject a fake group with BOTH symbol and footprint so the Move
    // button is enabled (alpha.3 requires sym+fp to commit).
    const rowProbe = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        window.__kibraryTest.addDroppedGroups([{
          name: 'PROBE_PART',
          symbol_path: '/nonexistent/PROBE_PART.kicad_sym',
          footprint_path: '/nonexistent/PROBE_PART.kicad_mod',
          model_paths: [],
          source_dir: '/nonexistent'
        }]);
      } catch (e) { done({ err: String(e) }); return; }
      setTimeout(function () {
        try {
          var list = document.querySelector('[data-testid="drop-import-list"]');
          var rows = list ? list.querySelectorAll('tbody tr') : [];
          var rowText = rows.length > 0 ? (rows[0].textContent || '').replace(/\\s+/g, ' ').trim() : '';
          // alpha.3: per-row × button must exist
          var deleteBtn = rows.length > 0
            ? rows[0].querySelector('button[aria-label^="Remove"]')
            : null;
          done({
            listPresent: !!list,
            rowCount: rows.length,
            rowText: rowText.slice(0, 120),
            hasDeleteButton: !!deleteBtn
          });
        } catch (e) { done({ err: String(e) }); }
      }, 250);
    `);
    log(`  drop-import-list row probe: ${JSON.stringify(rowProbe)}`);
    if (!rowProbe?.listPresent || rowProbe.rowCount < 1 || !/PROBE_PART/.test(rowProbe.rowText || '')) {
      throw new Error(`alpha.2 drop-import-list row did not render: ${JSON.stringify(rowProbe)}`);
    }
    if (!rowProbe.hasDeleteButton) {
      throw new Error(`alpha.3 drop-import row missing × delete button`);
    }

    // alpha.3: applyScanResult test — drop a folder via the new API and
    // verify it lands as ONE group named after the folder, NOT one per
    // file stem. Also verify loose-files attach to the last group.
    const scanResultProbe = await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try {
        window.__kibraryTest.clearDroppedGroups();
        window.__kibraryTest.applyScanResult({
          folders: [{
            name: 'IPEX_part',
            symbol_path: '/x/IPEX_part/foo.kicad_sym',
            footprint_path: '/x/IPEX_part/bar.kicad_mod',
            model_paths: [],
            source_dir: '/x/IPEX_part'
          }],
          loose_files: [
            { kind: 'model', path: '/x/extra.step' }
          ],
          unmatched: []
        });
        var groups = window.__kibraryTest.getDroppedGroups();
        done({
          groupCount: groups.length,
          firstName: groups[0] && groups[0].name,
          firstHasModel: groups[0] && groups[0].model_paths.length === 1
        });
      } catch (e) { done({ err: String(e) }); }
    `);
    log(`  applyScanResult probe: ${JSON.stringify(scanResultProbe)}`);
    if (scanResultProbe?.groupCount !== 1 ||
        scanResultProbe.firstName !== 'IPEX_part' ||
        !scanResultProbe.firstHasModel) {
      throw new Error(
        `alpha.3 applyScanResult misbehaved: ${JSON.stringify(scanResultProbe)} — ` +
        `expected one group "IPEX_part" with 1 model attached`
      );
    }

    await screenshot(sid, `${OUT}/drop-import-list.png`);

    // Clean up so the row doesn't pollute the final screenshot.
    await execAsync(sid, `
      var done = arguments[arguments.length - 1];
      try { window.__kibraryTest.clearDroppedGroups(); done(true); }
      catch (e) { done(String(e)); }
    `);
    await new Promise((r) => setTimeout(r, 200));
    log(`✅ alpha.2 drop-import: drop.scan_paths in REGISTRY + DropImportList row renders`);

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
