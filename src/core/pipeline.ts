/**
 * The pipeline runner, modelled on `scaledp/pipeline/PandasPipeline.py` rather
 * than on Spark.
 *
 * ScaleDP's Spark coupling is thin: every stage is a pure `Transformer` (there
 * are no Estimators, so no fit/transform duality) and the only DataFrame surface
 * stages use is withColumn / drop / select. That reduces to an array of plain
 * row objects, which is what this file implements.
 */

import { formatException } from './errors.js'
import type { BaseStageParams } from './params.js'

/** One record flowing through the pipeline. Stages read and write named fields. */
export type Row = Record<string, unknown>

/** Per-stage wall-clock timings, mirroring PandasPipeline's `execution_time` column. */
export interface ExecutionTime {
    stages: Record<string, number>
    total: number
}

export const EXECUTION_TIME_COL = 'execution_time'

/** Anything a pipeline can be fed directly. */
export type PipelineInput = Uint8Array | ArrayBuffer | Blob | File | string | Row | Row[]

export interface StageContext {
    /** Zero-based index of this stage in the pipeline. */
    index: number
    signal?: AbortSignal
}

/**
 * Base class for every stage.
 *
 * Subclasses implement `apply`, which transforms a single row's input value.
 * The base handles column wiring, error capture and the `keepInputData`
 * contract, so those behave identically everywhere.
 */
export abstract class Stage<P extends BaseStageParams = BaseStageParams> {
    abstract readonly name: string

    constructor(readonly params: P) {}

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

    /** Optional per-stage setup (model download, session creation). Called once. */
    async init(): Promise<void> {}

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

            try {
                const expanded = await this.expand(input, row, ctx)
                next = expanded ?? [{ ...row, [outputCol]: await this.apply(input, row, ctx) }]
            } catch (error) {
                if (propagateError) throw error
                next = [{ ...row, [outputCol]: this.onError(formatException(this.name, error), row) }]
            }

            if (!keepInputData && inputCol !== outputCol) {
                for (const r of next) delete r[inputCol]
            }
            out.push(...next)
        }
        return out
    }
}

export interface PipelineOptions {
    signal?: AbortSignal
    /** Called after each stage with its name and elapsed milliseconds. */
    onStage?: (name: string, ms: number, rows: number) => void
}

export class Pipeline {
    constructor(readonly stages: Stage[]) {}

    /** Run every stage in order. Input is normalised into rows first. */
    async transform(input: PipelineInput, options: PipelineOptions = {}): Promise<Row[]> {
        let rows = await toRows(input)
        const timings: Record<string, number> = {}
        const started = performance.now()

        for (const [index, stage] of this.stages.entries()) {
            options.signal?.throwIfAborted()
            const t0 = performance.now()
            await stage.init()
            rows = await stage.transform(rows, { index, signal: options.signal })
            const elapsed = performance.now() - t0

            // Two stages of the same class in one pipeline must not overwrite
            // each other's timing, so disambiguate by position.
            const key = timings[stage.name] === undefined ? stage.name : `${stage.name}#${index}`
            timings[key] = elapsed
            options.onStage?.(stage.name, elapsed, rows.length)
        }

        const executionTime: ExecutionTime = { stages: timings, total: performance.now() - started }
        return rows.map((row) => ({ ...row, [EXECUTION_TIME_COL]: executionTime }))
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
