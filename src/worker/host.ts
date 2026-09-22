/**
 * Worker-side pipeline host.
 *
 * Import this from your own worker entry point:
 *
 *   import { startScaleDpWorker } from '@stabrise/scaledp/worker'
 *   startScaleDpWorker()
 *
 * A worker entry has to be a real module in the consuming app so the bundler
 * can resolve it; a library cannot ship a URL that its consumer's bundler will
 * honour.
 */

import { configure } from '../core/config.js'
import { formatException } from '../core/errors.js'
import { Pipeline, type Row, type Stage } from '../core/pipeline.js'
import { CONTENT_REF_COL, type StageDescriptor, type WorkerRequest, type WorkerResponse } from './protocol.js'

/** Builds a stage from its descriptor. Consumers register the stages they use. */
export type StageFactory = (descriptor: StageDescriptor) => Stage | undefined

const registry = new Map<string, (options?: Record<string, unknown>) => Stage>()

/**
 * Register stage constructors the worker may build.
 *
 * Explicit registration keeps the worker bundle to the engines actually used --
 * importing every stage would pull pdf.js, ORT, PaddleOCR and Tesseract into
 * every worker regardless.
 */
export function registerStages(stages: Record<string, new (options?: never) => Stage>): void {
    for (const [name, Ctor] of Object.entries(stages)) {
        registry.set(name, (options) => new Ctor(options as never))
    }
}

function buildStage(descriptor: StageDescriptor): Stage {
    const factory = registry.get(descriptor.type)
    if (!factory) {
        throw new Error(
            `Stage "${descriptor.type}" is not registered in this worker. ` +
                `Call registerStages({ ${descriptor.type} }) in the worker entry.`
        )
    }
    return factory(descriptor.options)
}

/** Start listening for pipeline requests. Call once, from a worker entry. */
export function startScaleDpWorker(scope: DedicatedWorkerGlobalScope = self as never): void {
    const post = (message: WorkerResponse) => scope.postMessage(message)

    // ORT sessions run one inference at a time, so requests are serialised
    // rather than run concurrently. Without this, a second transform started
    // mid-flight fails with "Session already started".
    let queue: Promise<unknown> = Promise.resolve()
    let active: Pipeline | null = null

    /**
     * Content registered with `putContent`, by key.
     *
     * Holding the bytes here is the point: a row referencing a key gets the
     * *same* buffer object on every transform, so the document cache hits
     * instead of re-parsing a fresh copy. Nothing is evicted automatically --
     * the caller registered it and the caller drops it, because only the caller
     * knows when a document is finished with.
     */
    const contents = new Map<string, Uint8Array>()

    /** Swap `contentRef` for the bytes it names. */
    const resolveRows = (rows: Row[]): Row[] =>
        rows.map((row) => {
            const key = row[CONTENT_REF_COL]
            if (typeof key !== 'string') return row
            const content = contents.get(key)
            if (!content) {
                throw new Error(
                    `No content registered under "${key}". Call putContent() before referencing it.`
                )
            }
            const { [CONTENT_REF_COL]: _ref, ...rest } = row
            return { ...rest, content }
        })

    /**
     * The descriptor list `active` was built from.
     *
     * Rebuilding per request is not free: every stage that owns an ONNX session
     * holds it as an instance field created in `init()`, and `ensureModelFiles`
     * memoises nothing, so a fresh Pipeline per transform re-reads megabytes of
     * weights out of IndexedDB and creates a new InferenceSession. A host driven
     * a page at a time -- which is the normal way to stream results -- paid that
     * on every page.
     *
     * `transform` calls `init()` on every run and every stage's `init()` is
     * idempotent, so reusing the instance runs the same work minus the rebuild.
     */
    let activeKey: string | null = null

    scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
        const message = event.data
        queue = queue.then(async () => {
            try {
                switch (message.type) {
                    case 'configure': {
                        configure({
                            ...message.config,
                            onProgress: (progress) =>
                                post({ type: 'progress', requestId: message.requestId, progress }),
                        })
                        post({ type: 'configured', requestId: message.requestId })
                        break
                    }
                    case 'transform': {
                        // Descriptors are plain JSON by contract -- that is what
                        // lets them cross this boundary -- so stringifying them
                        // is a sound identity.
                        const key = JSON.stringify(message.stages)
                        if (!active || key !== activeKey) {
                            await active?.dispose()
                            active = new Pipeline(message.stages.map(buildStage))
                            activeKey = key
                        }
                        const rows: Row[] = await active.transform(resolveRows(message.rows), {
                            onStage: (name, ms, count) =>
                                post({
                                    type: 'stage',
                                    requestId: message.requestId,
                                    name,
                                    ms,
                                    rows: count,
                                }),
                        })
                        post({ type: 'result', requestId: message.requestId, rows })
                        break
                    }
                    case 'putContent': {
                        contents.set(message.key, message.content)
                        post({ type: 'stored', requestId: message.requestId })
                        break
                    }
                    case 'dropContent': {
                        contents.delete(message.key)
                        post({ type: 'stored', requestId: message.requestId })
                        break
                    }
                    case 'dispose': {
                        await active?.dispose()
                        active = null
                        activeKey = null
                        contents.clear()
                        post({ type: 'disposed', requestId: message.requestId })
                        break
                    }
                }
            } catch (error) {
                // A pipeline that failed mid-build or mid-run must not be handed
                // to the next request as if it were good.
                if (message.type === 'transform') {
                    active = null
                    activeKey = null
                }
                post({
                    type: 'error',
                    requestId: message.requestId,
                    message: formatException('worker', error),
                })
            }
        })
    }
}
