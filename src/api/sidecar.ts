import { invoke } from '@tauri-apps/api/core';

export const sidecar = {
  ping: () => invoke<{ pong: boolean }>('sidecar_ping'),
  version: () => invoke<{ version: string }>('sidecar_version'),
};
