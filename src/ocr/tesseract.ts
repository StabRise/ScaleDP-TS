/**
 * Tesseract OCR, mirroring ScaleDP's `TesseractOcr` stage.
 *
 * Recognition runs on tesseract-wasm; script detection uses tesseract.js's OSD
 * model. The two are deliberately independent -- script detection still works
 * when the recognition model is wrong for the page and garbles the text, which
 * is exactly when you most want to know the script.
 *
 * Both the worker URL and the traineddata location come from `configure()`.
 * The pdftools prototype hardcoded `/tesseract-worker.js` and a raw GitHub URL,
 * neither of which a library can assume.
 */

import { getConfig } from '../core/config.js'
import { OcrError } from '../core/errors.js'
import { decodeImage, toImageData } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import { type Box, boxFromBBox } from '../schemas/box.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'

/** tessdata_fast is a good default: far smaller than tessdata, barely less accurate. */
export const DEFAULT_TESSDATA_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/'

export interface TesseractOcrParams extends BaseStageParams {
    /** Language codes, e.g. ['eng'] or ['eng', 'deu']. */
    lang: readonly string[]
    /** Drop words below this confidence (0-1). */
    scoreThreshold: number
    keepFormatting: boolean
    lineTolerance: number
}

export const TESSERACT_OCR_DEFAULTS: TesseractOcrParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'text',
    keepInputData: true,
    lang: ['eng'] as readonly string[],
    scoreThreshold: 0.5,
    keepFormatting: false,
    lineTolerance: 0,
})

type TesseractWasm = typeof import('tesseract-wasm')
type OcrClient = InstanceType<TesseractWasm['OCRClient']>

let clientPromise: Promise<OcrClient> | null = null
let loadedLanguage: string | null = null

function trainedDataUrl(lang: string): string {
    const base = (getConfig().tesseract.dataUrl ?? DEFAULT_TESSDATA_URL).replace(/\/?$/, '/')
    return `${base}${lang}.traineddata`
}

/**
 * The shared Tesseract client, loading the model for `lang` if needed.
 *
 * Exported so the crop-based recognizer reuses this one client rather than
 * standing up a second worker and loading the same traineddata twice.
 */
export async function getTesseractClient(lang: string): Promise<OcrClient> {
    if (clientPromise && loadedLanguage === lang) return clientPromise

    // A client holds one model; switching language means a fresh one.
    if (clientPromise) {
        const previous = clientPromise
        clientPromise = null
        await previous.then((c) => c.destroy()).catch(() => undefined)
    }

    loadedLanguage = lang
    clientPromise = (async () => {
        let mod: TesseractWasm
        try {
            mod = await import('tesseract-wasm')
        } catch (cause) {
            throw new Error(
                'tesseract-wasm is required for the Tesseract engine. Install it: npm i tesseract-wasm',
                { cause }
            )
        }

        const { workerUrl } = getConfig().tesseract
        const client = new mod.OCRClient(workerUrl ? { workerURL: workerUrl } : {})
        const response = await fetch(trainedDataUrl(lang))
        if (!response.ok) {
            throw new OcrError(
                `Failed to fetch ${lang}.traineddata: ${response.status} ${response.statusText}`,
                'TesseractOcr'
            )
        }
        await client.loadModel(new Uint8Array(await response.arrayBuffer()))
        return client
    })()

    clientPromise.catch(() => {
        clientPromise = null
        loadedLanguage = null
    })
    return clientPromise
}

/** Tear down the shared Tesseract client. */
export async function disposeTesseract(): Promise<void> {
    const pending = clientPromise
    clientPromise = null
    loadedLanguage = null
    await pending?.then((c) => c.destroy()).catch(() => undefined)
}

export class TesseractOcr extends Stage<TesseractOcrParams> {
    readonly name = 'TesseractOcr'

    constructor(options: Partial<TesseractOcrParams> = {}) {
        super(
            resolveParams(TESSERACT_OCR_DEFAULTS, options, {
                lang: (value) => {
                    if (value.length === 0) throw new RangeError('lang must not be empty')
                },
            })
        )
    }

    /** tesseract-wasm loads one model, so multi-language means a joined code. */
    private get language(): string {
        return this.params.lang.join('+')
    }

    override async init(): Promise<void> {
        await getTesseractClient(this.language)
    }

    protected async apply(input: unknown, row: Row): Promise<Document> {
        const image = input as ScaleDpImage | undefined
        // Check `exception` first. A failed upstream stage returns a well-formed but
        // empty Image, so testing the bytes first would report "no decoded bytes" and
        // bury the real cause.
        if (image?.exception) {
            throw new OcrError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new OcrError('Expected an Image with decoded bytes', this.name)
        }

        const client = await getTesseractClient(this.language)
        const bitmap = await decodeImage(image.data)
        let words: import('tesseract-wasm').TextItem[]
        try {
            await client.loadImage(toImageData(bitmap))
            // getTextBoxes, not getBoundingBoxes: the latter is layout analysis
            // only and returns geometry with no text and no confidence.
            words = await client.getTextBoxes('word')
        } finally {
            bitmap.close()
        }

        const { scoreThreshold, keepFormatting, lineTolerance } = this.params
        const bboxes: Box[] = words
            // tesseract-wasm reports confidence on a 0-1 scale, not 0-100.
            .filter((word) => word.confidence >= scoreThreshold && word.text.trim().length > 0)
            .map((word) =>
                boxFromBBox([word.rect.left, word.rect.top, word.rect.right, word.rect.bottom], {
                    text: word.text.trim(),
                    score: word.confidence,
                })
            )

        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'tesseract',
            text: keepFormatting ? boxesToFormattedText(bboxes, lineTolerance) : boxesToText(bboxes),
            bboxes,
        })
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'tesseract',
            exception: message,
        })
    }

    override async dispose(): Promise<void> {
        await disposeTesseract()
    }
}
