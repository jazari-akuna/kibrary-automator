import { createResource, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { getBlock } from '~/blocks/registry';

export default function BlockHost(props: { id: string; data?: any }) {
  const def = getBlock(props.id);
  if (!def) return <div class="text-red-400">Unknown block: {props.id}</div>;
  const [comp] = createResource(() => def.load().then((m) => m.default));
  return (
    <Show when={comp()}>
      <Dynamic component={comp()!} {...props.data} />
    </Show>
  );
}
