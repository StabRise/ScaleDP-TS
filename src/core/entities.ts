/**
 * Engine-free helpers for working with entities over a document's text.
 *
 * These live in core rather than in `src/ner` because both the GLiNER stage and
 * the engine-free `NerConsistency` stage need them, and importing anything from
 * `src/ner/gliner-ner.ts` would drag the ONNX backends and the tokenizer into
 * the root bundle.
 */

import type { Box } from '../schemas/box.js'

/**
 * The first occurrence of `needle` at or after `from` whose whole range is
 * still unclaimed in `mapping`, or -1.
 */
function findUnclaimed(text: string, mapping: Int32Array, needle: string, from: number): number {
    for (let at = text.indexOf(needle, from); at !== -1; at = text.indexOf(needle, at + 1)) {
        let free = true
        for (let i = at; i < at + needle.length; i++) {
            if (mapping[i] !== -1) {
                free = false
                break
            }
        }
        if (free) return at
    }
    return -1
}

/**
 * Map each character of the joined document text to the box it came from.
 *
 * Built from the *actual* text the OCR stage produced rather than assuming one
 * separator per box. Python derives the mapping from `len(box.text) + 1`, which
 * silently drifts whenever `keepFormatting` inserted several spaces or a
 * newline, shifting every entity's boxes after the first wide gap.
 *
 * The search runs forward from the last match first, because that is the cheap
 * case and it keeps repeated strings -- the same email in a header and a footer
 * -- matched to the box that actually produced each one. But it must not stop
 * there: `boxesToFormattedText` emits boxes in reading order (clustered by y,
 * then sorted by x) while `bboxes` keeps the detector's order, so a box whose
 * text sits earlier in the page is routinely behind the cursor. Giving up on it
 * left the entity with no boxes at all -- found in the text, invisible on the
 * image -- so an unclaimed occurrence anywhere is better than none.
 */
export function buildCharToBoxMap(text: string, boxes: readonly Box[]): Int32Array {
    const mapping = new Int32Array(text.length).fill(-1)
    let cursor = 0

    for (const [index, box] of boxes.entries()) {
        if (box.text.length === 0) continue
        let found = findUnclaimed(text, mapping, box.text, cursor)
        if (found === -1 && cursor > 0) found = findUnclaimed(text, mapping, box.text, 0)
        if (found === -1) continue
        mapping.fill(index, found, found + box.text.length)
        cursor = found + box.text.length
    }
    return mapping
}

/** Boxes a character range touches, in document order and without repeats. */
export function boxesForRange(mapping: Int32Array, boxes: readonly Box[], start: number, end: number): Box[] {
    const seen = new Set<number>()
    const out: Box[] = []
    for (let i = Math.max(0, start); i < Math.min(end, mapping.length); i++) {
        const index = mapping[i] as number
        if (index < 0 || seen.has(index)) continue
        seen.add(index)
        const box = boxes[index]
        if (box) out.push(box)
    }
    return out
}

/** A folded copy of some text, with every folded index mapped back to the original. */
export interface FoldedText {
    /** Lower-cased, with every run of whitespace collapsed to a single space. */
    folded: string
    /** `offsets[i]` is the index in the source text that `folded[i]` came from. */
    offsets: number[]
}

/**
 * Fold text for case- and whitespace-insensitive matching.
 *
 * Collapsing whitespace is what lets a name broken across an OCR line break
 * match the same name written inline. The offsets are what let a match be
 * reported against the *original* text, so entity spans and box lookups stay
 * valid.
 *
 * Lower-casing is done per character, not with a single `text.toLowerCase()`,
 * because it is not length-preserving -- 'İ' lowers to two characters. Each
 * character the lowered form produced records the same source index, so the map
 * stays aligned where a blanket call would shift every offset after it.
 */
export function foldForMatching(text: string): FoldedText {
    let folded = ''
    const offsets: number[] = []
    let pendingSpace = false

    for (let i = 0; i < text.length; i++) {
        const char = text[i] as string
        if (/\s/u.test(char)) {
            // Leading whitespace is dropped entirely; an inner run becomes one
            // space, emitted only once a non-space character follows it.
            if (folded.length > 0) pendingSpace = true
            continue
        }
        if (pendingSpace) {
            folded += ' '
            offsets.push(i)
            pendingSpace = false
        }
        const lowered = char.toLowerCase()
        folded += lowered
        for (let k = 0; k < lowered.length; k++) offsets.push(i)
    }
    return { folded, offsets }
}

/** True when the character is one a word can be made of. */
function isWordChar(char: string | undefined): boolean {
    return char !== undefined && /[\p{L}\p{N}]/u.test(char)
}

/** A half-open span in folded coordinates. */
export interface FoldedSpan {
    start: number
    end: number
}

/**
 * Every whole-word occurrence of `phrase` in `folded`.
 *
 * Both sides must already be folded by `foldForMatching`. The word-boundary
 * test is what keeps "Ann" from matching inside "Announcement".
 */
export function findWholeWordOccurrences(folded: string, phrase: string): FoldedSpan[] {
    if (phrase.length === 0) return []

    const spans: FoldedSpan[] = []
    let from = 0
    for (;;) {
        const start = folded.indexOf(phrase, from)
        if (start === -1) break
        const end = start + phrase.length
        // Only a boundary on a *word* character matters: a phrase starting with
        // punctuation is already delimited by it.
        const openBoundary = !isWordChar(phrase[0]) || !isWordChar(folded[start - 1])
        const closeBoundary = !isWordChar(phrase[phrase.length - 1]) || !isWordChar(folded[end])
        if (openBoundary && closeBoundary) spans.push({ start, end })
        from = start + 1
    }
    return spans
}
