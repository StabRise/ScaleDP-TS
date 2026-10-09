/**
 * The host reuses its pipeline across transforms.
 *
 * Rebuilding per request is invisible from the outside and expensive: every
 * stage that owns an ONNX session creates it in `init()`, so a host driven one
 * page at a time -- the normal way to stream results -- built a new session for
 * every page. The only symptom is slowness, so it is pinned here.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { BASE_STAGE_DEFAULTS } from '../../src/core/params.js'
import { Stage } from '../../src/core/pipeline.js'
import { registerStages, type ScaleDpWorkerHostOptions, startScaleDpWorker } from '../../src/worker/host.js'
import type {
    StageDescriptor,
    WorkerRequest,
    WorkerRequestInit,
    WorkerResponse,
} from '../../src/worker/protocol.js'

const counts = { built: 0, disposed: 0, applied: 0 }

/** Buffers each run was handed, so identity across transforms is observable. */
const seenContent: unknown[] = []

class Probe extends Stage {
    readonly name = 'Probe'

    constructor(options?: Record<string, unknown>) {
        super({ ...BASE_STAGE_DEFAULTS, ...options })
        counts.built += 1
    }

    protected async apply(_input: unknown, row: { content?: unknown }): Promise<unknown> {
        counts.applied += 1
        seenContent.push(row.content)
        if (this.params.outputCol === 'boom') throw new Error('probe exploded')
        return { ok: true }
    }

    protected onError(message: string): unknown {
        return { exception: message }
    }

    override async dispose(): Promise<void> {
        counts.disposed += 1
    }
}

/** Slow, so a run can be caught in flight. */
class Sleepy extends Stage {
    readonly name = 'Sleepy'
    constructor(options?: Record<string, unknown>) {
        super({ ...BASE_STAGE_DEFAULTS, outputCol: 'slept', ...options })
    }
    protected async apply(): Promise<unknown> {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { image: { data: new Uint8Array(32) } }
    }
    protected onError(message: string): unknown {
        return { exception: message }
    }
}

registerStages({ Probe: Probe as never, Sleepy: Sleepy as never })

/** A DedicatedWorkerGlobalScope stand-in, driving the host directly. */
function stubScope(options: ScaleDpWorkerHostOptions = {}) {
    let nextId = 1
    const settled = new Map<number, (message: WorkerResponse) => void>()
    const streamed: WorkerResponse[] = []
    const streaming = new Set(['progress', 'stage', 'event', 'row'])

    const scope = {
        onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
        postMessage(message: WorkerResponse) {
            if (streaming.has(message.type)) {
                streamed.push(message)
                return
            }
            settled.get(message.requestId)?.(message)
        },
    }

    startScaleDpWorker(scope as never, options)

    const post = (request: WorkerRequestInit) => {
        const requestId = nextId++
        const done = new Promise<WorkerResponse>((resolve) => settled.set(requestId, resolve))
        scope.onmessage?.({ data: { ...request, requestId } } as never)
        return { requestId, done }
    }
    const send = (request: WorkerRequestInit) => post(request).done

    return { send, post, streamed }
}

const stages = (outputCol: string): StageDescriptor[] => [{ type: 'Probe', options: { outputCol } }]

beforeEach(() => {
    counts.built = 0
    counts.disposed = 0
    counts.applied = 0
    seenContent.length = 0
})

describe('startScaleDpWorker', () => {
    it('builds the pipeline once for repeated identical transforms', async () => {
        const { send } = stubScope()
        const same = stages('a')

        await send({ type: 'transform', stages: same, rows: [{}] })
        await send({ type: 'transform', stages: same, rows: [{}] })
        await send({ type: 'transform', stages: same, rows: [{}] })

        // Three pages, one session. Before this it was three of each.
        expect(counts.built).toBe(1)
        expect(counts.applied).toBe(3)
        expect(counts.disposed).toBe(0)
    })

    it('rebuilds only the stage whose options changed, and keeps the other cached', async () => {
        const { send } = stubScope()

        await send({ type: 'transform', stages: stages('a'), rows: [{}] })
        await send({ type: 'transform', stages: stages('b'), rows: [{}] })
        await send({ type: 'transform', stages: stages('a'), rows: [{}] })

        // Switching back to `a` finds its instance -- and its session -- alive.
        expect(counts.built).toBe(2)
        expect(counts.disposed).toBe(0)
    })

    it('disposes stages it evicts past the cache limit', async () => {
        const { send } = stubScope({ maxCachedStages: 2 })
        for (const col of ['a', 'b', 'c']) {
            await send({ type: 'transform', stages: stages(col), rows: [{}] })
        }
        expect(counts.built).toBe(3)
        expect(counts.disposed).toBe(1)
    })

    it('reuses instances when only id, enabled, when or barrier change', async () => {
        const { send } = stubScope()
        const variants: StageDescriptor[][] = [
            [{ type: 'Probe', options: { outputCol: 'a' } }],
            [{ type: 'Probe', options: { outputCol: 'a' }, id: 'probe' }],
            [{ type: 'Probe', options: { outputCol: 'a' }, enabled: false }],
            [{ type: 'Probe', options: { outputCol: 'a' }, when: { path: 'x', exists: false } }],
            [{ type: 'Probe', options: { outputCol: 'a' }, barrier: true }],
        ]
        for (const variant of variants) await send({ type: 'run', stages: variant, rows: [{}] })
        expect(counts.built).toBe(1)
    })

    it('releases the pipeline on dispose', async () => {
        const { send } = stubScope()

        await send({ type: 'transform', stages: stages('a'), rows: [{}] })
        await send({ type: 'dispose' })

        expect(counts.disposed).toBe(1)

        // And a transform after a dispose gets a fresh pipeline rather than a
        // disposed one.
        await send({ type: 'transform', stages: stages('a'), rows: [{}] })
        expect(counts.built).toBe(2)
    })

    it('does not reuse a pipeline whose run threw', async () => {
        const { send } = stubScope()
        // `propagateError` opts out of the never-throw contract, so this failure
        // reaches the host's own catch.
        const exploding: StageDescriptor[] = [
            { type: 'Probe', options: { outputCol: 'boom', propagateError: true } },
        ]

        const failed = await send({ type: 'transform', stages: exploding, rows: [{}] })
        expect(failed.type).toBe('error')

        await send({ type: 'transform', stages: exploding, rows: [{}] })

        // Rebuilt rather than reusing a pipeline left in an unknown state.
        expect(counts.built).toBe(2)
    })
})

describe('content handles', () => {
    it('hands every transform the same buffer object', async () => {
        const { send } = stubScope()
        const bytes = new Uint8Array([1, 2, 3, 4])
        await send({ type: 'putContent', key: 'doc-1', content: bytes })

        // Three pipelines over one file, as reading text, finding images and
        // rendering a page would be.
        for (const col of ['a', 'b', 'c']) {
            await send({ type: 'transform', stages: stages(col), rows: [{ contentRef: 'doc-1' }] })
        }

        expect(seenContent).toHaveLength(3)
        // Identity, not equality: the document cache keys on it, so a fresh
        // copy per transform would miss and pdf.js would re-parse each time.
        expect(seenContent[0]).toBe(bytes)
        expect(seenContent[1]).toBe(bytes)
        expect(seenContent[2]).toBe(bytes)
    })

    it('leaves a row carrying its own content alone', async () => {
        const { send } = stubScope()
        const inline = new Uint8Array([9])
        await send({ type: 'transform', stages: stages('a'), rows: [{ content: inline }] })
        expect(seenContent[0]).toBe(inline)
    })

    it('fails loudly on an unregistered key', async () => {
        const { send } = stubScope()
        const response = await send({
            type: 'transform',
            stages: stages('a'),
            rows: [{ contentRef: 'never-registered' }],
        })
        expect(response.type).toBe('error')
        expect((response as { message: string }).message).toMatch(/putContent/)
    })

    it('releases content on dropContent and on dispose', async () => {
        const { send } = stubScope()
        await send({ type: 'putContent', key: 'doc-1', content: new Uint8Array([1]) })
        await send({ type: 'dropContent', key: 'doc-1' })

        const afterDrop = await send({
            type: 'transform',
            stages: stages('a'),
            rows: [{ contentRef: 'doc-1' }],
        })
        expect(afterDrop.type).toBe('error')

        await send({ type: 'putContent', key: 'doc-2', content: new Uint8Array([2]) })
        await send({ type: 'dispose' })
        const afterDispose = await send({
            type: 'transform',
            stages: stages('a'),
            rows: [{ contentRef: 'doc-2' }],
        })
        expect(afterDispose.type).toBe('error')
    })
})

describe('streaming runs', () => {
    it('posts events and row updates, stripping binary data by default', async () => {
        const { send, streamed } = stubScope()
        const result = await send({
            type: 'run',
            stages: [{ type: 'Sleepy', id: 'sleep' }],
            rows: [{ path: 'p' }],
        })
        expect(result.type).toBe('result')

        const events = streamed
            .filter((m) => m.type === 'event')
            .map((m) => (m as { event: { type: string } }).event)
        expect(events[0]?.type).toBe('run:start')
        expect(events.at(-1)?.type).toBe('run:end')

        const rows = streamed.filter((m) => m.type === 'row')
        expect(rows).toHaveLength(1)
        expect((rows[0] as { update: { row: unknown } }).update.row).toEqual({
            slept: { image: { data: { bytes: 32 } } },
            path: 'p',
        })
    })

    it('cancels a running request without waiting behind it', async () => {
        const { post } = stubScope()
        const run = post({ type: 'run', stages: [{ type: 'Sleepy' }], rows: [{}, {}, {}, {}] })
        await new Promise((resolve) => setTimeout(resolve, 5))
        post({ type: 'cancel', target: run.requestId })

        const response = await run.done
        expect(response).toMatchObject({ type: 'error', aborted: true })
    })

    it('cancels a request still queued behind another', async () => {
        const { post } = stubScope()
        const first = post({ type: 'run', stages: [{ type: 'Sleepy' }], rows: [{}] })
        const second = post({ type: 'run', stages: [{ type: 'Sleepy' }], rows: [{}] })
        post({ type: 'cancel', target: second.requestId })

        expect((await first.done).type).toBe('result')
        expect(await second.done).toMatchObject({ type: 'error', aborted: true })
    })

    it('reports the environment it runs in on configure', async () => {
        const { send } = stubScope()
        const response = await send({ type: 'configure', config: {} })
        expect(response).toMatchObject({
            type: 'configured',
            environment: { numThreads: expect.any(Number), crossOriginIsolated: expect.any(Boolean) },
        })
    })
})
