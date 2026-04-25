import BlockHost from '~/shell/BlockHost';
export default function Header() {
  return (
    <header class="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900">
      <div class="font-semibold">Kibrary</div>
      <div class="flex items-center gap-4">
        <BlockHost id="sidecar-status" />
      </div>
    </header>
  );
}
