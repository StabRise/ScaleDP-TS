/** Numeric helpers for the GLiNER runtimes. Adapted from @lmoe/gliner-onnx (MIT). */

/** Numerically stable sigmoid: exp(-x) overflows for large negative x. */
export function sigmoid(x: number): number {
    if (x >= 0) return 1 / (1 + Math.exp(-x))
    const expX = Math.exp(x)
    return expX / (1 + expX)
}

export function softmax(values: ArrayLike<number>): Float32Array {
    let max = Number.NEGATIVE_INFINITY
    for (let i = 0; i < values.length; i++) {
        const v = values[i] as number
        if (v > max) max = v
    }
    const out = new Float32Array(values.length)
    let sum = 0
    for (let i = 0; i < values.length; i++) {
        const e = Math.exp((values[i] as number) - max)
        out[i] = e
        sum += e
    }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / sum
    return out
}

/** Gather rows out of a flat [n, hiddenSize] matrix. */
export function gatherRows(
    source: Float32Array,
    positions: readonly number[],
    hiddenSize: number
): Float32Array {
    const out = new Float32Array(positions.length * hiddenSize)
    for (let i = 0; i < positions.length; i++) {
        const from = (positions[i] as number) * hiddenSize
        out.set(source.subarray(from, from + hiddenSize), i * hiddenSize)
    }
    return out
}

/** Contiguous row slice of a flat [n, hiddenSize] matrix. */
export function sliceRows(
    source: Float32Array,
    startRow: number,
    rowCount: number,
    hiddenSize: number
): Float32Array {
    const from = startRow * hiddenSize
    return source.slice(from, from + rowCount * hiddenSize)
}

/** Token ids from a transformers.js `tolist()` result, flattened and de-bigint'd. */
export function extractTokenIds(tolistResult: (bigint | number)[][] | (bigint | number)[]): number[] {
    const flat = Array.isArray(tolistResult[0])
        ? (tolistResult as (bigint | number)[][]).flat()
        : (tolistResult as (bigint | number)[])
    return flat.map((v) => (typeof v === 'bigint' ? Number(v) : v))
}
