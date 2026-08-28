/**
 * PDF reading for @stabrise/scaledp.
 *
 * Requires the optional peer dependency `pdfjs-dist`. Asset URLs (worker, cMaps,
 * standard fonts, wasm) are supplied through `configure({ pdf: { ... } })` and
 * must be served by the consuming application.
 */

export type { TextBox } from './extract-text.js'
export { extractTextBoxes, isTextItem, TEXT_LAYER_SCORE, textItemToBox } from './extract-text.js'
export type { PdfToDocumentParams } from './pdf-to-document.js'
export {
    hasUsableTextLayer,
    PDF_TO_DOCUMENT_DEFAULTS,
    PdfToDocument,
} from './pdf-to-document.js'
export type { PdfToImageParams } from './pdf-to-image.js'
export { PDF_TO_IMAGE_DEFAULTS, PdfToImage, POINTS_PER_INCH, renderPage } from './pdf-to-image.js'
export { documentOptions, loadPdfjs, resetPdfjs } from './pdfjs.js'
export {
    cssFontFromPdfName,
    relativeCharWidth,
    resetMeasurementContext,
    splitRunIntoWords,
    splitRunsIntoWords,
} from './split-words.js'
