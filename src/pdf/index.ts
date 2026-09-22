/**
 * PDF reading for @stabrise/scaledp.
 *
 * Requires the optional peer dependency `pdfjs-dist`. Asset URLs (worker, cMaps,
 * standard fonts, wasm) are supplied through `configure({ pdf: { ... } })` and
 * must be served by the consuming application.
 */

export type {
    EmbeddedImage,
    ExtractImagesOptions,
    ImageOpCodes,
    ImagePlacement,
    Matrix,
    RawImagePlacement,
    SubRect,
} from './extract-images.js'
export {
    applyMatrix,
    awaitObject,
    boxToPage,
    collectImagePlacements,
    effectiveResolution,
    extractEmbeddedImages,
    IDENTITY,
    imageDataSize,
    imageDataToOwnedCanvas,
    imageOpCodes,
    multiplyMatrix,
    placementMap,
    toImagePlacement,
    upscaleFactor,
} from './extract-images.js'
export type { TextBox } from './extract-text.js'
export { extractTextBoxes, isTextItem, TEXT_LAYER_SCORE, textItemToBox } from './extract-text.js'
export type { AssembleOptions, MergeOptions, MergeStrategy } from './merge-text.js'
export {
    assembleDocument,
    coveringBoxes,
    dropCovered,
    MERGE_STRATEGIES,
    mergeBoxSets,
} from './merge-text.js'
export type { PdfEmbeddedImagesParams } from './pdf-embedded-images.js'
export {
    NO_EMBEDDED_IMAGES,
    PDF_EMBEDDED_IMAGES_DEFAULTS,
    PdfEmbeddedImages,
} from './pdf-embedded-images.js'
export type { PdfMergeImageTextParams } from './pdf-merge-image-text.js'
export { PDF_MERGE_IMAGE_TEXT_DEFAULTS, PdfMergeImageText } from './pdf-merge-image-text.js'
export type { PdfToDocumentParams } from './pdf-to-document.js'
export {
    hasUsableTextLayer,
    PDF_TO_DOCUMENT_DEFAULTS,
    PdfToDocument,
} from './pdf-to-document.js'
export type { PdfToImageParams } from './pdf-to-image.js'
export {
    PDF_TO_IMAGE_DEFAULTS,
    PdfToImage,
    POINTS_PER_INCH,
    pageIndexes,
    renderPage,
} from './pdf-to-image.js'
export {
    documentOptions,
    loadPdfjs,
    resetPdfDocuments,
    resetPdfjs,
    withPdfDocument,
} from './pdfjs.js'
export {
    cssFontFromPdfName,
    relativeCharWidth,
    resetMeasurementContext,
    splitRunIntoWords,
    splitRunsIntoWords,
} from './split-words.js'
