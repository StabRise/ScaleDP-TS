import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const dist = (path: string) => resolve(here, '../../dist', path)

export default defineConfig({
    resolve: {
        // The library is aliased straight at its build output rather than
        // installed as a dependency. Every linking protocol has a catch here:
        // `link:` is pnpm/yarn-only (bun reads it as a global link name),
        // `workspace:*` cannot address the repository root, and `file:` makes
        // bun hardlink-clone the package -- which goes stale the moment tsdown
        // cleans dist and writes new inodes. Aliasing always resolves the
        // current build, under every package manager.
        //
        // The trade-off: this bypasses the package's `exports` map, so it does
        // not prove that map is correct. `pnpm check:pkg` (publint + attw) is
        // what covers that.
        //
        // Longest specifier first -- Vite tries these in order.
        alias: [
            { find: '@stabrise/scaledp/worker', replacement: dist('worker/index.js') },
            { find: '@stabrise/scaledp/detect', replacement: dist('detect/index.js') },
            { find: '@stabrise/scaledp/pdf', replacement: dist('pdf/index.js') },
            { find: '@stabrise/scaledp/ocr', replacement: dist('ocr/index.js') },
            { find: '@stabrise/scaledp/ner', replacement: dist('ner/index.js') },
            { find: '@stabrise/scaledp', replacement: dist('index.js') },
        ],
    },
    server: {
        // Vite refuses to serve files outside the project root by default, and
        // the build output lives one level up.
        fs: { allow: [resolve(here, '../..')] },
        headers: {
            // Cross-origin isolation enables SharedArrayBuffer, which is what
            // multi-threaded WASM needs. Without these, onnxruntime-web
            // silently falls back to its single-threaded build.
            //
            // This is a property of the page, not the worker. WebGPU needs
            // none of it, so drop these if you only target WebGPU.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    optimizeDeps: {
        // These ship WASM and their own workers; pre-bundling breaks both.
        exclude: ['onnxruntime-web', 'ppu-paddle-ocr', '@huggingface/transformers'],
    },
})
