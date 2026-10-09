import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/**
 * The benchmark can serve its page cross-origin isolated, which is the only
 * way onnxruntime-web's WASM threads engage. `credentialless` rather than
 * `require-corp` so cross-origin model downloads need no CORP header.
 */
const isolationHeaders =
    process.env.BENCH_ISOLATED === '1'
        ? {
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'credentialless',
          }
        : {}

export default defineConfig({
    test: {
        projects: [
            {
                // Pure logic: schemas, geometry, params, chunking, text reconstruction.
                test: {
                    name: 'unit',
                    environment: 'node',
                    include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
                },
            },
            {
                // Anything touching onnxruntime-web, WASM, WebGPU, OffscreenCanvas or
                // pdf.js needs a real browser. pdftools skips these entirely; we don't.
                test: {
                    name: 'browser',
                    include: ['test/browser/**/*.test.ts'],
                    browser: {
                        enabled: true,
                        provider: playwright(),
                        headless: true,
                        instances: [{ browser: 'chromium' }],
                    },
                },
                // pdf.js is large enough that Vite discovers and pre-bundles it
                // mid-run, which reloads the page under the running test.
                optimizeDeps: {
                    include: ['pdfjs-dist'],
                },
            },
            {
                // Throughput across parallelism settings. Never part of a test
                // run: `pnpm bench` runs it and records the numbers.
                test: {
                    name: 'bench',
                    include: ['bench/**/*.bench.test.ts'],
                    browser: {
                        enabled: true,
                        // WebGPU is off by default in headless Chromium, and headless
                        // only ever gets SwiftShader, a software adapter: timing it
                        // measures the emulator. BENCH_HEADED=1 opens a window and
                        // gets the real GPU.
                        provider: playwright({ launchOptions: { args: ['--enable-unsafe-webgpu'] } }),
                        headless: process.env.BENCH_HEADED !== '1',
                        instances: [{ browser: 'chromium' }],
                    },
                },
                server: { headers: isolationHeaders },
                // Not onnxruntime-web: pre-bundled, it can no longer find its
                // own .wasm files, and every engine stage fails in a blink.
                optimizeDeps: {
                    include: ['pdfjs-dist'],
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'json-summary'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/index.ts', 'src/**/*.test.ts', 'src/ner/vendor/**'],
            thresholds: { lines: 85, functions: 85, statements: 85, branches: 75 },
        },
    },
})
