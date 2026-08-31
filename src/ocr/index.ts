/**
 * Text detection and recognition for @stabrise/scaledp.
 *
 * Engines:
 *   PaddleTextDetector / PaddleTextRecognizer  default; PP-OCR via ppu-paddle-ocr
 *   PaddleRecognizer                           PP-OCR reading another detector's boxes
 *   DbnetOnnxDetector                          the direct ScaleDP mirror
 *   TesseractOcr                               mirrors ScaleDP's TesseractOcr stage
 *   TesseractScriptDetector                    which script a page is written in, via OSD
 *
 * Requires the optional peer dependency `onnxruntime-web`, plus the engine
 * package you use.
 */

export type { DbPostProcessOptions, DetectedQuad, ProbabilityMap } from './db-postprocess.js'
export {
    boxScore,
    DB_POSTPROCESS_DEFAULTS,
    findComponentBoundaries,
    miniBox,
    orderPointsClockwise,
    quadsFromProbabilityMap,
    unclipRect,
} from './db-postprocess.js'
export type { DbnetOnnxDetectorParams } from './dbnet-onnx.js'
export {
    DBNET_DETECTOR_DEFAULTS,
    DBNET_INPUT_SIZE,
    DbnetOnnxDetector,
    DEFAULT_DBNET_MODEL,
} from './dbnet-onnx.js'
export type { DetectorKind, DetectorModel } from './detector-registry.js'
export {
    DEFAULT_DETECTOR_ID,
    DETECTOR_MODELS,
    getDetectorModel,
} from './detector-registry.js'
export type { LineOrientation } from './line-orientation.js'
export {
    DEFAULT_ORIENTATION_MODEL,
    LineOrientationClassifier,
    ORIENTATION_INPUT,
} from './line-orientation.js'
export type { LineOrientationDetectorParams } from './line-orientation-stage.js'
export {
    LINE_ORIENTATION_DEFAULTS,
    LineOrientationDetector,
} from './line-orientation-stage.js'
export type { SessionOptions } from './ort.js'
export {
    createSession,
    isCrossOriginIsolated,
    isWebGpuAvailable,
    loadOrt,
    resetOrt,
    wasmFallbackProviders,
} from './ort.js'
export type {
    PaddleOcrParams,
    PaddleTextDetectorParams,
    PaddleTextRecognizerParams,
    RecognitionStrategy,
} from './paddle.js'
export {
    PADDLE_TEXT_DETECTOR_DEFAULTS,
    PADDLE_TEXT_RECOGNIZER_DEFAULTS,
    PaddleTextDetector,
    PaddleTextRecognizer,
} from './paddle.js'
export type { PaddleRecognizerParams } from './paddle-recognizer.js'
export { PADDLE_RECOGNIZER_DEFAULTS, PaddleRecognizer } from './paddle-recognizer.js'
export type { PaddleRecognitionService, PaddleRecognizerOptions } from './paddle-service.js'
export {
    disposePaddleServices,
    getPaddleRecognizer,
    getPaddleService,
    isPresetCached,
    loadPreset,
    removePreset,
} from './paddle-service.js'
export type { OcrPreset } from './presets.js'
export {
    DEFAULT_OCR_PRESET,
    isKnownPreset,
    PADDLE_OCR_PRESETS,
    presetsForScript,
    validatePreset,
} from './presets.js'
export type { DetectedScript, OsdReading, OsdSource } from './script-detect.js'
export {
    detectOsd,
    detectScript,
    disposeScriptDetection,
    loadScriptDetection,
    suggestPresets,
} from './script-detect.js'
export type { TesseractScriptDetectorParams } from './script-detect-stage.js'
export {
    TESSERACT_SCRIPT_DETECTOR_DEFAULTS,
    TesseractScriptDetector,
} from './script-detect-stage.js'
export type { TesseractOcrParams } from './tesseract.js'
export { DEFAULT_TESSDATA_URL, disposeTesseract, TESSERACT_OCR_DEFAULTS, TesseractOcr } from './tesseract.js'

export type { TesseractRecognizerParams } from './tesseract-recognizer.js'
export {
    TESSERACT_RECOGNIZER_DEFAULTS,
    TesseractRecognizer,
} from './tesseract-recognizer.js'
