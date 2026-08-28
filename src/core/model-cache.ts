/**
 * Model file fetching with IndexedDB persistence and streaming progress.
 *
 * The pdftools prototype implements this twice -- once for GLiNER and once for
 * PaddleOCR -- differing only in where sizes come from and whether an auth
 * token is attached. Both behaviours are folded in here: sizes come from a HEAD
 * request (real percentages, rather than the hardcoded byte counts the GLiNER
 * copy used) with a declared `approxBytes` as fallback.
 */

import { getConfig, type ModelProgress } from './config.js'

const STORE = 'files'
const DB_VERSION = 1

export interface ModelFile {
    /** Repo-relative path, e.g. 'onnx/model_quantized.onnx'. */
    path: string
    /** Fallback size used for progress when the server sends no content-length. */
    approxBytes?: number
}

export interface ModelSpec {
    /** Hugging Face repo id, e.g. 'onnx-community/gliner_multi_pii-v1'. */
    repo: string
    revision?: string
    files: ModelFile[]
}

export type ModelFiles = Record<string, ArrayBuffer>

function openDb(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DB_VERSION)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

/**
 * Run one store operation.
 *
 * Writes resolve on transaction *commit*, not on request success -- a request
 * succeeding only means it was queued, so resolving there would report a
 * durable write that a later abort could still roll back.
 */
async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const db = await openDb(getConfig().cacheDbName)
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE, mode)
            const request = fn(tx.objectStore(STORE))
            request.onerror = () => reject(request.error)
            if (mode === 'readonly') {
                request.onsuccess = () => resolve(request.result)
            } else {
                tx.oncomplete = () => resolve(request.result)
                tx.onabort = () => reject(tx.error)
                tx.onerror = () => reject(tx.error)
            }
        })
    } finally {
        db.close()
    }
}

const cacheAvailable = (): boolean => getConfig().cache === 'indexeddb' && typeof indexedDB !== 'undefined'

export function cacheKey(spec: ModelSpec, path: string): string {
    return `${spec.repo}@${spec.revision ?? 'main'}/${path}`
}

/** Resolve a repo-relative path to a URL under the configured model host. */
export function fileUrl(spec: ModelSpec, path: string): string {
    const { modelHost } = getConfig()
    const host = modelHost.replace(/\/+$/, '')
    // A bare directory host (self-hosting) has no HF resolve/<revision> segment.
    if (!/^https?:\/\/(?:[^/]*\.)?huggingface\.co/.test(host)) {
        return `${host}/${spec.repo}/${path}`
    }
    return `${host}/${spec.repo}/resolve/${spec.revision ?? 'main'}/${path}`
}

async function authHeaders(repo: string): Promise<HeadersInit | undefined> {
    const auth = getConfig().auth
    if (!auth) return undefined
    const token = await auth(repo)
    return token ? { Authorization: `Bearer ${token}` } : undefined
}

/** Fetch a URL as an ArrayBuffer, reporting each chunk's byte length. */
async function fetchWithProgress(
    url: string,
    headers: HeadersInit | undefined,
    onChunk: (bytes: number) => void,
    signal?: AbortSignal
): Promise<ArrayBuffer> {
    const response = await fetch(url, { headers, signal })
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
    }
    if (!response.body) {
        const buffer = await response.arrayBuffer()
        onChunk(buffer.byteLength)
        return buffer
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        chunks.push(value)
        total += value.byteLength
        onChunk(value.byteLength)
    }

    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out.buffer
}

/** Byte size from a HEAD request, falling back to the declared estimate. */
async function contentLength(
    url: string,
    headers: HeadersInit | undefined,
    fallback: number
): Promise<number> {
    try {
        const response = await fetch(url, { method: 'HEAD', headers })
        return Number(response.headers.get('content-length') ?? 0) || fallback
    } catch {
        return fallback
    }
}

export async function isCached(spec: ModelSpec): Promise<boolean> {
    if (!cacheAvailable()) return false
    for (const file of spec.files) {
        const hit = await withStore('readonly', (s) => s.get(cacheKey(spec, file.path)))
        if (!hit) return false
    }
    return true
}

export async function evict(spec: ModelSpec): Promise<void> {
    if (!cacheAvailable()) return
    for (const file of spec.files) {
        await withStore('readwrite', (s) => s.delete(cacheKey(spec, file.path)))
    }
}

/**
 * Ensure every file in `spec` is available, downloading and caching what is
 * missing. Returns buffers keyed by repo-relative path.
 *
 * Progress is aggregate across the files still to fetch; already-cached files
 * count as instantly complete.
 */
export async function ensureModelFiles(spec: ModelSpec, signal?: AbortSignal): Promise<ModelFiles> {
    const { onProgress } = getConfig()
    const usable = cacheAvailable()
    const result: ModelFiles = {}
    const missing: ModelFile[] = []

    for (const file of spec.files) {
        const hit = usable
            ? await withStore<ArrayBuffer | undefined>('readonly', (s) => s.get(cacheKey(spec, file.path)))
            : undefined
        if (hit) result[file.path] = hit
        else missing.push(file)
    }

    if (missing.length === 0) {
        onProgress?.({ repo: spec.repo, file: '', loaded: 0, total: 0, phase: 'ready' })
        return result
    }

    const headers = await authHeaders(spec.repo)

    // Size everything up front so progress is a real percentage rather than a
    // byte count climbing toward an unknown ceiling.
    let total = 0
    for (const file of missing) {
        total += await contentLength(fileUrl(spec, file.path), headers, file.approxBytes ?? 0)
    }

    let loaded = 0
    for (const file of missing) {
        const buffer = await fetchWithProgress(
            fileUrl(spec, file.path),
            headers,
            (bytes) => {
                loaded += bytes
                onProgress?.({
                    repo: spec.repo,
                    file: file.path,
                    loaded,
                    total,
                    phase: 'downloading',
                })
            },
            signal
        )
        if (usable) {
            await withStore('readwrite', (s) => s.put(buffer, cacheKey(spec, file.path)))
        }
        result[file.path] = buffer
    }

    onProgress?.({ repo: spec.repo, file: '', loaded: total, total, phase: 'initializing' })
    return result
}

export type { ModelProgress }
