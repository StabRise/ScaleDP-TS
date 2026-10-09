/**
 * Client and host wired together in-process, with structured clone standing in
 * for postMessage -- so what crosses the boundary is exactly what would.
 */
import { describe, expect, it } from 'vitest'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../../src/core/params.js'
import { type Row, Stage } from '../../src/core/pipeline.js'
import type { PipelineEvent, RowUpdate } from '../../src/core/run.js'
import { ScaleDpWorkerClient } from '../../src/worker/client.js'
import { registerStages, startScaleDpWorker } from '../../src/worker/host.js'
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.js'

const inits: string[] = []

class Split extends Stage {
    readonly name = 'Split'
    constructor(options: Partial<BaseStageParams> = {}) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'doc',
                outputCol: 'text',
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

class Upper extends Stage {
    readonly name: string = 'Upper'
    constructor(options: Partial<BaseStageParams> = {}) {
        super(
            resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, {
                inputCol: 'text',
                outputCol: 'upper',
                keepInputData: true,
                ...options,
            })
        )
    }
    override async init(): Promise<void> {
        inits.push(this.name)
    }
    protected async apply(input: unknown): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return String(input).toUpperCase()
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

class Faces extends Upper {
    override readonly name = 'Faces'
}

registerStages({ Split: Split as never, Upper: Upper as never, Faces: Faces as never })

function connect(): ScaleDpWorkerClient {
    const scope = {
        onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
        postMessage: (message: WorkerResponse) =>
            queueMicrotask(() => worker.onmessage?.({ data: structuredClone(message) } as never)),
    }
    const worker = {
        onmessage: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
        onerror: null,
        postMessage: (message: WorkerRequest) =>
            queueMicrotask(() => scope.onmessage?.({ data: structuredClone(message) } as never)),
        terminate: () => undefined,
    }
    startScaleDpWorker(scope as never)
    return new ScaleDpWorkerClient({ worker: worker as never })
}

const stages = [
    { type: 'Split' },
    { type: 'Upper', id: 'upper' },
    { type: 'Faces', id: 'faces', options: { outputCol: 'faces' } },
]

describe('ScaleDpWorkerClient.run', () => {
    it('streams events and rows per page and resolves with every row', async () => {
        const updates: RowUpdate[] = []
        const run = connect().run(stages, [{ doc: 'abc', path: 'p' }], {
            pagesInFlight: 2,
            onRow: (update) => updates.push(update),
            rowUpdates: { stages: ['upper'] },
        })
        const events: PipelineEvent[] = []
        for await (const event of run) events.push(event)
        const rows = await run.result

        expect(rows.map((r) => r.upper)).toEqual(['A', 'B', 'C'])
        expect(updates.map((u) => [u.unit.page, u.row.upper])).toEqual(
            expect.arrayContaining([
                [0, 'A'],
                [1, 'B'],
                [2, 'C'],
            ])
        )
        expect(events[0]?.type).toBe('run:start')
        expect(events.at(-1)).toMatchObject({ type: 'run:end', status: 'done' })
    })

    it('disables a stage per run without loading it', async () => {
        inits.length = 0
        const client = connect()
        const rows = await client.run(stages, [{ doc: 'ab', path: 'p' }], { enabled: { faces: false } })
            .result
        expect(rows[0]).not.toHaveProperty('faces')
        expect(inits).toEqual(['Upper'])
    })

    it('cancels a running request', async () => {
        const run = connect().run(stages, [{ doc: 'abcdefghij', path: 'p' }], {
            onEvent: (event) => {
                if (event.type === 'stage:end' && event.stageId === 'upper') run.cancel()
            },
        })
        await expect(run.result).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('never posts a request cancelled while queued', async () => {
        const client = connect()
        const first = client.run(stages, [{ doc: 'ab', path: 'p' }])
        const controller = new AbortController()
        const second = client.run(stages, [{ doc: 'ab', path: 'p' }], { signal: controller.signal })
        controller.abort()

        await expect(first.result).resolves.toHaveLength(2)
        await expect(second.result).rejects.toMatchObject({ name: 'AbortError' })
    })
})
