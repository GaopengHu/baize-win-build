import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { resolve } from 'path';
import { builtinModules } from 'module';

// Node built-in modules must be external for Electron main process
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);
const ignoredWatchPaths = [
  '**/release/**',
  '**/dist/**',
  '**/dist-electron/**',
  '**/dist-wsl-agent/**',
  '**/dist-lima-agent/**',
  '**/dist-mcp/**',
];

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            emptyOutDir: true,
            target: 'node16',
            rollupOptions: {
              external: [
                ...nodeBuiltins,
                'better-sqlite3',
                'bufferutil',
                'utf-8-validate',
                'electron',
                // Externalize large CJS-compatible main-process dependencies
                // NOTE: ESM-only packages (@mariozechner/pi-coding-agent, pi-ai, electron-store, uuid)
                // must stay bundled — CJS require() can't load them
                '@anthropic-ai/sdk',
                '@larksuiteoapi/node-sdk',
                'openai',
                '@modelcontextprotocol/sdk',
                'electron-updater',
                'chokidar',
                'archiver',
                'ngrok',
                // NOTE: 'ws' must stay BUNDLED (not external). Its CJS exports is a
                // class extending EventEmitter; under Electron 22 (Node 16) the
                // inherited EventEmitter statics are enumerable, so Rollup's
                // namespace interop helper (for...in + getOwnPropertyDescriptor)
                // crashes at bundle top level. Bundled by both gateway.ts and
                // @slack/socket-mode. Its optional native deps stay external:
                'glob',
                'dotenv',
                // photon-node reads photon_rs_bg.wasm relative to its own package
                // dir at init. Bundling it inlines the glue into the main chunk,
                // where __dirname becomes dist-electron/main/ (no wasm) and the
                // lazy init gets hoisted to top level by inlineDynamicImports →
                // ENOENT at startup. Keep external: the package ships inside the
                // asar as a production dependency of pi-coding-agent.
                '@silvia-odwyer/photon-node',
              ],
              output: {
                // Ensure consistent interop for CJS/ESM
                interop: 'auto',
                // Prevent code splitting: dynamic imports (lima-sync, electron-updater)
                // must NOT create shared chunks that duplicate main module code.
                // Without this, provider chunks that require shared chunks will
                // re-execute all module-level side effects (single-instance lock,
                // NavServer, IPC handlers, app lifecycle).
                inlineDynamicImports: true,
              },
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            target: 'node16',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    watch: {
      ignored: ignoredWatchPaths,
    },
  },
  build: {
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'chrome108',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
