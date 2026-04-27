import { check, type Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';

export async function checkForUpdate(): Promise<Update | null> {
  return await check();
}

/**
 * Download + install the update. Caller follows up with quitApp() and
 * asks the user to launch the new version themselves.
 *
 * Why not auto-relaunch: on Linux the .deb install happens inside a polkit
 * prompt — by the time relaunch would fire, the running process has the
 * old binary mapped, the X11/WebKit context is in mid-transition, and the
 * fork+exec frequently no-ops. Manual restart is dramatically more
 * reliable.
 */
export async function downloadAndInstall(update: Update): Promise<void> {
  await update.downloadAndInstall();
}

/** Cleanly terminate the running process via the `quit_app` Tauri command. */
export async function quitApp(): Promise<void> {
  await invoke('quit_app');
}
