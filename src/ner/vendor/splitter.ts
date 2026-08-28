/** Word splitting for GLiNER. Adapted from @lmoe/gliner-onnx (MIT). */

/**
 * Unicode word classes (`\p{L}\p{N}` with the `u` flag), deliberately not `\w`.
 *
 * JavaScript's `\w` is ASCII-only even under `/u`, so it would shatter accented
 * names -- "Müller", "García" -- into single-character tokens and wreck
 * multi-word span detection in German, Polish and Spanish text. Python's `\w`
 * is Unicode-aware, so this restores parity with the reference tokenizer.
 */
export const WORD_PATTERN = /[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S/gu

/**
 * As above, plus leading branches for URLs, emails and @mentions so they stay
 * whole. Those branches are ASCII on purpose, mirroring the Python pattern.
 */
export const RICH_WORD_PATTERN =
    /(?:https?:\/\/[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S/giu

export type SplitWord = [text: string, start: number, end: number]

/**
 * Split text into words with their character offsets.
 *
 * A fresh RegExp per call: the `g` flag makes `lastIndex` stateful, so sharing
 * one instance across calls silently skips matches.
 */
export function splitWords(text: string, pattern: RegExp = WORD_PATTERN): SplitWord[] {
    const regex = new RegExp(pattern.source, pattern.flags)
    const out: SplitWord[] = []
    for (;;) {
        const match = regex.exec(text)
        if (match === null) break
        out.push([match[0], match.index, regex.lastIndex])
    }
    return out
}
