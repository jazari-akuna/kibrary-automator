import type { BlockDef } from './types';

export const blocks: Record<string, BlockDef> = {
  // Shell / global
  'sidecar-status':      { id: 'sidecar-status',      load: () => import('./SidecarStatus') },
  'workspace-picker':    { id: 'workspace-picker',    load: () => import('./WorkspacePicker') },
  'first-run-wizard':    { id: 'first-run-wizard',    load: () => import('./FirstRunWizard') },

  // Rooms
  'room-add':            { id: 'room-add',            load: () => import('./RoomAdd') },
  'room-libraries':      { id: 'room-libraries',      load: () => import('./RoomLibraries') },
  'room-settings':       { id: 'room-settings',       load: () => import('./RoomSettings') },

  // Add-room blocks
  'import':              { id: 'import',              load: () => import('./Import') },
  'queue':               { id: 'queue',               load: () => import('./Queue') },
  'review-bulk-assign':  { id: 'review-bulk-assign',  load: () => import('./ReviewBulkAssign') },
  'review-sequential':   { id: 'review-sequential',   load: () => import('./ReviewSequential') },
  'search-panel':        { id: 'search-panel',        load: () => import('./SearchPanel') },

  // Library-room blocks (P2)
  'library-tree':        { id: 'library-tree',        load: () => import('./LibraryTree') },
  'component-list':      { id: 'component-list',      load: () => import('./ComponentList') },
  'component-detail':    { id: 'component-detail',    load: () => import('./ComponentDetail') },
  'library-metadata':    { id: 'library-metadata',    load: () => import('./LibraryMetadata') },
  'diff-preview':        { id: 'diff-preview',        load: () => import('./DiffPreview') },

  // Editing & previews (used inside both rooms)
  'property-editor':     { id: 'property-editor',     load: () => import('./PropertyEditor') },
  'symbol-preview':      { id: 'symbol-preview',      load: () => import('./SymbolPreview') },
  'footprint-preview':   { id: 'footprint-preview',   load: () => import('./FootprintPreview') },
  '3d-preview':          { id: '3d-preview',          load: () => import('./Model3DPreview') },
};

export function getBlock(id: string): BlockDef | undefined {
  return blocks[id];
}
