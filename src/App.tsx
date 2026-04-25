import BlockHost from '~/shell/BlockHost';

export default function App() {
  return (
    <div class="p-4 space-y-2">
      <h1 class="text-2xl">Kibrary</h1>
      <BlockHost id="sidecar-status" />
    </div>
  );
}
