/**
 * The pool, against several real hosts in-process. What matters is that a
 * caller cannot tell it from one worker -- same rows, same order, one run in
 * the events -- except that the pages went to more than one place.
 */
import { describe, expect, it } from 'vitest'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../../src/core/params.js'
import {
    EXECUTION_TIME_COL,
    Pipeline,
    ROW_TIME_COL,
    type Row,
    Stage,
    type StageContext,
    type StageScope,
} from '../../src/core/pipeline.js'
import type { PipelineEvent, RowUpdate } from '../../src/core/run.js'
import { registerStages, startScaleDpWorker } from '../../src/worker/host.js'
import { ScaleDpWorkerPool } from '../../src/worker/pool.js'
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.js'

/** Which worker ran each call, from the tag the fake worker puts on every row it is sent. */
const calls: { stage: string; worker: number; page: unknown }[] = []

class PoolSplit extends Stage {
    readonly name = 'PoolSplit'
    constructor(options: Partial<BaseStageParams> = {}) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'doc',
                outputCol: 'text',
                keepInputData: true,
                ...options,
            })
        )
    }
    override async planPages(row: Row): Promise<number[]> {
        return typeof row.page === 'number' ? [row.page] : [...String(row.doc)].map((_, i) => i)
    }
    protected override async expand(input: unknown, row: Row): Promise<Row[]> {
        const pages = await this.planPages(row)
        return pages.map((page) => ({ ...row, page, text: String(input)[page] }))
    }
    protected async apply(): Promise<never> {
        throw new Error('unreachable')
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Records which worker it ran in. */
class PoolWork extends Stage {
    readonly name = 'PoolWork'
    constructor(options: Partial<BaseStageParams> = {}) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'text',
                outputCol: 'work',
                keepInputData: true,
                ...options,
            })
        )
    }
    protected async apply(input: unknown, row: Row): Promise<string> {
        calls.push({ stage: this.name, worker: Number(row.__worker ?? -1), page: row.page })
        await new Promise((resolve) => setTimeout(resolve, 3))
        return String(input).toUpperCase()
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Needs the whole run: writes every page's work, joined. */
class PoolWhole extends Stage {
    readonly name = 'PoolWhole'
    private seen: string[] = []
    constructor(options: Partial<BaseStageParams> = {}) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'work',
                outputCol: 'whole',
                keepInputData: true,
                ...options,
            })
        )
    }
    override get scope(): StageScope {
        return 'document'
    }
    override async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        this.seen = rows.map((row) => String(row.work))
        return super.transform(rows, ctx)
    }
    protected async apply(): Promise<string> {
        return this.seen.join('')
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

registerStages({ PoolSplit: PoolSplit as never, PoolWork: PoolWork as never, PoolWhole: PoolWhole as never })

/** A worker stand-in whose host tags every row it is sent with its index. */
function fakeWorker(index: number) {
    const scope = {
        onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
        postMessage: (message: WorkerResponse) =>
            queueMicrotask(() => worker.onmessage?.({ data: structuredClone(message) } as never)),
    }
    const worker = {
        onmessage: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
        onerror: null,
        postMessage: (message: WorkerRequest) =>
            queueMicrotask(() => {
                const data = structuredClone(message) as WorkerRequest & { rows?: Row[] }
                if (data.rows) data.rows = data.rows.map((row) => ({ ...row, __worker: index }))
                scope.onmessage?.({ data } as never)
            }),
        terminate: () => undefined,
    }
    startScaleDpWorker(scope as never)
    return worker as unknown as Worker
}

const strip = (rows: Row[]) =>
    rows.map((row) => {
        const { [ROW_TIME_COL]: _r, [EXECUTION_TIME_COL]: _e, __worker: _w, ...rest } = row
        return rest
    })

const descriptors = [{ type: 'PoolSplit' }, { type: 'PoolWork', id: 'work' }, { type: 'PoolWhole' }]
const inputs = [
    { doc: 'abcdef', path: 'one' },
    { doc: 'gh', path: 'two' },
]

describe('ScaleDpWorkerPool', () => {
    it('returns what one in-realm run returns, with the barrier seeing every page', async () => {
        const expected = strip(
            await new Pipeline([new PoolSplit(), new PoolWork(), new PoolWhole()]).transform(inputs)
        )
        const pool = new ScaleDpWorkerPool({ createWorker: fakeWorker, size: 3, pagesPerWorker: 2 })
        const rows = strip(await pool.run(descriptors, inputs).result)

        expect(rows).toEqual(expected)
        expect(rows.every((row) => row.whole === 'ABCDEFGH')).toBe(true)
    })

    it('spreads pages over every worker', async () => {
        calls.length = 0
        const pool = new ScaleDpWorkerPool({ createWorker: fakeWorker, size: 3, pagesPerWorker: 1 })
        await pool.run(descriptors.slice(0, 2), [{ doc: 'abcdefghi', path: 'p' }]).result
        const workers = new Set(calls.map((call) => call.worker))
        expect(workers.size).toBe(3)
        expect(calls).toHaveLength(9)
    })

    it('presents one run: one start, one end, unit keys in the run’s own terms', async () => {
        const events: PipelineEvent[] = []
        const updates: RowUpdate[] = []
        const pool = new ScaleDpWorkerPool({ createWorker: fakeWorker, size: 2 })
        await pool.run(descriptors, inputs, {
            onEvent: (event) => events.push(event),
            onRow: (update) => updates.push(update),
            rowUpdates: { stages: ['work'] },
        }).result

        expect(events.filter((e) => e.type === 'run:start')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'run:end')).toHaveLength(1)
        expect(events.at(-1)).toMatchObject({ type: 'run:end', status: 'done', rows: 8 })

        const keys = updates.map((u) => u.unit.key).sort()
        expect(keys).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '1.0', '1.1'])
        expect(updates.every((u) => !('__scaledp_pool_unit' in u.row))).toBe(true)
        const second = updates.find((u) => u.unit.key === '1.1')
        expect(second?.unit).toMatchObject({ input: 1, page: 1 })
    })

    it('honours enabled across the pool', async () => {
        const pool = new ScaleDpWorkerPool({ createWorker: fakeWorker, size: 2 })
        const rows = await pool.run(descriptors, inputs, { enabled: { work: false, PoolWhole: false } })
            .result
        expect(rows).toHaveLength(8)
        expect(rows.every((row) => !('work' in row) && !('whole' in row))).toBe(true)
    })

    it('cancels every worker', async () => {
        const pool = new ScaleDpWorkerPool({ createWorker: fakeWorker, size: 2, pagesPerWorker: 1 })
        const run = pool.run(descriptors, [{ doc: 'abcdefghijklmnop', path: 'p' }], {
            onEvent: (event) => {
                if (event.type === 'stage:end' && event.stageId === 'work') run.cancel()
            },
        })
        await expect(run.result).rejects.toMatchObject({ name: 'AbortError' })
    })
})
