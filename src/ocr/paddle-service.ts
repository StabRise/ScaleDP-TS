/**
 * PaddleOcrService lifecycle: model fetching, caching and per-preset reuse.
 *
 * Models are pulled through our own ModelCache and handed to the service as
 * ArrayBuffers, rather than letting ppu-paddle-ocr fetch them itself. Its
 * browser build re-downloads ~6 MB on every page load, relying only on the HTTP
 * cache; routing through IndexedDB makes a repeat visit instant and offline-safe.
 */

import { getConfig } from '../core/config.js'
import type { ModelSpec } from '../core/model-cache.js'
import { ensureModelFiles, evict, isCached } from '../core/model-cache.js'
import { loadOrt } from './ort.js'
import { DEFAULT_OCR_PRESET } from './presets.js'

type PpuWeb = typeof import('ppu-paddle-ocr/web')
type PaddleOcrService = InstanceType<PpuWeb['PaddleOcrService']>

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
    await evict(spec)
}

/** Tear down every cached service. */
export async function disposePaddleServices(): Promise<void> {
    const pending = [...services.values()]
    services.clear()
    await Promise.all(pending.map((p) => p.then((s) => s.destroy()).catch(() => undefined)))
}
