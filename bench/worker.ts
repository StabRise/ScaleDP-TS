/**
 * Worker entry for the throughput benchmark: the stages it runs, nothing else.
 */
import { configure } from '../src/core/config.js'
import { FaceDetector } from '../src/detect/index.js'
import { DbnetOnnxDetector, PaddleRecognizer } from '../src/ocr/index.js'
import { PdfEmbeddedImages, PdfToDocument, PdfToImage } from '../src/pdf/index.js'
import { FitBoxesToInk } from '../src/stages/fit-boxes-to-ink.js'
import { registerStages, startScaleDpWorker } from '../src/worker/index.js'

configure({ pdf: { workerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs' } })
registerStages({
    PdfToDocument: PdfToDocument as never,
    PdfToImage: PdfToImage as never,
    DbnetOnnxDetector: DbnetOnnxDetector as never,
    PaddleRecognizer: PaddleRecognizer as never,
    FaceDetector: FaceDetector as never,
    PdfEmbeddedImages: PdfEmbeddedImages as never,
    FitBoxesToInk: FitBoxesToInk as never,
})
startScaleDpWorker()
