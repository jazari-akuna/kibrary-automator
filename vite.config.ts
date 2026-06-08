/// <reference types="vitest" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Read the package version at config-load time so the frontend bundle can
// surface its own version (independent of the Tauri shell and Python sidecar)
// in the Settings room's "Versions" card. See `src/global.d.ts` for the
// matching ambient declaration of __APP_VERSION__.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
);

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        // Split three.js (+ its loaders/controls) into its own async chunk
        // so it stays off the startup critical path. Model3DViewerGL is the
        // only static importer of `three` and is itself lazy()-loaded.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
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
  test: {
    // Default Node environment — keeps unit tests fast and avoids
    // pulling jsdom for purely-reactive Solid logic. Specs that need
    // a DOM should opt in per-file via `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'e2e/**/__tests__/*.test.{ts,tsx}'],
  },
});
