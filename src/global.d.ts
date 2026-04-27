/**
 * Ambient declarations for compile-time-injected globals.
 *
 * `__APP_VERSION__` is replaced by Vite (`define:` in vite.config.ts) with
 * the literal string from package.json's `version` field. It's surfaced in
 * the Settings room's "Versions" card alongside the Tauri shell version
 * (via the `app_version` Tauri command) and the Python sidecar version
 * (via `system.version` over JSON-RPC).
 */
declare const __APP_VERSION__: string;
