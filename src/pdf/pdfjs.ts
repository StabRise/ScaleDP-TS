/**
 * Lazy pdf.js loader.
 *
 * pdfjs-dist is an optional peer dependency, so it is imported only when a PDF
 * stage actually runs. Every asset path comes from `configure()` -- unlike the
 * pdftools prototype, which hardcoded `/pdf.worker.min.mjs`, a path only its
 * own Next app could serve.
 */

import { getConfig } from '../core/config.js'

type PdfjsModule = typeof import('pdfjs-dist')

let modulePromise: Promise<PdfjsModule> | null = null

export async function loadPdfjs(): Promise<PdfjsModule> {
    if (modulePromise) return modulePromise

    modulePromise = (async () => {
        let pdfjs: PdfjsModule
        try {
            pdfjs = await import('pdfjs-dist')
        } catch (cause) {
            throw new Error('pdfjs-dist is required for PDF support. Install it: npm i pdfjs-dist', { cause })
        }

        const { workerSrc } = getConfig().pdf
        if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
        return pdfjs
    })()

    return modulePromise
}

/** Reset the cached module. Tests only. */
export function resetPdfjs(): void {
    modulePromise = null
}

/**
 * Turn pdf.js's worker-setup failure into something actionable.
 *
 * When `workerSrc` is unset or 404s, pdf.js reports "Setting up fake worker
 * failed" with a bare module URL, which says nothing about what to do. The
 * worker is not bundled with this library on purpose -- it has to be served by
 * the consuming application -- so the fix is always the same two steps.
 */
export function describePdfError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    if (!/fake worker|worker/i.test(message)) {
        return error instanceof Error ? error : new Error(message)
    }

    const { workerSrc } = getConfig().pdf
    const cause = workerSrc
        ? `pdf.js could not load its worker from "${workerSrc}".`
        : 'pdf.js has no worker configured.'

    return new Error(
        `${cause}\n` +
            'Copy it out of the package and point the config at it:\n' +
            '  cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/\n' +
            "  configure({ pdf: { workerSrc: '/pdf.worker.min.mjs' } })\n" +
            `Original error: ${message}`,
        { cause: error }
    )
}

/** Document-level options assembled from the global config. */
export function documentOptions(data: Uint8Array): Record<string, unknown> {
    const { cMapUrl, standardFontDataUrl, wasmUrl } = getConfig().pdf
    // pdf.js takes ownership of the buffer it is given and detaches it, so hand
    // over a copy: callers routinely reuse the row's `content` afterwards.
    const owned = new Uint8Array(data.byteLength)
    owned.set(data)

    const options: Record<string, unknown> = { data: owned }
    if (cMapUrl) {
        options.cMapUrl = cMapUrl
        options.cMapPacked = true
    }
    if (standardFontDataUrl) options.standardFontDataUrl = standardFontDataUrl
    if (wasmUrl) options.wasmUrl = wasmUrl
    return options
}
