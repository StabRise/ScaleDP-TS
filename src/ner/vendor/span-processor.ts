/**
 * GLiNER1 span-enumeration input builder. Adapted from @lmoe/gliner-onnx (MIT).
 *
 * Builds the prompt `<<ENT>> label1 <<ENT>> label2 <<SEP>> text` and enumerates
 * every candidate span up to `maxWidth` words, which is what the model scores.
 */

import { type SplitWord, splitWords } from './splitter.js'

const PAD = 0

export interface GlinerConfig {
    /**
     * `span_mode` from the repo's gliner_config.json. Selects the decoder:
     * 'token_level' reads start/end/inside triples, everything else reads
     * enumerated spans.
     */
    spanMode?: string
    maxWidth: number
    entToken: string
    sepToken: string
}

/** Minimal tokenizer surface the processor needs. */
export interface SpanTokenizer {
    encode(text: string): number[]
    clsTokenId: number
    sepTokenId: number
}

export interface ProcessorBatch {
    inputIds: number[][]
    attentionMasks: number[][]
    wordsMasks: number[][]
    textLengths: number[]
    spanIdxs: number[][][]
    spanMasks: boolean[][]
    /** 1-based entity index -> label, matching the model's class numbering. */
    idToClass: Record<number, string>
    batchWords: SplitWord[][]
}

function pad<T>(arrays: T[][], value: T): T[][] {
    const max = Math.max(...arrays.map((a) => a.length))
    return arrays.map((a) => [...a, ...new Array<T>(max - a.length).fill(value)])
}

export class SpanProcessor {
    constructor(
        private readonly config: GlinerConfig,
        private readonly tokenizer: SpanTokenizer
    ) {}

    prepare(texts: readonly string[], labels: readonly string[]): ProcessorBatch {
        const batchWords = texts.map((text) => splitWords(text))

        const idToClass: Record<number, string> = {}
        for (const [i, label] of labels.entries()) idToClass[i + 1] = label

        const inputIds: number[][] = []
        const attentionMasks: number[][] = []
        const wordsMasks: number[][] = []
        const textLengths: number[] = []
        const spanIdxs: number[][][] = []
        const spanMasks: boolean[][] = []

        for (const words of batchWords) {
            textLengths.push(words.length)

            // Prompt tokens first, then the text's own words.
            const prompt: string[] = []
            for (const label of labels) prompt.push(this.config.entToken, label)
            prompt.push(this.config.sepToken)
            const sequence = [...prompt, ...words.map(([w]) => w)]

            const ids: number[] = [this.tokenizer.clsTokenId]
            const attention: number[] = [1]
            // wordsMask marks the FIRST sub-token of each text word with a
            // 1-based word index; prompt tokens and continuation sub-tokens get
            // 0. That is how the model pools sub-tokens back to words.
            const wordsMask: number[] = [PAD]
            let wordCounter = 1

            for (const [wordIdx, word] of sequence.entries()) {
                // slice(1, -1) drops the tokenizer's own CLS/SEP around a
                // single word.
                const subTokens = this.tokenizer.encode(word).slice(1, -1)
                for (const [tokenIdx, id] of subTokens.entries()) {
                    ids.push(id)
                    attention.push(1)
                    if (wordIdx < prompt.length) wordsMask.push(PAD)
                    else if (tokenIdx === 0) wordsMask.push(wordCounter++)
                    else wordsMask.push(PAD)
                }
            }
            ids.push(this.tokenizer.sepTokenId)
            attention.push(1)
            wordsMask.push(PAD)

            inputIds.push(ids)
            attentionMasks.push(attention)
            wordsMasks.push(wordsMask)

            const spanIdx: number[][] = []
            const spanMask: boolean[] = []
            for (let start = 0; start < words.length; start++) {
                for (let width = 0; width < this.config.maxWidth; width++) {
                    const end = Math.min(start + width, words.length - 1)
                    spanIdx.push([start, end])
                    spanMask.push(end < words.length)
                }
            }
            spanIdxs.push(spanIdx)
            spanMasks.push(spanMask)
        }

        const maxSpans = Math.max(...spanIdxs.map((s) => s.length))
        return {
            inputIds: pad(inputIds, PAD),
            attentionMasks: pad(attentionMasks, PAD),
            wordsMasks: pad(wordsMasks, PAD),
            textLengths,
            spanIdxs: spanIdxs.map((s) => [
                ...s,
                ...Array.from({ length: maxSpans - s.length }, () => [PAD, PAD]),
            ]),
            spanMasks: pad(spanMasks, false),
            idToClass,
            batchWords,
        }
    }
}
