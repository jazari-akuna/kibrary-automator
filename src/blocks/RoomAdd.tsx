import BlockHost from '~/shell/BlockHost';
import { searchPaneOpen } from '~/state/searchPane';

export default function RoomAdd() {
  // Two-column shell (alpha.15):
  //   Main column (fluid):   Import + Queue stacked, Bulk Assign directly
  //                          beneath. Bulk Assign is a child of the main
  //                          column, so when the search pane collapses,
  //                          Bulk Assign reclaims the freed width and the
  //                          table can show all columns above the fold.
  //   Right column (fixed):  Search pane — sticky, collapses to a 40px
  //                          rail. Auto-collapses on Download all (see
  //                          collapseSearchPane()).
  //
  // The width animation lives on the search pane (transition-[width]),
  // not on the main column — main is `flex-1 min-w-0` and reflows
  // synchronously, so the table widens as the pane shrinks without
  // remounting Bulk Assign.
  return (
    <div class="flex gap-4 items-start">
      <div class="flex-1 min-w-0 space-y-4">
        <BlockHost id="import" />
        <BlockHost id="queue" />
        <BlockHost id="review-bulk-assign" />
      </div>
      <aside
        class="shrink-0 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto transition-[width] duration-200 ease-out"
        classList={{
          'w-[360px] xl:w-[400px]': searchPaneOpen(),
          'w-10': !searchPaneOpen(),
        }}
        aria-label="Search parts side pane"
      >
        <BlockHost id="search-panel" />
      </aside>
    </div>
  );
}
