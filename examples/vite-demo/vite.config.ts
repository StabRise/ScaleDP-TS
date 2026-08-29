import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const dist = (path: string) => resolve(here, '../../dist', path)

/**
 * Cross-origin isolation on every dev response.
 *
 * `server.headers` alone is not enough once React Router owns the dev server:
 * it reaches Vite's static and transform middleware but not the SSR handler
 * that renders the HTML document, which is precisely the response the headers
 * have to be on -- isolation is a property of the *page*. Without them
 * `crossOriginIsolated` is false, onnxruntime-web silently falls back to its
 * single-threaded build, and `numThreads` does nothing.
 *
 * `public/_headers` and `netlify.toml` say the same thing to the static host.
 * All three have to stay in step, or a slowdown that is really a missing header
 * reads as a performance regression.
 */
const crossOriginIsolation = (): Plugin => ({
    name: 'scaledp-cross-origin-isolation',
    configureServer(server) {
        server.middlewares.use((_request, response, next) => {
            response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
            response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
            next()
        })
    },
})

export default defineConfig({
    // Order matters: fumadocs-mdx has to claim .mdx before React Router walks
    // the route graph, and tailwind has to run before the router's asset pass.
    plugins: [crossOriginIsolation(), fumadocsMdx(), tailwindcss(), reactRouter()],
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
            { find: '@stabrise/scaledp/registry', replacement: dist('registry/index.js') },
            { find: '@stabrise/scaledp/display', replacement: dist('display/index.js') },
            { find: '@stabrise/scaledp/worker', replacement: dist('worker/index.js') },
            { find: '@stabrise/scaledp/detect', replacement: dist('detect/index.js') },
            { find: '@stabrise/scaledp/pdf', replacement: dist('pdf/index.js') },
            { find: '@stabrise/scaledp/ocr', replacement: dist('ocr/index.js') },
            { find: '@stabrise/scaledp/ner', replacement: dist('ner/index.js') },
            { find: '@stabrise/scaledp', replacement: dist('index.js') },
        ],
    },
    server: {
        // Pin the port. Vite otherwise moves to the next free one when 5173 is
        // busy, and because IndexedDB is scoped per origin, every new port is a
        // fresh empty cache -- so the models appear to re-download on every run.
        // Failing loudly is better than silently losing several hundred MB of
        // cached weights.
        port: 5173,
        strictPort: true,
        // Vite refuses to serve files outside the project root by default, and
        // the build output lives one level up.
        fs: { allow: [resolve(here, '../..')] },
        // Cross-origin isolation is set by the plugin above rather than here --
        // see its comment for why `server.headers` is not sufficient.
    },
    optimizeDeps: {
        // Zustand is only reached through the demo route's lazy import, so
        // Vite's initial scan never sees it and optimises it mid-session
        // instead -- against a second copy of React, which throws "Invalid
        // hook call" on the builder's first render. Declaring it puts it in
        // the first pass with everything else.
        include: ['zustand', 'zustand/middleware'],
        // These ship WASM and their own workers; pre-bundling breaks both.
        exclude: ['onnxruntime-web', 'ppu-paddle-ocr', '@huggingface/transformers'],
    },
})
