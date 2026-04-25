import type { BlockDef } from './types';

export const blocks: Record<string, BlockDef> = {
  'sidecar-status':      { id: 'sidecar-status',      load: () => import('./SidecarStatus') },
  'room-add':            { id: 'room-add',            load: () => import('./RoomAdd') },
  'room-libraries-stub': { id: 'room-libraries-stub', load: () => import('./RoomLibrariesStub') },
  'room-settings':       { id: 'room-settings',       load: () => import('./RoomSettings') },
  'workspace-picker':    { id: 'workspace-picker',    load: () => import('./WorkspacePicker') },
  'import':              { id: 'import',              load: () => import('./Import') },
  'queue':               { id: 'queue',               load: () => import('./Queue') },
  'property-editor':     { id: 'property-editor',     load: () => import('./PropertyEditor') },
  'review-bulk-assign':  { id: 'review-bulk-assign',  load: () => import('./ReviewBulkAssign') },
};

export function getBlock(id: string): BlockDef | undefined {
  return blocks[id];
}
