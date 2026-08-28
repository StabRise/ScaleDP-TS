/**
 * Text detectors that can run in the browser.
 *
 * Detection and recognition are separable in ScaleDP -- a detector stage feeds
 * boxes to a recognizer -- so which detector produced a page's boxes is a real
 * choice worth making addressable, the same way OCR presets and NER models are.
 */

export type DetectorKind = 'paddle' | 'dbnet-onnx'

export interface DetectorModel {
    /** Short id callers pass to the picker. */
    id: string
    /** Human-readable name including the download size. */
    name: string
    kind: DetectorKind
    /**
     * Hugging Face repo, for ONNX detectors. Paddle detectors come from the
     * OCR preset instead, so this is unset for them.
     */
    repo?: string
    approxBytes?: number
    notes: string
}

export const DETECTOR_MODELS: readonly DetectorModel[] = Object.freeze([
    {
        id: 'paddle',
        name: 'PaddleOCR DB (follows the OCR preset)',
        kind: 'paddle',
        notes: 'Shares the detection model already downloaded for the selected OCR preset.',
    },
    {
        id: 'dbnet-v0.2',
        name: 'StabRise DBNet ONNX v0.2 (~5 MB)',
        kind: 'dbnet-onnx',
        repo: 'StabRise/text_detection_dbnet_ml_v0.2',
        approxBytes: 4_800_000,
        notes: 'The same detection model ScaleDP uses server-side.',
    },
    {
        id: 'dbnet-v0.1',
        name: 'StabRise DBNet ONNX v0.1 (~5 MB)',
        kind: 'dbnet-onnx',
        repo: 'StabRise/text_detection_dbnet_ml_v0.1',
        approxBytes: 4_800_000,
        notes: 'The earlier revision, kept for comparison.',
    },
])

export const DEFAULT_DETECTOR_ID = 'paddle'

export function getDetectorModel(id: string): DetectorModel | undefined {
    return DETECTOR_MODELS.find((m) => m.id === id)
}
