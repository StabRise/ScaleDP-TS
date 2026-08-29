/**
 * One-time library setup, and the download-progress channel.
 *
 * `configure()` takes a single `onProgress` callback and runs before React
 * mounts, so the callback writes into a module-level sink a component can
 * subscribe to -- rather than the config being rebuilt on every render.
 */

import { configure } from '@stabrise/scaledp'
import { isCrossOriginIsolated, isWebGpuAvailable } from '@stabrise/scaledp/ocr'

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

export async function setup(): Promise<Capability[]> {
    const webgpu = await isWebGpuAvailable()

    configure({
        cache: 'indexeddb',
        // WebGPU is typically 2-5x faster and needs no cross-origin isolation.
        executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
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

    return [
        { label: webgpu ? 'webgpu' : 'wasm', on: true },
        { label: 'cross-origin isolated', on: isCrossOriginIsolated() },
    ]
}
