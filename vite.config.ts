import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Skip artifact dirs that contain symlink loops or huge unrelated trees.
      ignored: [
        '**/.flatpak-builder/**',
        '**/.test-ctx/**',
        '**/build-flatpak/**',
        '**/sidecar/.build-venv/**',
        '**/sidecar/build/**',
        '**/sidecar/dist/**',
        '**/src-tauri/target/**',
      ],
    },
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
