import BlockHost from '~/shell/BlockHost';
import { theme, setTheme } from '~/state/theme';

export default function Header() {
  return (
    <header class="flex items-center justify-between px-4 py-2 border-b border-zinc-300 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
      <div class="font-semibold">Kibrary</div>
      <div class="flex items-center gap-4">
        <BlockHost id="workspace-picker" />
        <BlockHost id="sidecar-status" />
        <button
          title={theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          class="text-lg leading-none px-1 py-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
          onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')}
        >
          {theme() === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </header>
  );
}
