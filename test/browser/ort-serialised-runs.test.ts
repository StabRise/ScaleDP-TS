/**
 * Concurrent inference on the real onnxruntime-web WebGPU build.
 *
 * Its JSEP glue holds one "run in progress" slot per wasm instance, so two
 * sessions running at once used to fail with "Session already started" and
 * "Session mismatch" -- DBNet on one page colliding with PaddleOCR's
 * line-orientation model on another. `loadOrt()` queues runs to prevent it.
 *
 * The model is a single `Add` (y = x + x) encoded by hand, so the test needs
 * no download.
 */
import { describe, expect, it } from 'vitest'
import { createSession, loadOrt } from '../../src/ocr/ort.js'

const SIZE = 1 << 16

/** Protobuf varint. */
function varint(value: number): number[] {
    const out: number[] = []
    let v = value
    while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80)
        v = Math.floor(v / 128)
    }
    out.push(v)
    return out
}

const field = {
    varint: (n: number, value: number) => [...varint((n << 3) | 0), ...varint(value)],
    bytes: (n: number, payload: number[]) => [...varint((n << 3) | 2), ...varint(payload.length), ...payload],
    string: (n: number, text: string) => field.bytes(n, [...new TextEncoder().encode(text)]),
}

/** A float tensor value info of shape [SIZE]. */
function valueInfo(name: string): number[] {
    const shape = field.bytes(2, field.bytes(1, field.varint(1, SIZE)))
    const tensorType = field.bytes(1, [...field.varint(1, 1), ...shape])
    return [...field.string(1, name), ...field.bytes(2, tensorType)]
}

function addModel(): Uint8Array {
    const node = [
        ...field.string(1, 'x'),
        ...field.string(1, 'x'),
        ...field.string(2, 'y'),
        ...field.string(4, 'Add'),
    ]
    const graph = [
        ...field.bytes(1, node),
        ...field.string(2, 'g'),
        ...field.bytes(11, valueInfo('x')),
        ...field.bytes(12, valueInfo('y')),
    ]
    const opset = [...field.string(1, ''), ...field.varint(2, 13)]
    return new Uint8Array([...field.varint(1, 7), ...field.bytes(8, opset), ...field.bytes(7, graph)])
}

describe('serialised ORT runs on WebGPU', () => {
    it('runs two sessions concurrently without a session collision', async () => {
        const hasWebGpu = Boolean(
            await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter()
        )
        if (!hasWebGpu) {
            console.warn('No WebGPU adapter in this browser; skipping.')
            return
        }

        const ort = await loadOrt()
        const sessions = await Promise.all([
            createSession(addModel(), { executionProviders: ['webgpu'] }),
            createSession(addModel(), { executionProviders: ['webgpu'] }),
        ])
        const input = new ort.Tensor('float32', new Float32Array(SIZE).fill(1.5), [SIZE])

        // A collision can also leave a run that never settles, so each one is
        // raced against a deadline: a regression fails here instead of hanging.
        const deadline = () =>
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('run never settled')), 15_000)
            )
        const runs = Array.from({ length: 12 }, (_, i) =>
            Promise.race([(sessions[i % 2] as (typeof sessions)[0]).run({ x: input }), deadline()])
        )
        const results = await Promise.allSettled(runs)

        const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []))
        expect(failures).toEqual([])
        for (const r of results) {
            const y = (r as PromiseFulfilledResult<Record<string, { data: Float32Array }>>).value.y
            expect(y?.data[0]).toBe(3)
        }
        await Promise.all(sessions.map((s) => s.release()))
    }, 60_000)
})
