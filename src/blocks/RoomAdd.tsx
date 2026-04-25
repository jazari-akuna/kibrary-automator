import BlockHost from '~/shell/BlockHost';

export default function RoomAdd() {
  return (
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="md:col-span-2 space-y-4">
        <BlockHost id="import" />
        <BlockHost id="queue" />
        <BlockHost id="review-bulk-assign" />
      </div>
      <div class="md:col-span-1">
        <BlockHost id="search-panel" />
      </div>
    </div>
  );
}
