import BlockHost from '~/shell/BlockHost';

export default function RoomAdd() {
  // Two-row layout:
  //   Row 1: Import + Queue (left, 2 cols) | Search (right, 1 col).
  //   Row 2: Bulk Assign (full width).
  //
  // Bulk-assign got moved out of the left column because it benefits from
  // the full page width (footprint + library picker + delete column don't
  // fit comfortably at 2/3 width). Pulling it below also lets the search
  // panel naturally end at the bottom of the queue rather than scrolling
  // alongside a tall table — matches the "search module ends before the
  // table" feedback.
  return (
    <div class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div class="md:col-span-2 space-y-4">
          <BlockHost id="import" />
          <BlockHost id="queue" />
        </div>
        <div class="md:col-span-1">
          <BlockHost id="search-panel" />
        </div>
      </div>
      <BlockHost id="review-bulk-assign" />
    </div>
  );
}
