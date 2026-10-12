/**
 * @stabrise/scaledp -- process documents in the browser using AI/ML pipelines.
 *
 * A browser mirror of the ScaleDP Python library. Engines live behind subpath
 * exports so importing the core pulls in no ML runtime:
 *
 *   @stabrise/scaledp/pdf     PDF reading
 *   @stabrise/scaledp/ocr     text detection + recognition
 *   @stabrise/scaledp/ner     GLiNER named-entity recognition
 *   @stabrise/scaledp/detect  YOLO object detection
 *   @stabrise/scaledp/worker  run a pipeline off the main thread
 */

export type { Condition, Json, Operand, Test, Tests } from './core/condition.js'
export { evaluate, readPath, validateCondition } from './core/condition.js'
export type { ModelProgress, ScaleDpConfig } from './core/config.js'
export { configure, defaultNumThreads, getConfig, resetConfig, resolveNumThreads } from './core/config.js'
export type { FoldedSpan, FoldedText } from './core/entities.js'
export {
    boxesForRange,
    buildCharToBoxMap,
    findWholeWordOccurrences,
    foldForMatching,
} from './core/entities.js'
export {
    ConfigError,
    DetectionError,
    formatException,
    ImageError,
    isSkipped,
    NerError,
    NO_EMBEDDED_IMAGES,
    OcrError,
    ScaleDpError,
    SkipError,
    upstreamError,
} from './core/errors.js'
export { EventStream } from './core/events.js'
export type {
    FuzzyCosts,
    FuzzyEdit,
    FuzzyEditKind,
    FuzzyMatch,
    FuzzySearchOptions,
} from './core/fuzzy-regex.js'
export { FuzzyRegex } from './core/fuzzy-regex.js'
export * from './core/geometry.js'
export * from './core/image.js'
export type { Priority, ResourceClaim } from './core/locks.js'
export type {
    CachedFile,
    EnsureModelOptions,
    ModelFile,
    ModelFiles,
    ModelRequirement,
    ModelSpec,
    ProgressListener,
} from './core/model-cache.js'
export {
    cachedFiles,
    cacheKey,
    downloadSize,
    ensureModelFiles,
    evict,
    fileUrl,
    isCached,
    LazyLoad,
    ProgressHub,
    raceAbort,
    reportProgress,
    reportReady,
    requestPersistentStorage,
} from './core/model-cache.js'
export type { EnvironmentProbe, Parallelism, ParallelismPreset } from './core/parallelism.js'
export { probeEnvironment, resolveParallelism } from './core/parallelism.js'
export type { BaseStageParams, Validator } from './core/params.js'
export {
    assertInRange,
    assertPositiveInt,
    BASE_STAGE_DEFAULTS,
    resolveParams,
} from './core/params.js'
export type {
    ExecutionTime,
    InitContext,
    PipelineInput,
    PipelineOptions,
    PipelineStage,
    Row,
    RowTime,
    StageContext,
    StageDescriptor,
    StageRuntime,
    StageScope,
} from './core/pipeline.js'
export { EXECUTION_TIME_COL, Pipeline, ROW_TIME_COL, Stage, toRows } from './core/pipeline.js'
export type {
    PipelineEvent,
    PipelineEventType,
    PlannedStage,
    RowUpdate,
    RowUpdateOptions,
    RunOptions,
    RunOrder,
    StageRunOptions,
    UnitRef,
} from './core/run.js'
export type { PipelineEntry } from './core/scheduler.js'
export { stripBinary } from './core/scheduler.js'
export * from './core/text.js'
export * from './schemas/index.js'
export type { CountryMatch } from './stages/countries.js'
export { countryLocalesSupported, findCountries, ISO_COUNTRIES } from './stages/countries.js'
export type { DataToImageParams } from './stages/data-to-image.js'
export { DATA_TO_IMAGE_DEFAULTS, DataToImage, toBytes } from './stages/data-to-image.js'
export type { DocumentDeltaParams } from './stages/document-delta.js'
export {
    boxIdentity,
    DOCUMENT_DELTA_DEFAULTS,
    DocumentDelta,
    documentDelta,
} from './stages/document-delta.js'
export type { FitBoxesToInkParams, FitOptions, Luma } from './stages/fit-boxes-to-ink.js'
export {
    FIT_BOXES_TO_INK_DEFAULTS,
    FitBoxesToInk,
    fitBands,
    fitBoxesToInk,
    fitBoxToInk,
    fitRegion,
    toLuma,
} from './stages/fit-boxes-to-ink.js'
export type { ImageCropBoxesParams } from './stages/image-crop-boxes.js'
export { IMAGE_CROP_BOXES_DEFAULTS, ImageCropBoxes } from './stages/image-crop-boxes.js'
export type { ImageDrawBoxesParams } from './stages/image-draw-boxes.js'
export { colorForGroup, IMAGE_DRAW_BOXES_DEFAULTS, ImageDrawBoxes } from './stages/image-draw-boxes.js'
export type {
    ConsistencyScope,
    NerConsistencyParams,
    Vocabulary,
    VocabularyEntry,
} from './stages/ner-consistency.js'
export {
    applyVocabulary,
    buildVocabulary,
    CONSISTENCY_SCOPES,
    NER_CONSISTENCY_DEFAULTS,
    NerConsistency,
} from './stages/ner-consistency.js'
export type { NerMergeDedupe, NerMergerParams } from './stages/ner-merger.js'
export {
    dedupeEntities,
    NER_MERGE_DEDUPE,
    NER_MERGER_DEFAULTS,
    NerMerger,
    rebaseEntities,
} from './stages/ner-merger.js'
export type {
    FindPatternOptions,
    LibraryMatch,
    NormalisedText,
    PatternEngines,
    PatternLabel,
    PatternMatch,
    RegexNerParams,
} from './stages/regex-ner.js'
export {
    DATE_LOCALES,
    dateValid,
    findPatternEntities,
    findPatternMatches,
    ibanValid,
    loadPatternEngines,
    luhnValid,
    normaliseOcrText,
    PATTERN_DETECTORS,
    PATTERN_LABELS,
    peselValid,
    REGEX_NER_DEFAULTS,
    RegexNer,
    ssnValid,
} from './stages/regex-ner.js'
