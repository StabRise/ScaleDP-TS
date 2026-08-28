/**
 * 0 / 180 degree line-orientation classifier.
 *
 * Port of `scaledp/models/detectors/HasDetectLineOrientation.py`. Tiny, and it
 * meaningfully improves recognition on rotated crops -- an upside-down line
 * otherwise recognises as noise.
 *
 * Reproduces the same BGR-with-RGB-statistics quirk as the DBNet path: the
 * Python code converts to BGR and normalises with RGB ImageNet constants.
 */

import { DetectionError } from '../core/errors.js'
import {
    context2d,
    createCanvas,
    IMAGENET_MEAN,
    IMAGENET_STD,
    toImageData,
    toNchwFloat32,
} from '../core/image.js'
import { ensureModelFiles } from '../core/model-cache.js'
import { createSession } from './ort.js'

export const DEFAULT_ORIENTATION_MODEL = 'StabRise/line_orientation_detection_v0.1'

/** Model input, width x height. */
export const ORIENTATION_INPUT = { width: 160, height: 80 } as const

export type LineOrientation = '0_degree' | '180_degree'

const LABELS: readonly LineOrientation[] = ['0_degree', '180_degree']

export class LineOrientationClassifier {
    private session: import('onnxruntime-web').InferenceSession | null = null
    private loading: Promise<import('onnxruntime-web').InferenceSession> | null = null

    constructor(readonly model: string = DEFAULT_ORIENTATION_MODEL) {}

    private getSession(): Promise<import('onnxruntime-web').InferenceSession> {
        if (this.session) return Promise.resolve(this.session)
        if (this.loading) return this.loading

        this.loading = (async () => {
            const files = await ensureModelFiles({
                repo: this.model,
                files: [{ path: 'model.onnx' }],
            })
            const bytes = files['model.onnx']
            if (!bytes) {
                throw new DetectionError(`Model ${this.model} has no model.onnx`, 'LineOrientation')
            }
            const session = await createSession(bytes)
            this.session = session
            return session
        })()

        this.loading.catch(() => {
            this.loading = null
        })
        return this.loading
    }

    async classify(source: ImageBitmap | OffscreenCanvas): Promise<LineOrientation> {
        const session = await this.getSession()

        // Plain resize, not a letterbox: the Python path calls cv2.resize
        // directly and lets the aspect ratio distort.
        const canvas = createCanvas(ORIENTATION_INPUT.width, ORIENTATION_INPUT.height)
        context2d(canvas).drawImage(source, 0, 0, canvas.width, canvas.height)

        const data = toNchwFloat32(toImageData(canvas), {
            mean: IMAGENET_MEAN,
            std: IMAGENET_STD,
            bgr: true,
        })

        const { Tensor } = await import('onnxruntime-web')
        const inputName = session.inputNames[0]
        const outputName = session.outputNames[0]
        if (!inputName || !outputName) {
            throw new DetectionError('Model exposes no input or output', 'LineOrientation')
        }

        const outputs = await session.run({
            [inputName]: new Tensor('float32', data, [
                1,
                3,
                ORIENTATION_INPUT.height,
                ORIENTATION_INPUT.width,
            ]),
        })
        const logits = outputs[outputName]?.data as Float32Array | undefined
        if (!logits || logits.length < 2) {
            throw new DetectionError('Classifier produced no logits', 'LineOrientation')
        }

        return (logits[1] as number) > (logits[0] as number)
            ? (LABELS[1] as LineOrientation)
            : (LABELS[0] as LineOrientation)
    }

    async dispose(): Promise<void> {
        await this.session?.release()
        this.session = null
        this.loading = null
    }
}
