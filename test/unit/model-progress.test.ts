import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, type ModelProgress, resetConfig } from '../../src/core/config.js'
import { ensureModelFiles, LazyLoad, ProgressHub } from '../../src/core/model-cache.js'

afterEach(() => {
    vi.unstubAllGlobals()
    resetConfig()
})

function stubFetch(bytes = 8, delay = 5) {
    const fetch = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes) } })
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
}

describe('ensureModelFiles', () => {
    it('shares one download between concurrent callers, and both hear its progress', async () => {
        const fetch = stubFetch()
        configure({ cache: 'none' })
        const spec = { repo: 'r/shared', files: [{ path: 'model.onnx', approxBytes: 8 }] }

        const first: ModelProgress[] = []
        const second: ModelProgress[] = []
        const [a, b] = await Promise.all([
            ensureModelFiles(spec, { onProgress: (p) => first.push(p) }),
            ensureModelFiles(spec, { onProgress: (p) => second.push(p) }),
        ])

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(a['model.onnx']?.byteLength).toBe(8)
        expect(b['model.onnx']).toBe(a['model.onnx'])
        expect(first.map((p) => p.phase)).toEqual(['downloading', 'ready'])
        expect(second.map((p) => p.phase)).toEqual(['downloading', 'ready'])
    })

    it('reports to the global callback once per event, not once per waiter', async () => {
        stubFetch()
        const global: ModelProgress[] = []
        configure({ cache: 'none', onProgress: (p) => global.push(p) })
        const spec = { repo: 'r/global', files: [{ path: 'model.onnx', approxBytes: 8 }] }
        await Promise.all([ensureModelFiles(spec), ensureModelFiles(spec)])
        expect(global.map((p) => p.phase)).toEqual(['downloading', 'ready'])
    })

    it('ends with initializing for a caller about to build a session', async () => {
        stubFetch()
        configure({ cache: 'none' })
        const phases: string[] = []
        await ensureModelFiles(
            { repo: 'r/build', files: [{ path: 'model.onnx', approxBytes: 8 }] },
            { building: true, onProgress: (p) => phases.push(p.phase) }
        )
        expect(phases.at(-1)).toBe('initializing')
    })

    it('stops waiting on abort without cancelling the shared download', async () => {
        const fetch = stubFetch(8, 20)
        configure({ cache: 'none' })
        const spec = { repo: 'r/abort', files: [{ path: 'model.onnx', approxBytes: 8 }] }
        const controller = new AbortController()

        const abandoned = ensureModelFiles(spec, { signal: controller.signal })
        const kept = ensureModelFiles(spec)
        controller.abort()

        await expect(abandoned).rejects.toThrow()
        expect((await kept)['model.onnx']?.byteLength).toBe(8)
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('still accepts a bare AbortSignal', async () => {
        stubFetch()
        configure({ cache: 'none' })
        const files = await ensureModelFiles(
            { repo: 'r/signal', files: [{ path: 'm', approxBytes: 8 }] },
            new AbortController().signal
        )
        expect(files.m?.byteLength).toBe(8)
    })
})

describe('LazyLoad', () => {
    it('loads once, tells a late waiter it is ready, and retries after a failure', async () => {
        const load = new LazyLoad<string>(() => 'repo')
        let attempts = 0
        const loader = async () => {
            attempts += 1
            if (attempts === 1) throw new Error('flaky')
            return 'session'
        }

        await expect(load.get(loader)).rejects.toThrow('flaky')
        expect(await load.get(loader)).toBe('session')
        expect(await load.get(loader)).toBe('session')
        expect(attempts).toBe(2)

        const late: string[] = []
        await load.get(loader, (p) => late.push(p.phase))
        expect(late).toEqual(['ready'])
    })

    it('forwards progress to every waiter of an in-flight load', async () => {
        const load = new LazyLoad<number>(() => 'repo')
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const a: string[] = []
        const b: string[] = []
        const loader = async (emit: (p: ModelProgress) => void) => {
            emit({ repo: 'repo', file: 'f', loaded: 1, total: 2, phase: 'downloading' })
            await gate
            return 1
        }
        const first = load.get(loader, (p) => a.push(p.phase))
        const second = load.get(loader, (p) => b.push(p.phase))
        release()
        await Promise.all([first, second])
        expect(a).toEqual(['downloading', 'ready'])
        expect(b).toEqual(['downloading', 'ready'])
    })
})

describe('ProgressHub', () => {
    it('drops a listener once its promise settles', async () => {
        const hub = new ProgressHub()
        const heard: string[] = []
        const done = Promise.resolve(1)
        await hub.follow('k', done, (p) => heard.push(p.file))
        hub.emitter('k')({ repo: 'r', file: 'after', loaded: 0, total: 0, phase: 'downloading' })
        expect(heard).toEqual([])
    })
})
