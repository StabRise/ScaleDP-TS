/**
 * Main-thread client for a pipeline worker.
 *
 * Presents the same `transform` shape as `Pipeline` while the work happens off
 * the main thread. Everything below the stages is already OffscreenCanvas-based
 * and DOM-free, so OCR, detection and NER all move across -- not just NER, as
 * in the pdftools prototype.
 */

import type { ModelProgress, ScaleDpConfig } from '../core/config.js'
import type { Row } from '../core/pipeline.js'
import type {
    StageDescriptor,
    TransferableConfig,
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
    onProgress?: (progress: ModelProgress) => void
    onStage?: (name: string, ms: number, rows: number) => void
}

export class ScaleDpWorkerClient {
    private nextRequestId = 1
    private readonly pending = new Map<
        number,
        { resolve: (value: never) => void; reject: (reason: Error) => void }
    >()

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
                options.onProgress?.(message.progress)
                return
            }
            if (message.type === 'stage') {
                options.onStage?.(message.name, message.ms, message.rows)
                return
            }

            const entry = this.pending.get(message.requestId)
            if (!entry) return
            this.pending.delete(message.requestId)

            if (message.type === 'error') entry.reject(new Error(message.message))
            else if (message.type === 'result') entry.resolve(message.rows as never)
            else entry.resolve(undefined as never)
        }

        options.worker.onerror = (event) => {
            this.failure = new Error(`Worker failed: ${event.message}`)
            for (const [, entry] of this.pending) entry.reject(this.failure)
            this.pending.clear()
        }
    }

    private send<T>(request: WorkerRequestInit): Promise<T> {
        const run = async (): Promise<T> => {
            if (this.failure) throw this.failure
            const requestId = this.nextRequestId++
            return new Promise<T>((resolve, reject) => {
                this.pending.set(requestId, {
                    resolve: resolve as (value: never) => void,
                    reject,
                })
                this.options.worker.postMessage({ ...request, requestId } as WorkerRequest)
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
    configure(config: TransferableConfig): Promise<void> {
        return this.send({ type: 'configure', config: config as Partial<ScaleDpConfig> })
    }

    /** Run a pipeline in the worker. Stages are named, not passed by reference. */
    transform(stages: StageDescriptor[], rows: Row[]): Promise<Row[]> {
        return this.send<Row[]>({ type: 'transform', stages, rows })
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
