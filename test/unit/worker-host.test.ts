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
import { registerStages, startScaleDpWorker } from '../../src/worker/host.js'
import type {
    StageDescriptor,
    WorkerRequest,
    WorkerRequestInit,
    WorkerResponse,
} from '../../src/worker/protocol.js'

const counts = { built: 0, disposed: 0, applied: 0 }

class Probe extends Stage {
    readonly name = 'Probe'

    constructor(options?: Record<string, unknown>) {
        super({ ...BASE_STAGE_DEFAULTS, ...options })
        counts.built += 1
    }

    protected async apply(): Promise<unknown> {
        counts.applied += 1
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

registerStages({ Probe: Probe as never })

/** A DedicatedWorkerGlobalScope stand-in, driving the host directly. */
function stubScope() {
    let nextId = 1
    const settled = new Map<number, (message: WorkerResponse) => void>()

    const scope = {
        onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
        postMessage(message: WorkerResponse) {
            if ('requestId' in message && message.type !== 'progress' && message.type !== 'stage') {
                settled.get(message.requestId)?.(message)
            }
        },
    }

    startScaleDpWorker(scope as never)

    const send = (request: WorkerRequestInit) =>
        new Promise<WorkerResponse>((resolve) => {
            const requestId = nextId++
            settled.set(requestId, resolve)
            scope.onmessage?.({ data: { ...request, requestId } } as never)
        })

    return { send }
}

const stages = (outputCol: string): StageDescriptor[] => [{ type: 'Probe', options: { outputCol } }]

beforeEach(() => {
    counts.built = 0
    counts.disposed = 0
    counts.applied = 0
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

    it('rebuilds and disposes when the stages change', async () => {
        const { send } = stubScope()

        await send({ type: 'transform', stages: stages('a'), rows: [{}] })
        await send({ type: 'transform', stages: stages('b'), rows: [{}] })

        expect(counts.built).toBe(2)
        // The superseded pipeline's sessions are released, not leaked.
        expect(counts.disposed).toBe(1)
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
