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
        // Fires when another tab holds a connection open across the version
        // change this open needed (first-ever open on a fresh origin is one:
        // it upgrades from nothing to `DB_VERSION`). Neither `onsuccess` nor
        // `onerror` follows a block on its own -- the request just waits for
        // the other connection to close -- so without this handler a stale tab
        // left over from a crash or a hard reload turns into a silent,
        // indefinite hang here with no signal that anything is wrong.
        request.onblocked = () => {
            console.warn(
                `[scaledp] IndexedDB open of "${name}" is blocked by a connection open in ` +
                    'another tab. Close other tabs with this app open (or reload them) to ' +
                    'let the version change through.'
            )
        }
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

let warned = false

/**
 * Run a store operation, treating any failure as a cache miss.
 *
 * The cache is an optimisation and must never be the reason a model cannot be
 * used. IndexedDB refuses work for plenty of reasons outside this library's
 * control -- the quota is full, the page is in a private window, another tab
 * holds the database at a version this build does not know -- and a model that
 * has already been downloaded should still load through every one of them. The
 * cost of a refusal is a re-download next time, not a broken pipeline.
 *
 * Warned about once per page, because the alternative is one line per file per
 * model for the rest of the session.
 */
async function tryStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | undefined> {
    try {
        return await withStore(mode, fn)
    } catch (cause) {
        if (!warned) {
            warned = true
            const reason = cause instanceof Error ? cause.message : String(cause)
            const full = cause instanceof Error && cause.name === 'QuotaExceededError'
            console.warn(
                `[scaledp] The model cache is unavailable, so models will be re-downloaded ` +
                    `on every run. ${reason}` +
                    (full ? ' Free space with evict(), or configure({ cache: "none" }) to stop trying.' : '')
            )
        }
        return undefined
    }
}

/**
 * Ask the browser to keep this origin's storage rather than evict it.
 *
 * Without this the cache is "best effort", and a browser under disk pressure
 * drops a whole origin at a time -- which for a library that caches hundreds of
 * megabytes of weights is exactly the origin it will pick. Chrome decides
 * silently from site engagement rather than prompting, and Safari and private
 * windows expose no `persist` at all, so a `false` here is a normal answer and
 * not an error.
 *
 * Call it once during setup. It is the application's decision to make, so
 * nothing in this module calls it for you.
 */
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        const storage = navigator?.storage
        if (!storage?.persist || !storage.persisted) return false
        return (await storage.persisted()) || (await storage.persist())
    } catch {
        return false
    }
}

export function cacheKey(spec: ModelSpec, path: string): string {
    return `${spec.repo}@${spec.revision ?? 'main'}/${path}`
}

/**
 * Resolve a repo-relative path to a URL under the configured model host.
 *
 * A path that is already absolute is returned untouched -- some catalogues
 * (ppu-paddle-ocr's, for one) publish full URLs against their own host, and
 * rewriting those against `modelHost` would point at files that do not exist.
 */
export function fileUrl(spec: ModelSpec, path: string): string {
    if (/^https?:\/\//.test(path)) return path

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

/**
 * Fetch a URL as a Blob, reporting each chunk's byte length.
 *
 * A Blob rather than an ArrayBuffer because that is what goes into IndexedDB:
 * the browser keeps a large Blob in disk-backed storage, so writing one costs
 * a reference rather than a second copy of the weights in the renderer.
 */
async function fetchWithProgress(
    url: string,
    headers: HeadersInit | undefined,
    onChunk: (bytes: number) => void,
    signal?: AbortSignal
): Promise<Blob> {
    const response = await fetch(url, { headers, signal })
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
    }
    if (!response.body) {
        const blob = await response.blob()
        onChunk(blob.size)
        return blob
    }

    const reader = response.body.getReader()
    const chunks: BlobPart[] = []
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        // Cast, not copy: a Uint8Array is a BlobPart at runtime, and only
        // TypeScript's ArrayBufferLike generic disagrees. Copying each chunk
        // here would reintroduce exactly the second full copy this avoids.
        chunks.push(value as BlobPart)
        onChunk(value.byteLength)
    }

    // The Blob constructor takes the chunk list straight off the heap, so the
    // bytes are never assembled into one JS-side buffer here.
    const blob = new Blob(chunks)
    chunks.length = 0
    return blob
}

/** Cache entries were ArrayBuffers before they were Blobs; read either. */
async function toBuffer(value: Blob | ArrayBuffer): Promise<ArrayBuffer> {
    return value instanceof Blob ? await value.arrayBuffer() : value
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
        const hit = await tryStore('readonly', (s) => s.get(cacheKey(spec, file.path)))
        if (!hit) return false
    }
    return true
}

export async function evict(spec: ModelSpec): Promise<void> {
    if (!cacheAvailable()) return
    for (const file of spec.files) {
        await tryStore('readwrite', (s) => s.delete(cacheKey(spec, file.path)))
    }
}

export type ProgressListener = (progress: ModelProgress) => void

/**
 * Fan progress from one load out to everyone waiting on it.
 *
 * Model loads are shared -- two stages on one repo, or a second run arriving
 * while the first is still downloading, join the load already in flight rather
 * than starting their own -- so progress cannot simply be passed down as a
 * callback: only the caller that started the load would hear it. Each waiter
 * registers here instead, and a waiter that arrives after the load finished is
 * told `ready` straight away.
 */
export class ProgressHub {
    private readonly listeners = new Map<string, Set<ProgressListener>>()
    private readonly resolved = new WeakSet<Promise<unknown>>()
    private readonly tracked = new WeakSet<Promise<unknown>>()

    /** The callback a load reports through. */
    emitter(key: string): ProgressListener {
        return (progress) => {
            for (const listener of this.listeners.get(key) ?? []) listener(progress)
        }
    }

    /** Wait for `promise`, hearing its progress on `listener`. */
    follow<T>(key: string, promise: Promise<T>, listener?: ProgressListener, repo = key): Promise<T> {
        if (!this.tracked.has(promise)) {
            this.tracked.add(promise)
            promise.then(
                () => this.resolved.add(promise),
                () => undefined
            )
        }
        if (!listener) return promise
        if (this.resolved.has(promise)) {
            listener({ repo, file: '', loaded: 0, total: 0, phase: 'ready' })
            return promise
        }
        let set = this.listeners.get(key)
        if (!set) {
            set = new Set()
            this.listeners.set(key, set)
        }
        set.add(listener)
        const remove = () => {
            set.delete(listener)
            if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key)
        }
        promise.then(remove, remove)
        return promise
    }
}

/**
 * Report progress to the global `configure({ onProgress })` callback and to a
 * stage's own listener.
 */
export function reportProgress(progress: ModelProgress, local?: ProgressListener): void {
    getConfig().onProgress?.(progress)
    local?.(progress)
}

/** Report that `repo`'s session is built and usable. */
export function reportReady(repo: string, local?: ProgressListener): void {
    reportProgress({ repo, file: '', loaded: 0, total: 0, phase: 'ready' }, local)
}

/**
 * A value loaded once, on first use, with progress for every waiter.
 *
 * What each engine stage holds its ONNX session in. The load is memoised, a
 * failure is forgotten so the next call retries, and a waiter that asks after
 * the load finished is told `ready` -- which is how a second run over a reused
 * stage still reports the model's state to its UI.
 */
export class LazyLoad<T> {
    private value: T | undefined
    private loaded = false
    private pending: Promise<T> | null = null
    private readonly hub = new ProgressHub()

    /** `repo` names the model in the `ready` event. */
    constructor(private readonly repo: () => string) {}

    get current(): T | undefined {
        return this.value
    }

    get(load: (emit: ProgressListener) => Promise<T>, listener?: ProgressListener): Promise<T> {
        if (this.loaded && !listener) return Promise.resolve(this.value as T)
        if (!this.pending) {
            const emit = this.hub.emitter('load')
            // Started a microtask late, so the caller's listener is registered
            // before the loader can emit its first event.
            const pending = Promise.resolve()
                .then(() => load(emit))
                .then((value) => {
                    this.value = value
                    this.loaded = true
                    reportReady(this.repo(), emit)
                    return value
                })
            this.pending = pending
            pending.catch(() => {
                if (this.pending === pending) this.pending = null
            })
        }
        return this.hub.follow('load', this.pending, listener, this.repo())
    }

    /** Forget the value, so the next `get` loads again. Returns what was held. */
    reset(): T | undefined {
        const value = this.value
        this.value = undefined
        this.loaded = false
        this.pending = null
        return value
    }
}

export interface EnsureModelOptions {
    /** Stop *waiting* for the files. A download others share is not cancelled. */
    signal?: AbortSignal
    /** Progress for this call only, in addition to `configure({ onProgress })`. */
    onProgress?: ProgressListener
    /**
     * The caller is about to build a session from the files. The last event is
     * then `initializing` rather than `ready`, and the caller reports `ready`
     * (see `reportReady`) once the session exists -- so a UI never shows a
     * model as ready while its session is still being created.
     */
    building?: boolean
}

const downloads = new Map<string, Promise<ModelFiles>>()
const downloadProgress = new ProgressHub()

/**
 * Ensure every file in `spec` is available, downloading and caching what is
 * missing. Returns buffers keyed by repo-relative path.
 *
 * Progress is aggregate across the files still to fetch; already-cached files
 * count as instantly complete. Concurrent calls for the same files share one
 * load, and each hears its progress.
 */
export async function ensureModelFiles(
    spec: ModelSpec,
    options?: AbortSignal | EnsureModelOptions
): Promise<ModelFiles> {
    const { signal, onProgress, building } = isAbortSignal(options) ? { signal: options } : (options ?? {})
    signal?.throwIfAborted()

    const key = JSON.stringify([
        spec.repo,
        spec.revision ?? '',
        spec.files.map((f) => f.path),
        Boolean(building),
    ])
    let pending = downloads.get(key)
    if (!pending) {
        const emit = downloadProgress.emitter(key)
        // Deferred a microtask so this caller's listener is in place first.
        pending = Promise.resolve().then(() =>
            loadModelFiles(spec, building === true, (progress) => reportProgress(progress, emit))
        )
        downloads.set(key, pending)
        // Shared while in flight only: holding the buffers afterwards would
        // keep hundreds of megabytes alive after the sessions are built.
        const forget = () => {
            if (downloads.get(key) === pending) downloads.delete(key)
        }
        pending.then(forget, forget)
    }
    return raceAbort(downloadProgress.follow(key, pending, onProgress, spec.repo), signal)
}

function isAbortSignal(value: unknown): value is AbortSignal {
    return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            }
        )
    })
}

async function loadModelFiles(
    spec: ModelSpec,
    building: boolean,
    emit: ProgressListener
): Promise<ModelFiles> {
    const usable = cacheAvailable()
    const result: ModelFiles = {}
    const missing: ModelFile[] = []
    const finalPhase = building ? 'initializing' : 'ready'

    for (const file of spec.files) {
        const hit = usable
            ? await tryStore<Blob | ArrayBuffer | undefined>('readonly', (s) =>
                  s.get(cacheKey(spec, file.path))
              )
            : undefined
        if (hit) result[file.path] = await toBuffer(hit)
        else missing.push(file)
    }

    if (missing.length === 0) {
        emit({ repo: spec.repo, file: '', loaded: 0, total: 0, phase: finalPhase })
        return result
    }

    const headers = await authHeaders(spec.repo)

    // Size everything up front so progress is a real percentage rather than a
    // byte count climbing toward an unknown ceiling.
    //
    // A declared `approxBytes` is used as-is: a HEAD costs a full round-trip per
    // file (and on Hugging Face it follows a redirect to the CDN), which doubles
    // the request count for a download that is already the slow part. Only
    // files with no estimate are probed, and those probes run together.
    const sizes = await Promise.all(
        missing.map((file) =>
            file.approxBytes
                ? Promise.resolve(file.approxBytes)
                : contentLength(fileUrl(spec, file.path), headers, 0)
        )
    )
    const total = sizes.reduce((sum, size) => sum + size, 0)

    let loaded = 0
    for (const file of missing) {
        // No signal: the download is shared, so one caller giving up must not
        // cancel it for the others. It finishes into the cache regardless.
        const blob = await fetchWithProgress(fileUrl(spec, file.path), headers, (bytes) => {
            loaded += bytes
            emit({ repo: spec.repo, file: file.path, loaded, total, phase: 'downloading' })
        })
        // Stored before it is materialised, so the write never coincides with
        // the caller's copy of the same several hundred megabytes.
        if (usable) {
            await tryStore('readwrite', (s) => s.put(blob, cacheKey(spec, file.path)))
        }
        result[file.path] = await blob.arrayBuffer()
    }

    emit({ repo: spec.repo, file: '', loaded: total, total, phase: finalPhase })
    return result
}

export type { ModelProgress }
