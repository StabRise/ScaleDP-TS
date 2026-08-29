/**
 * Whether a stage's weights are already in this browser.
 *
 * The cache is IndexedDB, scoped per origin -- port included -- so a dev server
 * that moved to a different port has an empty cache and looks exactly like
 * caching being broken. Saying "downloads 349 MB on first run" before someone
 * commits to a run is the whole point of this.
 */

import { isCached } from '@stabrise/scaledp'
import { getNerModel, modelSizeBytes } from '@stabrise/scaledp/ner'
import { isPresetCached } from '@stabrise/scaledp/ocr'
import { getStageSpec } from '@stabrise/scaledp/registry'
import { effective, type StageNode } from '../store/pipeline'

export interface CacheState {
    ready: boolean
    label: string
}

const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`

/**
 * The model a stage would download, as a plain string.
 *
 * Kept separate from the probe so a component can depend on this value rather
 * than on the whole stage object -- otherwise editing an unrelated parameter
 * re-runs the probe.
 */
export function cacheTarget(stage: StageNode): string {
    const spec = getStageSpec(stage.type)
    if (!spec?.cache) return ''
    const value = effective(stage, spec.cache.param)
    return typeof value === 'string' ? value : ''
}

export async function probeCache(type: string, value: string): Promise<CacheState | null> {
    const spec = getStageSpec(type)
    if (!spec?.cache || !value) return null

    try {
        if (spec.cache.kind === 'paddle-preset') {
            const cached = await isPresetCached(value)
            return { ready: cached, label: cached ? 'cached' : 'downloads on first run' }
        }

        if (spec.cache.kind === 'ner-id') {
            const model = getNerModel(value)
            if (!model) return { ready: false, label: 'unknown model' }
            const cached = await isCached({ repo: model.repo, files: model.files })
            return {
                ready: cached,
                label: cached ? 'cached' : `downloads ${megabytes(modelSizeBytes(model))} on first run`,
            }
        }

        const approx = spec.cache.approxBytes ?? 0
        const cached = await isCached({
            repo: value,
            files: [{ path: 'model.onnx', approxBytes: approx }],
        })
        return {
            ready: cached,
            label: cached ? 'cached' : approx ? `downloads ~${megabytes(approx)}` : 'downloads on first run',
        }
    } catch {
        // A probe that fails says nothing useful; the run will report the truth.
        return null
    }
}
