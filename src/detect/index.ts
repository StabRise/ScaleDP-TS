/**
 * Object detection for @stabrise/scaledp.
 *
 * Mirrors ScaleDP's YOLO detector stages. Requires the optional peer dependency
 * `onnxruntime-web`.
 */

import { YOLO_DETECTOR_DEFAULTS, YoloOnnxDetector, type YoloOnnxDetectorParams } from './yolo-onnx.js'

export type { Detection, YoloOnnxDetectorParams } from './yolo-onnx.js'
export {
    DEFAULT_YOLO_INPUT,
    decodeYoloOutput,
    iou,
    nonMaximumSuppression,
    YOLO_DETECTOR_DEFAULTS,
    YoloOnnxDetector,
} from './yolo-onnx.js'

/** Signature detection, mirroring ScaleDP's `SignatureDetector`. */
export class SignatureDetector extends YoloOnnxDetector {
    override readonly name = 'SignatureDetector'

    constructor(options: Partial<YoloOnnxDetectorParams> = {}) {
        super({
            ...YOLO_DETECTOR_DEFAULTS,
            model: 'StabRise/signature_detection',
            labels: ['signature'],
            outputCol: 'signatures',
            outputType: 'signature',
            scoreThreshold: 0.2,
            ...options,
        })
    }
}

/** Face detection, mirroring ScaleDP's `FaceDetector`. */
export class FaceDetector extends YoloOnnxDetector {
    override readonly name = 'FaceDetector'

    constructor(options: Partial<YoloOnnxDetectorParams> = {}) {
        super({
            ...YOLO_DETECTOR_DEFAULTS,
            model: 'StabRise/face_detection',
            labels: ['face'],
            outputCol: 'faces',
            outputType: 'face',
            scoreThreshold: 0.2,
            ...options,
        })
    }
}
