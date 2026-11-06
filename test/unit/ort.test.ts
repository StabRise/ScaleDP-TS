/**
 * Execution-provider fallback.
 *
 * WebGPU rejects some graphs outright -- PP-OCR's recognition model fails
 * kernel resolution with `com.ms.internal.nhwc:Conv:1` -- so a session created
 * against it has to be retried on a provider that is always there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, resetConfig } from '../../src/core/config.js'
import { createSession, resetOrt, serialiseRuns, wasmFallbackProviders } from '../../src/ocr/ort.js'

/** The one call that matters: what providers each attempt asked for. */
const attempts: string[][] = []
/** Providers whose session creation should blow up, as WebGPU does here. */
let rejects: string[] = []

vi.mock('onnxruntime-web', () => ({
    env: { wasm: {}, versions: { web: '1.29.0' }, logLevel: 'error' },
    InferenceSession: {
        create: async (_bytes: unknown, options: { executionProviders: string[] }) => {
            attempts.push(options.executionProviders)
            if (options.executionProviders.some((name) => rejects.includes(name))) {
                throw new Error(
                    "Can't create a session. ERROR_CODE: 1 ... " +
                        'Failed to find op_id: com.ms.internal.nhwc:Conv:1'
                )
            }
            return { ran: options.executionProviders }
        },
    },
}))

describe('wasmFallbackProviders', () => {
    it('retries on wasm when an accelerator was preferred', () => {
        expect(wasmFallbackProviders(['webgpu', 'wasm'])).toEqual(['wasm'])
    })

    it('has nothing left to try when every provider is already a safe one', () => {
        expect(wasmFallbackProviders(['wasm'])).toBeNull()
        expect(wasmFallbackProviders(['cpu', 'wasm'])).toBeNull()
        expect(wasmFallbackProviders([])).toBeNull()
    })

    it('falls back to wasm even when the caller listed no safe provider at all', () => {
        expect(wasmFallbackProviders(['webgpu'])).toEqual(['wasm'])
        // A listed safe provider wins over the default, so ['webgpu', 'cpu']
        // retries on cpu rather than silently switching the caller to wasm.
        expect(wasmFallbackProviders(['webgpu', 'cpu'])).toEqual(['cpu'])
    })
})

describe('createSession', () => {
    beforeEach(() => {
        attempts.length = 0
        rejects = []
        resetOrt()
        resetConfig()
    })

    it('retries on wasm when the preferred provider cannot run the graph', async () => {
        configure({ executionProviders: ['webgpu', 'wasm'] })
        rejects = ['webgpu']
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        const session = await createSession(new Uint8Array([1]), { fallbackToWasm: true })

        expect(attempts).toEqual([['webgpu', 'wasm'], ['wasm']])
        expect(session).toEqual({ ran: ['wasm'] })
    })

    it('rethrows without the opt-in, so a misconfigured provider still fails loudly', async () => {
        configure({ executionProviders: ['webgpu', 'wasm'] })
        rejects = ['webgpu']

        await expect(createSession(new Uint8Array([1]))).rejects.toThrow(/com\.ms\.internal\.nhwc/)
        expect(attempts).toEqual([['webgpu', 'wasm']])
    })
})

/**
 * One run at a time per ORT instance.
 *
 * The WebGPU build fails a run that starts while another session's run is in
 * flight ("Session already started"), then fails the first one too ("Session
 * mismatch") -- so two *different* sessions must not overlap either.
 */
describe('serialiseRuns', () => {
    /** A stand-in for ORT's class: tracks how many runs overlap. */
    function fakeOrt() {
        const state = { active: 0, maxActive: 0, order: [] as string[] }
        class InferenceSession {
            constructor(readonly name: string) {}
            async run(feeds: { ms: number; fail?: boolean }): Promise<string> {
                state.active += 1
                state.maxActive = Math.max(state.maxActive, state.active)
                state.order.push(`start:${this.name}`)
                await new Promise((resolve) => setTimeout(resolve, feeds.ms))
                state.active -= 1
                state.order.push(`end:${this.name}`)
                if (feeds.fail) throw new Error(`${this.name} failed`)
                return this.name
            }
        }
        return { ort: { InferenceSession } as never, InferenceSession, state }
    }

    it('never lets two sessions run at once, and keeps arrival order', async () => {
        const { ort, InferenceSession, state } = fakeOrt()
        serialiseRuns(ort)
        const detector = new InferenceSession('dbnet')
        const classifier = new InferenceSession('orientation')

        const results = await Promise.all([
            detector.run({ ms: 20 }),
            classifier.run({ ms: 5 }),
            detector.run({ ms: 1 }),
        ])

        expect(results).toEqual(['dbnet', 'orientation', 'dbnet'])
        expect(state.maxActive).toBe(1)
        expect(state.order).toEqual([
            'start:dbnet',
            'end:dbnet',
            'start:orientation',
            'end:orientation',
            'start:dbnet',
            'end:dbnet',
        ])
    })

    it('rejects only the failed run and lets the queue behind it through', async () => {
        const { ort, InferenceSession } = fakeOrt()
        serialiseRuns(ort)
        const session = new InferenceSession('rec')

        const failed = session.run({ ms: 5, fail: true })
        const next = session.run({ ms: 1 })

        await expect(failed).rejects.toThrow('rec failed')
        await expect(next).resolves.toBe('rec')
    })

    it('wraps a prototype once, however many times it is applied', async () => {
        const { ort, InferenceSession } = fakeOrt()
        serialiseRuns(ort)
        const wrapped = InferenceSession.prototype.run
        serialiseRuns(ort)

        expect(InferenceSession.prototype.run).toBe(wrapped)
    })

    it('leaves a module without a run method alone', () => {
        const ort = { InferenceSession: { create: async () => ({}) } } as never
        expect(() => serialiseRuns(ort)).not.toThrow()
    })
})
