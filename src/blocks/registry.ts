import type { BlockDef } from './types';

export const blocks: Record<string, BlockDef> = {
  'sidecar-status':       { id: 'sidecar-status',       load: () => import('./SidecarStatus') },
  'room-add':             { id: 'room-add',             load: () => import('./RoomAdd') },
  'room-libraries-stub':  { id: 'room-libraries-stub',  load: () => import('./RoomLibrariesStub') },
  'room-settings-stub':   { id: 'room-settings-stub',   load: () => import('./RoomSettingsStub') },
};

export function getBlock(id: string): BlockDef | undefined {
  return blocks[id];
}
