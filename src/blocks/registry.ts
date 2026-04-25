import type { BlockDef } from './types';

export const blocks: Record<string, BlockDef> = {
  'sidecar-status': {
    id: 'sidecar-status',
    load: () => import('./SidecarStatus'),
  },
};

export function getBlock(id: string): BlockDef | undefined {
  return blocks[id];
}
