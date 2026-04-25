import type { BlockDef } from './types';

export const blocks: Record<string, BlockDef> = {
  'sidecar-status':      { id: 'sidecar-status',      load: () => import('./SidecarStatus') },
  'workspace-picker':    { id: 'workspace-picker',    load: () => import('./WorkspacePicker') },
  'room-add':            { id: 'room-add',            load: () => import('./RoomAdd') },
  'room-libraries-stub': { id: 'room-libraries-stub', load: () => import('./RoomLibrariesStub') },
  'room-settings':       { id: 'room-settings',       load: () => import('./RoomSettings') },
  'import':              { id: 'import',              load: () => import('./Import') },
  'queue':               { id: 'queue',               load: () => import('./Queue') },
  'property-editor':     { id: 'property-editor',     load: () => import('./PropertyEditor') },
  'review-bulk-assign':  { id: 'review-bulk-assign',  load: () => import('./ReviewBulkAssign') },
  'review-sequential':   { id: 'review-sequential',   load: () => import('./ReviewSequential') },
  'symbol-preview':      { id: 'symbol-preview',      load: () => import('./SymbolPreview') },
  'footprint-preview':   { id: 'footprint-preview',   load: () => import('./FootprintPreview') },
  '3d-preview':          { id: '3d-preview',          load: () => import('./Model3DPreview') },
  'search-panel':        { id: 'search-panel',        load: () => import('./SearchPanel') },
  'first-run-wizard':    { id: 'first-run-wizard',    load: () => import('./FirstRunWizard') },
};

export function getBlock(id: string): BlockDef | undefined {
  return blocks[id];
}
