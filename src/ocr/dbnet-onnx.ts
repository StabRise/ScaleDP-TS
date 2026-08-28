/**
 * DBNet ONNX text detection -- the direct mirror of
 * `scaledp/models/detectors/DBNetOnnxDetector.py`, so ScaleDP's own detection
 * model runs unchanged in the browser.
 *
 * Preprocessing reproduces `paddle_onnx/operators.py` exactly, including one
 * quirk that matters: the Python path converts RGB to BGR and never converts
 * back, so the model is fed BGR channels normalised against *RGB* ImageNet
 * statistics. Feeding true RGB instead shifts the boxes.
 */

import { getConfig } from '../core/config.js'
import { DetectionError } from '../core/errors.js'
import {
    decodeImage,
    IMAGENET_MEAN,
    IMAGENET_STD,
    letterbox,
    toImageData,
    toNchwFloat32,
} from '../core/image.js'
import { ensureModelFiles, type ModelSpec } from '../core/model-cache.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import { type Box, boxFromPolygon, mergeOverlappingBoxes } from '../schemas/box.js'
import { createDetectorOutput, type DetectorOutput } from '../schemas/detector-output.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { DB_POSTPROCESS_DEFAULTS, type ProbabilityMap, quadsFromProbabilityMap } from './db-postprocess.js'
import { createSession } from './ort.js'

/** Fixed input size from ScaleDP's `DetResizeForTest` config. */
export const DBNET_INPUT_SIZE = 1280

/** Model ScaleDP's DBNetOnnxDetector documents and its tests use. */
export const DEFAULT_DBNET_MODEL = 'StabRise/text_detection_dbnet_ml_v0.2'

export interface DbnetOnnxDetectorParams extends BaseStageParams {
    /** Hugging Face repo id, or a URL when self-hosting. */
    model: string
    /** Mean in-box probability a candidate must reach. */
    scoreThreshold: number
    /** Probability above which a pixel counts as text. */
    binaryThreshold: number
    /** How far to grow each box; DB shrinks text regions during training. */
    unclipRatio: number
    /**
     * Merge boxes that overlap and share a line. ScaleDP uses an unusually low
     * IoU of 0.02 here, because adjacent words in a line barely overlap.
     */
    mergeBoxes: boolean
}

export const DBNET_DETECTOR_DEFAULTS: DbnetOnnxDetectorParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'boxes',
    keepInputData: true,
    model: DEFAULT_DBNET_MODEL,
    scoreThreshold: DB_POSTPROCESS_DEFAULTS.boxThresh,
    binaryThreshold: DB_POSTPROCESS_DEFAULTS.thresh,
    unclipRatio: DB_POSTPROCESS_DEFAULTS.unclipRatio,
    mergeBoxes: true,
})

function modelSpec(model: string): ModelSpec {
    return /^https?:\/\//.test(model)
        ? { repo: 'dbnet', files: [{ path: model }] }
        : { repo: model, files: [{ path: 'model.onnx' }] }
}

export class DbnetOnnxDetector extends Stage<DbnetOnnxDetectorParams> {
    readonly name = 'DbnetOnnxDetector'

    private session: import('onnxruntime-web').InferenceSession | null = null
    private loading: Promise<import('onnxruntime-web').InferenceSession> | null = null

    constructor(options: Partial<DbnetOnnxDetectorParams> = {}) {
        super(resolveParams(DBNET_DETECTOR_DEFAULTS, options))
    }

    override async init(): Promise<void> {
        await this.getSession()
    }

    private getSession(): Promise<import('onnxruntime-web').InferenceSession> {
        if (this.session) return Promise.resolve(this.session)
        if (this.loading) return this.loading

        this.loading = (async () => {
            const spec = modelSpec(this.params.model)
            const files = await ensureModelFiles(spec)
            const bytes = files[spec.files[0]?.path ?? '']
            if (!bytes) throw new DetectionError(`Model ${this.params.model} not found`, this.name)

            const session = await createSession(bytes, {
                executionProviders: getConfig().executionProviders,
            })
            this.session = session
            return session
        })()

        // Clear on failure so a transient network error can be retried rather
        // than cached as a permanently rejected promise.
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
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new DetectionError('Expected an Image with decoded bytes', this.name)
        }
        if (image.exception) {
            throw new DetectionError(`Upstream stage failed: ${image.exception}`, this.name)
        }

        const bitmap = await decodeImage(image.data)
        let boxes: Box[]
        try {
            boxes = await this.detect(bitmap)
        } finally {
            bitmap.close()
        }

        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'dbnet-onnx',
            bboxes: boxes,
        })
    }

    /** Run the model over one decoded image and return boxes in its coordinates. */
    async detect(source: ImageBitmap | OffscreenCanvas): Promise<Box[]> {
        const session = await this.getSession()

        // Letterbox to a fixed 1280x1280, padding bottom and right only with
        // white. Because nothing is padded at the top or left, coordinates
        // restore by dividing by the scale with no offset to subtract.
        const fitted = letterbox(
            source,
            { width: DBNET_INPUT_SIZE, height: DBNET_INPUT_SIZE },
            {
                padding: 'end',
                fill: '#ffffff',
            }
        )
        const tensorData = toNchwFloat32(toImageData(fitted.canvas), {
            mean: IMAGENET_MEAN,
            std: IMAGENET_STD,
            bgr: true,
        })

        const { Tensor } = await import('onnxruntime-web')
        const inputName = session.inputNames[0]
        const outputName = session.outputNames[0]
        if (!inputName || !outputName) {
            throw new DetectionError('Model exposes no input or output', this.name)
        }

        const outputs = await session.run({
            [inputName]: new Tensor('float32', tensorData, [1, 3, DBNET_INPUT_SIZE, DBNET_INPUT_SIZE]),
        })
        const output = outputs[outputName]
        if (!output) throw new DetectionError(`Model produced no "${outputName}" output`, this.name)

        // Output is [N, 1, H, W]; the first channel is the probability map.
        const [, , height = DBNET_INPUT_SIZE, width = DBNET_INPUT_SIZE] = output.dims
        const map: ProbabilityMap = {
            data: output.data as Float32Array,
            width,
            height,
        }

        const quads = quadsFromProbabilityMap(
            map,
            { width: source.width, height: source.height },
            fitted.scale,
            {
                thresh: this.params.binaryThreshold,
                boxThresh: this.params.scoreThreshold,
                unclipRatio: this.params.unclipRatio,
            }
        )

        const boxes = quads.map((quad) => boxFromPolygon(quad.points, { score: quad.score }))
        return this.params.mergeBoxes ? mergeOverlappingBoxes(boxes, 0.02, 10, 0.3) : boxes
    }

    protected onError(message: string, row: Row): DetectorOutput {
        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'dbnet-onnx',
            exception: message,
        })
    }
}
