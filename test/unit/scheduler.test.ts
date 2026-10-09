import { describe, expect, it, vi } from 'vitest'
import type { ResourceClaim } from '../../src/core/locks.js'
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Tracks how many calls of a group of stages are in progress at once. */
class Gauge {
    now = 0
    max = 0
    enter(): void {
        this.now += 1
        this.max = Math.max(this.max, this.now)
    }
    leave(): void {
        this.now -= 1
    }
}

interface TagOptions extends Partial<BaseStageParams> {
    tag?: string
    delay?: number
    gauge?: Gauge
    concurrency?: number
    claims?: ResourceClaim[]
    log?: string[]
}

/** Row-scope stage: appends its tag to a string column. */
class Tag extends Stage {
    readonly name: string
    constructor(
        name: string,
        private readonly opts: TagOptions = {}
    ) {
        super(resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, { inputCol: 'v', outputCol: 'v', ...opts }))
        this.name = name
    }
    override get maxConcurrency(): number {
        return this.opts.concurrency ?? 1
    }
    override resources(): ResourceClaim[] {
        return this.opts.claims ?? []
    }
    protected async apply(input: unknown, row: Row): Promise<string> {
        this.opts.gauge?.enter()
        this.opts.log?.push(`${this.name}:${String(row.page ?? '-')}`)
        try {
            if (this.opts.delay) await sleep(this.opts.delay)
            if (input === 'boom') throw new Error('exploded')
            return `${String(input ?? '')}${this.opts.tag ?? this.name}`
        } finally {
            this.opts.gauge?.leave()
        }
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** A document-to-pages expander, optionally able to plan its pages. */
class Pages extends Stage {
    readonly name = 'Pages'
    planned = 0
    calls = 0
    constructor(private readonly canPlan = true) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'doc',
                outputCol: 'v',
                keepInputData: true,
            })
        )
    }
    override async planPages(row: Row): Promise<number[] | null> {
        if (!this.canPlan) return null
        this.planned += 1
        return this.pagesOf(row)
    }
    private pagesOf(row: Row): number[] {
        const n = String(row.doc).length
        const page = row.page
        if (typeof page === 'number') return page < n ? [page] : []
        return Array.from({ length: n }, (_, i) => i)
    }
    protected override async expand(input: unknown, row: Row): Promise<Row[]> {
        this.calls += 1
        return this.pagesOf(row).map((page) => ({ ...row, page, v: String(input)[page] }))
    }
    protected async apply(): Promise<never> {
        throw new Error('unreachable')
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Expands each page into `parts` rows, like one row per embedded image. */
class Parts extends Stage {
    readonly name = 'Parts'
    constructor(private readonly parts: number) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'v',
                outputCol: 'part',
                keepInputData: true,
            })
        )
    }
    protected override async expand(_input: unknown, row: Row): Promise<Row[]> {
        return Array.from({ length: this.parts }, (_, part) => ({ ...row, part }))
    }
    protected async apply(): Promise<never> {
        throw new Error('unreachable')
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Folds each page's rows back into one, like PdfMergeImageText. */
class Fold extends Stage {
    readonly name = 'Fold'
    constructor() {
        super(resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, { inputCol: 'v', outputCol: 'v' }))
    }
    override get scope(): StageScope {
        return 'group'
    }
    override async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        const groups = new Map<string, Row[]>()
        for (const row of rows) {
            const key = `${String(row.path)}|${String(row.page)}`
            groups.set(key, [...(groups.get(key) ?? []), row])
        }
        const reps = [...groups.values()].map((group) => ({
            ...(group[0] as Row),
            v: `${String(group[0]?.v)}x${group.length}`,
        }))
        return super.transform(reps, ctx)
    }
    protected async apply(input: unknown): Promise<string> {
        return `${String(input)}F`
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Needs every row: writes how many rows the run had and their joined values. */
class Whole extends Stage {
    readonly name = 'Whole'
    seen: string[] = []
    constructor() {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'v',
                outputCol: 'whole',
                keepInputData: true,
            })
        )
    }
    override get scope(): StageScope {
        return 'document'
    }
    override async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        this.seen = rows.map((row) => String(row.v))
        return super.transform(rows, ctx)
    }
    protected async apply(): Promise<string> {
        return this.seen.join(',')
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Stage whose init can be made to fail; counts calls. */
class Model extends Stage {
    readonly name: string
    inits = 0
    constructor(
        name = 'Model',
        private readonly failInit = false,
        options: Partial<BaseStageParams> = {}
    ) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'v',
                outputCol: 'model',
                keepInputData: true,
                ...options,
            })
        )
        this.name = name
    }
    override async init(): Promise<void> {
        this.inits += 1
        await sleep(1)
        if (this.failInit) throw new Error('weights unavailable')
    }
    protected async apply(input: unknown): Promise<string> {
        return `m(${String(input)})`
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

const strip = (rows: Row[]) =>
    rows.map((row) => {
        const { [ROW_TIME_COL]: _r, [EXECUTION_TIME_COL]: _e, ...rest } = row
        return rest
    })

function lcg(seed: number): () => number {
    let state = seed
    return () => {
        state = (state * 1664525 + 1013904223) % 2 ** 32
        return state / 2 ** 32
    }
}

describe('page order equals stage order', () => {
    const inputs = [
        { doc: 'abc', path: 'one.pdf' },
        { doc: 'de', path: 'two.pdf' },
        { doc: 'f', path: 'three.pdf' },
    ]

    it('for a typical streaming chain', async () => {
        const build = () =>
            new Pipeline([new Pages(), new Tag('A'), new Parts(2), new Fold(), new Tag('B'), new Whole()])
        const expected = strip(await build().transform(inputs))
        for (const pagesInFlight of [1, 2, 4]) {
            expect(strip(await build().run(inputs, { pagesInFlight }))).toEqual(expected)
        }
        expect(expected.map((r) => r.v)).toEqual(['aAx2FB', 'bAx2FB', 'cAx2FB', 'dAx2FB', 'eAx2FB', 'fAx2FB'])
    })

    it('for random chains', async () => {
        const random = lcg(42)
        // Each recipe step fixes its parameters once, so both builds of a
        // recipe get identical stages.
        const steps: (() => () => Stage)[] = [
            () => {
                const delay = Math.floor(random() * 3)
                return () => new Tag('A', { delay })
            },
            () => () => new Tag('B'),
            () => {
                const parts = 1 + Math.floor(random() * 3)
                return () => new Parts(parts)
            },
            () => () => new Fold(),
            () => () => new Whole(),
            () => {
                const canPlan = random() > 0.3
                return () => new Pages(canPlan)
            },
        ]

        for (let trial = 0; trial < 60; trial++) {
            const length = 1 + Math.floor(random() * 5)
            const recipe = Array.from({ length }, () =>
                (steps[Math.floor(random() * steps.length)] as () => () => Stage)()
            )
            const planFirst = random() > 0.5
            const build = () => new Pipeline([new Pages(planFirst), ...recipe.map((make) => make())])

            const stageOrder = strip(await build().transform(inputs))
            const pagesInFlight = 1 + (trial % 4)
            const pageOrder = strip(await build().run(inputs, { pagesInFlight }))
            expect(pageOrder, `trial ${trial}`).toEqual(stageOrder)
        }
    })
})

describe('splitting into pages', () => {
    it('plans pages first so the expander runs once per page', async () => {
        const pages = new Pages()
        const rows = await new Pipeline([pages, new Tag('A')]).run([{ doc: 'abcd', path: 'p' }])
        expect(pages.planned).toBe(1)
        expect(pages.calls).toBe(4)
        expect(rows.map((r) => r.page)).toEqual([0, 1, 2, 3])
    })

    it('falls back to splitting after an expander that cannot plan', async () => {
        const events: PipelineEvent[] = []
        await new Pipeline([new Pages(false), new Tag('A')]).run([{ doc: 'abc', path: 'p' }], {
            onEvent: (e) => events.push(e),
        })
        const starts = events.filter((e) => e.type === 'stage:start' && e.stageId === 'A')
        expect(starts.map((e) => (e as { unit: { key: string } }).unit.key)).toEqual(['0.0', '0.1', '0.2'])
    })
})

describe('events', () => {
    it('reports a well-formed run', async () => {
        const events: PipelineEvent[] = []
        await new Pipeline([new Pages(), new Tag('A'), new Whole()]).run([{ doc: 'ab', path: 'p' }], {
            onEvent: (e) => events.push(e),
            pagesInFlight: 2,
        })

        expect(events[0]?.type).toBe('run:start')
        expect(events.at(-1)?.type).toBe('run:end')
        expect(events.filter((e) => e.type === 'run:end')).toHaveLength(1)

        const starts = events.filter((e) => e.type === 'stage:start')
        const ends = events.filter((e) => e.type === 'stage:end')
        expect(starts).toHaveLength(ends.length)

        const plan = events[0] as Extract<PipelineEvent, { type: 'run:start' }>
        expect(plan.segments).toEqual([['Pages', 'A'], ['Whole']])
        expect(events.some((e) => e.type === 'barrier:wait' && e.arrived === 2)).toBe(true)

        const aPages = ends
            .filter((e) => e.stageId === 'A')
            .map((e) => (e as Extract<PipelineEvent, { type: 'stage:end' }>).unit.page)
        expect(aPages.sort()).toEqual([0, 1])
    })

    it('streams row deltas carrying only what the stage wrote', async () => {
        const updates: RowUpdate[] = []
        await new Pipeline([new Pages(), new Tag('A')]).run(
            [{ doc: 'ab', path: 'p', heavy: new Uint8Array(8) }],
            {
                onRow: (u) => updates.push(u),
                rowUpdates: { stages: ['A'] },
            }
        )
        expect(updates.map((u) => u.row)).toEqual([
            { v: 'aA', path: 'p', page: 0 },
            { v: 'bA', path: 'p', page: 1 },
        ])
    })

    it('strips binary payloads on request', async () => {
        const updates: RowUpdate[] = []
        await new Pipeline([new Tag('A', { keepInputData: true })]).run(
            [{ v: 'x', image: { data: new Uint8Array(16), width: 2 } }],
            { onRow: (u) => updates.push(u), rowUpdates: { payload: 'full', stripBinary: true } }
        )
        expect(updates[0]?.row.image).toEqual({ data: { bytes: 16 }, width: 2 })
    })

    it('are also an async iterable', async () => {
        const run = new Pipeline([new Tag('A')]).events([{ v: '' }])
        const types: string[] = []
        for await (const event of run) types.push(event.type)
        expect(types[0]).toBe('run:start')
        expect(types.at(-1)).toBe('run:end')
        expect((await run.result)[0]?.v).toBe('A')
    })

    it('reports row errors with their phase', async () => {
        const events: PipelineEvent[] = []
        await new Pipeline([new Tag('A')]).run([{ v: 'boom' }, { v: 'ok' }], {
            onEvent: (e) => events.push(e),
        })
        const errors = events.filter((e) => e.type === 'stage:row-error')
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({ phase: 'apply', upstream: false, unit: { key: '0' } })
    })
})

describe('enabled and when', () => {
    it('skips a disabled stage without initialising it', async () => {
        const model = new Model()
        const events: PipelineEvent[] = []
        const pipeline = new Pipeline([new Tag('A'), { stage: model, id: 'faces' }])
        const rows = await pipeline.run([{ v: '' }], {
            enabled: { faces: false },
            onEvent: (e) => events.push(e),
        })

        expect(model.inits).toBe(0)
        expect(rows[0]).not.toHaveProperty('model')
        expect(events.some((e) => e.type === 'stage:skip' && e.reason === 'disabled')).toBe(true)

        // The same pipeline, re-enabled, runs it -- no rebuild needed.
        const again = await pipeline.run([{ v: '' }])
        expect(again[0]?.model).toBe('m(A)')
        expect(model.inits).toBe(1)
    })

    it('honours enabled: false on the stage and enabling by name', async () => {
        const model = new Model()
        const pipeline = new Pipeline([{ stage: model, enabled: false }])
        expect((await pipeline.run([{ v: '' }]))[0]).not.toHaveProperty('model')
        expect((await pipeline.run([{ v: '' }], { enabled: { Model: true } }))[0]?.model).toBe('m()')
    })

    it('runs a conditional stage only on matching rows, leaving the rest untouched', async () => {
        const rows = await new Pipeline([
            { stage: new Tag('Ocr', { keepInputData: true }), when: { path: 'needsOcr', truthy: true } },
        ]).run([
            { v: 'a', needsOcr: true },
            { v: 'b', needsOcr: false },
            { v: 'c', needsOcr: true },
        ])
        expect(rows.map((r) => r.v)).toEqual(['aOcr', 'b', 'cOcr'])
        expect(rows[1]).not.toHaveProperty(ROW_TIME_COL)
    })

    it('never initialises a stage no row matches', async () => {
        const model = new Model()
        const events: PipelineEvent[] = []
        await new Pipeline([{ stage: model, when: { var: 'forceOcr', truthy: true } }]).run(
            [{ v: 'a' }, { v: 'b' }],
            { order: 'stage', onEvent: (e) => events.push(e) }
        )
        expect(model.inits).toBe(0)
        expect(events.some((e) => e.type === 'stage:skip' && e.reason === 'when')).toBe(true)
    })

    it('splices a conditional group stage back in place', async () => {
        const rows = await new Pipeline([{ stage: new Fold(), when: { path: 'path', eq: 'a' } }]).transform([
            { v: '1', path: 'a', page: 0 },
            { v: '2', path: 'b', page: 0 },
            { v: '3', path: 'a', page: 0 },
        ])
        expect(rows.map((r) => r.v)).toEqual(['1x2F', '2'])
    })

    it('rejects a malformed condition when the pipeline is built', () => {
        expect(() => new Pipeline([{ stage: new Tag('A'), when: { path: 'x' } as never }])).toThrow(/A\.when/)
    })

    it('rejects duplicate ids', () => {
        expect(
            () =>
                new Pipeline([
                    { stage: new Tag('A'), id: 'x' },
                    { stage: new Tag('B'), id: 'x' },
                ])
        ).toThrow(/Duplicate stage id "x"/)
    })
})

describe('lazy init', () => {
    it('records an init failure on the matching rows instead of throwing', async () => {
        const model = new Model('Model', true)
        const events: PipelineEvent[] = []
        const rows = await new Pipeline([new Pages(), { stage: model, when: { path: 'page', ne: 1 } }]).run(
            [{ doc: 'abc', path: 'p' }],
            { onEvent: (e) => events.push(e) }
        )

        expect(rows.map((r) => (r.model as { exception?: string } | undefined)?.exception ?? null)).toEqual([
            expect.stringContaining('weights unavailable'),
            null,
            expect.stringContaining('weights unavailable'),
        ])
        // Cached for the run: two pages failed, one attempt.
        expect(model.inits).toBe(1)
        expect(events.filter((e) => e.type === 'stage:row-error' && e.phase === 'init')).toHaveLength(2)
        expect(events.filter((e) => e.type === 'stage:init' && e.phase === 'error')).toHaveLength(1)
    })

    it('retries per page with initRetry: row, and on the next run', async () => {
        const model = new Model('Model', true)
        const pipeline = new Pipeline([new Pages(), model])
        await pipeline.run([{ doc: 'abc', path: 'p' }], { initRetry: 'row' })
        expect(model.inits).toBe(3)
        await pipeline.run([{ doc: 'abc', path: 'p' }])
        expect(model.inits).toBe(4)
    })

    it('does not initialise for rows that already failed upstream', async () => {
        const model = new Model()
        const rows = await new Pipeline([model]).run([{ v: { exception: 'PdfToImage exploded' } }])
        expect(model.inits).toBe(0)
        // The stage still runs, so it is the one to report the failure.
        expect(rows[0]).toHaveProperty('model')
    })

    it('still throws with propagateError', async () => {
        const model = new Model('Model', true, { propagateError: true })
        await expect(new Pipeline([model]).run([{ v: 'x' }])).rejects.toThrow('weights unavailable')
    })

    it('reports progress attributed to the stage', async () => {
        class Downloading extends Model {
            override async init(ctx?: Parameters<Stage['init']>[0]): Promise<void> {
                ctx?.onProgress?.({ repo: 'r', file: 'f', loaded: 1, total: 2, phase: 'downloading' })
            }
        }
        const events: PipelineEvent[] = []
        await new Pipeline([{ stage: new Downloading(), id: 'ner' }]).run([{ v: 'x' }], {
            onEvent: (e) => events.push(e),
        })
        expect(events.find((e) => e.type === 'model:progress')).toMatchObject({ stageId: 'ner' })
    })
})

describe('concurrency', () => {
    it('keeps pages in flight within the limit and lets stages overlap', async () => {
        const gauge = new Gauge()
        const pages = new Gauge()
        const log: string[] = []
        await new Pipeline([
            new Pages(),
            new Tag('A', { delay: 5, gauge, log }),
            new Tag('B', { delay: 5, gauge: pages, log }),
        ]).run([{ doc: 'abcdef', path: 'p' }], { pagesInFlight: 3 })

        // One A at a time (default maxConcurrency), but A and B overlapped.
        expect(gauge.max).toBe(1)
        expect(pages.max).toBe(1)
        const firstB = log.findIndex((entry) => entry.startsWith('B'))
        const lastA = log.map((entry) => entry.startsWith('A')).lastIndexOf(true)
        expect(firstB).toBeLessThan(lastA)
    })

    it('serves the oldest page first', async () => {
        const log: string[] = []
        await new Pipeline([
            new Pages(),
            new Tag('A', { delay: 2, log }),
            new Tag('B', { delay: 2, log }),
        ]).run([{ doc: 'abcd', path: 'p' }], { pagesInFlight: 4 })
        expect(log.filter((entry) => entry.startsWith('B'))).toEqual(['B:0', 'B:1', 'B:2', 'B:3'])
    })

    it('admits several calls of a stage that declares it', async () => {
        const gauge = new Gauge()
        await new Pipeline([new Pages(), new Tag('Net', { delay: 10, gauge, concurrency: 4 })]).run(
            [{ doc: 'abcdef', path: 'p' }],
            { pagesInFlight: 6 }
        )
        expect(gauge.max).toBe(4)
    })

    it('lets a run lower, but never raise, a stage concurrency', async () => {
        const low = new Gauge()
        await new Pipeline([new Pages(), new Tag('Net', { delay: 5, gauge: low, concurrency: 4 })]).run(
            [{ doc: 'abcdef', path: 'p' }],
            { pagesInFlight: 6, stages: { Net: { maxConcurrency: 2 } } }
        )
        expect(low.max).toBe(2)

        const high = new Gauge()
        await new Pipeline([new Pages(), new Tag('Ort', { delay: 5, gauge: high })]).run(
            [{ doc: 'abcdef', path: 'p' }],
            { pagesInFlight: 6, stages: { Ort: { maxConcurrency: 8 } } }
        )
        expect(high.max).toBe(1)
    })

    it('never overlaps two stages sharing a resource', async () => {
        const gauge = new Gauge()
        const claims = ['ort:paddle:v5']
        await new Pipeline([
            new Pages(),
            new Tag('Detect', { delay: 3, gauge, claims }),
            new Tag('Read', { delay: 3, gauge, claims }),
        ]).run([{ doc: 'abcdef', path: 'p' }], { pagesInFlight: 4 })
        expect(gauge.max).toBe(1)
    })

    it('does not deadlock on overlapping resource sets', async () => {
        const rows = await new Pipeline([
            new Pages(),
            new Tag('X', { delay: 1, claims: ['r:a', 'r:b'] }),
            new Tag('Y', { delay: 1, claims: ['r:b', 'r:a'] }),
        ]).run([{ doc: 'abcdefgh', path: 'p' }], { pagesInFlight: 8 })
        expect(rows).toHaveLength(8)
    })

    it('aborts mid-run and reports it', async () => {
        const controller = new AbortController()
        const events: PipelineEvent[] = []
        const run = new Pipeline([new Pages(), new Tag('A', { delay: 5 })]).run(
            [{ doc: 'abcdef', path: 'p' }],
            {
                signal: controller.signal,
                onEvent: (e) => {
                    events.push(e)
                    if (e.type === 'stage:end') controller.abort()
                },
            }
        )
        await expect(run).rejects.toThrow()
        expect(events.at(-1)).toMatchObject({ type: 'run:end', status: 'aborted' })
        expect(events.filter((e) => e.type === 'stage:end')).toHaveLength(1)
    })
})

describe('legacy transform', () => {
    it('keeps execution_time keyed by stage, with busy time summed across pages', async () => {
        const rows = await new Pipeline([new Pages(), new Tag('A', { delay: 2 })]).run(
            [{ doc: 'abc', path: 'p' }],
            {
                pagesInFlight: 3,
            }
        )
        const time = rows[0]?.[EXECUTION_TIME_COL] as { stages: Record<string, number>; total: number }
        expect(Object.keys(time.stages)).toEqual(['Pages', 'A'])
        expect(time.stages.A).toBeGreaterThan(4)
    })

    it('calls onStage once per stage in page order too', async () => {
        const onStage = vi.fn()
        await new Pipeline([new Pages(), new Tag('A')]).run([{ doc: 'abc', path: 'p' }], { onStage })
        expect(onStage.mock.calls.map((call) => [call[0], call[2]])).toEqual([
            ['Pages', 3],
            ['A', 3],
        ])
    })
})
