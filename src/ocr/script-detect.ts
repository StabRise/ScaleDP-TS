/**
 * Writing-script detection via Tesseract's OSD model.
 *
 * Kept separate from recognition on purpose: when the recognition model is
 * wrong for the page the text comes back garbled, and that is precisely when
 * knowing the script is most useful. Running OSD independently means the
 * answer stays trustworthy.
 *
 * Feeds the preset picker -- see `presetsForScript` -- and the
 * `TesseractScriptDetector` stage.
 */

import { getConfig } from '../core/config.js'
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

/**
 * One raw OSD reading.
 *
 * Every field is null together: tesseract.js resolves an all-null record when
 * its `DetectOS` call fails, which is what a blank page produces. That is a
 * result, not an error.
 */
export interface OsdReading {
    script: string | null
    script_confidence: number | null
    /** 0, 90, 180 or 270. */
    orientation_degrees: number | null
    orientation_confidence: number | null
}

/** Anything OSD can be run on. */
export type OsdSource = ImageBitmap | OffscreenCanvas | ImageData | ScaleDpImage

type TesseractJs = typeof import('tesseract.js')
type OsdWorker = Awaited<ReturnType<TesseractJs['createWorker']>>
type WorkerOptions = NonNullable<Parameters<TesseractJs['createWorker']>[2]>

let workerPromise: Promise<OsdWorker> | null = null
/** The config the live worker was built from; a change rebuilds it. */
let workerKey = ''

/**
 * tesseract.js asset paths, from `configure()`.
 *
 * Unset keys are omitted rather than passed as undefined, so tesseract.js falls
 * back to its own CDN defaults -- which is also why `gzip` is only forwarded
 * when it was actually configured: its default is true, and a self-hosted
 * directory of plain `.traineddata` needs false.
 */
function workerOptions(): Partial<WorkerOptions> {
    const { osdWorkerPath, osdCorePath, osdLangPath, osdGzip } = getConfig().tesseract
    const options: Partial<WorkerOptions> = {}
    if (osdWorkerPath) options.workerPath = osdWorkerPath
    if (osdCorePath) options.corePath = osdCorePath
    if (osdLangPath) options.langPath = osdLangPath
    if (osdGzip !== undefined) options.gzip = osdGzip
    return options
}

async function getOsdWorker(): Promise<OsdWorker> {
    const options = workerOptions()
    const key = JSON.stringify(options)
    if (workerPromise && workerKey === key) return workerPromise

    // A worker is bound to the paths it was built from, so a later configure()
    // means a fresh one rather than a stale answer from the old CDN.
    if (workerPromise) {
        const previous = workerPromise
        workerPromise = null
        await previous.then((w) => w.terminate()).catch(() => undefined)
    }

    workerKey = key
    workerPromise = (async () => {
        let mod: TesseractJs
        try {
            mod = await import('tesseract.js')
        } catch (cause) {
            throw new Error('tesseract.js is required for script detection. Install it: npm i tesseract.js', {
                cause,
            })
        }
        // OEM 0 (legacy engine) is the only one that carries OSD data. The
        // choice is made here and cannot be revised: tesseract.js picks the
        // legacy-capable core at createWorker time and throws on a later
        // reinitialize, so OSD needs a worker of its own.
        return mod.createWorker('osd', mod.OEM.TESSERACT_ONLY, options)
    })()

    workerPromise.catch(() => {
        workerPromise = null
    })
    return workerPromise
}

/**
 * Load the OSD worker without running a detection.
 *
 * Stage `init()` calls this so a missing peer dependency or an unreachable
 * model host is reported before the first page rather than during it.
 */
export async function loadScriptDetection(): Promise<void> {
    await getOsdWorker()
}

/** Draw any accepted source onto a canvas OSD can read. */
async function toCanvas(source: OsdSource): Promise<OffscreenCanvas> {
    if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return source
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) return imageDataToCanvas(source)
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
        return imageDataToCanvas(toImageData(source))
    }

    const image = source as ScaleDpImage
    if (!(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
        throw new OcrError('Expected an Image with decoded bytes', 'detectScript')
    }
    const bitmap = await decodeImage(image.data)
    try {
        return imageDataToCanvas(toImageData(bitmap))
    } finally {
        bitmap.close()
    }
}

/**
 * Run OSD and return what it reported, unmassaged.
 *
 * `orientation_degrees` is Tesseract's own mapping of its orientation id
 * through `[0, 270, 180, 90]` -- not `id * 90`. It is passed through.
 */
export async function detectOsd(source: OsdSource): Promise<OsdReading> {
    const worker = await getOsdWorker()
    const canvas = await toCanvas(source)

    // tesseract.js's loadImage handles OffscreenCanvas, Blob, File and strings,
    // and falls through to `new Uint8Array(image)` for anything else -- so a
    // bare ImageBitmap would fail. The blob is what makes the canvas readable.
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const { data } = await worker.detect(blob)
    return {
        script: data?.script ?? null,
        script_confidence: data?.script_confidence ?? null,
        orientation_degrees: data?.orientation_degrees ?? null,
        orientation_confidence: data?.orientation_confidence ?? null,
    }
}

/** Detect the dominant writing script on a page. Returns null when unsure. */
export async function detectScript(source: OsdSource): Promise<DetectedScript | null> {
    const osd = await detectOsd(source)
    if (!osd.script) return null
    return { script: osd.script, confidence: osd.script_confidence ?? 0 }
}

/** Presets able to read the detected script, best-first. */
export async function suggestPresets(source: OsdSource): Promise<OcrPreset[]> {
    const detected = await detectScript(source)
    return detected ? presetsForScript(detected.script) : []
}

/** Tear down the shared OSD worker. */
export async function disposeScriptDetection(): Promise<void> {
    const pending = workerPromise
    workerPromise = null
    workerKey = ''
    await pending?.then((w) => w.terminate()).catch(() => undefined)
}
