/**
 * Execution-provider fallback.
 *
 * WebGPU rejects some graphs outright -- PP-OCR's recognition model fails
 * kernel resolution with `com.ms.internal.nhwc:Conv:1` -- so a session created
 * against it has to be retried on a provider that is always there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, resetConfig } from '../../src/core/config.js'
import { createSession, resetOrt, wasmFallbackProviders } from '../../src/ocr/ort.js'

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
