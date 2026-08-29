/**
 * PaddleOcrService lifecycle: model fetching, caching and per-preset reuse.
 *
 * Models are pulled through our own ModelCache and handed to the service as
 * ArrayBuffers, rather than letting ppu-paddle-ocr fetch them itself. Its
 * browser build re-downloads ~6 MB on every page load, relying only on the HTTP
 * cache; routing through IndexedDB makes a repeat visit instant and offline-safe.
 *
 * Two entry points, because the two halves of a preset are separable:
 * `getPaddleService` builds the full detect-then-read service, while
 * `getPaddleRecognizer` loads only the recognition model and its dictionary --
 * what `PaddleRecognizer` needs when some other detector already found the
 * boxes. Both key their cache on the same repo, so a pipeline using both pays
 * for each file once.
 */

import { getConfig } from '../core/config.js'
import type { ModelSpec } from '../core/model-cache.js'
import { ensureModelFiles, evict, isCached } from '../core/model-cache.js'
import { createSession, loadOrt } from './ort.js'
import { DEFAULT_OCR_PRESET } from './presets.js'

type OrtSession = Awaited<ReturnType<typeof createSession>>

type PpuWeb = typeof import('ppu-paddle-ocr/web')
type PaddleOcrService = InstanceType<PpuWeb['PaddleOcrService']>

/**
 * ppu's recognition half, bound to a session: `run(canvas, boxes)` reads the
 * regions it is handed and does no detection of its own.
 */
export type PaddleRecognitionService = InstanceType<PpuWeb['RecognitionService']>

/** Recognition tuning a stage may vary without paying for a second session. */
export interface PaddleRecognizerOptions {
    /** Crops per batched inference. 1 disables batching. */
    recBatchSize?: number
    /** Recover inter-word spaces the greedy CTC decode drops. */
    spaceRecovery?: boolean
}

let modulePromise: Promise<PpuWeb> | null = null

async function loadPpu(): Promise<PpuWeb> {
    if (modulePromise) return modulePromise
    modulePromise = (async () => {
        // ORT must be configured before ppu-paddle-ocr creates any session,
        // otherwise its own wasmPaths default wins the "if unset" check.
        await loadOrt()
        try {
            return await import('ppu-paddle-ocr/web')
        } catch (cause) {
            throw new Error(
                'ppu-paddle-ocr is required for PaddleOCR stages. Install it: npm i ppu-paddle-ocr',
                { cause }
            )
        }
    })()
    return modulePromise
}

/** The three files a preset needs, as a ModelSpec our cache understands. */
async function specForPreset(preset: string): Promise<{ spec: ModelSpec; roles: string[] }> {
    const ppu = await loadPpu()
    const urls =
        preset in ppu.MODEL_PRESETS
            ? ppu.MODEL_PRESETS[preset as keyof typeof ppu.MODEL_PRESETS]
            : ppu.DEFAULT_MODEL

    const roles = ['detection', 'recognition', 'charactersDictionary'] as const
    // ppu gives absolute URLs; the cache keys on repo-relative paths, so the
    // full URL doubles as the key and `modelHost` is bypassed for these.
    return {
        spec: { repo: `ppu-paddle-ocr/${preset}`, files: roles.map((r) => ({ path: urls[r] })) },
        roles: [...roles],
    }
}

/**
 * Absolute model URLs bypass `modelHost`: ppu-paddle-ocr publishes its own
 * catalogue and the paths are meaningful only against that host.
 */
async function fetchPresetFiles(preset: string): Promise<Record<string, ArrayBuffer>> {
    const { spec, roles } = await specForPreset(preset)
    const files = await ensureModelFiles({
        ...spec,
        files: spec.files.map((f) => ({ ...f })),
    })
    const out: Record<string, ArrayBuffer> = {}
    for (const [i, role] of roles.entries()) {
        const path = spec.files[i]?.path
        if (path && files[path]) out[role] = files[path] as ArrayBuffer
    }
    return out
}

// Keyed by preset: switching language keeps the previous service alive, so
// toggling back is instant rather than a re-download plus re-init.
const services = new Map<string, Promise<PaddleOcrService>>()

export async function getPaddleService(preset = DEFAULT_OCR_PRESET): Promise<PaddleOcrService> {
    const existing = services.get(preset)
    if (existing) return existing

    const promise = (async () => {
        const ppu = await loadPpu()
        const model = await fetchPresetFiles(preset)
        const service = new ppu.PaddleOcrService({
            model,
            session: {
                executionProviders: [...getConfig().executionProviders] as never,
                graphOptimizationLevel: 'all',
            },
        })
        await service.initialize()
        return service
    })()

    // Evict on failure so a transient network error is retried rather than
    // cached as a permanently rejected promise.
    promise.catch(() => services.delete(preset))
    services.set(preset, promise)
    return promise
}

/**
 * The recognition ONNX session and its character dictionary, per preset.
 *
 * Deliberately separate from `services`: a recognizer running behind someone
 * else's detector never needs the detection model, and skipping it saves a
 * download of a few MB. The cache `repo` is the same either way, so the two
 * files are shared with the full service rather than stored twice.
 */
const recognitionAssets = new Map<string, Promise<{ session: OrtSession; dictionary: string[] }>>()

/**
 * Split a PaddleOCR dictionary into an ordered array, one entry per line.
 *
 * ppu exports `parseDictionary` from a module its `exports` map does not
 * publish, so this reproduces it -- and it is the whole of it. Blank entries
 * are preserved: the index is the class id the model emits, so dropping one
 * would shift every character after it.
 */
function parseDictionary(source: ArrayBuffer): string[] {
    return new TextDecoder('utf-8').decode(source).split(/\r?\n/)
}

async function loadRecognitionAssets(preset: string): Promise<{ session: OrtSession; dictionary: string[] }> {
    const existing = recognitionAssets.get(preset)
    if (existing) return existing

    const promise = (async () => {
        // Nothing below imports ppu, but loading it first keeps the "ORT
        // configured before any session exists" ordering `loadPpu` enforces --
        // and importing `ppu-paddle-ocr/web` is also what registers ppu-ocv's
        // web canvas platform, which the crop path needs. Skipping
        // `PaddleOcrService.initialize()` skips nothing else: the web recognizer
        // runs the canvas-native engine and never touches OpenCV.
        await loadPpu()
        const { spec, roles } = await specForPreset(preset)
        // Same `spec.repo`, so these two land on the cache keys the full
        // service already uses -- the detection file is simply never asked for.
        const wanted = ['recognition', 'charactersDictionary'].map(
            (role) => spec.files[roles.indexOf(role)]?.path ?? ''
        )
        const files = await ensureModelFiles({ ...spec, files: wanted.map((path) => ({ path })) })
        const model = files[wanted[0] as string]
        const dict = files[wanted[1] as string]
        if (!model || !dict) {
            throw new Error(`PaddleOCR preset "${preset}" is missing its recognition model or dictionary.`)
        }

        const dictionary = parseDictionary(dict)
        if (dictionary.length === 0) {
            throw new Error(`PaddleOCR preset "${preset}" has an empty character dictionary.`)
        }
        // WebGPU cannot run PP-OCR's recognition graph -- it rewrites the
        // convolutions into `com.ms.internal.nhwc` and has no kernel for them,
        // which fails at session creation. `PaddleOcrService` retries on WASM
        // for exactly this, so a session built here has to as well.
        return { session: await createSession(model, { fallbackToWasm: true }), dictionary }
    })()

    promise.catch(() => recognitionAssets.delete(preset))
    recognitionAssets.set(preset, promise)
    return promise
}

/**
 * Recognition only: read the regions you hand it, no detection.
 *
 * `minimumConfidence` is pinned to 0 and `maxCropSourceSideLength` is set past
 * any canvas we pass. ppu would otherwise silently drop low-scoring results --
 * breaking the caller's box-to-result mapping, since `run` also sorts what it
 * returns into reading order -- and downscale a tall batch of stacked crops.
 * Filtering is the calling stage's job, where the threshold is a parameter.
 */
export async function getPaddleRecognizer(
    preset = DEFAULT_OCR_PRESET,
    options: PaddleRecognizerOptions = {}
): Promise<PaddleRecognitionService> {
    const ppu = await loadPpu()
    const { session, dictionary } = await loadRecognitionAssets(preset)
    return new ppu.RecognitionService(session, {
        charactersDictionary: dictionary,
        minimumConfidence: 0,
        maxCropSourceSideLength: Number.MAX_SAFE_INTEGER,
        ...(options.recBatchSize === undefined ? {} : { recBatchSize: options.recBatchSize }),
        ...(options.spaceRecovery === undefined ? {} : { spaceRecovery: options.spaceRecovery }),
    })
}

async function releaseRecognition(preset: string): Promise<void> {
    const pending = recognitionAssets.get(preset)
    if (!pending) return
    recognitionAssets.delete(preset)
    await pending.then(({ session }) => session.release()).catch(() => undefined)
}

export async function isPresetCached(preset: string): Promise<boolean> {
    const { spec } = await specForPreset(preset)
    return isCached(spec)
}

/** Pre-warm a preset so the first OCR call does not pay the download. */
export async function loadPreset(preset: string): Promise<void> {
    await getPaddleService(preset)
}

export async function removePreset(preset: string): Promise<void> {
    const { spec } = await specForPreset(preset)
    const service = services.get(preset)
    services.delete(preset)
    await service?.then((s) => s.destroy()).catch(() => undefined)
    await releaseRecognition(preset)
    await evict(spec)
}

/** Tear down every cached service, recognition-only sessions included. */
export async function disposePaddleServices(): Promise<void> {
    const pending = [...services.values()]
    services.clear()
    const recognition = [...recognitionAssets.keys()]
    await Promise.all([
        ...pending.map((p) => p.then((s) => s.destroy()).catch(() => undefined)),
        ...recognition.map((preset) => releaseRecognition(preset)),
    ])
}
