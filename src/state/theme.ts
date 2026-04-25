import { createSignal, createEffect } from 'solid-js';

export type Theme = 'light' | 'dark';

function detectInitial(): Theme {
  const stored = localStorage.getItem('theme') as Theme | null;
  if (stored === 'light' || stored === 'dark') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const [theme, setThemeRaw] = createSignal<Theme>(detectInitial());

// Sync to <html> class + localStorage
createEffect(() => {
  const t = theme();
  document.documentElement.classList.toggle('dark', t === 'dark');
  localStorage.setItem('theme', t);
});

export { theme, setThemeRaw as setTheme };
