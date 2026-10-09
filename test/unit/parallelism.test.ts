import { describe, expect, it } from 'vitest'
import { resolveParallelism } from '../../src/core/parallelism.js'

const machine = { cores: 10, isolated: false, webgpu: false }

describe('resolveParallelism', () => {
    it('conservative is one worker, one page', () => {
        expect(resolveParallelism('conservative', machine)).toEqual({
            workers: 1,
            threadsPerWorker: 1,
            pagesInFlight: 1,
            executionProviders: ['wasm'],
        })
        expect(resolveParallelism('conservative', { ...machine, isolated: true }).threadsPerWorker).toBe(4)
    })

    it('uses workers, not threads, on a page that is not isolated', () => {
        expect(resolveParallelism('auto', machine)).toMatchObject({ workers: 4, threadsPerWorker: 1 })
        expect(resolveParallelism('auto', { ...machine, cores: 2 })).toMatchObject({ workers: 1 })
    })

    it('caps workers by memory, since each one loads every model', () => {
        expect(resolveParallelism('auto', { ...machine, deviceMemoryGb: 4 }).workers).toBe(2)
        expect(resolveParallelism('auto', { ...machine, deviceMemoryGb: 1 }).workers).toBe(1)
    })

    it('adds workers before threads, and threads only when isolated', () => {
        // The measured best on 18 cores: 4 workers x 4 threads.
        expect(resolveParallelism('auto', { cores: 18, isolated: true, webgpu: false })).toMatchObject({
            workers: 4,
            threadsPerWorker: 4,
            pagesInFlight: 1,
        })
        // 4 workers x 1 beat 1 worker x 4 at equal threads.
        expect(resolveParallelism('auto', { cores: 5, isolated: true, webgpu: false })).toMatchObject({
            workers: 4,
            threadsPerWorker: 1,
        })
        expect(resolveParallelism('auto', { cores: 10, isolated: true, webgpu: false })).toMatchObject({
            workers: 4,
            threadsPerWorker: 2,
        })
    })

    it('keeps one page in flight per worker for CPU-bound pipelines', () => {
        expect(resolveParallelism('auto', machine).pagesInFlight).toBe(1)
    })

    it('prefers one WebGPU worker with more pages in flight', () => {
        expect(resolveParallelism('auto', { ...machine, webgpu: true })).toMatchObject({
            workers: 1,
            pagesInFlight: 3,
            executionProviders: ['webgpu', 'wasm'],
        })
    })

    it('pins what a partial preset names and derives the rest', () => {
        const pinned = resolveParallelism({ workers: 2 }, { ...machine, isolated: true })
        expect(pinned).toMatchObject({ workers: 2, threadsPerWorker: 4, pagesInFlight: 1 })
        expect(resolveParallelism({ pagesInFlight: 0 }, machine).pagesInFlight).toBe(1)
    })
})
