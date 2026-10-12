/**
 * DBNet ONNX text detection -- the direct mirror of
 * `scaledp/models/detectors/DBNetOnnxDetector.py`, so ScaleDP's own detection
 * model runs unchanged in the browser.
 *
 * Preprocessing reproduces `paddle_onnx/operators.py` exactly, including one
 * quirk that matters: the Python path converts RGB to BGR and never converts
 * back, so the model is fed BGR channels normalised against *RGB* ImageNet
 * statistics. Feeding true RGB instead shifts the boxes.
 *
 * The model detects text *lines*, not words -- one region per line, in Python
 * as here. Nothing downstream subdivides them either: `TesseractRecognizer`
 * reads each region with PSM.SINGLE_WORD and returns one box per region, which
 * is what ScaleDP does too. `TesseractOcr`, which runs tesseract's own layout
 * analysis over the whole page, is the stage that yields word boxes.
 */

import { getConfig } from '../core/config.js'
import { DetectionError, upstreamError } from '../core/errors.js'
import {
    context2d,
    createCanvas,
    decodeImage,
    IMAGENET_MEAN,
    IMAGENET_STD,
    letterbox,
    toImageData,
    toNchwFloat32,
} from '../core/image.js'
import {
    ensureModelFiles,
    LazyLoad,
    type ModelRequirement,
    type ModelSpec,
    type ProgressListener,
} from '../core/model-cache.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import {
    type InitContext,
    ROW_TIME_COL,
    type Row,
    type RowTime,
    Stage,
    type StageContext,
} from '../core/pipeline.js'
import { type Box, boxFromPolygon, mergeOverlappingBoxes } from '../schemas/box.js'
import { createDetectorOutput, type DetectorOutput } from '../schemas/detector-output.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { DB_POSTPROCESS_DEFAULTS, type ProbabilityMap, quadsFromProbabilityMap } from './db-postprocess.js'
import { createSession } from './ort.js'

/** Fixed input size from ScaleDP's `DetResizeForTest` config. */
export const DBNET_INPUT_SIZE = 1280

/** The network's total stride: input sides must be a multiple of it. */
export const DBNET_STRIDE = 32

/**
 * Scale like the letterbox -- longer side to `limit`, never distorting -- but
 * pad bottom and right only to the next multiple of `stride`, not to a square.
 */
export function padToStride(
    source: ImageBitmap | OffscreenCanvas,
    limit: number,
    stride: number
): { canvas: OffscreenCanvas; scale: number } {
    const scale = Math.min(limit / source.width, limit / source.height)
    // Truncated as the letterbox truncates, so both paths draw the same pixels.
    const width = Math.trunc(source.width * scale)
    const height = Math.trunc(source.height * scale)
    const canvas = createCanvas(
        Math.max(stride, Math.ceil(width / stride) * stride),
        Math.max(stride, Math.ceil(height / stride) * stride)
    )
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(source, 0, 0, width, height)
    return { canvas, scale }
}

/** One picture's place on a packed input. */
export interface Placement {
    /** Index into the list of sizes `packSheets` was given. */
    item: number
    x: number
    y: number
    width: number
    height: number
    scale: number
}

/**
 * Lay pictures out on square sheets, shelf by shelf, tallest first.
 *
 * Each picture is scaled as ScaleDP would scale it on its own -- long side to
 * `side` -- but never enlarged past `maxScale`, which is what lets small ones
 * share a sheet. `gutter` pixels of white separate neighbours. A picture that
 * is alone on its sheet sits at its top-left corner, exactly where the
 * unpacked path would put it.
 */
export function packSheets(
    sizes: readonly { width: number; height: number }[],
    side: number,
    maxScale: number,
    gutter: number
): Placement[][] {
    const scaled = sizes.map((size, item) => {
        const scale = Math.min(side / size.width, side / size.height, maxScale)
        return {
            item,
            scale,
            width: Math.max(1, Math.trunc(size.width * scale)),
            height: Math.max(1, Math.trunc(size.height * scale)),
        }
    })
    const order = [...scaled].sort((a, b) => b.height - a.height || b.width - a.width)

    const sheets: Placement[][] = []
    let sheet: Placement[] = []
    let x = 0
    let shelfTop = 0
    let shelfHeight = 0
    for (const piece of order) {
        if (sheet.length > 0 && x + piece.width > side) {
            // Next shelf.
            shelfTop += shelfHeight + gutter
            x = 0
            shelfHeight = 0
        }
        if (sheet.length > 0 && shelfTop + piece.height > side) {
            sheets.push(sheet)
            sheet = []
            x = 0
            shelfTop = 0
            shelfHeight = 0
        }
        sheet.push({ ...piece, x, y: shelfTop })
        x += piece.width + gutter
        shelfHeight = Math.max(shelfHeight, piece.height)
    }
    if (sheet.length > 0) sheets.push(sheet)
    return sheets
}

/**
 * One picture's window of a packed probability map, with origin at its corner.
 *
 * It runs half the gutter past the picture's right and bottom edges: the
 * unpacked path sees white padding there, and a box unclipped past the edge
 * still scores against it. Nothing is added left or top, where the unpacked
 * picture also starts at the map's edge.
 */
function cropMap(map: ProbabilityMap, place: Placement, gutter: number): ProbabilityMap {
    const margin = Math.floor(gutter / 2)
    const width = Math.min(map.width - place.x, place.width + margin)
    const height = Math.min(map.height - place.y, place.height + margin)
    const data = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
        const from = (place.y + y) * map.width + place.x
        data.set(map.data.subarray(from, from + width), y * width)
    }
    return { data, width, height }
}

/** Add `ms` to a row's `row_time` under `stage`, copying the record as the base class does. */
function addRowTime(row: Row, stage: string, ms: number): void {
    const previous = row[ROW_TIME_COL] as RowTime | undefined
    const stages = { ...previous?.stages }
    stages[stage] = (stages[stage] ?? 0) + ms
    row[ROW_TIME_COL] = { stages, total: (previous?.total ?? 0) + ms }
}

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
     *
     * In practice it rarely changes anything for this model: the regions are
     * already whole lines and do not overlap. ScaleDP merges unconditionally
     * and its box count is likewise unchanged. Kept as a parameter because it
     * does matter for detectors that emit overlapping candidates.
     */
    mergeBoxes: boolean
    /**
     * Pad the resized image to the full 1280x1280 square, as ScaleDP does.
     *
     * Off (the default), it is padded only to the next multiple of 32, which
     * is all the network's strides need: up to 4x faster on a small or wide
     * picture (a 1000x300 crop: 450 -> 115 ms) and ~1.3x on a page. The image
     * is scaled the same either way. The default model was trained on padded
     * squares, though, and its output depends on the white around the text:
     * on the sample PDFs some boxes moved and lines split differently. Turn
     * it on to reproduce ScaleDP's boxes exactly.
     */
    squareInput: boolean
    /**
     * Detect several small pictures in one inference.
     *
     * Every call costs a full 1280x1280 run whatever the picture's size, so a
     * page with three embedded pictures -- a logo among them -- pays for three
     * pages. Packed, the pictures a page was cut into share square inputs,
     * each surrounded by white as the model expects, separated by
     * `packGutter` pixels of it. Sharing needs them smaller than ScaleDP's
     * scale, which blows every picture up to 1280 on its long side; packing
     * caps that upscale at `packMaxScale`. A picture too large to share still
     * gets an input to itself, laid out exactly as without packing.
     */
    pack: boolean
    /** Most a picture is enlarged when packing. ScaleDP enlarges without limit. */
    packMaxScale: number
    /** White between packed pictures, in model pixels. */
    packGutter: number
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
    squareInput: false,
    pack: false,
    packMaxScale: 2,
    packGutter: 64,
})

/** The files a DBNet `model` param names: a repo's `model.onnx`, or a URL. */
export function dbnetSpec(model: string): ModelSpec {
    return /^https?:\/\//.test(model)
        ? { repo: 'dbnet', files: [{ path: model }] }
        : { repo: model, files: [{ path: 'model.onnx' }] }
}

export class DbnetOnnxDetector extends Stage<DbnetOnnxDetectorParams> {
    readonly name = 'DbnetOnnxDetector'

    private readonly session = new LazyLoad<import('onnxruntime-web').InferenceSession>(
        () => this.params.model
    )

    constructor(options: Partial<DbnetOnnxDetectorParams> = {}) {
        super(resolveParams(DBNET_DETECTOR_DEFAULTS, options))
    }

    override async init(ctx?: InitContext): Promise<void> {
        await this.getSession(ctx?.onProgress)
    }

    override async requiredModels(): Promise<ModelRequirement[]> {
        return [{ label: this.params.model, spec: dbnetSpec(this.params.model) }]
    }

    private getSession(onProgress?: ProgressListener): Promise<import('onnxruntime-web').InferenceSession> {
        return this.session.get(async (emit) => {
            const spec = dbnetSpec(this.params.model)
            const files = await ensureModelFiles(spec, { onProgress: emit, building: true })
            const bytes = files[spec.files[0]?.path ?? '']
            if (!bytes) throw new DetectionError(`Model ${this.params.model} not found`, this.name)

            return createSession(bytes, {
                executionProviders: this.runtime.executionProviders ?? getConfig().executionProviders,
            })
        }, onProgress)
    }

    override async dispose(): Promise<void> {
        await this.session.reset()?.release()
    }

    protected async apply(input: unknown, row: Row): Promise<DetectorOutput> {
        const image = input as ScaleDpImage | undefined
        // Check `exception` first. A failed upstream stage returns a well-formed but
        // empty Image, so testing the bytes first would report "no decoded bytes" and
        // bury the real cause.
        if (image?.exception) {
            throw upstreamError(
                image.exception,
                this.name,
                (message) => new DetectionError(message, this.name)
            )
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new DetectionError('Expected an Image with decoded bytes', this.name)
        }

        let boxes: Box[]
        const packed = this.packed?.get(row)
        if (packed instanceof Error) throw packed
        if (packed) {
            boxes = packed
        } else {
            const bitmap = await decodeImage(image.data)
            try {
                boxes = await this.detect(bitmap)
            } finally {
                bitmap.close()
            }
        }

        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'dbnet-onnx',
            bboxes: boxes,
        })
    }

    /** Run the model over one decoded image and return boxes in its coordinates. */
    async detect(source: ImageBitmap | OffscreenCanvas): Promise<Box[]> {
        // Scale so the longer side fits 1280, padding bottom and right only
        // with white. Because nothing is padded at the top or left,
        // coordinates restore by dividing by the scale with no offset.
        const fitted = this.params.squareInput
            ? letterbox(
                  source,
                  { width: DBNET_INPUT_SIZE, height: DBNET_INPUT_SIZE },
                  { padding: 'end', fill: '#ffffff' }
              )
            : padToStride(source, DBNET_INPUT_SIZE, DBNET_STRIDE)
        const map = await this.infer(fitted.canvas)
        return this.finish(this.quads(map, { width: source.width, height: source.height }, fitted.scale))
    }

    /** The probability map for one prepared input canvas. */
    private async infer(canvas: OffscreenCanvas): Promise<ProbabilityMap> {
        const session = await this.getSession()
        const inputHeight = canvas.height
        const inputWidth = canvas.width
        const tensorData = toNchwFloat32(toImageData(canvas), {
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
            [inputName]: new Tensor('float32', tensorData, [1, 3, inputHeight, inputWidth]),
        })
        const output = outputs[outputName]
        if (!output) throw new DetectionError(`Model produced no "${outputName}" output`, this.name)

        // Output is [N, 1, H, W]; the first channel is the probability map.
        const [, , height = inputHeight, width = inputWidth] = output.dims
        return { data: output.data as Float32Array, width, height }
    }

    private quads(map: ProbabilityMap, source: { width: number; height: number }, scale: number) {
        return quadsFromProbabilityMap(map, source, scale, {
            thresh: this.params.binaryThreshold,
            boxThresh: this.params.scoreThreshold,
            unclipRatio: this.params.unclipRatio,
        })
    }

    private finish(quads: { points: [number, number][]; score: number }[]): Box[] {
        const boxes = quads.map((quad) => boxFromPolygon(quad.points, { score: quad.score }))
        return this.params.mergeBoxes ? mergeOverlappingBoxes(boxes, 0.02, 10, 0.3) : boxes
    }

    /**
     * With `pack`, detect every row's picture first, several to an input, then
     * let the base class wire the results into the rows.
     */
    override async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        if (!this.params.pack || rows.length < 2) return super.transform(rows, ctx)

        const started = performance.now()
        this.packed = await this.detectPacked(rows)
        const elapsed = performance.now() - started
        try {
            const out = await super.transform(rows, ctx)
            // The inference ran before the per-row pass, so its time is added
            // to the rows here, shared evenly like an expanding stage's.
            for (const row of out) addRowTime(row, this.name, elapsed / out.length)
            return out
        } finally {
            this.packed = null
        }
    }

    /** Boxes per input row, by identity, for rows whose picture was packed. */
    private packed: Map<Row, Box[] | Error> | null = null

    private async detectPacked(rows: Row[]): Promise<Map<Row, Box[] | Error>> {
        const results = new Map<Row, Box[] | Error>()
        const items: { row: Row; bitmap: ImageBitmap }[] = []
        try {
            for (const row of rows) {
                const image = row[this.params.inputCol] as ScaleDpImage | undefined
                // Anything the per-row path would reject is left to it, so it
                // fails with the same message it always has.
                if (
                    !image ||
                    image.exception ||
                    !(image.data instanceof Uint8Array) ||
                    image.data.byteLength === 0
                ) {
                    continue
                }
                items.push({ row, bitmap: await decodeImage(image.data) })
            }

            const sheets = packSheets(
                items.map(({ bitmap }) => ({ width: bitmap.width, height: bitmap.height })),
                DBNET_INPUT_SIZE,
                this.params.packMaxScale,
                this.params.packGutter
            )
            for (const sheet of sheets) {
                try {
                    const canvas = createCanvas(DBNET_INPUT_SIZE, DBNET_INPUT_SIZE)
                    const context = context2d(canvas)
                    context.fillStyle = '#ffffff'
                    context.fillRect(0, 0, canvas.width, canvas.height)
                    for (const place of sheet) {
                        const { bitmap } = items[place.item] as { bitmap: ImageBitmap }
                        context.drawImage(bitmap, place.x, place.y, place.width, place.height)
                    }

                    const map = await this.infer(canvas)
                    for (const place of sheet) {
                        const { row, bitmap } = items[place.item] as { row: Row; bitmap: ImageBitmap }
                        // Each picture is post-processed on its own window of
                        // the map, through the same call the unpacked path
                        // makes, so a picture alone on its sheet comes out
                        // exactly as it would unpacked.
                        const window = sheet.length === 1 ? map : cropMap(map, place, this.params.packGutter)
                        const quads = this.quads(
                            window,
                            { width: bitmap.width, height: bitmap.height },
                            place.scale
                        )
                        results.set(row, this.finish(quads))
                    }
                } catch (error) {
                    // One input failing fails the pictures on it, not the page.
                    const failure = error instanceof Error ? error : new Error(String(error))
                    for (const place of sheet) results.set((items[place.item] as { row: Row }).row, failure)
                }
            }
        } finally {
            for (const { bitmap } of items) bitmap.close()
        }
        return results
    }

    protected onError(message: string, row: Row): DetectorOutput {
        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'dbnet-onnx',
            exception: message,
        })
    }
}
