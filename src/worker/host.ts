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
import type { StageDescriptor, WorkerRequest, WorkerResponse } from './protocol.js'

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
                        await active?.dispose()
                        active = new Pipeline(message.stages.map(buildStage))
                        const rows: Row[] = await active.transform(message.rows, {
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
                    case 'dispose': {
                        await active?.dispose()
                        active = null
                        post({ type: 'disposed', requestId: message.requestId })
                        break
                    }
                }
            } catch (error) {
                post({
                    type: 'error',
                    requestId: message.requestId,
                    message: formatException('worker', error),
                })
            }
        })
    }
}
