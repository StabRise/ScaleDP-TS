/**
 * Writing-script detection via Tesseract's OSD model.
 *
 * Kept separate from recognition on purpose: when the recognition model is
 * wrong for the page the text comes back garbled, and that is precisely when
 * knowing the script is most useful. Running OSD independently means the
 * answer stays trustworthy.
 *
 * Feeds the preset picker -- see `presetsForScript`.
 */

import { OcrError } from '../core/errors.js'
import { decodeImage, imageDataToCanvas, toImageData } from '../core/image.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { type OcrPreset, presetsForScript } from './presets.js'

export interface DetectedScript {
    /** Script name as Tesseract reports it, e.g. 'Latin', 'Cyrillic', 'Han'. */
    script: string
    /** Tesseract's own confidence; not a probability. */
    confidence: number
}

type TesseractJs = typeof import('tesseract.js')
type OsdWorker = Awaited<ReturnType<TesseractJs['createWorker']>>

let workerPromise: Promise<OsdWorker> | null = null

async function getOsdWorker(): Promise<OsdWorker> {
    if (workerPromise) return workerPromise

    workerPromise = (async () => {
        let mod: TesseractJs
        try {
            mod = await import('tesseract.js')
        } catch (cause) {
            throw new Error('tesseract.js is required for script detection. Install it: npm i tesseract.js', {
                cause,
            })
        }
        // OEM 0 (legacy engine) is the only one that carries OSD data.
        return mod.createWorker('osd', mod.OEM.TESSERACT_ONLY)
    })()

    workerPromise.catch(() => {
        workerPromise = null
    })
    return workerPromise
}

/** Detect the dominant writing script on a page. Returns null when unsure. */
export async function detectScript(
    source: ImageBitmap | OffscreenCanvas | ImageData | ScaleDpImage
): Promise<DetectedScript | null> {
    const worker = await getOsdWorker()

    let canvas: OffscreenCanvas
    if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) {
        canvas = source
    } else if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
        canvas = imageDataToCanvas(source)
    } else if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
        canvas = imageDataToCanvas(toImageData(source))
    } else {
        const image = source as ScaleDpImage
        if (!(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new OcrError('Expected an Image with decoded bytes', 'detectScript')
        }
        const bitmap = await decodeImage(image.data)
        try {
            canvas = imageDataToCanvas(toImageData(bitmap))
        } finally {
            bitmap.close()
        }
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const { data } = await worker.detect(blob)
    if (!data?.script) return null
    return { script: data.script, confidence: data.script_confidence ?? 0 }
}

/** Presets able to read the detected script, best-first. */
export async function suggestPresets(
    source: ImageBitmap | OffscreenCanvas | ImageData | ScaleDpImage
): Promise<OcrPreset[]> {
    const detected = await detectScript(source)
    return detected ? presetsForScript(detected.script) : []
}

/** Tear down the shared OSD worker. */
export async function disposeScriptDetection(): Promise<void> {
    const pending = workerPromise
    workerPromise = null
    await pending?.then((w) => w.terminate()).catch(() => undefined)
}
