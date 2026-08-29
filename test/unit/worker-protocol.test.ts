import { describe, expect, it, vi } from 'vitest'
import { ScaleDpWorkerClient } from '../../src/worker/client.js'
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.js'

/** A Worker stand-in that lets a test script the replies. */
function stubWorker(reply: (request: WorkerRequest) => WorkerResponse | null) {
    const worker = {
        onmessage: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
        onerror: null as ((event: { message: string }) => void) | null,
        postMessage: vi.fn((request: WorkerRequest) => {
            const response = reply(request)
            if (response) queueMicrotask(() => worker.onmessage?.({ data: response } as never))
        }),
        terminate: vi.fn(),
    }
    return worker
}

describe('ScaleDpWorkerClient', () => {
    it('correlates responses to requests by id', async () => {
        const worker = stubWorker((request) =>
            request.type === 'transform'
                ? { type: 'result', requestId: request.requestId, rows: [{ ok: true }] }
                : null
        )
        const client = new ScaleDpWorkerClient({ worker: worker as never })
        await expect(client.transform([{ type: 'X' }], [{}])).resolves.toEqual([{ ok: true }])
    })

    it('rejects on an error response', async () => {
        const worker = stubWorker((request) => ({
            type: 'error',
            requestId: request.requestId,
            message: 'model missing',
        }))
        const client = new ScaleDpWorkerClient({ worker: worker as never })
        await expect(client.transform([], [])).rejects.toThrow('model missing')
    })

    it('keeps serving requests after one fails, rather than poisoning the queue', async () => {
        let call = 0
        const worker = stubWorker((request) => {
            call++
            return call === 1
                ? { type: 'error', requestId: request.requestId, message: 'boom' }
                : { type: 'result', requestId: request.requestId, rows: [{ n: call }] }
        })
        const client = new ScaleDpWorkerClient({ worker: worker as never })

        await expect(client.transform([], [])).rejects.toThrow('boom')
        await expect(client.transform([], [])).resolves.toEqual([{ n: 2 }])
    })

    it('forwards progress and stage messages without resolving a request', async () => {
        const onProgress = vi.fn()
        const onStage = vi.fn()
        const worker = stubWorker((request) =>
            request.type === 'transform' ? { type: 'result', requestId: request.requestId, rows: [] } : null
        )
        const client = new ScaleDpWorkerClient({ worker: worker as never, onProgress, onStage })

        const pending = client.transform([], [])
        worker.onmessage?.({
            data: {
                type: 'progress',
                requestId: 1,
                progress: { repo: 'r', file: 'f', loaded: 1, total: 2, phase: 'downloading' },
            },
        } as never)
        worker.onmessage?.({ data: { type: 'stage', requestId: 1, name: 'S', ms: 5, rows: 1 } } as never)

        await pending
        expect(onProgress).toHaveBeenCalledOnce()
        expect(onStage).toHaveBeenCalledWith('S', 5, 1)
    })

    it('rejects everything in flight when the worker itself errors', async () => {
        const worker = stubWorker(() => null)
        const client = new ScaleDpWorkerClient({ worker: worker as never })
        const pending = client.transform([], [])
        // Requests are posted from inside the queue, so let it drain first.
        await Promise.resolve()
        worker.onerror?.({ message: 'worker died' })
        await expect(pending).rejects.toThrow('worker died')
    })

    it('rejects requests queued behind a worker failure instead of hanging', async () => {
        const worker = stubWorker(() => null)
        const client = new ScaleDpWorkerClient({ worker: worker as never })
        worker.onerror?.({ message: 'worker died' })
        await expect(client.transform([], [])).rejects.toThrow('worker died')
    })

    it('terminates the worker on dispose', async () => {
        const worker = stubWorker((request) => ({ type: 'disposed', requestId: request.requestId }))
        const client = new ScaleDpWorkerClient({ worker: worker as never })
        await client.dispose()
        expect(worker.terminate).toHaveBeenCalledOnce()
    })
})
