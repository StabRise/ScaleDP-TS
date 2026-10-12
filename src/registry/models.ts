/**
 * The models a pipeline will download, before it runs.
 *
 * Every stage reports what it needs (`Stage.requiredModels()`); this gathers
 * those for a whole pipeline, merges the ones that share files, and answers
 * the questions a settings panel or a "first run downloads 349 MB" notice
 * asks: what, how big, already here or not. Then it can fetch them ahead of
 * time, or delete them.
 *
 * Prefetching on the main thread and running in a worker works out of the
 * box: the cache is IndexedDB, which every realm of an origin shares, and
 * downloads are coordinated across realms (see `ensureModelFiles`), so the
 * worker reads what the main thread fetched rather than fetching it again.
 */

import type { ModelProgress } from '../core/config.js'
import {
    cacheKey,
    downloadSize,
    ensureModelFiles,
    evict,
    isCached,
    type ModelSpec,
    type ProgressListener,
} from '../core/model-cache.js'
import { Pipeline, type StageDescriptor } from '../core/pipeline.js'
import { pipelineFromDescriptors } from './index.js'

export interface PipelineModel {
    /** Stable identity: the repo and revision the files come from. */
    key: string
    /** A name for people. */
    label: string
    /** Every file of this model any of the pipeline's stages needs. */
    spec: ModelSpec
    /** Ids of the stages that need it. */
    stages: string[]
}

export interface PipelineModelsOptions {
    /** As `RunOptions.enabled`: a disabled stage's models are left out. */
    enabled?: Readonly<Record<string, boolean>>
}

/**
 * The models a pipeline's enabled stages need, one entry per repo.
 *
 * Two stages on one model share an entry -- PaddleOCR's recogniser-only stage
 * and its full detect-and-read stage on one preset are one download, since
 * they read the same cache keys. A stage gated by `when` is included: whether
 * any page will match is not known before the run.
 */
export async function pipelineModels(
    source: Pipeline | readonly StageDescriptor[],
    options: PipelineModelsOptions = {}
): Promise<PipelineModel[]> {
    const pipeline = source instanceof Pipeline ? source : pipelineFromDescriptors(source)
    const byKey = new Map<string, PipelineModel>()

    for (const entry of pipeline.entries) {
        const enabled = options.enabled?.[entry.id] ?? options.enabled?.[entry.stage.name] ?? entry.enabled
        if (!enabled) continue
        for (const requirement of await entry.stage.requiredModels()) {
            const key = `${requirement.spec.repo}@${requirement.spec.revision ?? 'main'}`
            const existing = byKey.get(key)
            if (!existing) {
                byKey.set(key, {
                    key,
                    label: requirement.label,
                    spec: { ...requirement.spec, files: [...requirement.spec.files] },
                    stages: [entry.id],
                })
                continue
            }
            if (!existing.stages.includes(entry.id)) existing.stages.push(entry.id)
            const have = new Set(existing.spec.files.map((file) => cacheKey(existing.spec, file.path)))
            const added = requirement.spec.files.filter(
                (file) => !have.has(cacheKey(requirement.spec, file.path))
            )
            // The requirement naming more of the model is the more general
            // name for it: "PaddleOCR v6-small" over "... (recognition)".
            if (added.length > 0 && requirement.spec.files.length > existing.spec.files.length) {
                existing.label = requirement.label
            }
            existing.spec.files.push(...added)
        }
    }
    return [...byKey.values()]
}

export interface ModelStatus extends PipelineModel {
    /** Every file is in the cache. */
    cached: boolean
    /** What the download comes to, from declared sizes or the server's; 0 when unknown. */
    bytes: number
}

/** Which of `models` are cached, and how large each is. */
export async function modelStatus(models: readonly PipelineModel[]): Promise<ModelStatus[]> {
    return Promise.all(
        models.map(async (model) => ({
            ...model,
            cached: await isCached(model.spec),
            bytes: await downloadSize(model.spec).catch(() => 0),
        }))
    )
}

export interface PrefetchOptions {
    /** Progress per model; each ends with `ready`. */
    onProgress?: (model: PipelineModel, progress: ModelProgress) => void
    /** Stops waiting. Downloads already shared with a run carry on into the cache. */
    signal?: AbortSignal
}

export interface PrefetchResult {
    model: PipelineModel
    ok: boolean
    error?: string
}

/**
 * Download `models` into the cache now, rather than on first use.
 *
 * Never throws for a model that cannot be fetched -- a private repo with no
 * token is a normal state for an app to show -- it reports `ok: false` with
 * the reason. Builds no sessions: the stages do that when they run.
 */
export async function prefetchModels(
    models: readonly PipelineModel[],
    options: PrefetchOptions = {}
): Promise<PrefetchResult[]> {
    return Promise.all(
        models.map(async (model) => {
            const onProgress: ProgressListener | undefined =
                options.onProgress && ((progress) => options.onProgress?.(model, progress))
            try {
                await ensureModelFiles(model.spec, { onProgress, signal: options.signal })
                return { model, ok: true }
            } catch (error) {
                options.signal?.throwIfAborted()
                return { model, ok: false, error: error instanceof Error ? error.message : String(error) }
            }
        })
    )
}

/** Delete `models`' files from the cache. */
export async function evictModels(models: readonly PipelineModel[]): Promise<void> {
    for (const model of models) await evict(model.spec)
}
