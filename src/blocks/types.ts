import type { Component } from 'solid-js';

export type BlockId = string;

export interface BlockDef {
  id: BlockId;
  load: () => Promise<{ default: Component<any> }>;
}
