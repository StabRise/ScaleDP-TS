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

type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>
type PdfLoadingTask = ReturnType<PdfjsModule['getDocument']>

interface CachedDocument {
    task: PdfLoadingTask
    document: Promise<PdfDocument>
    /** Callers currently inside `withPdfDocument` for this entry. */
    users: number
    /** Evicted while in use: destroy once the last user leaves. */
    stale: boolean
}

/**
 * Loaded documents, keyed by the exact buffer they were loaded from.
 *
 * Parsing a PDF is not cheap and every PDF stage did it independently: a
 * caller that reads a page's text, looks for embedded images and renders it
 * parses the same file three times, and doing that per page parses a 100-page
 * document hundreds of times.
 *
 * Keyed on object identity rather than on a content hash. Two different files
 * can share a length and a prefix, and being wrong here means serving the wrong
 * document -- whereas a caller that builds a fresh array each time merely
 * misses the cache and gets today's behaviour.
 */
const documents = new Map<Uint8Array, CachedDocument>()

/**
 * How many documents may stay loaded.
 *
 * Each holds the pdf.js worker's own copy of the file, so this is real memory.
 * Two covers the common shape of a consumer running two passes over one
 * document from separately-obtained buffers.
 */
const MAX_CACHED_DOCUMENTS = 2

function release(entry: CachedDocument): void {
    entry.users -= 1
    if (entry.stale && entry.users === 0) {
        // destroy() lives on the loading task, not the document proxy, and is
        // what releases the pdf.js worker's copy of the file.
        void entry.task.destroy().catch(() => undefined)
    }
}

function evictBeyondLimit(): void {
    while (documents.size > MAX_CACHED_DOCUMENTS) {
        const oldest = documents.keys().next().value as Uint8Array
        const entry = documents.get(oldest)
        documents.delete(oldest)
        if (!entry) continue
        entry.stale = true
        // A document still being read is destroyed by its last user instead.
        if (entry.users === 0) void entry.task.destroy().catch(() => undefined)
    }
}

/**
 * Run `use` against a loaded PDF, reusing an already-parsed one when possible.
 *
 * The document outlives the call, so `use` must not destroy it; page-level
 * cleanup (`page.cleanup()`) is still the caller's to do.
 */
export async function withPdfDocument<T>(
    data: Uint8Array,
    use: (document: PdfDocument) => Promise<T>
): Promise<T> {
    let entry = documents.get(data)

    if (entry) {
        // Re-insert so eviction order stays least-recently-used.
        documents.delete(data)
        documents.set(data, entry)
    } else {
        const pdfjs = await loadPdfjs()
        const task = pdfjs.getDocument(documentOptions(data))
        entry = { task, document: task.promise, users: 0, stale: false }
        // A document that fails to load must not be served to the next caller.
        entry.document.catch(() => {
            if (documents.get(data) === entry) documents.delete(data)
        })
        documents.set(data, entry)
        evictBeyondLimit()
    }

    entry.users += 1
    try {
        return await use(await entry.document)
    } finally {
        release(entry)
    }
}

/** Drop every cached document, releasing the pdf.js worker copies. */
export async function resetPdfDocuments(): Promise<void> {
    const live = [...documents.values()]
    documents.clear()
    await Promise.all(
        live.map((entry) => {
            entry.stale = true
            return entry.users === 0 ? entry.task.destroy().catch(() => undefined) : undefined
        })
    )
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
