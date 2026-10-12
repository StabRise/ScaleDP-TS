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

import { configure, type ModelProgress, resolveNumThreads } from '../core/config.js'
import { formatException } from '../core/errors.js'
import { Pipeline, type PipelineStage, type Row, type Stage } from '../core/pipeline.js'
import type { PipelineEvent, RunOptions } from '../core/run.js'
import { planRun } from '../core/scheduler.js'
import {
    CONTENT_REF_COL,
    type StageDescriptor,
    type TransferableRunOptions,
    type WorkerEnvironment,
    type WorkerRequest,
    type WorkerResponse,
} from './protocol.js'

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
    return factory(descriptor.options).withRuntime(descriptor.runtime)
}

export interface ScaleDpWorkerHostOptions {
    /**
     * Stage instances kept alive between requests, least recently used first
     * out. Each may hold an ONNX session, so this bounds memory; the default
     * covers a full PDF pipeline with room to switch OCR presets.
     */
    maxCachedStages?: number
    /** Minimum interval between `downloading` progress messages per file. */
    progressIntervalMs?: number
}

/**
 * What a cached stage is keyed on: only what changes the instance.
 *
 * `id`, `enabled`, `when` and `barrier` steer the *run*, not the stage, so
 * toggling a stage or editing its condition reuses the live instance and its
 * session.
 */
function stageKey(descriptor: StageDescriptor): string {
    return JSON.stringify([descriptor.type, descriptor.options ?? {}, descriptor.runtime ?? {}])
}

function environment(): WorkerEnvironment {
    const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { gpu?: unknown })
    return {
        numThreads: resolveNumThreads(),
        crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
        webgpu: Boolean(nav?.gpu),
        hardwareConcurrency: nav?.hardwareConcurrency ?? 1,
    }
}

/**
 * Drop `downloading` progress that arrives faster than `interval`, per file.
 * Phase changes always pass, so nothing a UI needs to settle is lost.
 */
function throttled(
    interval: number,
    send: (progress: ModelProgress) => void
): (progress: ModelProgress) => void {
    const last = new Map<string, number>()
    return (progress) => {
        if (progress.phase === 'downloading' && progress.loaded < progress.total) {
            const key = `${progress.repo}\u0000${progress.file}`
            const now = performance.now()
            if (now - (last.get(key) ?? -Infinity) < interval) return
            last.set(key, now)
        }
        send(progress)
    }
}

/** Start listening for pipeline requests. Call once, from a worker entry. */
export function startScaleDpWorker(
    scope: DedicatedWorkerGlobalScope = self as never,
    options: ScaleDpWorkerHostOptions = {}
): void {
    const maxCachedStages = Math.max(1, options.maxCachedStages ?? 12)
    const interval = options.progressIntervalMs ?? 100
    const post = (message: WorkerResponse) => scope.postMessage(message)

    // ORT sessions run one inference at a time, so requests are serialised
    // rather than run concurrently. Pages *within* a run are what overlap --
    // see `RunOptions.pagesInFlight` -- where the scheduler knows which stages
    // share a session.
    let queue: Promise<unknown> = Promise.resolve()

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

    /**
     * Live stage instances, in least-recently-used order.
     *
     * Rebuilding per request is not free: a stage that owns an ONNX session
     * holds it as an instance field, so a fresh stage per run re-reads megabytes
     * of weights out of IndexedDB and creates a new InferenceSession. Caching
     * per *stage* rather than per pipeline means editing one stage's options
     * rebuilds that stage alone, and switching between two pipelines that
     * share stages shares their sessions.
     */
    const stages = new Map<string, Stage>()

    /** Requests that may still be cancelled, by id. */
    const controllers = new Map<number, AbortController>()

    /**
     * Tokens asked of the client and not yet answered, by id.
     *
     * `auth` cannot cross postMessage, so a worker used to need its own copy
     * of the app's token logic in its entry file. Relayed, the main thread --
     * where the session and its cookies already live -- stays the only place
     * that knows how to get one.
     */
    const tokens = new Map<number, (token: string | undefined) => void>()
    let nextTokenId = 0
    const relayAuth = (repo: string) =>
        new Promise<string | undefined>((resolve) => {
            const requestId = ++nextTokenId
            tokens.set(requestId, resolve)
            post({ type: 'auth', requestId, repo })
        })

    const evict = async (keep: ReadonlySet<string>) => {
        while (stages.size > maxCachedStages) {
            const oldest = [...stages.keys()].find((key) => !keep.has(key))
            if (oldest === undefined) return
            const stage = stages.get(oldest)
            stages.delete(oldest)
            await stage?.dispose()
        }
    }

    /** Instances for a request, re-using cached ones; two identical descriptors get two instances. */
    const acquire = async (
        descriptors: StageDescriptor[]
    ): Promise<{ entries: PipelineStage[]; keys: string[] }> => {
        const occurrences = new Map<string, number>()
        const keys: string[] = []
        const entries = descriptors.map((descriptor): PipelineStage => {
            const base = stageKey(descriptor)
            const n = occurrences.get(base) ?? 0
            occurrences.set(base, n + 1)
            const key = n === 0 ? base : `${base}#${n}`
            keys.push(key)

            let stage = stages.get(key)
            if (stage) stages.delete(key)
            else stage = buildStage(descriptor)
            stages.set(key, stage) // re-insert: most recently used last
            return {
                stage,
                id: descriptor.id,
                enabled: descriptor.enabled,
                when: descriptor.when,
                barrier: descriptor.barrier,
            }
        })
        await evict(new Set(keys))
        return { entries, keys }
    }

    /** A run that threw is not trusted to have left its stages sound. */
    const discard = async (keys: readonly string[]) => {
        for (const key of keys) {
            const stage = stages.get(key)
            stages.delete(key)
            await stage?.dispose().catch(() => undefined)
        }
    }

    /**
     * Swap `contentRef` for the bytes it names, remembering which buffers came
     * in by reference so the way out can swap them back.
     */
    const resolveRows = (rows: Row[], refs: Map<Uint8Array, string>): Row[] =>
        rows.map((row) => {
            const key = row[CONTENT_REF_COL]
            if (typeof key !== 'string') return row
            const content = contents.get(key)
            if (!content) {
                throw new Error(
                    `No content registered under "${key}". Call putContent() before referencing it.`
                )
            }
            refs.set(content, key)
            const { [CONTENT_REF_COL]: _ref, ...rest } = row
            return { ...rest, content }
        })

    /**
     * Turn a referenced buffer back into its reference.
     *
     * A PDF stage keeps `content` on every page row it makes, so a forty-page
     * result would otherwise carry forty structured-cloned copies of the file
     * back to the caller -- who already has it, and sent it by reference.
     */
    const restoreRow = (row: Row, refs: ReadonlyMap<Uint8Array, string>): Row => {
        const content = row.content
        if (!(content instanceof Uint8Array)) return row
        const key = refs.get(content)
        if (key === undefined) return row
        const { content: _content, ...rest } = row
        return { ...rest, [CONTENT_REF_COL]: key }
    }

    const execute = async (
        descriptors: StageDescriptor[],
        rows: Row[],
        signal: AbortSignal,
        runOptions: RunOptions & { onStage?: (name: string, ms: number, rows: number) => void }
    ): Promise<Row[]> => {
        const refs = new Map<Uint8Array, string>()
        const resolved = resolveRows(rows, refs)
        const { entries, keys } = await acquire(descriptors)
        const onRow = runOptions.onRow
        try {
            const out = await new Pipeline(entries).run(resolved, {
                ...runOptions,
                signal,
                onRow: onRow && ((update) => onRow({ ...update, row: restoreRow(update.row, refs) })),
            })
            return out.map((row) => restoreRow(row, refs))
        } catch (error) {
            if (!signal.aborted) await discard(keys)
            throw error
        }
    }

    const handle = async (message: WorkerRequest, signal: AbortSignal | undefined): Promise<void> => {
        switch (message.type) {
            case 'configure': {
                configure({
                    ...message.config,
                    onProgress: throttled(interval, (progress) =>
                        post({ type: 'progress', requestId: message.requestId, progress })
                    ),
                    ...(message.relayAuth ? { auth: relayAuth } : {}),
                })
                post({ type: 'configured', requestId: message.requestId, environment: environment() })
                return
            }
            case 'transform': {
                const rows = await execute(message.stages, message.rows, signal as AbortSignal, {
                    order: 'stage',
                    onStage: (name, ms, count) =>
                        post({ type: 'stage', requestId: message.requestId, name, ms, rows: count }),
                })
                post({ type: 'result', requestId: message.requestId, rows })
                return
            }
            case 'run': {
                const options: TransferableRunOptions = message.options ?? {}
                const rowUpdates = { stripBinary: true, ...options.rowUpdates }
                const sendProgress = new Map<string, (progress: ModelProgress) => void>()
                const onEvent = (event: PipelineEvent) => {
                    if (event.type === 'model:progress') {
                        let send = sendProgress.get(event.stageId)
                        if (!send) {
                            send = throttled(interval, (progress) =>
                                post({
                                    type: 'event',
                                    requestId: message.requestId,
                                    event: { ...event, progress },
                                })
                            )
                            sendProgress.set(event.stageId, send)
                        }
                        send(event.progress)
                        return
                    }
                    post({ type: 'event', requestId: message.requestId, event })
                }
                const rows = await execute(message.stages, message.rows, signal as AbortSignal, {
                    ...options,
                    rowUpdates,
                    onEvent,
                    onRow:
                        rowUpdates.payload === 'none'
                            ? undefined
                            : (update) => post({ type: 'row', requestId: message.requestId, update }),
                })
                post({ type: 'result', requestId: message.requestId, rows })
                return
            }
            case 'plan': {
                const refs = new Map<Uint8Array, string>()
                const rows = resolveRows(message.rows, refs)
                const { entries } = await acquire(message.stages)
                const plan = await planRun(new Pipeline(entries).entries, rows, message.options ?? {})
                post({ type: 'planned', requestId: message.requestId, ...plan })
                return
            }
            case 'putContent': {
                contents.set(message.key, message.content)
                post({ type: 'stored', requestId: message.requestId })
                return
            }
            case 'dropContent': {
                contents.delete(message.key)
                post({ type: 'stored', requestId: message.requestId })
                return
            }
            case 'dispose': {
                const live = [...stages.values()]
                stages.clear()
                contents.clear()
                await Promise.all(live.map((stage) => stage.dispose().catch(() => undefined)))
                post({ type: 'disposed', requestId: message.requestId })
                return
            }
            case 'cancel':
            case 'authToken':
                return
        }
    }

    scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
        const message = event.data

        // A token is awaited by a request already running, so it cannot queue.
        if (message.type === 'authToken') {
            tokens.get(message.requestId)?.(message.token)
            tokens.delete(message.requestId)
            return
        }

        // A cancel must not wait behind the run it cancels.
        if (message.type === 'cancel') {
            controllers.get(message.target)?.abort(new DOMException('Run cancelled', 'AbortError'))
            return
        }

        const controller = new AbortController()
        if (message.type === 'run' || message.type === 'transform')
            controllers.set(message.requestId, controller)

        queue = queue.then(async () => {
            try {
                controller.signal.throwIfAborted()
                await handle(message, controller.signal)
            } catch (error) {
                post({
                    type: 'error',
                    requestId: message.requestId,
                    message: formatException('worker', error),
                    ...(controller.signal.aborted ? { aborted: true } : {}),
                })
            } finally {
                controllers.delete(message.requestId)
            }
        })
    }
}
