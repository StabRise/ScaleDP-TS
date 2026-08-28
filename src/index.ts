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

export type { ModelProgress, ScaleDpConfig } from './core/config.js'
export { configure, defaultNumThreads, getConfig, resetConfig, resolveNumThreads } from './core/config.js'
export {
    ConfigError,
    DetectionError,
    formatException,
    ImageError,
    NerError,
    OcrError,
    ScaleDpError,
} from './core/errors.js'
export * from './core/geometry.js'
export * from './core/image.js'
export type { ModelFile, ModelFiles, ModelSpec } from './core/model-cache.js'
export {
    cacheKey,
    ensureModelFiles,
    evict,
    fileUrl,
    isCached,
} from './core/model-cache.js'
export type { BaseStageParams, Validator } from './core/params.js'
export {
    assertInRange,
    assertPositiveInt,
    BASE_STAGE_DEFAULTS,
    resolveParams,
} from './core/params.js'
export type { ExecutionTime, PipelineInput, PipelineOptions, Row, StageContext } from './core/pipeline.js'
export { EXECUTION_TIME_COL, Pipeline, Stage, toRows } from './core/pipeline.js'
export * from './core/text.js'
export * from './schemas/index.js'
export type { DataToImageParams } from './stages/data-to-image.js'
export { DATA_TO_IMAGE_DEFAULTS, DataToImage, toBytes } from './stages/data-to-image.js'
export type { ImageCropBoxesParams } from './stages/image-crop-boxes.js'
export { IMAGE_CROP_BOXES_DEFAULTS, ImageCropBoxes } from './stages/image-crop-boxes.js'
export type { ImageDrawBoxesParams } from './stages/image-draw-boxes.js'
export { colorForGroup, IMAGE_DRAW_BOXES_DEFAULTS, ImageDrawBoxes } from './stages/image-draw-boxes.js'
