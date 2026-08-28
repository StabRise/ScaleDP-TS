/**
 * onnxruntime-web setup, shared by every ONNX-backed stage.
 *
 * onnxruntime-web is an optional peer dependency, imported lazily so the core
 * pulls in no ML runtime.
 */

import { getConfig, resolveNumThreads } from '../core/config.js'

type OrtModule = typeof import('onnxruntime-web')

let modulePromise: Promise<OrtModule> | null = null

/**
 * onnxruntime-web's JS glue and its .wasm binary must come from the same build
 * variant AND the same version -- a mismatch fails at session creation with an
 * opaque error. Deriving the CDN URL from the resolved package version is what
 * keeps them in step; the pdftools prototype hardcoded 1.23.2 in three files
 * while actually running 1.26/1.27.
 */
function cdnWasmPaths(version: string): string {
    return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`
}

export async function loadOrt(): Promise<OrtModule> {
    if (modulePromise) return modulePromise

    modulePromise = (async () => {
        let ort: OrtModule
        try {
            ort = await import('onnxruntime-web')
        } catch (cause) {
            throw new Error(
                'onnxruntime-web is required for OCR, NER and detection. Install it: npm i onnxruntime-web',
                { cause }
            )
        }

        const config = getConfig()
        if (config.ortWasmPaths) {
            ort.env.wasm.wasmPaths = config.ortWasmPaths
        } else if (!ort.env.wasm.wasmPaths && ort.env.versions?.web) {
            // Set eagerly, before any session exists, so a bundled library's own
            // "if not already set" default never wins.
            ort.env.wasm.wasmPaths = cdnWasmPaths(ort.env.versions.web)
        }

        // Threading only engages on a cross-origin-isolated page (COOP/COEP).
        // Without that, ORT silently falls back to its single-threaded build and
        // this value has no effect -- not an error, just a slower run.
        ort.env.wasm.numThreads = resolveNumThreads()
        ort.env.logLevel = 'error'
        return ort
    })()

    return modulePromise
}

/** Reset the cached module. Tests only. */
export function resetOrt(): void {
    modulePromise = null
}

export interface SessionOptions {
    executionProviders?: readonly string[]
    /** Companion `.onnx_data` files for models with external weights. */
    externalData?: { path: string; data: ArrayBuffer | Uint8Array }[]
}

/** Create an inference session from model bytes. */
export async function createSession(
    model: ArrayBuffer | Uint8Array,
    options: SessionOptions = {}
): Promise<import('onnxruntime-web').InferenceSession> {
    const ort = await loadOrt()
    const bytes = model instanceof Uint8Array ? model : new Uint8Array(model)

    return ort.InferenceSession.create(bytes, {
        executionProviders: [...(options.executionProviders ?? getConfig().executionProviders)] as string[],
        graphOptimizationLevel: 'all',
        ...(options.externalData ? { externalData: options.externalData } : {}),
    })
}

/** True when the browser exposes a usable WebGPU adapter. */
export async function isWebGpuAvailable(): Promise<boolean> {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (!gpu) return false
    try {
        return (await gpu.requestAdapter()) !== null
    } catch {
        return false
    }
}

/**
 * True when the page is cross-origin isolated, which is what SharedArrayBuffer
 * and therefore multi-threaded WASM require. A library cannot set COOP/COEP for
 * its consumer, so this is reported rather than enforced.
 */
export function isCrossOriginIsolated(): boolean {
    return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
}
