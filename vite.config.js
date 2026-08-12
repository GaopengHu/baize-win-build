var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { resolve } from 'path';
import { builtinModules } from 'module';
// Node built-in modules must be external for Electron main process
var nodeBuiltins = builtinModules.flatMap(function (m) { return [m, "node:".concat(m)]; });
var ignoredWatchPaths = [
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
                onstart: function (args) {
                    args.startup();
                },
                vite: {
                    build: {
                        outDir: 'dist-electron/main',
                        rollupOptions: {
                            external: __spreadArray(__spreadArray([], nodeBuiltins, true), [
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
                                'ws',
                                'glob',
                                'dotenv',
                            ], false),
                            output: {
                                // Ensure consistent interop for CJS/ESM
                                interop: 'auto',
                            },
                        },
                    },
                },
            },
            {
                entry: 'src/preload/index.ts',
                onstart: function (args) {
                    args.reload();
                },
                vite: {
                    build: {
                        outDir: 'dist-electron/preload',
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
        outDir: 'dist',
        emptyOutDir: true,
    },
});
