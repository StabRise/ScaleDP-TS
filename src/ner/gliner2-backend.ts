/**
 * GLiNER2 runtime on onnxruntime-web.
 *
 * Three graphs, orchestrated in JS:
 *   encoder      input_ids, attention_mask [1, seq] int64 -> hidden states
 *   span_rep     hidden_states [1, seq, hidden] + span_start_idx/span_end_idx
 *                [1, spans] int64 -> span representations
 *   count_embed  label_embeddings [labels, hidden] -> transformed embeddings
 *
 * The `classifier` graph is for text classification only and is not downloaded.
 * Scoring (dot product + sigmoid) happens in JS between span_rep and
 * count_embed.
 *
 * Unlike GLiNER1's single prompt string, GLiNER2 builds a *schema*:
 *   ( [P] entities ( [E] label1 [E] label2 ) ) [SEP_TEXT] <text>
 * with each label's position recorded so its embedding can be gathered from
 * the encoder output.
 */

import { NerError } from '../core/errors.js'
import type { ModelFiles } from '../core/model-cache.js'
import { createSession } from '../ocr/ort.js'
import type { NerBackend, NerBackendLoadOptions } from './backend.js'
import type { PretrainedTokenizerLike } from './tokenizer-types.js'
import {
    computeDotProductScores,
    decodeEntities,
    generateSpans,
    type WordOffset,
} from './vendor/gliner2-decoder.js'
import { extractTokenIds, gatherRows, sliceRows } from './vendor/math.js'
import type { DecodedSpan } from './vendor/span-decoder.js'
import { RICH_WORD_PATTERN, splitWords } from './vendor/splitter.js'

const CONFIG_FILE = 'config.json'
const GLINER2_CONFIG_FILE = 'gliner2_config.json'

const TOKEN_P = '[P]'
const TOKEN_E = '[E]'
const TOKEN_SEP_TEXT = '[SEP_TEXT]'
const SCHEMA_OPEN = '('
const SCHEMA_CLOSE = ')'
const NER_TASK_NAME = 'entities'

interface Gliner2Config {
    hiddenSize: number
    maxWidth: number
    specialTokens: Record<string, number>
}

function decodeJson<T>(buffer: ArrayBuffer | undefined, name: string): T {
    if (!buffer) throw new NerError(`Model is missing ${name}`, 'Gliner2Backend')
    return JSON.parse(new TextDecoder().decode(buffer)) as T
}

export class Gliner2Backend implements NerBackend {
    readonly arch = 'gliner2' as const

    private config: Gliner2Config | null = null
    private encoder: import('onnxruntime-web').InferenceSession | null = null
    private spanRep: import('onnxruntime-web').InferenceSession | null = null
    private countEmbed: import('onnxruntime-web').InferenceSession | null = null
    private tokenize: ((text: string) => number[]) | null = null

    async load(files: ModelFiles, options: NerBackendLoadOptions): Promise<void> {
        const transformer = decodeJson<{ hidden_size: number }>(files[CONFIG_FILE], CONFIG_FILE)
        const gliner2 = decodeJson<{ max_width: number; special_tokens: Record<string, number> }>(
            files[GLINER2_CONFIG_FILE],
            GLINER2_CONFIG_FILE
        )
        if (typeof transformer.hidden_size !== 'number') {
            throw new NerError(`${CONFIG_FILE} is missing hidden_size`, 'Gliner2Backend')
        }
        if (typeof gliner2.max_width !== 'number') {
            throw new NerError(`${GLINER2_CONFIG_FILE} is missing max_width`, 'Gliner2Backend')
        }

        this.config = {
            hiddenSize: transformer.hidden_size,
            maxWidth: gliner2.max_width,
            specialTokens: gliner2.special_tokens,
        }

        const tokenizer = options.tokenizer as PretrainedTokenizerLike
        this.tokenize = (text: string) =>
            extractTokenIds(tokenizer(text, { add_special_tokens: false }).input_ids.tolist())

        const graph = (path: string): ArrayBuffer => {
            const bytes = files[path]
            if (!bytes) throw new NerError(`Model is missing ${path}`, 'Gliner2Backend')
            return bytes
        }

        // Pinned to WASM by the registry: ORT's WebGPU backend silently drops
        // entities here, because the dynamic span-gather and count_embed ops
        // fall back to CPU mid-graph and the partition boundary corrupts data.
        const providers = options.executionProviders ?? ['wasm']
        const [encoder, spanRep, countEmbed] = await Promise.all([
            createSession(graph('onnx/encoder.onnx'), { executionProviders: providers }),
            createSession(graph('onnx/span_rep.onnx'), { executionProviders: providers }),
            createSession(graph('onnx/count_embed.onnx'), { executionProviders: providers }),
        ])
        this.encoder = encoder
        this.spanRep = spanRep
        this.countEmbed = countEmbed
    }

    async extract(text: string, labels: readonly string[], threshold: number): Promise<DecodedSpan[]> {
        const { config, tokenize } = this
        if (!config || !tokenize || !this.encoder || !this.spanRep || !this.countEmbed) {
            throw new NerError('Backend used before load()', 'Gliner2Backend')
        }
        if (text.trim().length === 0 || labels.length === 0) return []

        const schema = this.buildSchema(labels)
        const words = this.tokenizeWords(text)
        if (words.wordOffsets.length === 0) return []

        const allTokens = [...schema.tokens, ...words.tokens]
        const hidden = await this.encode(allTokens)

        const labelEmbeddings = gatherRows(hidden, schema.labelPositions, config.hiddenSize)
        const textTokenCount = allTokens.length - schema.tokens.length
        if (textTokenCount === 0) return []

        const textHidden = sliceRows(hidden, schema.tokens.length, textTokenCount, config.hiddenSize)

        const { spanStart, spanEnd, spanCount } = generateSpans(words.wordOffsets.length, config.maxWidth)
        // Spans are enumerated over words but scored over tokens, so map each
        // word index to the position of its first sub-token.
        const toToken = (wordIdx: number) => words.firstTokenPositions[wordIdx] ?? 0
        const spanRepresentations = await this.runSpanRep(
            textHidden,
            textTokenCount,
            spanStart.map(toToken),
            spanEnd.map(toToken),
            spanCount
        )
        const transformedLabels = await this.runCountEmbed(labelEmbeddings, labels.length)

        const scores = computeDotProductScores(
            spanRepresentations,
            transformedLabels,
            spanCount,
            labels.length,
            config.hiddenSize
        )

        return decodeEntities(
            { scores, wordSpanStart: spanStart, wordSpanEnd: spanEnd, spanCount },
            words.wordOffsets.length,
            labels,
            words.wordOffsets,
            text,
            threshold
        )
    }

    /** `( [P] entities ( [E] label1 [E] label2 ) ) [SEP_TEXT]` */
    private buildSchema(labels: readonly string[]): { tokens: number[]; labelPositions: number[] } {
        const config = this.config as Gliner2Config
        const tokenize = this.tokenize as (text: string) => number[]

        const open = tokenize(SCHEMA_OPEN)
        const close = tokenize(SCHEMA_CLOSE)
        const tokens: number[] = [...open, config.specialTokens[TOKEN_P] as number]
        tokens.push(...tokenize(NER_TASK_NAME), ...open)

        const labelPositions: number[] = []
        for (const label of labels) {
            // Record the position of the [E] marker: that token's hidden state
            // is the label's embedding.
            labelPositions.push(tokens.length)
            tokens.push(config.specialTokens[TOKEN_E] as number, ...tokenize(label))
        }
        tokens.push(...close, ...close, config.specialTokens[TOKEN_SEP_TEXT] as number)
        return { tokens, labelPositions }
    }

    /**
     * Word-split and tokenize the text.
     *
     * Lower-cased before splitting, matching the reference implementation --
     * offsets stay valid because `toLowerCase` is length-preserving for the
     * scripts these models cover.
     */
    private tokenizeWords(text: string): {
        tokens: number[]
        wordOffsets: WordOffset[]
        firstTokenPositions: number[]
    } {
        const tokenize = this.tokenize as (text: string) => number[]
        const tokens: number[] = []
        const wordOffsets: WordOffset[] = []
        const firstTokenPositions: number[] = []

        for (const [word, start, end] of splitWords(text.toLowerCase(), RICH_WORD_PATTERN)) {
            wordOffsets.push([start, end])
            firstTokenPositions.push(tokens.length)
            tokens.push(...tokenize(word))
        }
        return { tokens, wordOffsets, firstTokenPositions }
    }

    private async encode(tokens: number[]): Promise<Float32Array> {
        const { Tensor } = await import('onnxruntime-web')
        const session = this.encoder as import('onnxruntime-web').InferenceSession
        const seqLen = tokens.length

        const outputs = await session.run({
            input_ids: new Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, seqLen]),
            attention_mask: new Tensor('int64', new BigInt64Array(seqLen).fill(1n), [1, seqLen]),
        })
        return firstOutput(outputs, 'encoder')
    }

    private async runSpanRep(
        hidden: Float32Array,
        seqLen: number,
        spanStart: number[],
        spanEnd: number[],
        spanCount: number
    ): Promise<Float32Array> {
        const { Tensor } = await import('onnxruntime-web')
        const session = this.spanRep as import('onnxruntime-web').InferenceSession
        const hiddenSize = (this.config as Gliner2Config).hiddenSize

        const outputs = await session.run({
            hidden_states: new Tensor('float32', hidden, [1, seqLen, hiddenSize]),
            span_start_idx: new Tensor('int64', BigInt64Array.from(spanStart, BigInt), [1, spanCount]),
            span_end_idx: new Tensor('int64', BigInt64Array.from(spanEnd, BigInt), [1, spanCount]),
        })
        return firstOutput(outputs, 'span_rep')
    }

    private async runCountEmbed(labelEmbeddings: Float32Array, labelCount: number): Promise<Float32Array> {
        const { Tensor } = await import('onnxruntime-web')
        const session = this.countEmbed as import('onnxruntime-web').InferenceSession
        const hiddenSize = (this.config as Gliner2Config).hiddenSize

        const outputs = await session.run({
            label_embeddings: new Tensor('float32', labelEmbeddings, [labelCount, hiddenSize]),
        })
        return firstOutput(outputs, 'count_embed')
    }

    async dispose(): Promise<void> {
        await Promise.all([this.encoder?.release(), this.spanRep?.release(), this.countEmbed?.release()])
        this.encoder = null
        this.spanRep = null
        this.countEmbed = null
        this.config = null
        this.tokenize = null
    }
}

function firstOutput(
    outputs: import('onnxruntime-web').InferenceSession.OnnxValueMapType,
    graph: string
): Float32Array {
    const [name] = Object.keys(outputs)
    if (!name) throw new NerError(`Graph ${graph} produced no output`, 'Gliner2Backend')
    return (outputs[name] as { data: Float32Array }).data
}
