/**
 * The pipeline scheduler: how a run walks its stages.
 *
 * Two orders, one mechanism. In `stage` order -- Python's -- every row goes
 * through a stage before any row goes through the next. In `page` order the
 * run is split into *units*, normally one per page, and each unit walks the
 * stages on its own, so page 1's entities can be on screen while page 40 is
 * still being rendered. Both call `runStage` for every (stage, unit) pair, and
 * a unit is just a slice of the rows stage order would see, so both produce
 * the same rows in the same order.
 *
 * What makes the split possible:
 *
 * - A PDF stage explodes a document into pages in one call. Before running
 *   one on a document-level unit, the scheduler asks it for its pages
 *   (`planPages`) and splits the unit first, so the stage then runs once per
 *   page. `pageIndexes` already honours a row that names its page, so the
 *   rows come out identical.
 * - A stage that needs every row (`scope: 'document'`, e.g. document-scope
 *   NerConsistency) is a barrier: units wait until all of them arrive, the
 *   stage sees the whole run in order, and the units carry on.
 * - Stages that cannot be entered twice at once -- anything holding an ONNX
 *   session -- are guarded by priority semaphores (see `locks.ts`), so with
 *   several pages in flight the oldest page always gets the free stage.
 */

import { type Condition, evaluate, type Json, validateCondition } from './condition.js'
import type { ModelProgress } from './config.js'
import { formatException, isSkipped } from './errors.js'
import { acquireAll, claimKey, comparePriority, type Priority, Semaphore, sharedSemaphore } from './locks.js'
import type { PipelineOptions, PipelineStage, Row, Stage, StageContext } from './pipeline.js'
import type { PipelineEvent, PlannedStage, RowUpdate, RunOptions, UnitRef } from './run.js'

/** A stage as compiled into a pipeline. */
export interface PipelineEntry {
    readonly stage: Stage
    readonly id: string
    /** Position in the pipeline, counting disabled stages. */
    readonly index: number
    /** Key in `execution_time.stages`: the name, or `Name#index` when it repeats. */
    readonly timingKey: string
    readonly enabled: boolean
    readonly when?: Condition
    readonly barrier: boolean
}

function isPipelineStage(value: Stage | PipelineStage): value is PipelineStage {
    return 'stage' in value && typeof (value as PipelineStage).stage === 'object'
}

export function compilePlan(stages: readonly (Stage | PipelineStage)[]): PipelineEntry[] {
    const seenNames = new Set<string>()
    const seenIds = new Set<string>()

    return stages.map((item, index) => {
        const spec: PipelineStage = isPipelineStage(item) ? item : { stage: item }
        const { stage } = spec
        const timingKey = seenNames.has(stage.name) ? `${stage.name}#${index}` : stage.name
        seenNames.add(stage.name)

        const id = spec.id ?? timingKey
        if (seenIds.has(id)) throw new Error(`Duplicate stage id "${id}" at position ${index}`)
        seenIds.add(id)

        const when = spec.when === undefined ? undefined : validateCondition(spec.when, `${id}.when`)
        return {
            stage,
            id,
            index,
            timingKey,
            enabled: spec.enabled ?? true,
            when,
            barrier: spec.barrier ?? false,
        }
    })
}

export interface PlanResult {
    rows: Row[]
    timings: Record<string, number>
    ms: number
}

interface Unit {
    key: number[]
    rows: Row[]
    input: number
    page?: number
    /** Index, within the current segment, of the next stage to run. */
    next: number
}

type WalkOutcome = { done: Unit } | { children: Unit[] }

let runCounter = 0

/** Per-stage concurrency slots, one per stage instance and realm. */
const stageSlots = new WeakMap<Stage, Semaphore>()

function stageSlot(stage: Stage): Semaphore {
    let slot = stageSlots.get(stage)
    if (!slot) {
        slot = new Semaphore(Math.max(1, stage.maxConcurrency))
        stageSlots.set(stage, slot)
    }
    return slot
}

const byKey = (a: Unit, b: Unit) => comparePriority(a.key, b.key)

export async function runPlan(
    entries: readonly PipelineEntry[],
    input: Row[],
    options: RunOptions & PipelineOptions
): Promise<PlanResult> {
    const run = new Run(entries, options)
    return run.execute(input)
}

class Run {
    readonly runId = `run-${++runCounter}`
    private readonly order: 'page' | 'stage'
    private readonly pagesInFlight: number
    private readonly vars: Readonly<Record<string, Json>>
    private readonly controller = new AbortController()
    private readonly signal: AbortSignal
    private readonly inits = new Map<PipelineEntry, Promise<void>>()
    private readonly overrides = new Map<PipelineEntry, Semaphore>()
    private readonly busy = new Map<PipelineEntry, number>()
    private readonly rowsAfter = new Map<PipelineEntry, number>()
    private readonly active: PipelineEntry[]
    private readonly disabled: PipelineEntry[]

    constructor(
        private readonly entries: readonly PipelineEntry[],
        private readonly options: RunOptions & PipelineOptions
    ) {
        this.order = options.order ?? 'page'
        this.pagesInFlight = Math.max(1, Math.floor(options.pagesInFlight ?? 1))
        this.vars = options.vars ?? {}
        this.signal = this.controller.signal
        this.active = entries.filter((entry) => this.isEnabled(entry))
        this.disabled = entries.filter((entry) => !this.isEnabled(entry))

        for (const entry of this.active) {
            const requested = this.lookup(options.stages, entry)?.maxConcurrency
            if (requested !== undefined && requested < entry.stage.maxConcurrency) {
                this.overrides.set(entry, new Semaphore(Math.max(1, Math.floor(requested))))
            }
        }
    }

    private lookup<T>(map: Readonly<Record<string, T>> | undefined, entry: PipelineEntry): T | undefined {
        if (!map) return undefined
        return map[entry.id] ?? map[entry.stage.name]
    }

    private isEnabled(entry: PipelineEntry): boolean {
        return this.lookup(this.options.enabled, entry) ?? entry.enabled
    }

    private emit(event: PipelineEvent): void {
        this.options.onEvent?.(event)
    }

    /** Segments split at barriers; every segment after the first starts with one. */
    private segments(): PipelineEntry[][] {
        const segments: PipelineEntry[][] = [[]]
        for (const entry of this.active) {
            const isBarrier = entry.barrier || entry.stage.scope === 'document'
            if (isBarrier) segments.push([entry])
            else (segments[segments.length - 1] as PipelineEntry[]).push(entry)
        }
        return segments
    }

    async execute(input: Row[]): Promise<PlanResult> {
        const started = performance.now()
        const external = this.options.signal
        external?.throwIfAborted()
        const forward = () => this.controller.abort(external?.reason)
        external?.addEventListener('abort', forward, { once: true })

        const segments = this.segments()
        this.emit({
            type: 'run:start',
            runId: this.runId,
            order: this.order,
            pagesInFlight: this.order === 'page' ? this.pagesInFlight : 1,
            stages: this.entries.map(
                (entry): PlannedStage => ({
                    id: entry.id,
                    name: entry.stage.name,
                    enabled: this.isEnabled(entry),
                    scope: entry.stage.scope,
                    conditional: entry.when !== undefined,
                })
            ),
            segments: segments.map((segment) => segment.map((entry) => entry.id)),
        })
        for (const entry of this.disabled) {
            this.emit({
                type: 'stage:skip',
                runId: this.runId,
                stageId: entry.id,
                index: entry.index,
                reason: 'disabled',
                rows: input.length,
            })
        }

        try {
            let units: Unit[] =
                this.order === 'stage'
                    ? [{ key: [], rows: input, input: -1, next: 0 }]
                    : input.map((row, i) => ({
                          key: [i],
                          rows: [row],
                          input: i,
                          page: pageOf(row, 'page'),
                          next: 0,
                      }))

            for (const [s, segment] of segments.entries()) {
                let stages = segment
                if (s > 0) {
                    units = await this.barrier(units, segment[0] as PipelineEntry)
                    stages = segment.slice(1)
                }
                for (const unit of units) unit.next = 0
                units = await this.walkAll(units, stages, s)
            }

            const rows = units.sort(byKey).flatMap((unit) => unit.rows)
            const ms = performance.now() - started
            if (this.order === 'page') this.reportStages()
            this.emit({ type: 'run:end', runId: this.runId, status: 'done', ms, rows: rows.length })
            return { rows, timings: this.timings(), ms }
        } catch (error) {
            const aborted = external?.aborted === true
            this.emit({
                type: 'run:end',
                runId: this.runId,
                status: aborted ? 'aborted' : 'failed',
                ms: performance.now() - started,
                rows: 0,
                message: formatException('pipeline', error),
            })
            throw error
        } finally {
            external?.removeEventListener('abort', forward)
        }
    }

    private timings(): Record<string, number> {
        const out: Record<string, number> = {}
        for (const entry of this.active) out[entry.timingKey] = this.busy.get(entry) ?? 0
        return out
    }

    /** The legacy `onStage` callback, once per stage, for orders where stages interleave. */
    private reportStages(): void {
        if (!this.options.onStage) return
        for (const entry of this.active) {
            this.options.onStage(entry.stage.name, this.busy.get(entry) ?? 0, this.rowsAfter.get(entry) ?? 0)
        }
    }

    /** Gather every unit, run the barrier stage over the whole run, hand the rows back. */
    private async barrier(units: Unit[], entry: PipelineEntry): Promise<Unit[]> {
        units.sort(byKey)
        this.emit({ type: 'barrier:wait', runId: this.runId, stageId: entry.id, arrived: units.length })
        const all: Unit = { key: [], rows: units.flatMap((u) => u.rows), input: -1, next: 0 }
        const counts = units.map((u) => u.rows.length)
        const out = await this.runStage(entry, all)

        if (out.length !== all.rows.length || this.order === 'stage') {
            return [{ ...all, rows: out }]
        }
        // Same count: the stage rewrote rows in place, so each unit takes its
        // own back and pages keep streaming independently after the barrier.
        let at = 0
        return units.map((unit, i) => {
            const n = counts[i] as number
            const rows = out.slice(at, at + n)
            at += n
            return { ...unit, rows }
        })
    }

    /** Walk units through a segment, `pagesInFlight` at a time, oldest first. */
    private walkAll(units: Unit[], stages: readonly PipelineEntry[], segment: number): Promise<Unit[]> {
        const limit = this.order === 'page' ? this.pagesInFlight : 1
        const queue = [...units].sort(byKey)
        const finished: Unit[] = []
        let running = 0
        let failure: { error: unknown } | null = null

        return new Promise<Unit[]>((resolve, reject) => {
            const pump = () => {
                if (failure) {
                    // Let the walks already started see the abort and settle,
                    // so no event arrives after the run has ended.
                    if (running === 0) reject(failure.error)
                    return
                }
                if (queue.length === 0 && running === 0) {
                    resolve(finished)
                    return
                }
                while (running < limit && queue.length > 0) {
                    const unit = queue.shift() as Unit
                    running += 1
                    this.walk(unit, stages, segment).then(
                        (outcome) => {
                            running -= 1
                            if ('done' in outcome) finished.push(outcome.done)
                            else {
                                queue.push(...outcome.children)
                                queue.sort(byKey)
                            }
                            pump()
                        },
                        (error) => {
                            running -= 1
                            if (!failure) {
                                failure = { error }
                                this.controller.abort(error)
                            }
                            pump()
                        }
                    )
                }
            }
            pump()
        })
    }

    private async walk(unit: Unit, stages: readonly PipelineEntry[], segment: number): Promise<WalkOutcome> {
        const started = performance.now()
        this.emit({ type: 'unit:start', runId: this.runId, unit: this.ref(unit), segment })

        for (let i = unit.next; i < stages.length; i++) {
            this.signal.throwIfAborted()
            const entry = stages[i] as PipelineEntry

            if (this.order === 'page' && unit.page === undefined && unit.rows.length === 1) {
                const children = await this.preSplit(unit, entry, i)
                if (children) {
                    this.emit({
                        type: 'unit:end',
                        runId: this.runId,
                        unit: this.ref(unit),
                        segment,
                        ms: performance.now() - started,
                    })
                    return { children }
                }
            }

            unit.rows = await this.runStage(entry, unit)

            if (this.order === 'page' && unit.page === undefined) {
                const groups = splitByPage(unit.rows, entry.stage)
                if (groups && groups.length > 1) {
                    this.emit({
                        type: 'unit:end',
                        runId: this.runId,
                        unit: this.ref(unit),
                        segment,
                        ms: performance.now() - started,
                    })
                    return {
                        children: groups.map((rows, k) => ({
                            key: [...unit.key, k],
                            rows,
                            input: unit.input,
                            page: pageOf(rows[0] as Row, entry.stage.params.pageCol),
                            next: i + 1,
                        })),
                    }
                }
                if (groups?.length === 1) unit.page = pageOf(unit.rows[0] as Row, entry.stage.params.pageCol)
            }
        }

        this.emit({
            type: 'unit:end',
            runId: this.runId,
            unit: this.ref(unit),
            segment,
            ms: performance.now() - started,
        })
        return { done: unit }
    }

    /** Split a document-level unit into its pages before an expanding stage runs on it. */
    private async preSplit(unit: Unit, entry: PipelineEntry, at: number): Promise<Unit[] | null> {
        const row = unit.rows[0] as Row
        if (entry.when && !evaluate(entry.when, row, this.vars)) return null

        let pages: number[] | null
        try {
            pages = await entry.stage.planPages(row, this.context(entry))
        } catch {
            // The stage itself will fail on this row and record why.
            return null
        }
        if (!pages || pages.length < 2) return null

        const pageCol = entry.stage.params.pageCol
        return pages.map((page, k) => ({
            key: [...unit.key, k],
            rows: [{ ...row, [pageCol]: page }],
            input: unit.input,
            page,
            next: at,
        }))
    }

    private context(entry: PipelineEntry): StageContext {
        return {
            index: entry.index,
            signal: this.signal,
            stageId: entry.id,
            runId: this.runId,
            onProgress: (progress: ModelProgress) =>
                this.emit({ type: 'model:progress', runId: this.runId, stageId: entry.id, progress }),
        }
    }

    private ref(unit: Unit): UnitRef {
        const first = unit.rows[0]
        const path = first?.path
        return {
            key: unit.key.join('.'),
            input: unit.input,
            ...(unit.page !== undefined ? { page: unit.page } : {}),
            ...(typeof path === 'string' ? { path } : {}),
        }
    }

    /** Run one stage over one unit: filter, lock, initialise, transform, splice, report. */
    private async runStage(entry: PipelineEntry, unit: Unit): Promise<Row[]> {
        const { stage } = entry
        const rows = unit.rows
        const ref = this.ref(unit)

        const mask = entry.when ? rows.map((row) => evaluate(entry.when as Condition, row, this.vars)) : null
        const matched = mask ? mask.filter(Boolean).length : rows.length
        if (rows.length === 0 || matched === 0) {
            this.emit({
                type: 'stage:skip',
                runId: this.runId,
                stageId: entry.id,
                index: entry.index,
                unit: ref,
                reason: rows.length === 0 ? 'no-rows' : 'when',
                rows: rows.length,
            })
            this.countRows(entry, rows.length)
            return rows
        }

        const waitStarted = performance.now()
        const release = await acquireAll(this.claims(entry), unit.key as Priority, this.signal)
        const waitMs = performance.now() - waitStarted

        try {
            this.emit({
                type: 'stage:start',
                runId: this.runId,
                stageId: entry.id,
                index: entry.index,
                unit: ref,
                rows: matched,
            })
            const started = performance.now()
            // A row whose input already failed upstream needs no model: the
            // stage only reports that failure. When that is every row, skip
            // loading -- a dead page must not trigger a download, and a
            // download failing would bury the real cause.
            const live = (mask ? rows.filter((_, i) => mask[i]) : rows).some(
                (row) => !failedUpstream(row, stage)
            )
            const initError = live ? await this.ensureInit(entry) : null
            const ctx = this.context(entry)
            const apply = (batch: Row[]): Promise<Row[]> =>
                initError === null
                    ? stage.transform(batch, ctx)
                    : Promise.resolve(stage.failRows(batch, initError))

            const produced: Row[] = []
            const out = await splice(stage, rows, mask, apply, produced)
            const ms = performance.now() - started

            this.busy.set(entry, (this.busy.get(entry) ?? 0) + ms)
            this.countRows(entry, out.length)
            const failed = this.reportFailures(entry, ref, produced, initError === null ? 'apply' : 'init')

            this.emit({
                type: 'stage:end',
                runId: this.runId,
                stageId: entry.id,
                index: entry.index,
                unit: ref,
                rowsIn: rows.length,
                rowsOut: out.length,
                matched,
                failed,
                ms,
                waitMs,
            })
            if (this.order === 'stage') this.options.onStage?.(stage.name, ms, out.length)
            this.reportRows(entry, ref, produced)
            return out
        } finally {
            release()
        }
    }

    private countRows(entry: PipelineEntry, n: number): void {
        this.rowsAfter.set(entry, (this.rowsAfter.get(entry) ?? 0) + n)
    }

    private claims(entry: PipelineEntry): { key: string; semaphore: Semaphore }[] {
        const claims = new Map<string, Semaphore>()
        claims.set(`stage:${entry.stage.uid}`, stageSlot(entry.stage))
        const override = this.overrides.get(entry)
        if (override) claims.set(`run:${this.runId}:${entry.id}`, override)
        for (const claim of entry.stage.resources()) {
            const key = `resource:${claimKey(claim)}`
            if (!claims.has(key)) claims.set(key, sharedSemaphore(claim))
        }
        return [...claims].map(([key, semaphore]) => ({ key, semaphore }))
    }

    /**
     * Initialise a stage once per run, inside the error contract.
     *
     * Returns the failure message, or null when the stage is ready. A stage
     * with `propagateError` rethrows, as it would for a failure in `apply`.
     */
    private async ensureInit(entry: PipelineEntry): Promise<string | null> {
        let pending = this.inits.get(entry)
        if (!pending) {
            const started = performance.now()
            this.emit({ type: 'stage:init', runId: this.runId, stageId: entry.id, phase: 'start' })
            const ctx = this.context(entry)
            pending = entry.stage
                .init({ stageId: entry.id, signal: this.signal, onProgress: ctx.onProgress })
                .then(
                    () => {
                        this.emit({
                            type: 'stage:init',
                            runId: this.runId,
                            stageId: entry.id,
                            phase: 'end',
                            ms: performance.now() - started,
                        })
                    },
                    (error: unknown) => {
                        this.emit({
                            type: 'stage:init',
                            runId: this.runId,
                            stageId: entry.id,
                            phase: 'error',
                            ms: performance.now() - started,
                            message: formatException(entry.stage.name, error),
                        })
                        throw error
                    }
                )
            this.inits.set(entry, pending)
        }

        try {
            await pending
            return null
        } catch (error) {
            this.signal.throwIfAborted()
            if (entry.stage.params.propagateError) throw error
            if (this.options.initRetry === 'row' && this.inits.get(entry) === pending)
                this.inits.delete(entry)
            return formatException(entry.stage.name, error)
        }
    }

    private reportFailures(
        entry: PipelineEntry,
        unit: UnitRef,
        produced: Row[],
        phase: 'init' | 'apply'
    ): number {
        const col = entry.stage.params.outputCol
        let failed = 0
        produced.forEach((row, rowIndex) => {
            const message = exceptionOf(row[col])
            if (!message || isSkipped(message)) return
            failed += 1
            this.emit({
                type: 'stage:row-error',
                runId: this.runId,
                stageId: entry.id,
                unit,
                rowIndex,
                message,
                phase,
                upstream: message.includes('Upstream stage failed'),
            })
        })
        return failed
    }

    private reportRows(entry: PipelineEntry, unit: UnitRef, produced: Row[]): void {
        const onRow = this.options.onRow
        const settings = this.options.rowUpdates ?? {}
        if (!onRow || settings.payload === 'none') return
        if (
            settings.stages &&
            !settings.stages.includes(entry.id) &&
            !settings.stages.includes(entry.stage.name)
        ) {
            return
        }

        const { pathCol, pageCol } = entry.stage.params
        const cols = [...new Set([...entry.stage.writes(), pathCol, pageCol])]
        produced.forEach((row, rowIndex) => {
            let payload: Row = settings.payload === 'full' ? row : pick(row, cols)
            if (settings.stripBinary) payload = stripBinary(payload) as Row
            const update: RowUpdate = {
                runId: this.runId,
                stageId: entry.id,
                unit,
                rowIndex,
                rowCount: produced.length,
                row: payload,
            }
            onRow(update)
        })
    }
}

/**
 * Run `apply` on the rows `mask` admits and put the results back in place.
 *
 * A row-scope stage treats each row on its own, so it is called once per run
 * of consecutive matching rows and its output lands exactly where its input
 * was. A group or document stage must see its matching rows together; if it
 * keeps their count they go back one-for-one, otherwise its output takes the
 * place of the first matching row.
 */
async function splice(
    stage: Stage,
    rows: Row[],
    mask: boolean[] | null,
    apply: (batch: Row[]) => Promise<Row[]>,
    produced: Row[]
): Promise<Row[]> {
    if (!mask) {
        const out = await apply(rows)
        produced.push(...out)
        return out
    }

    if (stage.scope === 'row') {
        const out: Row[] = []
        let i = 0
        while (i < rows.length) {
            if (!mask[i]) {
                out.push(rows[i] as Row)
                i += 1
                continue
            }
            let j = i
            while (j < rows.length && mask[j]) j += 1
            const result = await apply(rows.slice(i, j))
            produced.push(...result)
            out.push(...result)
            i = j
        }
        return out
    }

    const batch = rows.filter((_, i) => mask[i])
    const result = await apply(batch)
    produced.push(...result)
    if (result.length === batch.length) {
        let k = 0
        return rows.map((row, i) => (mask[i] ? (result[k++] as Row) : row))
    }
    const first = mask.indexOf(true)
    const out: Row[] = []
    rows.forEach((row, i) => {
        if (i === first) out.push(...result)
        else if (!mask[i]) out.push(row)
    })
    return out
}

/** How a run would be laid out, without running it: see `planRun`. */
export interface RunPlan {
    /** Per input row, the pages the first stage splits it into, or null when it does not. */
    pages: (number[] | null)[]
    /** Pipeline positions of the stages the run waits at, given this run's `enabled`. */
    barriers: number[]
}

/**
 * The page split and the barriers of a run, worked out up front.
 *
 * What a coordinator spreading one document over several workers needs: which
 * pages to hand out, and where every page must come back before any goes on.
 * Uses the same rules the scheduler does, so the two cannot disagree.
 */
export async function planRun(
    entries: readonly PipelineEntry[],
    rows: readonly Row[],
    options: Pick<RunOptions, 'enabled' | 'vars'> = {}
): Promise<RunPlan> {
    const enabled = (entry: PipelineEntry) =>
        options.enabled?.[entry.id] ?? options.enabled?.[entry.stage.name] ?? entry.enabled
    const active = entries.filter(enabled)
    const barriers = active
        .filter((entry) => entry.barrier || entry.stage.scope === 'document')
        .map((entry) => entry.index)

    const first = active[0]
    const pages = await Promise.all(
        rows.map(async (row) => {
            if (!first || barriers.includes(first.index)) return null
            if (first.when && !evaluate(first.when, row, options.vars ?? {})) return null
            try {
                return await first.stage.planPages(row, { index: first.index })
            } catch {
                return null
            }
        })
    )
    return { pages, barriers }
}

function pageOf(row: Row, pageCol: string): number | undefined {
    const page = row[pageCol]
    return typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page : undefined
}

/**
 * Group a unit's rows into pages, when they fall into contiguous runs of one
 * page each. Rows out of page order, or without a page, are left as one unit:
 * splitting them would reorder the result.
 */
function splitByPage(rows: readonly Row[], stage: Stage): Row[][] | null {
    if (rows.length === 0) return null
    const { pageCol, pathCol } = stage.params
    const groups: Row[][] = []
    const seen = new Set<string>()
    let current: string | null = null

    for (const row of rows) {
        if (pageOf(row, pageCol) === undefined) return null
        const key = `${String(row[pathCol])}\u0000${String(row[pageCol])}`
        if (key !== current) {
            if (seen.has(key)) return null
            seen.add(key)
            groups.push([])
            current = key
        }
        ;(groups[groups.length - 1] as Row[]).push(row)
    }
    return groups
}

/** A column the stage reads carries an `exception`: the stage will only report it. */
function failedUpstream(row: Row, stage: Stage): boolean {
    return stage.reads().some((col) => exceptionOf(row[col]) !== null)
}

function exceptionOf(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null
    const exception = (value as { exception?: unknown }).exception
    return typeof exception === 'string' && exception !== '' ? exception : null
}

function pick(row: Row, cols: readonly string[]): Row {
    const out: Row = {}
    for (const col of cols) if (col in row) out[col] = row[col]
    return out
}

/**
 * Replace binary payloads with their size, sharing everything that holds none.
 *
 * Returns the very same object when nothing inside it is binary, so a row of
 * entities is not copied just to find that out.
 */
export function stripBinary(value: unknown, depth = 0): unknown {
    if (value === null || typeof value !== 'object') return value
    if (ArrayBuffer.isView(value)) return { bytes: value.byteLength }
    if (value instanceof ArrayBuffer) return { bytes: value.byteLength }
    if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) {
        return { bytes: value.width * value.height * 4 }
    }
    if (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas) {
        return { bytes: value.width * value.height * 4 }
    }
    if (depth > 8) return value

    if (Array.isArray(value)) {
        let changed = false
        const out = value.map((item) => {
            const next = stripBinary(item, depth + 1)
            if (next !== item) changed = true
            return next
        })
        return changed ? out : value
    }

    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        const next = stripBinary(item, depth + 1)
        if (next !== item) changed = true
        out[key] = next
    }
    return changed ? out : value
}
