/**
 * Regression spec — the Rust side of the window-close flow must call
 * `app.exit(0)` (a guaranteed process exit with a `std::process::exit(0)`
 * fallback) and NOT `window.destroy()` / `window.close()`.
 *
 * Bug under regression (v26.5.7-alpha.2):
 *   `confirm_quit` was implemented as `window.destroy()`.  In tauri-runtime-wry
 *   2.10.x, `WindowMessage::Destroy` is dispatched to `on_window_close()`
 *   which only sets `WindowWrapper.inner = None` — it does NOT remove the
 *   wrapper from the `windows` map and it does NOT set `ControlFlow::Exit`.
 *   The OS-level GTK window is only torn down when the inner Arc actually
 *   drops, which is deferred indefinitely if the webview holds a clone.
 *   Result: the user's X-click was acknowledged, the prompt was correctly
 *   skipped (isDirty=false after Save), `confirm_quit` returned Ok, but the
 *   process kept running with a zombie window — "no prompts, needs to be
 *   killed".
 *
 *   `app.exit(0)` sends `Message::RequestExit` which sets `ControlFlow::Exit`
 *   directly; if the runtime is wedged it falls back to `std::process::exit`
 *   (see `tauri::App::exit` source). It is the ONLY guaranteed-exit path.
 *
 * This test guards the Rust source against silent regressions to either
 * `window.destroy()` or `window.close()` — both of which let the bug back in.
 *
 * It's a structural assertion (greps the Rust source) rather than a runtime
 * test because Rust unit tests for Tauri commands require the `test` feature
 * and a MockRuntime, which is heavier than this regression deserves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const systemRsPath = fileURLToPath(
  new URL('../../../src-tauri/src/commands/system.rs', import.meta.url),
);
const mainRsPath = fileURLToPath(
  new URL('../../../src-tauri/src/main.rs', import.meta.url),
);

describe('Rust close-flow structural guards', () => {
  it('confirm_quit calls app.exit(0) (the guaranteed-exit path)', () => {
    const src = readFileSync(systemRsPath, 'utf-8');
    // Locate the function body — everything between `fn confirm_quit` and
    // the terminating `}` of its `pub fn` block.
    const fnStart = src.indexOf('pub fn confirm_quit');
    expect(fnStart, 'confirm_quit must exist in commands/system.rs').toBeGreaterThanOrEqual(0);

    // The function body ends at the next `pub fn` (or end of file).
    const nextFn = src.indexOf('pub fn ', fnStart + 1);
    const body = nextFn === -1 ? src.slice(fnStart) : src.slice(fnStart, nextFn);

    // The whole point of the alpha.3 fix.
    expect(body, 'confirm_quit must invoke app.exit(0)').toMatch(/\bapp\.exit\s*\(\s*0\s*\)/);
  });

  it('confirm_quit does NOT call window.destroy() (alpha.2 regression)', () => {
    const src = readFileSync(systemRsPath, 'utf-8');
    const fnStart = src.indexOf('pub fn confirm_quit');
    const nextFn = src.indexOf('pub fn ', fnStart + 1);
    const body = nextFn === -1 ? src.slice(fnStart) : src.slice(fnStart, nextFn);

    // window.destroy() only nulls the runtime's inner Arc — it does not
    // exit the process.  See the doc comment on confirm_quit for the full
    // tauri-runtime-wry trace.
    expect(body, 'confirm_quit must not call window.destroy()').not.toMatch(
      /\bwindow\.destroy\s*\(/,
    );
  });

  it('confirm_quit does NOT call window.close() (alpha.1 regression)', () => {
    const src = readFileSync(systemRsPath, 'utf-8');
    const fnStart = src.indexOf('pub fn confirm_quit');
    const nextFn = src.indexOf('pub fn ', fnStart + 1);
    const body = nextFn === -1 ? src.slice(fnStart) : src.slice(fnStart, nextFn);

    // window.close() re-emits CloseRequested → re-enters the prevent-close
    // handler → relies on the QUIT_CONFIRMED latch to break the loop, which
    // the v26.5.7-alpha.1 user-visible bug proved is racy on GTK.
    expect(body, 'confirm_quit must not call window.close()').not.toMatch(
      /\bwindow\.close\s*\(/,
    );
  });

  it('confirm_quit sets QUIT_CONFIRMED before exiting (defense-in-depth)', () => {
    const src = readFileSync(systemRsPath, 'utf-8');
    const fnStart = src.indexOf('pub fn confirm_quit');
    const nextFn = src.indexOf('pub fn ', fnStart + 1);
    const body = nextFn === -1 ? src.slice(fnStart) : src.slice(fnStart, nextFn);

    // The latch must still fire before exit so any CloseRequested that
    // races between exit dispatch and ControlFlow::Exit landing on the
    // event loop is allowed through unprompted.
    const latchIdx = body.search(/QUIT_CONFIRMED\.store\s*\(\s*true/);
    const exitIdx = body.search(/\bapp\.exit\s*\(/);
    expect(latchIdx, 'QUIT_CONFIRMED.store(true) must appear in confirm_quit')
      .toBeGreaterThanOrEqual(0);
    expect(exitIdx, 'app.exit must appear in confirm_quit').toBeGreaterThanOrEqual(0);
    expect(latchIdx, 'QUIT_CONFIRMED must be set BEFORE app.exit').toBeLessThan(exitIdx);
  });

  it('CloseRequested handler in main.rs honours QUIT_CONFIRMED before prevent_close', () => {
    const src = readFileSync(mainRsPath, 'utf-8');
    // The handler is the on_window_event closure; we just need to confirm
    // the structural invariant: load(QUIT_CONFIRMED) → return-without-prevent
    // happens before api.prevent_close() is called.
    const handlerStart = src.indexOf('WindowEvent::CloseRequested');
    expect(handlerStart, 'CloseRequested handler must exist').toBeGreaterThanOrEqual(0);

    const handlerEnd = src.indexOf('.invoke_handler', handlerStart);
    const handler = src.slice(handlerStart, handlerEnd);

    const latchLoad = handler.search(/QUIT_CONFIRMED\.load/);
    const preventClose = handler.search(/api\.prevent_close/);
    expect(latchLoad, 'handler must check QUIT_CONFIRMED').toBeGreaterThanOrEqual(0);
    expect(preventClose, 'handler must call api.prevent_close on the no-latch path')
      .toBeGreaterThanOrEqual(0);
    expect(latchLoad, 'QUIT_CONFIRMED must be checked BEFORE prevent_close')
      .toBeLessThan(preventClose);
  });

  it('confirm_quit accepts an AppHandle (not a Window) — required for app.exit()', () => {
    // app.exit() lives on AppHandle; window.destroy/close lived on Window.
    // The argument type is the load-bearing signal that we're on the new
    // exit path.
    const src = readFileSync(systemRsPath, 'utf-8');
    const sigMatch = src.match(/pub fn confirm_quit\s*\(([^)]*)\)/);
    expect(sigMatch, 'confirm_quit signature must be parseable').not.toBeNull();
    const args = sigMatch![1];
    expect(args, 'confirm_quit must take a tauri::AppHandle').toMatch(/tauri::AppHandle/);
  });
});
