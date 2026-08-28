/**
 * GLiNER1 span decoder. Adapted from @lmoe/gliner-onnx (MIT).
 *
 * The model emits logits shaped [batch, seqLen, maxWidth, entityCount]. Every
 * (start word, width, label) triple above threshold becomes a candidate span;
 * greedy non-maximum suppression then keeps the highest-scoring
 * non-overlapping set.
 */

import { sigmoid } from './math.js'
import type { SplitWord } from './splitter.js'

export interface DecodedSpan {
    text: string
    label: string
    start: number
    end: number
    score: number
}

export interface DecodeOptions {
    threshold?: number
    /** Flat NER forbids nesting; set false to allow a span inside another. */
    flatNer?: boolean
    /** Allow the same span to carry more than one label. */
    multiLabel?: boolean
}

/** Model class ids are 1-based; index 0 is reserved. */
const ENTITY_ID_OFFSET = 1

function spansOverlap(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
    allowNested: boolean,
    allowMultiLabel: boolean
): boolean {
    // Identical spans collide unless multi-label output is wanted.
    if (aStart === bStart && aEnd === bEnd) return !allowMultiLabel
    if (aStart > bEnd || bStart > aEnd) return false
    if (allowNested) {
        const nested = (aStart <= bStart && aEnd >= bEnd) || (bStart <= aStart && bEnd >= aEnd)
        if (nested) return false
    }
    return true
}

/** Keep the highest-scoring spans that do not collide. */
function greedySearch(spans: DecodedSpan[], flatNer: boolean, multiLabel: boolean): DecodedSpan[] {
    const byScore = [...spans].sort((a, b) => b.score - a.score)
    const kept: DecodedSpan[] = []
    for (const span of byScore) {
        const collides = kept.some((other) =>
            spansOverlap(span.start, span.end, other.start, other.end, !flatNer, multiLabel)
        )
        if (!collides) kept.push(span)
    }
    return kept.sort((a, b) => a.start - b.start)
}

export function decodeSpans(
    logits: ArrayLike<number>,
    params: {
        batchSize: number
        /** Words per sequence, i.e. the model's span-start axis. */
        inputLength: number
        maxWidth: number
        entityCount: number
        texts: readonly string[]
        batchWords: readonly SplitWord[][]
        idToClass: Record<number, string>
    },
    options: DecodeOptions = {}
): DecodedSpan[][] {
    const threshold = options.threshold ?? 0.5
    const flatNer = options.flatNer ?? true
    const multiLabel = options.multiLabel ?? false

    const { batchSize, inputLength, maxWidth, entityCount } = params
    const batchStride = inputLength * maxWidth * entityCount
    const tokenStride = maxWidth * entityCount

    const spans: DecodedSpan[][] = Array.from({ length: batchSize }, () => [])

    for (let index = 0; index < logits.length; index++) {
        const score = sigmoid(logits[index] as number)
        if (score < threshold) continue

        const batchIdx = Math.floor(index / batchStride)
        const startWord = Math.floor(index / tokenStride) % inputLength
        const endWord = startWord + (Math.floor(index / entityCount) % maxWidth)
        const entityIdx = index % entityCount

        const words = params.batchWords[batchIdx]
        if (!words || startWord >= words.length || endWord >= words.length) continue

        const start = (words[startWord] as SplitWord)[1]
        const end = (words[endWord] as SplitWord)[2]
        const text = params.texts[batchIdx] ?? ''

        ;(spans[batchIdx] as DecodedSpan[]).push({
            text: text.slice(start, end),
            label: params.idToClass[entityIdx + ENTITY_ID_OFFSET] ?? '',
            start,
            end,
            score,
        })
    }

    return spans.map((batch) => greedySearch(batch, flatNer, multiLabel))
}
