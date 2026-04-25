import BlockHost from '~/shell/BlockHost';

export default function RoomAdd() {
  return (
    <div class="space-y-4">
      <BlockHost id="import" />
      <BlockHost id="queue" />
      <BlockHost id="review-bulk-assign" />
    </div>
  );
}
