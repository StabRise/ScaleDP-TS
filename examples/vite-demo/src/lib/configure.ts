/**
 * One-time library setup, and the download-progress channel.
 *
 * `configure()` takes a single `onProgress` callback and runs before React
 * mounts, so the callback writes into a module-level sink a component can
 * subscribe to -- rather than the config being rebuilt on every render.
 */

import { configure, defaultNumThreads, requestPersistentStorage } from '@stabrise/scaledp'
import {
    disposePaddleServices,
    disposeScriptDetection,
    disposeTesseract,
    isCrossOriginIsolated,
    isWebGpuAvailable,
    resetOrt,
} from '@stabrise/scaledp/ocr'
import { type Engine, useRuntime } from '../store/runtime'

let sink: ((message: string) => void) | null = null

export function setProgressSink(next: (message: string) => void): () => void {
    sink = next
    return () => {
        sink = null
    }
}

export interface Capability {
    label: string
    on: boolean
}

/** What the tab can offer, and what the current choice resolves to on it. */
export interface RuntimeReport {
    /** The browser reported a usable WebGPU adapter. */
    webgpu: boolean
    /**
     * WASM threads need SharedArrayBuffer, which needs COOP/COEP. GitHub Pages
     * cannot set response headers, so the deployed site is single-threaded
     * however this is set; the dev server sets them and is not.
     */
    isolated: boolean
    /** The provider new sessions will be created with. */
    engine: 'webgpu' | 'wasm'
    /** Threads onnxruntime-web is being asked for. 1 is single-threaded. */
    threads: number
    /** What "auto" resolves to, so the control can name the number. */
    autoThreads: number
    /** Upper bound the control offers: what the machine reports. */
    cores: number
}

/**
 * Turn the stored preference into the two config fields that carry it.
 *
 * WASM stays behind WebGPU in the list even when WebGPU was asked for by name:
 * a model WebGPU has no kernel for -- PP-OCR's recognition graph is one --
 * fails at session creation, and the fallback is what keeps that a slower run
 * rather than a broken one.
 */
function resolve(engine: Engine, threads: boolean, threadCount: number, webgpu: boolean, isolated: boolean) {
    const useGpu = engine === 'webgpu' || (engine === 'auto' && webgpu)
    return {
        executionProviders: useGpu ? ['webgpu', 'wasm'] : ['wasm'],
        // 0 lets the library choose; 1 is one thread, which is threads off.
        numThreads: threads && isolated ? threadCount : 1,
        engine: (useGpu ? 'webgpu' : 'wasm') as 'webgpu' | 'wasm',
    }
}

/** What the machine reports, floored at 1 where it reports nothing. */
export function coreCount(): number {
    const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency
    return Math.max(1, cores || 4)
}

export async function setup(): Promise<RuntimeReport> {
    const webgpu = await isWebGpuAvailable()
    const isolated = isCrossOriginIsolated()
    const { engine, threads, threadCount } = useRuntime.getState()
    const chosen = resolve(engine, threads, threadCount, webgpu, isolated)

    configure({
        cache: 'indexeddb',
        // WebGPU is typically 2-5x faster and needs no cross-origin isolation.
        executionProviders: chosen.executionProviders,
        numThreads: chosen.numThreads,
        tesseract: {
            workerUrl: '/tesseract/tesseract-worker.js',
            dataUrl: '/tesseract/',
        },
        pdf: {
            workerSrc: '/pdf.worker.min.mjs',
            cMapUrl: '/cmaps/',
            standardFontDataUrl: '/standard_fonts/',
        },
        onProgress: ({ repo, file, loaded, total, phase }) => {
            if (phase === 'ready') return sink?.('')
            // Some catalogues use absolute URLs as file paths, so show the
            // filename rather than dumping a signed CDN URL into the interface.
            const what = (file || repo).split('/').pop() ?? repo
            sink?.(
                total > 0 ? `${phase} ${what} — ${Math.round((loaded / total) * 100)}%` : `${phase} ${what}…`
            )
        },
    })

    // Weights here run to hundreds of megabytes, which makes this origin the
    // first thing a browser under disk pressure evicts. Asking costs nothing:
    // Chrome decides silently from site engagement, and Safari has no such call.
    void requestPersistentStorage()

    return {
        webgpu,
        isolated,
        engine: chosen.engine,
        threads: chosen.numThreads === 0 ? defaultNumThreads() : chosen.numThreads,
        autoThreads: defaultNumThreads(),
        cores: coreCount(),
    }
}

/**
 * Re-read the preference and drop every engine cached against the old one.
 *
 * The execution provider is chosen per session, so a new session picks up the
 * change -- but only a new one. Everything the library keeps between runs is
 * holding a session built with the provider in force when it was created:
 * PaddleOCR's per-preset services, the Tesseract worker, the OSD worker. A
 * pipeline's own stages are disposed after every run, so they need nothing.
 *
 * Threads are not in this list on purpose. `env.wasm.numThreads` is read when
 * onnxruntime-web starts its WASM runtime, and there is no way to restart it
 * inside a page, so that one only lands on reload.
 */
export async function applyRuntime(): Promise<RuntimeReport> {
    await Promise.all([disposePaddleServices(), disposeTesseract(), disposeScriptDetection()]).catch(
        () => undefined
    )
    resetOrt()
    return setup()
}
