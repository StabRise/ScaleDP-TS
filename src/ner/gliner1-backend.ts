/**
 * GLiNER1 span-enumeration runtime on onnxruntime-web.
 *
 * One ONNX graph. Inputs:
 *   input_ids       int64  [batch, tokens]
 *   attention_mask  int64  [batch, tokens]
 *   words_mask      int64  [batch, tokens]   1-based word index on first sub-token
 *   text_lengths    int64  [batch, 1]
 *   span_idx        int64  [batch, spans, 2]
 *   span_mask       bool   [batch, spans]
 * Output:
 *   logits          float32 [batch, words, maxWidth, entityCount]
 *
 * A `token_level` export is the same graph without `span_idx`/`span_mask`, and
 * its logits are [batch, words, entityCount, 3] instead. Only the inputs the
 * export actually declares are fed, and `span_mode` picks the decoder.
 */

import { NerError } from '../core/errors.js'
import type { ModelFiles } from '../core/model-cache.js'
import { createSession } from '../ocr/ort.js'
import type { NerBackend, NerBackendLoadOptions } from './backend.js'
import { type PretrainedTokenizerLike, toSpanTokenizer } from './tokenizer-types.js'
import { type DecodedSpan, decodeSpans, decodeTokenSpans } from './vendor/span-decoder.js'
import { type GlinerConfig, SpanProcessor } from './vendor/span-processor.js'

/** Fallback when a repo's config omits max_width. */
const DEFAULT_MAX_WIDTH = 12
const DEFAULT_ENT_TOKEN = '<<ENT>>'
const DEFAULT_SEP_TOKEN = '<<SEP>>'

const CONFIG_CANDIDATES = ['gliner_config.json', 'config.json']
/** Some repos put the graph at the root rather than under onnx/. */
const MODEL_EXTENSIONS = ['.onnx', '.model']

const OUTPUT_LOGITS = 'logits'
/** `span_mode` of the models that emit start/end/inside triples. */
const TOKEN_LEVEL = 'token_level'

function readConfig(files: ModelFiles): GlinerConfig {
    for (const name of CONFIG_CANDIDATES) {
        const raw = files[name]
        if (!raw) continue
        try {
            const parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
            return {
                maxWidth: Number(parsed.max_width) || DEFAULT_MAX_WIDTH,
                entToken: String(parsed.ent_token ?? DEFAULT_ENT_TOKEN),
                sepToken: String(parsed.sep_token ?? DEFAULT_SEP_TOKEN),
                spanMode: typeof parsed.span_mode === 'string' ? parsed.span_mode : undefined,
            }
        } catch {
            // Fall through to the next candidate rather than failing outright.
        }
    }
    return {
        maxWidth: DEFAULT_MAX_WIDTH,
        entToken: DEFAULT_ENT_TOKEN,
        sepToken: DEFAULT_SEP_TOKEN,
    }
}

function findModelBytes(files: ModelFiles): ArrayBuffer {
    for (const [path, bytes] of Object.entries(files)) {
        if (MODEL_EXTENSIONS.some((ext) => path.endsWith(ext))) return bytes
    }
    throw new NerError('No .onnx or .model file in the downloaded model', 'Gliner1Backend')
}

export class Gliner1Backend implements NerBackend {
    readonly arch = 'gliner1' as const

    private session: import('onnxruntime-web').InferenceSession | null = null
    private processor: SpanProcessor | null = null
    private config: GlinerConfig | null = null

    async load(files: ModelFiles, options: NerBackendLoadOptions): Promise<void> {
        this.config = readConfig(files)
        this.processor = new SpanProcessor(
            this.config,
            toSpanTokenizer(options.tokenizer as PretrainedTokenizerLike)
        )
        this.session = await createSession(findModelBytes(files), {
            executionProviders: options.executionProviders,
        })
    }

    async extract(text: string, labels: readonly string[], threshold: number): Promise<DecodedSpan[]> {
        // Read directly rather than by destructuring: Biome's
        // noUnusedPrivateClassMembers does not see destructured member reads.
        const session = this.session
        const processor = this.processor
        const config = this.config
        if (!session || !processor || !config) {
            throw new NerError('Backend used before load()', 'Gliner1Backend')
        }
        if (labels.length === 0) return []

        const batch = processor.prepare([text], labels)
        const words = batch.batchWords[0] ?? []
        if (words.length === 0) return []

        const { Tensor } = await import('onnxruntime-web')
        const tokenCount = (batch.inputIds[0] as number[]).length
        const spanCount = (batch.spanIdxs[0] as number[][]).length

        const big = (values: number[]) => BigInt64Array.from(values, BigInt)

        const feeds: Record<string, import('onnxruntime-web').Tensor> = {
            input_ids: new Tensor('int64', big(batch.inputIds.flat()), [1, tokenCount]),
            attention_mask: new Tensor('int64', big(batch.attentionMasks.flat()), [1, tokenCount]),
            words_mask: new Tensor('int64', big(batch.wordsMasks.flat()), [1, tokenCount]),
            text_lengths: new Tensor('int64', big(batch.textLengths), [1, 1]),
            span_idx: new Tensor('int64', big(batch.spanIdxs.flat(2)), [1, spanCount, 2]),
            span_mask: new Tensor(
                'bool',
                Uint8Array.from(batch.spanMasks.flat(), (v) => (v ? 1 : 0)),
                [1, spanCount]
            ),
        }

        // Only feed inputs this particular export actually declares: token-mode
        // GLiNER variants omit span_idx/span_mask entirely.
        const inputs: Record<string, import('onnxruntime-web').Tensor> = {}
        for (const name of session.inputNames) {
            const tensor = feeds[name]
            if (!tensor) throw new NerError(`Model expects unknown input "${name}"`, 'Gliner1Backend')
            inputs[name] = tensor
        }

        const outputs = await session.run(inputs)
        const logits = (outputs[OUTPUT_LOGITS] ?? outputs[session.outputNames[0] ?? ''])?.data
        if (!logits) throw new NerError('Model produced no logits', 'Gliner1Backend')

        const decode = config.spanMode === TOKEN_LEVEL ? decodeTokenSpans : decodeSpans
        const [spans = []] = decode(
            logits as Float32Array,
            {
                batchSize: 1,
                inputLength: words.length,
                maxWidth: config.maxWidth,
                entityCount: labels.length,
                texts: [text],
                batchWords: batch.batchWords,
                idToClass: batch.idToClass,
            },
            { threshold, flatNer: true, multiLabel: false }
        )
        return spans
    }

    async dispose(): Promise<void> {
        await this.session?.release()
        this.session = null
        this.processor = null
        this.config = null
    }
}
