/**
 * Long-text chunking and entity de-duplication for NER.
 *
 * Mirrors `Ner.split_text` in Python ScaleDP: fixed-length character windows
 * with a small overlap, offsets rebased onto the original text.
 *
 * Python has no cross-chunk de-duplication, so any entity landing in the
 * overlap is reported twice. That is fixed here.
 */

import type { DecodedSpan } from './vendor/span-decoder.js'

/** Python's `split_text` default, and what the cloud /ner/text endpoint uses. */
export const DEFAULT_CHUNK_LENGTH = 500
/** 500 - 480 leaves a 20-character overlap so entities on a seam survive. */
export const DEFAULT_CHUNK_STRIDE = 480

export interface Chunk {
    text: string
    /** Character offset of this chunk within the original text. */
    offset: number
}

export function chunkText(
    text: string,
    maxLength = DEFAULT_CHUNK_LENGTH,
    stride = DEFAULT_CHUNK_STRIDE
): Chunk[] {
    if (stride <= 0) throw new RangeError(`stride must be positive, received ${stride}`)
    if (maxLength <= 0) throw new RangeError(`maxLength must be positive, received ${maxLength}`)
    if (text.length === 0) return []
    if (text.length <= maxLength) return [{ text, offset: 0 }]

    const chunks: Chunk[] = []
    for (let offset = 0; offset < text.length; offset += stride) {
        const slice = text.slice(offset, offset + maxLength)
        chunks.push({ text: slice, offset })
        // A short slice means the end of the text; stop rather than emit
        // ever-shorter tails.
        if (slice.length < maxLength) break
    }
    return chunks
}

/** Shift a chunk-local span onto the original text's coordinates. */
export function rebaseSpan(span: DecodedSpan, offset: number): DecodedSpan {
    return { ...span, start: span.start + offset, end: span.end + offset }
}

/**
 * Drop duplicates produced by the chunk overlap, keeping the highest score for
 * each distinct (start, end, label).
 */
export function dedupeSpans(spans: readonly DecodedSpan[]): DecodedSpan[] {
    const best = new Map<string, DecodedSpan>()
    for (const span of spans) {
        const key = `${span.start}:${span.end}:${span.label}`
        const existing = best.get(key)
        if (!existing || span.score > existing.score) best.set(key, span)
    }
    return [...best.values()].sort((a, b) => a.start - b.start)
}

/** Ratio of uppercase to cased letters. */
function uppercaseRatio(text: string): number {
    let upper = 0
    let lower = 0
    for (const char of text) {
        if (char >= 'A' && char <= 'Z') upper++
        else if (char >= 'a' && char <= 'z') lower++
        else if (char !== char.toLowerCase()) upper++
        else if (char !== char.toUpperCase()) lower++
    }
    return upper + lower === 0 ? 0 : upper / (upper + lower)
}

export const ALL_CAPS_RATIO = 0.6

export function isMostlyUppercase(text: string): boolean {
    return uppercaseRatio(text) > ALL_CAPS_RATIO
}

/**
 * Title-case runs of capitals, preserving length.
 *
 * GLiNER1 models are cased and scanned documents are frequently set in all
 * caps, which reads to the model as unlike anything in training. Length
 * preservation is essential: every character offset the decoder returns is used
 * to index the original text.
 */
export function titleCaseAllCapsWords(text: string): string {
    return text.replace(/\p{Lu}[\p{Lu}\p{N}'’-]*\p{Lu}/gu, (word) => {
        const titled = (word[0] as string) + word.slice(1).toLowerCase()
        return titled.length === word.length ? titled : word
    })
}

/** Apply the casing fix only when the text is predominantly uppercase. */
export function normaliseCasing(text: string): string {
    return isMostlyUppercase(text) ? titleCaseAllCapsWords(text) : text
}
