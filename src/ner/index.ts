/**
 * Named-entity recognition for @stabrise/scaledp.
 *
 * GLiNER is zero-shot: entity types are given as plain-language labels at call
 * time, not fixed by the model head. The label text is part of the prompt, so
 * renaming a label changes the results.
 *
 * Requires the optional peer dependencies `onnxruntime-web` and
 * `@huggingface/transformers` (the latter for tokenization only).
 */

export type { DecodedSpan, NerBackend, NerBackendLoadOptions } from './backend.js'
export type { Chunk } from './chunking.js'
export {
    chunkText,
    DEFAULT_CHUNK_LENGTH,
    DEFAULT_CHUNK_STRIDE,
    dedupeSpans,
    isMostlyUppercase,
    normaliseCasing,
    rebaseSpan,
    titleCaseAllCapsWords,
} from './chunking.js'
export type { GlinerNerParams } from './gliner-ner.js'
export { boxesForRange, buildCharToBoxMap, GLINER_NER_DEFAULTS, GlinerNer } from './gliner-ner.js'
export { Gliner1Backend } from './gliner1-backend.js'
export { Gliner2Backend } from './gliner2-backend.js'
export type { NerArchitecture, NerModel } from './registry.js'
export {
    DEFAULT_NER_MODEL_ID,
    DEFAULT_PII_LABELS,
    GLINER2_PII_LABELS,
    getNerModel,
    modelSizeBytes,
    NER_MODELS,
} from './registry.js'

export { loadTokenizer, resetTransformers, toCallableTokenizer } from './tokenizer.js'
export { toSpanTokenizer } from './tokenizer-types.js'
export { computeDotProductScores, decodeEntities, generateSpans } from './vendor/gliner2-decoder.js'
export { sigmoid, softmax } from './vendor/math.js'
export { decodeSpans } from './vendor/span-decoder.js'
export type { SplitWord } from './vendor/splitter.js'
export { RICH_WORD_PATTERN, splitWords, WORD_PATTERN } from './vendor/splitter.js'
