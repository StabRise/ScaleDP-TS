/**
 * GLiNER1 decoders. The span one is adapted from @lmoe/gliner-onnx (MIT).
 *
 * Two shapes of model share this file, distinguished by `span_mode` in a repo's
 * gliner_config.json, and they need different readings of `logits`:
 *
 *   markerV0 / marker  [batch, words, maxWidth, entityCount]
 *       One score per enumerated (start word, width, label) triple.
 *
 *   token_level        [batch, words, entityCount, 3]
 *       Per word and label, a start score, an end score and an "inside" score.
 *       Spans are not enumerated at all; they are assembled by pairing a start
 *       with a later end whose whole interior also scores.
 *
 * Both then run the same greedy non-maximum suppression to keep the
 * highest-scoring non-overlapping set.
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

/** Where each of the three token-level scores sits in the last axis. */
const START = 0
const END = 1
const INSIDE = 2
const TOKEN_SCORES = 3

/**
 * Token-level GLiNER decoding.
 *
 * A span runs from a word whose start score clears the threshold to a later
 * word whose end score clears it, with every word in between clearing the
 * inside score. Its score is the weakest link of the three, which is what keeps
 * a confident start from carrying an unconfident end.
 */
export function decodeTokenSpans(
    logits: ArrayLike<number>,
    params: {
        batchSize: number
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
    const wordStride = entityCount * TOKEN_SCORES
    const batchStride = inputLength * wordStride

    const at = (batchIdx: number, word: number, entity: number, which: number) =>
        sigmoid(logits[batchIdx * batchStride + word * wordStride + entity * TOKEN_SCORES + which] as number)

    const spans: DecodedSpan[][] = Array.from({ length: batchSize }, () => [])

    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
        const words = params.batchWords[batchIdx]
        if (!words) continue
        const usable = Math.min(inputLength, words.length)
        const text = params.texts[batchIdx] ?? ''

        for (let entity = 0; entity < entityCount; entity++) {
            for (let start = 0; start < usable; start++) {
                const startScore = at(batchIdx, start, entity, START)
                if (startScore < threshold) continue

                // Walk forward while the interior holds up. The moment a word
                // fails the inside score no longer span can reach past it, so
                // the scan stops rather than continuing to the width limit.
                let weakestInside = Number.POSITIVE_INFINITY
                for (let end = start; end < usable && end - start < maxWidth; end++) {
                    const inside = at(batchIdx, end, entity, INSIDE)
                    if (inside < threshold) break
                    if (inside < weakestInside) weakestInside = inside

                    const endScore = at(batchIdx, end, entity, END)
                    if (endScore < threshold) continue

                    ;(spans[batchIdx] as DecodedSpan[]).push({
                        text: text.slice((words[start] as SplitWord)[1], (words[end] as SplitWord)[2]),
                        label: params.idToClass[entity + ENTITY_ID_OFFSET] ?? '',
                        start: (words[start] as SplitWord)[1],
                        end: (words[end] as SplitWord)[2],
                        score: Math.min(startScore, endScore, weakestInside),
                    })
                }
            }
        }
    }

    return spans.map((batch) => greedySearch(batch, flatNer, multiLabel))
}
