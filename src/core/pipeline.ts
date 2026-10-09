/**
 * The pipeline runner, modelled on `scaledp/pipeline/PandasPipeline.py` rather
 * than on Spark.
 *
 * ScaleDP's Spark coupling is thin: every stage is a pure `Transformer` (there
 * are no Estimators, so no fit/transform duality) and the only DataFrame surface
 * stages use is withColumn / drop / select. That reduces to an array of plain
 * row objects, which is what this file implements.
 */

import type { Condition } from './condition.js'
import type { ModelProgress } from './config.js'
import { formatException } from './errors.js'
import { EventStream } from './events.js'
import type { ResourceClaim } from './locks.js'
import type { BaseStageParams } from './params.js'
import type { PipelineEvent, RunOptions } from './run.js'
import { compilePlan, type PipelineEntry, runPlan } from './scheduler.js'

/** One record flowing through the pipeline. Stages read and write named fields. */
export type Row = Record<string, unknown>

/** Per-stage wall-clock timings, mirroring PandasPipeline's `execution_time` column. */
export interface ExecutionTime {
    stages: Record<string, number>
    total: number
}

export const EXECUTION_TIME_COL = 'execution_time'

/**
 * Per-row timings, accumulated as a row travels the pipeline.
 *
 * `execution_time` is per *run* -- one number per stage, the same on every row,
 * which is what Python records. That cannot answer "how long did page 7 take",
 * because a stage's number covers every page at once. This column can: each row
 * carries the time spent on it alone.
 *
 * A stage that expands produces several rows from one call, so its cost is
 * split evenly between them. The parts still sum to the call, but no finer
 * attribution is available from outside the stage.
 */
export interface RowTime {
    stages: Record<string, number>
    total: number
}

export const ROW_TIME_COL = 'row_time'

/** Anything a pipeline can be fed directly. */
export type PipelineInput = Uint8Array | ArrayBuffer | Blob | File | string | Row | Row[]

/**
 * A stage described well enough to reconstruct it from plain data.
 *
 * This is the serialised form of a pipeline: `StageDescriptor[]` is JSON, so it
 * crosses the worker boundary (see `@stabrise/scaledp/worker`) and survives a
 * round trip through storage. `@stabrise/scaledp/registry` turns it back into
 * live stages.
 */
export interface StageDescriptor {
    /** Exported class name, e.g. 'PdfToImage'. */
    type: string
    /** Constructor options. Must be structured-cloneable. */
    options?: Record<string, unknown>
    /**
     * Stable name for events, toggles and per-stage run options. Defaults to
     * the stage's name, or `Name#index` when the name repeats -- the same rule
     * as the `execution_time` keys.
     */
    id?: string
    /** Whether the stage runs by default. `RunOptions.enabled` overrides it per run. */
    enabled?: boolean
    /**
     * Run the stage only on rows matching this condition; the others pass
     * through untouched. A stage no row matches never initialises, so its
     * model is never downloaded.
     */
    when?: Condition
    /**
     * Wait for every page to reach this stage before any page enters it. A
     * stage that needs the whole document (`NerConsistency` at document scope)
     * is a barrier already; this forces one, e.g. to finish a cheap pass over
     * every page before an expensive one starts.
     */
    barrier?: boolean
    /** Session-level settings, for stages that create ONNX sessions. */
    runtime?: StageRuntime
}

/**
 * Settings that shape a stage's ONNX session rather than its output.
 *
 * Thread count is deliberately absent: onnxruntime-web's `env.wasm.numThreads`
 * is one value per realm, fixed when the first session is created, so two
 * stages in one worker cannot differ in it. Run them in separate workers --
 * see `createScaleDpWorkerPool` -- to give them different thread counts.
 */
export interface StageRuntime {
    /** Execution providers in priority order, overriding `configure()` for this stage. */
    executionProviders?: readonly string[]
}

/** How much of a run a stage needs to see at once. */
export type StageScope = 'row' | 'group' | 'document'

export interface InitContext {
    /** Id of the stage within the running pipeline, for attributing progress. */
    stageId?: string
    signal?: AbortSignal
    /** Model download / session progress for this stage only. */
    onProgress?: (progress: ModelProgress) => void
}

export interface StageContext extends InitContext {
    /** Zero-based index of this stage in the pipeline. */
    index: number
    runId?: string
}

let nextStageUid = 0

/**
 * Base class for every stage.
 *
 * Subclasses implement `apply`, which transforms a single row's input value.
 * The base handles column wiring, error capture and the `keepInputData`
 * contract, so those behave identically everywhere.
 */
export abstract class Stage<P extends BaseStageParams = BaseStageParams> {
    abstract readonly name: string

    /** Unique per instance; names the stage's own concurrency slot. */
    readonly uid: number = nextStageUid++

    /**
     * Session-level settings (see `StageRuntime`). Read when the stage first
     * builds its session, so set it before the stage runs.
     */
    runtime: StageRuntime = {}

    /** Apply session-level settings; chainable. */
    withRuntime(runtime: StageRuntime | undefined): this {
        if (runtime) this.runtime = { ...runtime }
        return this
    }

    constructor(readonly params: P) {}

    /**
     * How much of a run this stage needs to see at once.
     *
     * - `row` (default): each row on its own, so pages stream independently.
     * - `group`: every row of one page together -- a page exploded into one
     *   row per embedded image and folded back. Still streams per page.
     * - `document`: every row of the run. The scheduler waits for all pages
     *   to arrive first, which makes the stage a barrier.
     */
    get scope(): StageScope {
        return 'row'
    }

    /**
     * Calls of this stage that may be in progress at once.
     *
     * 1 by default, which is the only safe value for a stage holding an ONNX
     * session or any per-call state on the instance. A stage that is pure, or
     * that waits on the network, can raise it.
     */
    get maxConcurrency(): number {
        return 1
    }

    /**
     * Named resources a call holds besides the stage itself.
     *
     * For stages sharing something that tolerates one user at a time: every
     * PaddleOCR stage on one preset shares one session, so all of them claim
     * that session's name.
     */
    resources(): ResourceClaim[] {
        return []
    }

    /**
     * Pages this stage would expand one row into, without doing the work.
     *
     * A PDF stage explodes a document into a row per page in one call, which
     * makes page 1 wait for the last page to be rendered. A stage that can
     * list its pages cheaply lets the scheduler split the document first and
     * run the stage once per page instead -- same rows, but streamed. `null`
     * means "cannot tell", and the stage runs on the whole row.
     */
    async planPages(_row: Row, _ctx: StageContext): Promise<number[] | null> {
        return null
    }

    /** Columns this stage writes; what a row update carries. */
    writes(): string[] {
        return [this.params.outputCol]
    }

    /** Columns this stage reads. */
    reads(): string[] {
        const cols = [this.params.inputCol]
        const extra = (this.params as { inputCols?: unknown }).inputCols
        if (Array.isArray(extra)) cols.push(...extra.filter((c): c is string => typeof c === 'string'))
        return [...new Set(cols)]
    }

    /**
     * Rows as they would leave this stage had every one of them failed with
     * `message`: the output schema's empty instance, the `keepInputData`
     * contract and the time charged. Used when the stage cannot even start.
     */
    failRows(rows: readonly Row[], message: string, ms = 0): Row[] {
        const { inputCol, outputCol, keepInputData } = this.params
        return rows.map((row) => {
            const out: Row = { ...row, [outputCol]: this.onError(message, row) }
            if (!keepInputData && inputCol !== outputCol) delete out[inputCol]
            chargeRow(out, this.name, rows.length > 0 ? ms / rows.length : 0)
            return out
        })
    }

    /**
     * Transform one row's input value into this stage's output value.
     *
     * Throwing is fine and expected -- `transform` converts it into the output
     * schema's `exception` field unless `propagateError` is set.
     */
    protected abstract apply(input: unknown, row: Row, ctx: StageContext): Promise<unknown>

    /**
     * Value written to `outputCol` when `apply` throws. Subclasses return an
     * empty instance of their output schema carrying the message, so downstream
     * stages see a well-formed value rather than `undefined`.
     */
    protected abstract onError(message: string, row: Row): unknown

    /**
     * Optional per-stage setup (model download, session creation).
     *
     * Called lazily, just before the first row that actually reaches the
     * stage, and on every run -- so it must be idempotent. A failure is
     * recorded on the rows rather than thrown, like any other stage failure.
     */
    async init(_ctx?: InitContext): Promise<void> {}

    /** Release any held resources (ONNX sessions, workers). */
    async dispose(): Promise<void> {}

    /**
     * A stage may emit several rows per input row -- PDF page explosion, box
     * cropping. Returning `null` means "use the single-row path".
     */
    protected async expand(_input: unknown, _row: Row, _ctx: StageContext): Promise<Row[] | null> {
        return null
    }

    async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        const { inputCol, outputCol, keepInputData, propagateError } = this.params
        const out: Row[] = []

        for (const row of rows) {
            ctx.signal?.throwIfAborted()
            const input = row[inputCol]
            let next: Row[]

            const started = performance.now()
            try {
                const expanded = await this.expand(input, row, ctx)
                next = expanded ?? [{ ...row, [outputCol]: await this.apply(input, row, ctx) }]
            } catch (error) {
                if (propagateError) throw error
                next = [{ ...row, [outputCol]: this.onError(formatException(this.name, error), row) }]
            }
            // Failures are timed too: a stage that spent nine seconds before
            // throwing still cost nine seconds.
            const elapsed = performance.now() - started

            if (!keepInputData && inputCol !== outputCol) {
                for (const r of next) delete r[inputCol]
            }
            for (const r of next) chargeRow(r, this.name, elapsed / next.length)
            out.push(...next)
        }
        return out
    }
}

/**
 * Add a stage's cost to one row's running total.
 *
 * The row inherited its predecessor's timings by the spread that built it, so
 * the record is copied before writing -- sibling rows from one expand would
 * otherwise share it and every charge would land on all of them.
 */
function chargeRow(row: Row, name: string, ms: number): void {
    const previous = row[ROW_TIME_COL] as RowTime | undefined
    const stages = { ...previous?.stages }
    stages[name] = (stages[name] ?? 0) + ms
    row[ROW_TIME_COL] = { stages, total: (previous?.total ?? 0) + ms }
}

export interface PipelineOptions {
    signal?: AbortSignal
    /** Called after each stage with its name and elapsed milliseconds. */
    onStage?: (name: string, ms: number, rows: number) => void
}

/** A stage plus how this pipeline runs it. */
export interface PipelineStage {
    stage: Stage
    id?: string
    enabled?: boolean
    when?: Condition
    barrier?: boolean
}

export class Pipeline {
    /** The stages, in order. */
    readonly stages: Stage[]
    readonly entries: readonly PipelineEntry[]

    constructor(stages: readonly (Stage | PipelineStage)[]) {
        this.entries = compilePlan(stages)
        this.stages = this.entries.map((entry) => entry.stage)
    }

    /**
     * Run every stage in Python's order: all rows through each stage before the
     * next. Input is normalised into rows first.
     *
     * Accepts every `RunOptions` field too; `order` defaults to `stage` here.
     */
    async transform(input: PipelineInput, options: PipelineOptions & RunOptions = {}): Promise<Row[]> {
        return this.run(input, { order: 'stage', ...options })
    }

    /**
     * Run the pipeline, streaming by page by default.
     *
     * Events and row updates arrive through `onEvent` / `onRow` while it runs;
     * the promise resolves with every row, in the same order `transform` would
     * return them.
     */
    async run(input: PipelineInput, options: RunOptions & PipelineOptions = {}): Promise<Row[]> {
        const rows = await toRows(input)
        const { rows: out, timings, ms } = await runPlan(this.entries, rows, options)
        const executionTime: ExecutionTime = { stages: timings, total: ms }
        return out.map((row) => ({ ...row, [EXECUTION_TIME_COL]: executionTime }))
    }

    /**
     * The same run as an async iterable of events, with the rows on `result`.
     *
     *   const run = pipeline.events(file)
     *   for await (const event of run) show(event)
     *   const rows = await run.result
     *
     * The iteration always ends normally, after `run:end`, whose `status` says
     * how the run finished; a failure surfaces on `result`.
     */
    events(
        input: PipelineInput,
        options: Omit<RunOptions, 'onEvent'> = {}
    ): AsyncIterable<PipelineEvent> & { result: Promise<Row[]> } {
        const stream = new EventStream<PipelineEvent>()
        const result = this.run(input, { ...options, onEvent: (event) => stream.push(event) })
        result.then(
            () => stream.close(),
            () => stream.close()
        )
        return Object.assign(stream, { result })
    }

    async dispose(): Promise<void> {
        await Promise.all(this.stages.map((s) => s.dispose()))
    }
}

/** Normalise any accepted input into pipeline rows with `content` and `path`. */
export async function toRows(input: PipelineInput): Promise<Row[]> {
    if (Array.isArray(input)) return input.map((r) => ({ ...r }))

    if (typeof input === 'string') {
        const response = await fetch(input)
        if (!response.ok) {
            throw new Error(`Failed to fetch ${input}: ${response.status} ${response.statusText}`)
        }
        const data = new Uint8Array(await response.arrayBuffer())
        return [{ content: data, path: input }]
    }

    if (input instanceof Uint8Array) return [{ content: input, path: 'memory' }]
    if (input instanceof ArrayBuffer) return [{ content: new Uint8Array(input), path: 'memory' }]

    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        const data = new Uint8Array(await input.arrayBuffer())
        const path = 'name' in input && typeof input.name === 'string' ? input.name : 'memory'
        return [{ content: data, path }]
    }

    return [{ ...(input as Row) }]
}
