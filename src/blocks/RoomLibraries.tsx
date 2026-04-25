/**
 * RoomLibraries — Room 2 top-level layout.
 *
 * Three-pane layout: LibraryTree | ComponentList | ComponentDetail
 *
 * ┌─ Libraries (12) ───┐ ┌─ Resistors_KSL (47) ─────────────────┐ ┌─ Detail ─────┐
 * │ ▾ Resistors_KSL  47│ │ Search: [10k_____]                   │ │ Symbol prev  │
 * │   • R_10k_0402     │ │  ☐ R_10k_0402  ✎ 🗑                   │ │ FP prev      │
 * │ ▸ Capacitors_KSL  │ │  ...                                 │ │ 3D prev      │
 * │ + New library      │ │ Bulk: [Move…] [Delete] [Re-export]   │ │ PropEditor   │
 * └────────────────────┘ └──────────────────────────────────────┘ └──────────────┘
 */

import LibraryTree from '~/blocks/LibraryTree';
import ComponentList from '~/blocks/ComponentList';
import ComponentDetail from '~/blocks/ComponentDetail';

export default function RoomLibraries() {
  return (
    <div class="flex h-full overflow-hidden gap-0">
      {/* Left pane — Library tree */}
      <div
        class="flex-shrink-0 border-r border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 overflow-hidden"
        style={{ width: '220px' }}
      >
        <LibraryTree />
      </div>

      {/* Middle pane — Component list */}
      <div
        class="flex-shrink-0 border-r border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 overflow-hidden"
        style={{ width: '320px' }}
      >
        <ComponentList />
      </div>

      {/* Right pane — Component detail */}
      <div class="flex-1 bg-zinc-50 dark:bg-zinc-900 overflow-hidden">
        <ComponentDetail />
      </div>
    </div>
  );
}
