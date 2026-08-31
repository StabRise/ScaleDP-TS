/**
 * Global configuration. Everything an application owns -- asset URLs, model
 * hosts, auth -- is injected here rather than hardcoded, which is the main
 * structural difference from the pdftools prototype this library supersedes.
 */

export interface ModelProgress {
    repo: string
    file: string
    /** Bytes fetched so far across the request set. */
    loaded: number
    /** Total bytes expected; 0 when the server sent no content-length. */
    total: number
    phase: 'downloading' | 'initializing' | 'ready'
}

export interface ScaleDpConfig {
    /** Base URL models resolve against. Point at an origin you control to self-host. */
    modelHost: string
    /** Where downloaded model files are kept between page loads. */
    cache: 'indexeddb' | 'none'
    /** IndexedDB database name, so consumers can isolate or purge their own store. */
    cacheDbName: string
    /**
     * Bearer token supplier for private model repos. Returning `undefined`
     * means "fetch anonymously".
     */
    auth?: (repo: string) => Promise<string | undefined> | string | undefined
    /** Reports download progress for every model file. */
    onProgress?: (progress: ModelProgress) => void
    /** Execution providers, in priority order, for ONNX sessions. */
    executionProviders: readonly string[]
    /**
     * WASM threads. `0` lets onnxruntime-web choose from hardwareConcurrency.
     * Threading only engages on a cross-origin-isolated page (COOP/COEP);
     * without that ORT silently falls back to the single-threaded build.
     */
    numThreads: number
    /**
     * Directory holding the onnxruntime-web `.wasm`/`.mjs` pair. The loader and
     * the binary must come from the same build variant AND the same version --
     * a mismatch fails at init with an opaque error. Leave unset to let
     * onnxruntime-web resolve its own default.
     */
    ortWasmPaths?: string
    /** pdf.js assets. All must be served by the consuming application. */
    pdf: {
        workerSrc?: string
        cMapUrl?: string
        standardFontDataUrl?: string
        wasmUrl?: string
    }
    /**
     * Tesseract assets.
     *
     * Two engines, two schemes. Recognition runs on tesseract-wasm, which takes
     * one worker URL and fetches `<lang>.traineddata` itself. Script detection
     * runs on tesseract.js, which resolves a worker script, a core directory and
     * a *directory* of models, and appends `.gz` unless told otherwise -- so its
     * paths cannot be folded into `dataUrl` and are named separately.
     *
     * Leave the `osd*` keys unset to let tesseract.js use its own CDN.
     */
    tesseract: {
        workerUrl?: string
        /** Base URL for `<lang>.traineddata` files. */
        dataUrl?: string
        /** tesseract.js worker script, for OSD. */
        osdWorkerPath?: string
        /** tesseract.js-core directory, for OSD. */
        osdCorePath?: string
        /** Directory holding `osd.traineddata`, for OSD. */
        osdLangPath?: string
        /** Whether `osdLangPath` serves `.traineddata.gz`. tesseract.js defaults to true. */
        osdGzip?: boolean
    }
    /** Hugging Face host overrides, for proxying gated repos through your origin. */
    hf: {
        remoteHost?: string
        /** e.g. 'api/hf-model/{model}/resolve/{revision}/' */
        remotePathTemplate?: string
    }
}

const DEFAULTS: ScaleDpConfig = {
    modelHost: 'https://huggingface.co',
    cache: 'indexeddb',
    cacheDbName: 'scaledp-models',
    executionProviders: ['wasm'],
    numThreads: 0,
    pdf: {},
    tesseract: {},
    hf: {},
}

let current: ScaleDpConfig = { ...DEFAULTS }

/** Merge `patch` into the global config. Nested asset maps merge per key. */
export function configure(patch: Partial<ScaleDpConfig>): ScaleDpConfig {
    current = {
        ...current,
        ...patch,
        pdf: { ...current.pdf, ...patch.pdf },
        tesseract: { ...current.tesseract, ...patch.tesseract },
        hf: { ...current.hf, ...patch.hf },
    }
    return current
}

export function getConfig(): Readonly<ScaleDpConfig> {
    return current
}

/** Restore defaults. Primarily for tests. */
export function resetConfig(): void {
    current = { ...DEFAULTS, pdf: {}, tesseract: {}, hf: {} }
}

/**
 * Threads to request from onnxruntime-web.
 *
 * Leaves one core for the UI and caps at 4 -- past that, ORT's own
 * synchronisation overhead outweighs the gain on these model sizes.
 */
export function defaultNumThreads(): number {
    const cores =
        typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
            ? navigator.hardwareConcurrency
            : 4
    return Math.max(1, Math.min(4, cores - 1))
}

export function resolveNumThreads(): number {
    const configured = getConfig().numThreads
    return configured > 0 ? configured : defaultNumThreads()
}
