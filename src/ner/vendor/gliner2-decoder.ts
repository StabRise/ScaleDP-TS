/** GLiNER2 span generation and decoding. Adapted from @lmoe/gliner-onnx (MIT). */

import { sigmoid } from './math.js'
import type { DecodedSpan } from './span-decoder.js'

export type WordOffset = [start: number, end: number]

/**
 * Every span up to `maxWidth` words.
 *
 * Out-of-range slots are filled with (0, 0) rather than dropped, because the
 * span axis must stay a fixed `seqLen * maxWidth` for the ONNX graph. The
 * decoder skips them by re-checking the word bounds.
 */
export function generateSpans(
    seqLen: number,
    maxWidth: number
): { spanStart: number[]; spanEnd: number[]; spanCount: number } {
    const spanStart: number[] = []
    const spanEnd: number[] = []
    for (let i = 0; i < seqLen; i++) {
        for (let j = 0; j < maxWidth; j++) {
            const inRange = i + j < seqLen
            spanStart.push(inRange ? i : 0)
            spanEnd.push(inRange ? i + j : 0)
        }
    }
    return { spanStart, spanEnd, spanCount: spanStart.length }
}

/** Sigmoid of the dot product between each span and each label embedding. */
export function computeDotProductScores(
    spanRep: Float32Array,
    labelRep: Float32Array,
    spanCount: number,
    labelCount: number,
    hiddenSize: number
): Float32Array {
    const scores = new Float32Array(spanCount * labelCount)
    for (let s = 0; s < spanCount; s++) {
        const spanOffset = s * hiddenSize
        for (let l = 0; l < labelCount; l++) {
            const labelOffset = l * hiddenSize
            let dot = 0
            for (let h = 0; h < hiddenSize; h++) {
                dot += (spanRep[spanOffset + h] as number) * (labelRep[labelOffset + h] as number)
            }
            scores[s * labelCount + l] = sigmoid(dot)
        }
    }
    return scores
}

export interface NerScoreData {
    scores: Float32Array
    wordSpanStart: number[]
    wordSpanEnd: number[]
    spanCount: number
}

/** Score matrix -> entities, then drop same-label overlaps keeping the best. */
export function decodeEntities(
    scoreData: NerScoreData,
    wordCount: number,
    labels: readonly string[],
    wordOffsets: readonly WordOffset[],
    text: string,
    threshold: number
): DecodedSpan[] {
    const { scores, wordSpanStart, wordSpanEnd, spanCount } = scoreData
    const labelCount = labels.length
    const entities: DecodedSpan[] = []

    for (let s = 0; s < spanCount; s++) {
        const startWord = wordSpanStart[s] as number
        const endWord = wordSpanEnd[s] as number
        if (startWord >= wordCount || endWord >= wordCount) continue

        for (let l = 0; l < labelCount; l++) {
            const score = scores[s * labelCount + l] as number
            if (score < threshold) continue

            const start = (wordOffsets[startWord] as WordOffset)[0]
            const end = (wordOffsets[endWord] as WordOffset)[1]
            entities.push({
                text: text.slice(start, end),
                label: labels[l] as string,
                start,
                end,
                score,
            })
        }
    }
    return deduplicateEntities(entities)
}

/**
 * Keep the highest-scoring entity among overlapping ones *of the same label*.
 * Different labels may overlap: a person name inside an organization is a
 * legitimate reading, not a conflict.
 */
function deduplicateEntities(entities: readonly DecodedSpan[]): DecodedSpan[] {
    const byScore = [...entities].sort((a, b) => b.score - a.score)
    const kept: DecodedSpan[] = []
    for (const entity of byScore) {
        const overlaps = kept.some(
            (other) => entity.label === other.label && entity.start < other.end && entity.end > other.start
        )
        if (!overlaps) kept.push(entity)
    }
    return kept.sort((a, b) => a.start - b.start)
}
