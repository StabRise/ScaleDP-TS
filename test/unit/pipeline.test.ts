import { describe, expect, it, vi } from 'vitest'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../../src/core/params.js'
import { EXECUTION_TIME_COL, Pipeline, type Row, Stage, toRows } from '../../src/core/pipeline.js'

interface EchoParams extends BaseStageParams {
    suffix: string
}

/** Minimal stage: appends a suffix, or throws when the input says to. */
class Echo extends Stage<EchoParams> {
    readonly name = 'Echo'
    constructor(options: Partial<EchoParams> = {}) {
        super(
            resolveParams(
                { ...BASE_STAGE_DEFAULTS, inputCol: 'content', outputCol: 'out', suffix: '!' },
                options
            )
        )
    }
    protected async apply(input: unknown): Promise<string> {
        if (input === 'boom') throw new Error('exploded')
        return `${String(input)}${this.params.suffix}`
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

/** Stage that emits one row per character, exercising the expand path. */
class Explode extends Stage<BaseStageParams> {
    readonly name = 'Explode'
    constructor(options: Partial<BaseStageParams> = {}) {
        super(resolveParams({ ...BASE_STAGE_DEFAULTS, inputCol: 'content', outputCol: 'ch' }, options))
    }
    protected async apply(): Promise<never> {
        throw new Error('unreachable: expand always handles the row')
    }
    protected override async expand(input: unknown, row: Row): Promise<Row[]> {
        return String(input)
            .split('')
            .map((ch, page) => ({ ...row, ch, page }))
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

describe('toRows', () => {
    it('wraps binary input with a memory path', async () => {
        const rows = await toRows(new Uint8Array([1, 2, 3]))
        expect(rows).toHaveLength(1)
        expect(rows[0]?.path).toBe('memory')
        expect(rows[0]?.content).toBeInstanceOf(Uint8Array)
    })

    it('accepts ArrayBuffer, rows, and arrays of rows', async () => {
        expect((await toRows(new ArrayBuffer(4)))[0]?.content).toBeInstanceOf(Uint8Array)
        expect(await toRows({ content: 'x', path: 'p' })).toEqual([{ content: 'x', path: 'p' }])
        expect(await toRows([{ a: 1 }, { a: 2 }])).toHaveLength(2)
    })

    it('copies rows rather than aliasing the caller', async () => {
        const original = { a: 1 }
        const [copy] = await toRows([original])
        expect(copy).toBeDefined()
        Object.assign(copy as Row, { a: 99 })
        expect(original.a).toBe(1)
    })
})

describe('Pipeline', () => {
    it('runs stages in order and threads output forward', async () => {
        const pipeline = new Pipeline([
            new Echo({ inputCol: 'content', outputCol: 'a', suffix: '-1' }),
            new Echo({ inputCol: 'a', outputCol: 'b', suffix: '-2' }),
        ])
        const rows = await pipeline.transform([{ content: 'x' }])
        expect(rows[0]?.b).toBe('x-1-2')
    })

    it('drops the input column unless keepInputData is set', async () => {
        const dropped = await new Pipeline([new Echo()]).transform([{ content: 'x' }])
        expect(dropped[0]).not.toHaveProperty('content')

        const kept = await new Pipeline([new Echo({ keepInputData: true })]).transform([{ content: 'x' }])
        expect(kept[0]?.content).toBe('x')
    })

    it('captures stage failures instead of throwing, so the pipeline completes', async () => {
        const rows = await new Pipeline([new Echo()]).transform([{ content: 'ok' }, { content: 'boom' }])
        expect(rows).toHaveLength(2)
        expect(rows[0]?.out).toBe('ok!')
        expect((rows[1]?.out as { exception: string } | undefined)?.exception).toContain('exploded')
    })

    it('rethrows when propagateError is set', async () => {
        const pipeline = new Pipeline([new Echo({ propagateError: true })])
        await expect(pipeline.transform([{ content: 'boom' }])).rejects.toThrow('exploded')
    })

    it('supports stages that emit several rows per input row', async () => {
        const rows = await new Pipeline([new Explode()]).transform([{ content: 'abc' }])
        expect(rows.map((r) => r.ch)).toEqual(['a', 'b', 'c'])
        expect(rows.map((r) => r.page)).toEqual([0, 1, 2])
    })

    it('records per-stage timings without collisions between same-named stages', async () => {
        const rows = await new Pipeline([
            new Echo({ outputCol: 'a' }),
            new Echo({ inputCol: 'a', outputCol: 'b' }),
        ]).transform([{ content: 'x' }])

        const timing = rows[0]?.[EXECUTION_TIME_COL] as { stages: Record<string, number>; total: number }
        expect(Object.keys(timing.stages)).toEqual(['Echo', 'Echo#1'])
        expect(timing.total).toBeGreaterThanOrEqual(0)
    })

    it('reports progress through onStage', async () => {
        const onStage = vi.fn()
        await new Pipeline([new Echo()]).transform([{ content: 'x' }], { onStage })
        expect(onStage).toHaveBeenCalledWith('Echo', expect.any(Number), 1)
    })

    it('honours an abort signal', async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(
            new Pipeline([new Echo()]).transform([{ content: 'x' }], { signal: controller.signal })
        ).rejects.toThrow()
    })

    it('calls init once per stage and dispose on teardown', async () => {
        const stage = new Echo()
        const init = vi.spyOn(stage, 'init')
        const dispose = vi.spyOn(stage, 'dispose')
        const pipeline = new Pipeline([stage])
        await pipeline.transform([{ content: 'x' }])
        await pipeline.dispose()
        expect(init).toHaveBeenCalledTimes(1)
        expect(dispose).toHaveBeenCalledTimes(1)
    })
})

describe('resolveParams', () => {
    it('ignores undefined so optional config does not erase defaults', () => {
        const resolved = resolveParams({ a: 1, b: 2 }, { a: undefined, b: 5 })
        expect(resolved).toEqual({ a: 1, b: 5 })
    })

    it('runs validators against the resolved value', () => {
        expect(() =>
            resolveParams(
                { n: 1 },
                { n: -1 },
                {
                    n: (value) => {
                        if (value < 0) throw new RangeError('n must be positive')
                    },
                }
            )
        ).toThrow('n must be positive')
    })
})
