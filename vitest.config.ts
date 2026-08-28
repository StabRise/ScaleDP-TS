import { defineConfig } from 'vitest/config'

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
                        provider: 'playwright',
                        headless: true,
                        instances: [{ browser: 'chromium' }],
                    },
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
