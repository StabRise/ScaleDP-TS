import { defineConfig } from 'tsdown'

export default defineConfig({
    // Subpath entries are added here as each engine lands, so a green build
    // always means every declared export actually resolves.
    entry: [
        'src/index.ts',
        'src/pdf/index.ts',
        'src/ocr/index.ts',
        'src/ner/index.ts',
        'src/detect/index.ts',
        'src/registry/index.ts',
        'src/worker/index.ts',
        'src/display/index.ts',
    ],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    platform: 'browser',
    target: ['es2022', 'chrome111', 'firefox128', 'safari17'],
    deps: {
        // Every ML/PDF engine is an optional peer dependency. Bundling one would
        // duplicate the runtime and break the single-onnxruntime-web rule. The
        // phone and date libraries are optional peers too: RegexNer works
        // without them, so their weight is the application's choice.
        neverBundle: [
            '@huggingface/transformers',
            'chrono-node',
            'libphonenumber-js',
            'onnxruntime-web',
            'pdfjs-dist',
            'ppu-paddle-ocr',
            'tesseract-wasm',
            'tesseract.js',
        ],
    },
})
