/**
 * YOLO object detection on onnxruntime-web.
 *
 * Mirrors `scaledp/models/detectors/YoloOnnxDetector.py`. Note the
 * preprocessing differs from the text detector: YOLO letterboxes with
 * *centred* padding and no mean/std normalisation, where DBNet pads bottom and
 * right and applies ImageNet statistics. Centred padding means the pad offsets
 * must be subtracted before unscaling.
 */

import { getConfig } from '../core/config.js'
import { DetectionError } from '../core/errors.js'
import { decodeImage, letterbox, toImageData, toNchwFloat32 } from '../core/image.js'
import { ensureModelFiles } from '../core/model-cache.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import { createSession } from '../ocr/ort.js'
import { type Box, boxFromBBox } from '../schemas/box.js'
import { createDetectorOutput, type DetectorOutput } from '../schemas/detector-output.js'
import type { ScaleDpImage } from '../schemas/image.js'

/** Fallback when the graph declares a symbolic input size. */
export const DEFAULT_YOLO_INPUT = 960

export interface YoloOnnxDetectorParams extends BaseStageParams {
    model: string
    /** Class index -> label. An empty list falls back to `class_<n>`. */
    labels: readonly string[]
    scoreThreshold: number
    /** IoU above which two same-class boxes are considered duplicates. */
    iouThreshold: number
    /** Grow each box by this fraction of its size, to avoid clipping edges. */
    padding: number
    /** Emitted as DetectorOutput.type. */
    outputType: string
}

export const YOLO_DETECTOR_DEFAULTS: YoloOnnxDetectorParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'boxes',
    keepInputData: true,
    model: '',
    labels: [] as readonly string[],
    scoreThreshold: 0.2,
    iouThreshold: 0.5,
    padding: 0,
    outputType: 'yolo',
})

export interface Detection {
    /** [x0, y0, x1, y1] in source-image coordinates. */
    bbox: [number, number, number, number]
    score: number
    classId: number
    label: string
}

/** Axis-aligned IoU over xyxy boxes. */
export function iou(a: readonly number[], b: readonly number[]): number {
    const x0 = Math.max(a[0] as number, b[0] as number)
    const y0 = Math.max(a[1] as number, b[1] as number)
    const x1 = Math.min(a[2] as number, b[2] as number)
    const y1 = Math.min(a[3] as number, b[3] as number)
    if (x1 <= x0 || y1 <= y0) return 0

    const intersection = (x1 - x0) * (y1 - y0)
    const areaA = ((a[2] as number) - (a[0] as number)) * ((a[3] as number) - (a[1] as number))
    const areaB = ((b[2] as number) - (b[0] as number)) * ((b[3] as number) - (b[1] as number))
    const union = areaA + areaB - intersection
    return union <= 0 ? 0 : intersection / union
}

/** Per-class non-maximum suppression; different classes never suppress each other. */
export function nonMaximumSuppression(detections: readonly Detection[], iouThreshold: number): Detection[] {
    const byScore = [...detections].sort((a, b) => b.score - a.score)
    const kept: Detection[] = []
    for (const detection of byScore) {
        const suppressed = kept.some(
            (other) => other.classId === detection.classId && iou(other.bbox, detection.bbox) > iouThreshold
        )
        if (!suppressed) kept.push(detection)
    }
    return kept
}

/**
 * Decode a YOLO output tensor.
 *
 * Two layouts are handled, because exports differ:
 *  - [1, 4 + numClasses, numAnchors] -- the classic v8/v11 transposed form,
 *    with cx,cy,w,h then per-class scores.
 *  - [1, numDetections, 6] -- an end-to-end NMS export: x0,y0,x1,y1,score,class.
 */
export function decodeYoloOutput(
    data: Float32Array,
    dims: readonly number[],
    scoreThreshold: number
): { bbox: [number, number, number, number]; score: number; classId: number }[] {
    const out: { bbox: [number, number, number, number]; score: number; classId: number }[] = []

    if (dims.length === 3 && dims[2] === 6) {
        const count = dims[1] as number
        for (let i = 0; i < count; i++) {
            const o = i * 6
            const score = data[o + 4] as number
            if (score < scoreThreshold) continue
            out.push({
                bbox: [
                    data[o] as number,
                    data[o + 1] as number,
                    data[o + 2] as number,
                    data[o + 3] as number,
                ],
                score,
                classId: Math.round(data[o + 5] as number),
            })
        }
        return out
    }

    if (dims.length !== 3) {
        throw new DetectionError(`Unsupported YOLO output shape [${dims.join(', ')}]`, 'decodeYoloOutput')
    }

    const channels = dims[1] as number
    const anchors = dims[2] as number
    const classCount = channels - 4

    for (let a = 0; a < anchors; a++) {
        let best = -1
        let bestScore = 0
        for (let c = 0; c < classCount; c++) {
            const score = data[(4 + c) * anchors + a] as number
            if (score > bestScore) {
                bestScore = score
                best = c
            }
        }
        if (best < 0 || bestScore < scoreThreshold) continue

        const cx = data[a] as number
        const cy = data[anchors + a] as number
        const w = data[2 * anchors + a] as number
        const h = data[3 * anchors + a] as number
        out.push({
            bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
            score: bestScore,
            classId: best,
        })
    }
    return out
}

export class YoloOnnxDetector extends Stage<YoloOnnxDetectorParams> {
    // Annotated as string rather than inferred as a literal, so SignatureDetector
    // and FaceDetector can narrow it to their own names.
    readonly name: string = 'YoloOnnxDetector'

    private session: import('onnxruntime-web').InferenceSession | null = null
    private loading: Promise<import('onnxruntime-web').InferenceSession> | null = null
    private inputSize = DEFAULT_YOLO_INPUT

    constructor(options: Partial<YoloOnnxDetectorParams> = {}) {
        super(
            resolveParams(YOLO_DETECTOR_DEFAULTS, options, {
                model: (value) => {
                    if (!value) throw new RangeError('model is required')
                },
            })
        )
    }

    override async init(): Promise<void> {
        await this.getSession()
    }

    private getSession(): Promise<import('onnxruntime-web').InferenceSession> {
        if (this.session) return Promise.resolve(this.session)
        if (this.loading) return this.loading

        this.loading = (async () => {
            const { model } = this.params
            const spec = /^https?:\/\//.test(model)
                ? { repo: 'yolo', files: [{ path: model }] }
                : { repo: model, files: [{ path: 'model.onnx' }] }

            const files = await ensureModelFiles(spec)
            const bytes = files[spec.files[0]?.path ?? '']
            if (!bytes) throw new DetectionError(`Model ${model} not found`, this.name)

            const session = await createSession(bytes, {
                executionProviders: getConfig().executionProviders,
            })
            this.inputSize = readInputSize(session)
            this.session = session
            return session
        })()

        this.loading.catch(() => {
            this.loading = null
        })
        return this.loading
    }

    override async dispose(): Promise<void> {
        await this.session?.release()
        this.session = null
        this.loading = null
    }

    protected async apply(input: unknown, row: Row): Promise<DetectorOutput> {
        const image = input as ScaleDpImage | undefined
        // Check `exception` first. A failed upstream stage returns a well-formed but
        // empty Image, so testing the bytes first would report "no decoded bytes" and
        // bury the real cause.
        if (image?.exception) {
            throw new DetectionError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new DetectionError('Expected an Image with decoded bytes', this.name)
        }

        const bitmap = await decodeImage(image.data)
        let detections: Detection[]
        try {
            detections = await this.detect(bitmap)
        } finally {
            bitmap.close()
        }

        const bboxes: Box[] = detections.map((d) => boxFromBBox(d.bbox, { text: d.label, score: d.score }))
        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: this.params.outputType,
            bboxes,
        })
    }

    /** Run the model over one decoded image, returning source-space detections. */
    async detect(source: ImageBitmap | OffscreenCanvas): Promise<Detection[]> {
        const session = await this.getSession()
        const size = this.inputSize

        // Centred padding, no mean/std -- YOLO's convention, unlike DBNet's.
        const fitted = letterbox(
            source,
            { width: size, height: size },
            {
                padding: 'center',
                fill: '#ffffff',
            }
        )
        const tensorData = toNchwFloat32(toImageData(fitted.canvas))

        const { Tensor } = await import('onnxruntime-web')
        const inputName = session.inputNames[0]
        const outputName = session.outputNames[0]
        if (!inputName || !outputName) {
            throw new DetectionError('Model exposes no input or output', this.name)
        }

        const outputs = await session.run({
            [inputName]: new Tensor('float32', tensorData, [1, 3, size, size]),
        })
        const output = outputs[outputName]
        if (!output) throw new DetectionError(`Model produced no "${outputName}" output`, this.name)

        const raw = decodeYoloOutput(output.data as Float32Array, output.dims, this.params.scoreThreshold)

        const padX = Math.trunc((size - fitted.resized.width) / 2)
        const padY = Math.trunc((size - fitted.resized.height) / 2)
        const { labels, padding } = this.params

        const detections: Detection[] = raw.map(({ bbox, score, classId }) => {
            // Undo the centred pad first, then the scale.
            const x0 = (bbox[0] - padX) / fitted.scale
            const y0 = (bbox[1] - padY) / fitted.scale
            const x1 = (bbox[2] - padX) / fitted.scale
            const y1 = (bbox[3] - padY) / fitted.scale

            const padW = (x1 - x0) * padding
            const padH = (y1 - y0) * padding
            return {
                bbox: [
                    Math.max(0, x0 - padW),
                    Math.max(0, y0 - padH),
                    Math.min(source.width, x1 + padW),
                    Math.min(source.height, y1 + padH),
                ],
                score,
                classId,
                label: labels[classId] ?? `class_${classId}`,
            }
        })

        return nonMaximumSuppression(detections, this.params.iouThreshold)
    }

    protected onError(message: string, row: Row): DetectorOutput {
        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: this.params.outputType,
            exception: message,
        })
    }
}

/** Input side length from the graph, falling back when the dim is symbolic. */
function readInputSize(session: import('onnxruntime-web').InferenceSession): number {
    const meta = (
        session as unknown as {
            inputMetadata?: { dims?: (number | string)[] }[]
        }
    ).inputMetadata?.[0]
    const dims = meta?.dims
    const height = dims?.[2]
    return typeof height === 'number' && height > 0 ? height : DEFAULT_YOLO_INPUT
}
