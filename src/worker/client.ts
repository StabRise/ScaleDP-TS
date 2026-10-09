/**
 * Main-thread client for a pipeline worker.
 *
 * Presents the same `transform` shape as `Pipeline` while the work happens off
 * the main thread. Everything below the stages is already OffscreenCanvas-based
 * and DOM-free, so OCR, detection and NER all move across -- not just NER, as
 * in the pdftools prototype.
 */

import type { ModelProgress, ScaleDpConfig } from '../core/config.js'
import { EventStream } from '../core/events.js'
import type { Row } from '../core/pipeline.js'
import type { PipelineEvent, RowUpdate } from '../core/run.js'
import type { RunPlan } from '../core/scheduler.js'
import type {
    StageDescriptor,
    TransferableConfig,
    TransferableRunOptions,
    WorkerEnvironment,
    WorkerRequest,
    WorkerRequestInit,
    WorkerResponse,
} from './protocol.js'

export interface ScaleDpWorkerOptions {
    /**
     * The worker running `startScaleDpWorker()`. Constructed by the caller,
     * because only the consuming app's bundler can resolve a worker entry URL:
     *
     *   new Worker(new URL('./my-worker.ts', import.meta.url), { type: 'module' })
     */
    worker: Worker
    /** Model progress from `configure({ onProgress })` in the worker, for any request. */
    onProgress?: (progress: ModelProgress, requestId: number) => void
    /** Per-stage timing of `transform` requests. */
    onStage?: (name: string, ms: number, rows: number, requestId: number) => void
}

/** `run` options as a caller passes them: the transferable part plus the live callbacks. */
export interface WorkerRunOptions extends TransferableRunOptions {
    signal?: AbortSignal
    onEvent?: (event: PipelineEvent) => void
    onRow?: (update: RowUpdate) => void
}

/** A run in progress: iterate its events, await its rows, or cancel it. */
export interface RunHandle extends AsyncIterable<PipelineEvent> {
    /** Every row, in order, once the run finishes. Rejects with an `AbortError` when cancelled. */
    readonly result: Promise<Row[]>
    /** Stop the run -- immediately if it is running, before it starts if it is queued. */
    cancel(): void
}

interface Pending {
    resolve: (value: never) => void
    reject: (reason: Error) => void
    onEvent?: (event: PipelineEvent) => void
    onRow?: (update: RowUpdate) => void
}

function abortError(message = 'Run cancelled'): Error {
    return typeof DOMException === 'undefined'
        ? Object.assign(new Error(message), { name: 'AbortError' })
        : new DOMException(message, 'AbortError')
}

export class ScaleDpWorkerClient {
    private nextRequestId = 1
    private readonly pending = new Map<number, Pending>()

    // ORT runs one inference at a time, so requests are serialised here as well
    // as in the host -- this keeps the *queueing* observable to callers.
    private queue: Promise<unknown> = Promise.resolve()

    /**
     * Set once the worker itself fails. Requests are posted from inside the
     * queue, so a request enqueued before the failure would otherwise sit
     * unposted and never settle.
     */
    private failure: Error | null = null

    constructor(private readonly options: ScaleDpWorkerOptions) {
        options.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data
            if (message.type === 'progress') {
                options.onProgress?.(message.progress, message.requestId)
                return
            }
            if (message.type === 'stage') {
                options.onStage?.(message.name, message.ms, message.rows, message.requestId)
                return
            }
            if (message.type === 'event') {
                this.pending.get(message.requestId)?.onEvent?.(message.event)
                return
            }
            if (message.type === 'row') {
                this.pending.get(message.requestId)?.onRow?.(message.update)
                return
            }

            const entry = this.pending.get(message.requestId)
            if (!entry) return
            this.pending.delete(message.requestId)

            if (message.type === 'error') {
                entry.reject(message.aborted ? abortError(message.message) : new Error(message.message))
            } else if (message.type === 'result') entry.resolve(message.rows as never)
            else if (message.type === 'configured') entry.resolve(message.environment as never)
            else if (message.type === 'planned') {
                entry.resolve({ pages: message.pages, barriers: message.barriers } as never)
            } else entry.resolve(undefined as never)
        }

        options.worker.onerror = (event) => {
            this.failure = new Error(`Worker failed: ${event.message}`)
            for (const [, entry] of this.pending) entry.reject(this.failure)
            this.pending.clear()
        }
    }

    private send<T>(
        request: WorkerRequestInit,
        hooks: Pick<Pending, 'onEvent' | 'onRow'> & {
            signal?: AbortSignal
            /** Told the request id once the request is posted. */
            posted?: (requestId: number) => void
        } = {}
    ): Promise<T> {
        const run = async (): Promise<T> => {
            if (this.failure) throw this.failure
            // Cancelled while queued: never posted at all.
            if (hooks.signal?.aborted) throw abortError()
            const requestId = this.nextRequestId++
            return new Promise<T>((resolve, reject) => {
                this.pending.set(requestId, {
                    resolve: resolve as (value: never) => void,
                    reject,
                    onEvent: hooks.onEvent,
                    onRow: hooks.onRow,
                })
                this.options.worker.postMessage({ ...request, requestId } as WorkerRequest)
                hooks.posted?.(requestId)
            })
        }

        // Chain onto the queue but never let a rejection break it, otherwise one
        // failed request poisons every request that follows.
        const result = this.queue.then(run, run)
        this.queue = result.catch(() => undefined)
        return result
    }

    /**
     * Push configuration into the worker.
     *
     * `auth` and `onProgress` are dropped: functions cannot be cloned across a
     * postMessage boundary. Progress is forwarded back through `onProgress` on
     * the client instead.
     */
    configure(config: TransferableConfig): Promise<WorkerEnvironment | undefined> {
        return this.send({ type: 'configure', config: config as Partial<ScaleDpConfig> })
    }

    /** Run a pipeline in the worker in stage order. Stages are named, not passed by reference. */
    transform(stages: StageDescriptor[], rows: Row[]): Promise<Row[]> {
        return this.send<Row[]>({ type: 'transform', stages, rows })
    }

    /**
     * Run a pipeline in the worker, streaming events and row updates as it
     * goes. The same options as `Pipeline.run`; the callbacks and the signal
     * stay on this side and the rest crosses over.
     *
     *   const run = client.run(stages, [{ contentRef: 'doc', path }], {
     *     pagesInFlight: 2,
     *     enabled: { FaceDetector: settings.faces },
     *     onRow: (update) => show(update),
     *   })
     *   cancelButton.onclick = () => run.cancel()
     *   const rows = await run.result
     *
     * Row updates strip binary data by default here (`rowUpdates.stripBinary`),
     * since every byte of every message is copied.
     */
    run(stages: StageDescriptor[], rows: Row[], options: WorkerRunOptions = {}): RunHandle {
        const { signal, onEvent, onRow, ...transferable } = options
        const stream = new EventStream<PipelineEvent>()
        const local = new AbortController()
        let requestId: number | null = null

        const cancel = () => {
            if (local.signal.aborted) return
            local.abort()
            // Running: tell the worker. Queued: `send` sees the abort and never posts.
            if (requestId !== null) {
                this.options.worker.postMessage({
                    type: 'cancel',
                    requestId: this.nextRequestId++,
                    target: requestId,
                } as WorkerRequest)
            }
        }
        if (signal?.aborted) cancel()
        signal?.addEventListener('abort', cancel, { once: true })

        const result = this.send<Row[]>(
            { type: 'run', stages, rows, options: transferable },
            {
                signal: local.signal,
                onEvent: (event) => {
                    stream.push(event)
                    onEvent?.(event)
                },
                onRow,
                posted: (id) => {
                    requestId = id
                },
            }
        )
        result.then(
            () => stream.close(),
            () => stream.close()
        )
        result.then(
            () => signal?.removeEventListener('abort', cancel),
            () => signal?.removeEventListener('abort', cancel)
        )

        return Object.assign(stream, { result, cancel }) as RunHandle
    }

    /** How a run would be laid out -- page split and barriers -- without running it. */
    plan(stages: StageDescriptor[], rows: Row[], options: TransferableRunOptions = {}): Promise<RunPlan> {
        return this.send<RunPlan>({ type: 'plan', stages, rows, options })
    }

    /**
     * Hand the worker a file once, to be referenced by key from later rows.
     *
     * Structured clone copies every byte of every message, so running several
     * pipelines over one document -- read its text, find its images, render it
     * -- otherwise copies the whole file once per pipeline, per page. Each copy
     * is also a fresh `Uint8Array`, which the document cache keys on, so pdf.js
     * re-parses every time too.
     *
     * A row carrying `contentRef: key` instead of `content` gets the stored
     * buffer, the same object every time. Call `dropContent` when the document
     * is finished with; the worker holds it until then.
     */
    putContent(key: string, content: Uint8Array): Promise<void> {
        return this.send({ type: 'putContent', key, content })
    }

    /** Release content registered with `putContent`. */
    dropContent(key: string): Promise<void> {
        return this.send({ type: 'dropContent', key })
    }

    async dispose(): Promise<void> {
        await this.send({ type: 'dispose' }).catch(() => undefined)
        this.options.worker.terminate()
    }
}

/** Convenience wrapper around the client constructor. */
export function createScaleDpWorker(options: ScaleDpWorkerOptions): ScaleDpWorkerClient {
    return new ScaleDpWorkerClient(options)
}
