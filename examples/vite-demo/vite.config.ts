import { defineConfig } from 'vite'

export default defineConfig({
    server: {
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
