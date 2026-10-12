/**
 * Several pipeline workers presented as one: pages spread across them.
 *
 * Inside one worker, pages in flight overlap stages that wait on different
 * things -- pdf.js parsing in its own thread, a network NER call, a WebGPU
 * queue -- but two CPU-bound WASM inferences still share one thread pool. On a
 * page that is not cross-origin isolated (GitHub Pages, most embeds) that pool
 * has a single thread, so the only way to use a second core is a second
 * worker. That is what this is.
 *
 * The cost is memory: every worker holds its own copy of every model it
 * loads. Size the pool against the models in the pipeline, not only against
 * the core count -- see `resolveParallelism`.
 *
 * How a run is spread:
 *
 * 1. One worker plans it: which pages the first stage splits each input into,
 *    and where the barriers are (`planRun`).
 * 2. Pages go to whichever worker is free, a few at a time, so a page that
 *    needs OCR and one that does not balance out by themselves.
 * 3. At a barrier every page comes back, the barrier stage runs once over all
 *    of them on one worker, and the pages are spread out again.
 *
 * Events and row updates from every worker are forwarded with their unit keys
 * rewritten into the run's own, so a caller cannot tell a pool from a single
 * worker except by the speed.
 */

import type { ModelProgress, ScaleDpConfig } from '../core/config.js'
import { EventStream } from '../core/events.js'
import { comparePriority } from '../core/locks.js'
import type { Row, StageDescriptor } from '../core/pipeline.js'
import type { PipelineEvent, RowUpdate, UnitRef } from '../core/run.js'
import { type RunHandle, ScaleDpWorkerClient, type WorkerRunOptions } from './client.js'
import type { TransferableConfig, WorkerEnvironment } from './protocol.js'

export interface ScaleDpWorkerPoolOptions {
    /** Make worker `index`. Called `size` times, up front. */
    createWorker: (index: number) => Worker
    /** Workers in the pool. Default 2. */
    size?: number
    /**
     * WASM threads per worker, sent as `numThreads` with every `configure`.
     * Threads only engage on a cross-origin-isolated page; elsewhere leave it
     * at 1 and let the pool size carry the parallelism.
     */
    threadsPerWorker?: number
    /**
     * Pages each worker is handed at once, and walks with `pagesInFlight`.
     * Default 1: with CPU-bound stages a second page per worker only competes
     * for its threads (see `bench/results/`). Raise it for a pipeline with a
     * stage that waits on the network or the GPU.
     */
    pagesPerWorker?: number
    onProgress?: (progress: ModelProgress, worker: number) => void
    /** Token supplier for private repos, relayed to every worker. */
    auth?: ScaleDpConfig['auth']
}

/** Transient column that tells the coordinator which unit a returned row belongs to. */
const UNIT_COL = '__scaledp_pool_unit'

interface Unit {
    key: number[]
    rows: Row[]
    input: number
    page?: number
}

const byKey = (a: Unit, b: Unit) => comparePriority(a.key, b.key)

interface RunContext {
    runId: string
    signal: AbortSignal
    /** Requests in flight, so a cancel reaches every worker. */
    live: Set<RunHandle>
    emit: (event: PipelineEvent) => void
    onRow?: (update: RowUpdate) => void
    /** Whether the caller has been sent `run:start`. */
    announced: boolean
}

function abortError(): Error {
    return typeof DOMException === 'undefined'
        ? Object.assign(new Error('Run cancelled'), { name: 'AbortError' })
        : new DOMException('Run cancelled', 'AbortError')
}

export class ScaleDpWorkerPool {
    readonly clients: ScaleDpWorkerClient[]
    private readonly threadsPerWorker: number | undefined
    private readonly pagesPerWorker: number
    private runCounter = 0

    constructor(options: ScaleDpWorkerPoolOptions) {
        const size = Math.max(1, Math.floor(options.size ?? 2))
        this.threadsPerWorker = options.threadsPerWorker
        this.pagesPerWorker = Math.max(1, Math.floor(options.pagesPerWorker ?? 1))
        this.clients = Array.from(
            { length: size },
            (_, index) =>
                new ScaleDpWorkerClient({
                    worker: options.createWorker(index),
                    auth: options.auth,
                    onProgress: options.onProgress && ((progress) => options.onProgress?.(progress, index)),
                })
        )
    }

    get size(): number {
        return this.clients.length
    }

    /** Configure every worker. `numThreads` is forced to `threadsPerWorker` when that is set. */
    configure(config: TransferableConfig): Promise<(WorkerEnvironment | undefined)[]> {
        const patch =
            this.threadsPerWorker === undefined ? config : { ...config, numThreads: this.threadsPerWorker }
        return Promise.all(this.clients.map((client) => client.configure(patch)))
    }

    /** Register content with every worker, since any of them may be handed a page of it. */
    async putContent(key: string, content: Uint8Array): Promise<void> {
        // Each worker gets its own copy: a buffer transferred to one is gone
        // for the next, and structured clone copies anyway.
        await Promise.all(this.clients.map((client) => client.putContent(key, content)))
    }

    async dropContent(key: string): Promise<void> {
        await Promise.all(this.clients.map((client) => client.dropContent(key)))
    }

    async dispose(): Promise<void> {
        await Promise.all(this.clients.map((client) => client.dispose()))
    }

    /**
     * Run a pipeline across the pool. Same contract as `ScaleDpWorkerClient.run`.
     *
     * `pagesInFlight` is per worker here (default `pagesPerWorker`), so the
     * pool as a whole has `size * pagesInFlight` pages in flight.
     */
    run(stages: StageDescriptor[], rows: Row[], options: WorkerRunOptions = {}): RunHandle {
        const { signal, onEvent, onRow, ...transferable } = options
        const stream = new EventStream<PipelineEvent>()
        const local = new AbortController()
        const runId = `pool-${++this.runCounter}`
        const live = new Set<RunHandle>()

        const cancel = () => {
            if (local.signal.aborted) return
            local.abort(abortError())
            for (const handle of live) handle.cancel()
        }
        if (signal?.aborted) cancel()
        signal?.addEventListener('abort', cancel, { once: true })

        const emit = (event: PipelineEvent) => {
            stream.push(event)
            onEvent?.(event)
        }

        const result = this.execute(stages, rows, transferable, {
            runId,
            signal: local.signal,
            live,
            emit,
            onRow,
            announced: false,
        })
        const settle = () => {
            signal?.removeEventListener('abort', cancel)
            stream.close()
        }
        result.then(settle, settle)
        return Object.assign(stream, { result, cancel }) as RunHandle
    }

    private async execute(
        stages: StageDescriptor[],
        input: Row[],
        options: Omit<WorkerRunOptions, 'signal' | 'onEvent' | 'onRow'>,
        ctx: RunContext
    ): Promise<Row[]> {
        const started = performance.now()
        const first = this.clients[0] as ScaleDpWorkerClient

        try {
            ctx.signal.throwIfAborted()
            const plan = await first.plan(stages, input, options)
            ctx.signal.throwIfAborted()

            // Page units, in the order the result must come back in.
            let units: Unit[] = input.flatMap((row, i): Unit[] => {
                const pages = plan.pages[i]
                if (!pages || pages.length < 2) return [{ key: [i], rows: [row], input: i }]
                return pages.map((page, k) => ({ key: [i, k], rows: [{ ...row, page }], input: i, page }))
            })

            const cuts = [0, ...plan.barriers.filter((index) => index > 0), stages.length]
            const segments = cuts.slice(0, -1).map((from, s) => ({ from, to: cuts[s + 1] as number }))

            for (const [s, { from, to }] of segments.entries()) {
                let start = from
                if (s > 0 || plan.barriers.includes(0)) {
                    // A barrier sees every row, in order, exactly as it would in one worker.
                    units = await this.barrier(stages, from, units, options, ctx)
                    start = from + 1
                }
                if (start < to) {
                    units = await this.spread(stages, start, to, units, options, ctx)
                }
            }

            const rows = units.sort(byKey).flatMap((unit) => unit.rows)
            ctx.emit({
                type: 'run:end',
                runId: ctx.runId,
                status: 'done',
                ms: performance.now() - started,
                rows: rows.length,
            })
            return rows
        } catch (error) {
            ctx.emit({
                type: 'run:end',
                runId: ctx.runId,
                status: ctx.signal.aborted ? 'aborted' : 'failed',
                ms: performance.now() - started,
                rows: 0,
                message: error instanceof Error ? error.message : String(error),
            })
            throw ctx.signal.aborted ? abortError() : error
        }
    }

    /** Run stages `[from, to)` over every unit, handing units to whichever worker is free. */
    private async spread(
        stages: StageDescriptor[],
        from: number,
        to: number,
        units: Unit[],
        options: Omit<WorkerRunOptions, 'signal' | 'onEvent' | 'onRow'>,
        ctx: RunContext
    ): Promise<Unit[]> {
        const slice = this.slice(stages, from, to)
        const queue = [...units].sort(byKey)
        const done: Unit[] = []
        const take = this.pagesPerWorker

        const work = async (client: ScaleDpWorkerClient) => {
            while (queue.length > 0) {
                ctx.signal.throwIfAborted()
                // A unit already spanning several rows is one page that must
                // stay together (a group stage may need all of them), so it
                // goes alone and in stage order.
                const head = queue[0] as Unit
                const batch = head.rows.length > 1 ? queue.splice(0, 1) : takeSingles(queue, take)
                const order = batch.length === 1 && (batch[0] as Unit).rows.length > 1 ? 'stage' : 'page'

                const out = await this.runBatch(client, slice, batch, order, options, ctx)
                done.push(...out)
            }
        }

        await Promise.all(this.clients.map((client) => work(client)))
        return done
    }

    /** Run the barrier stage once, over every row, on the first worker. */
    private async barrier(
        stages: StageDescriptor[],
        at: number,
        units: Unit[],
        options: Omit<WorkerRunOptions, 'signal' | 'onEvent' | 'onRow'>,
        ctx: RunContext
    ): Promise<Unit[]> {
        const sorted = [...units].sort(byKey)
        const barrierStage = stages[at] as StageDescriptor
        ctx.emit({
            type: 'barrier:wait',
            runId: ctx.runId,
            stageId: barrierStage.id ?? barrierStage.type,
            arrived: sorted.length,
        })
        const all: Unit = { key: [], rows: sorted.flatMap((unit) => unit.rows), input: -1 }
        const [merged] = await this.runBatch(
            this.clients[0] as ScaleDpWorkerClient,
            this.slice(stages, at, at + 1),
            [all],
            'stage',
            options,
            ctx
        )
        const rows = merged?.rows ?? []
        if (rows.length !== all.rows.length) return [{ ...all, rows }]

        let offset = 0
        return sorted.map((unit) => {
            const n = unit.rows.length
            const next = { ...unit, rows: rows.slice(offset, offset + n) }
            offset += n
            return next
        })
    }

    /**
     * Stages `[from, to)` with everything else disabled, so stage ids and
     * `execution_time` keys stay what they are in the whole pipeline.
     */
    private slice(stages: StageDescriptor[], from: number, to: number): StageDescriptor[] {
        return stages.map((stage, index) =>
            index >= from && index < to ? stage : { ...stage, enabled: false }
        )
    }

    /** One request to one worker, with its events and rows mapped back onto the run's units. */
    private async runBatch(
        client: ScaleDpWorkerClient,
        stages: StageDescriptor[],
        batch: Unit[],
        order: 'page' | 'stage',
        options: Omit<WorkerRunOptions, 'signal' | 'onEvent' | 'onRow'>,
        ctx: RunContext
    ): Promise<Unit[]> {
        const rows = batch.flatMap((unit, u) => unit.rows.map((row) => ({ ...row, [UNIT_COL]: u })))
        const enabled = this.enabledFor(stages, options.enabled)

        const mapUnit = (ref: UnitRef): UnitRef => {
            const local = ref.key === '' ? [] : ref.key.split('.').map(Number)
            const unit = order === 'stage' ? batch[0] : batch[local[0] as number]
            if (!unit) return ref
            const rest = order === 'stage' ? local : local.slice(1)
            const key = [...unit.key, ...rest]
            return {
                ...ref,
                key: key.join('.'),
                input: unit.input,
                ...(ref.page === undefined && unit.page !== undefined ? { page: unit.page } : {}),
            }
        }

        const handle = client.run(stages, rows, {
            ...options,
            enabled,
            order,
            pagesInFlight: options.pagesInFlight ?? this.pagesPerWorker,
            onEvent: (event) => {
                if (event.type === 'run:end') return
                if (event.type === 'run:start') {
                    // Every batch starts a run in its worker; the caller sees one.
                    if (ctx.announced) return
                    ctx.announced = true
                    ctx.emit({
                        ...event,
                        runId: ctx.runId,
                        stages: event.stages.map((stage, index) => ({
                            ...stage,
                            enabled: this.isEnabled(stage.id, stage.name, index, options.enabled),
                        })),
                        pagesInFlight: (options.pagesInFlight ?? this.pagesPerWorker) * this.size,
                    })
                    return
                }
                ctx.emit({
                    ...event,
                    runId: ctx.runId,
                    ...('unit' in event && event.unit ? { unit: mapUnit(event.unit) } : {}),
                } as PipelineEvent)
            },
            onRow:
                ctx.onRow &&
                ((update) => {
                    const { [UNIT_COL]: _unit, ...row } = update.row
                    ctx.onRow?.({ ...update, runId: ctx.runId, unit: mapUnit(update.unit), row })
                }),
        })

        ctx.live.add(handle)
        try {
            const out = await handle.result
            const grouped = batch.map((unit): Unit => ({ ...unit, rows: [] }))
            for (const row of out) {
                const u = Number(row[UNIT_COL])
                const { [UNIT_COL]: _unit, ...clean } = row
                ;(grouped[Number.isInteger(u) ? u : 0] as Unit).rows.push(clean)
            }
            return grouped
        } finally {
            ctx.live.delete(handle)
        }
    }

    /** The caller's `enabled`, keyed by the ids the sliced descriptors carry. */
    private enabledFor(
        stages: StageDescriptor[],
        enabled: Readonly<Record<string, boolean>> | undefined
    ): Record<string, boolean> | undefined {
        if (!enabled) return undefined
        const out: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(enabled)) out[key] = value
        // A slice's out-of-range stages are disabled on the descriptor; a
        // caller's `enabled: { X: true }` must not switch them back on.
        stages.forEach((stage, index) => {
            if (stage.enabled === false) {
                const id =
                    stage.id ??
                    (stages.findIndex((s) => s.type === stage.type) === index
                        ? stage.type
                        : `${stage.type}#${index}`)
                out[id] = false
            }
        })
        return out
    }

    private isEnabled(
        id: string,
        name: string,
        _index: number,
        enabled: Readonly<Record<string, boolean>> | undefined
    ): boolean {
        return enabled?.[id] ?? enabled?.[name] ?? true
    }
}

/** Up to `n` single-row units from the front of the queue. */
function takeSingles(queue: Unit[], n: number): Unit[] {
    const out: Unit[] = []
    while (out.length < n && queue.length > 0 && (queue[0] as Unit).rows.length <= 1) {
        out.push(queue.shift() as Unit)
    }
    return out
}

/** Convenience wrapper around the pool constructor. */
export function createScaleDpWorkerPool(options: ScaleDpWorkerPoolOptions): ScaleDpWorkerPool {
    return new ScaleDpWorkerPool(options)
}
