/**
 * Named-entity recognition over a Document, mirroring ScaleDP's `Ner` stage.
 *
 * Chunks long text, runs a GLiNER backend, and maps the resulting character
 * offsets back onto the OCR boxes so every entity carries its position on the
 * page.
 */

import { getConfig } from '../core/config.js'
import { boxesForRange, buildCharToBoxMap } from '../core/entities.js'
import { NerError } from '../core/errors.js'
import { ensureModelFiles } from '../core/model-cache.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import type { Document } from '../schemas/document.js'
import { createNerOutput, type Entity, type NerOutput } from '../schemas/entity.js'
import type { NerBackend } from './backend.js'
import {
    chunkText,
    DEFAULT_CHUNK_LENGTH,
    DEFAULT_CHUNK_STRIDE,
    dedupeSpans,
    normaliseCasing,
    rebaseSpan,
} from './chunking.js'
import { Gliner1Backend } from './gliner1-backend.js'
import { Gliner2Backend } from './gliner2-backend.js'
import { DEFAULT_NER_MODEL_ID, DEFAULT_PII_LABELS, getNerModel } from './registry.js'
import { loadTokenizer } from './tokenizer.js'
import type { DecodedSpan } from './vendor/span-decoder.js'

// Moved to core so the engine-free NerConsistency stage can share them; still
// exported here, where they have always been part of the /ner surface.
export { boxesForRange, buildCharToBoxMap }

export interface GlinerNerParams extends BaseStageParams {
    /** Registry id, e.g. 'gliner-multi-pii'. */
    model: string
    /** Entity types to look for. GLiNER scores a label by its prompt text. */
    labels: readonly string[]
    /** Minimum score an entity must reach (0-1). */
    threshold: number
    /** Only keep these entity groups; empty keeps everything. */
    whiteList: readonly string[]
    chunkLength: number
    chunkStride: number
    /**
     * Title-case runs of capitals before inference. GLiNER1 models are cased
     * and scanned documents are often set in all caps.
     */
    normaliseCasing: boolean
}

export const GLINER_NER_DEFAULTS: GlinerNerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'text',
    outputCol: 'ner',
    keepInputData: true,
    model: DEFAULT_NER_MODEL_ID,
    labels: DEFAULT_PII_LABELS,
    threshold: 0.5,
    whiteList: [] as readonly string[],
    chunkLength: DEFAULT_CHUNK_LENGTH,
    chunkStride: DEFAULT_CHUNK_STRIDE,
    normaliseCasing: true,
})

export class GlinerNer extends Stage<GlinerNerParams> {
    readonly name = 'GlinerNer'

    private backend: NerBackend | null = null
    private loading: Promise<NerBackend> | null = null

    constructor(options: Partial<GlinerNerParams> = {}) {
        super(
            resolveParams(GLINER_NER_DEFAULTS, options, {
                threshold: (value) => {
                    if (!(value >= 0 && value <= 1)) {
                        throw new RangeError(`threshold must be between 0 and 1, received ${value}`)
                    }
                },
                model: (value) => {
                    if (!getNerModel(value)) {
                        throw new RangeError(`Unknown NER model "${value}". See NER_MODELS for valid ids.`)
                    }
                },
            })
        )
    }

    override async init(): Promise<void> {
        await this.getBackend()
    }

    private getBackend(): Promise<NerBackend> {
        if (this.backend) return Promise.resolve(this.backend)
        if (this.loading) return this.loading

        this.loading = (async () => {
            const model = getNerModel(this.params.model)
            if (!model) throw new NerError(`Unknown model ${this.params.model}`, this.name)
            if (model.private && !getConfig().auth) {
                throw new NerError(
                    `Model ${model.id} lives in a private repo. Supply a token via configure({ auth }).`,
                    this.name
                )
            }

            const [files, tokenizer] = await Promise.all([
                ensureModelFiles({ repo: model.repo, files: model.files }),
                loadTokenizer(model.repo),
            ])

            const backend: NerBackend = model.arch === 'gliner2' ? new Gliner2Backend() : new Gliner1Backend()
            await backend.load(files, {
                tokenizer,
                executionProviders: model.executionProviders ?? getConfig().executionProviders,
            })
            this.backend = backend
            return backend
        })()

        this.loading.catch(() => {
            this.loading = null
        })
        return this.loading
    }

    protected async apply(input: unknown, row: Row): Promise<NerOutput> {
        const document = input as Document | undefined
        if (!document || typeof document.text !== 'string') {
            throw new NerError('Expected a Document with text', this.name)
        }
        if (document.exception) {
            throw new NerError(`Upstream stage failed: ${document.exception}`, this.name)
        }

        const entities = await this.extract(document)
        return createNerOutput({
            path: String(row[this.params.pathCol] ?? document.path ?? 'memory'),
            entities,
            json: JSON.stringify(entities),
        })
    }

    /** Run NER over a document and attach boxes to every entity found. */
    async extract(document: Document): Promise<Entity[]> {
        const { labels, threshold, whiteList, chunkLength, chunkStride } = this.params
        if (document.text.trim().length === 0 || labels.length === 0) return []

        const backend = await this.getBackend()
        // Casing is normalised length-preservingly, so offsets stay valid
        // against the ORIGINAL text -- entity strings are re-sliced from it.
        const source = this.params.normaliseCasing ? normaliseCasing(document.text) : document.text

        const spans: DecodedSpan[] = []
        for (const chunk of chunkText(source, chunkLength, chunkStride)) {
            const found = await backend.extract(chunk.text, labels, threshold)
            for (const span of found) spans.push(rebaseSpan(span, chunk.offset))
        }

        const mapping = buildCharToBoxMap(document.text, document.bboxes)
        const allowed = new Set(whiteList)

        return dedupeSpans(spans)
            .filter((span) => allowed.size === 0 || allowed.has(span.label))
            .map((span) => ({
                entity_group: span.label,
                score: span.score,
                // Re-slice from the original text so the reported word keeps its
                // real casing, not the normalised form the model saw.
                word: document.text.slice(span.start, span.end),
                start: span.start,
                end: span.end,
                boxes: boxesForRange(mapping, document.bboxes, span.start, span.end),
            }))
    }

    protected onError(message: string, row: Row): NerOutput {
        return createNerOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }

    override async dispose(): Promise<void> {
        await this.backend?.dispose()
        this.backend = null
        this.loading = null
    }
}
