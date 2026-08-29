/** Port of `scaledp/schemas/DetectorOutput.py`. */

import type { Box } from './box.js'

export interface DetectorOutput {
    path: string
    /** Engine that produced the boxes: 'paddle' | 'dbnet-onnx' | 'yolo' | 'tesseract' | ... */
    type: string
    bboxes: Box[]
    exception: string
}

export function createDetectorOutput(init: Partial<DetectorOutput> = {}): DetectorOutput {
    return {
        path: init.path ?? 'memory',
        type: init.type ?? 'detector',
        bboxes: init.bboxes ?? [],
        exception: init.exception ?? '',
    }
}
