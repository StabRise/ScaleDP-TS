/**
 * One download per origin, not per realm: the main thread and a worker asking
 * for the same model at the same time share one fetch through Web Locks, and
 * the one that waits still sees the download's progress.
 */
import { expect, it } from 'vitest'
import { configure, type ModelProgress } from '../../src/core/config.js'
import { cachedFiles, ensureModelFiles } from '../../src/core/model-cache.js'

it('downloads a model once for the page and its worker together', async () => {
    const db = `scaledp-share-test-${Date.now()}`
    const url = `${location.origin}/examples/pdfs/SampleWithFaceImage.pdf`
    configure({ cacheDbName: db, cache: 'indexeddb' })

    let gets = 0
    const realFetch = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') gets++
        return realFetch(input, init)
    }

    const worker = new Worker(new URL('./fixtures/model-worker.ts', import.meta.url), { type: 'module' })
    const fromWorker = new Promise<{ gets: number; phases: ModelProgress[]; bytes: number }>((resolve) => {
        worker.onmessage = (event) => resolve(event.data)
    })
    const phases: ModelProgress[] = []
    worker.postMessage({ url, db })
    const page = await ensureModelFiles(
        { repo: 'probe', files: [{ path: url }] },
        { onProgress: (p) => phases.push(p) }
    )
    const other = await fromWorker
    window.fetch = realFetch
    worker.terminate()

    const bytes = page[url]?.byteLength ?? 0
    expect(bytes).toBeGreaterThan(0)
    expect(other.bytes).toBe(bytes)
    // One GET between the two realms.
    expect(gets + other.gets).toBe(1)
    // Both finished, and the one that waited saw the bytes arrive.
    for (const seen of [phases, other.phases]) {
        expect(seen.at(-1)?.phase).toBe('ready')
        expect(seen.some((p) => p.phase === 'downloading' && p.loaded === bytes)).toBe(true)
    }
    expect((await cachedFiles()).map((f) => f.key)).toEqual([`probe@main/${url}`])
}, 60000)

it('merges Paddle stages on one preset, and prefetches, reports and evicts them', async () => {
    const { evictModels, modelStatus, pipelineModels, prefetchModels } = await import(
        '../../src/registry/index.js'
    )
    configure({ cacheDbName: `scaledp-manager-test-${Date.now()}`, cache: 'indexeddb' })
    const models = await pipelineModels([
        { type: 'PaddleRecognizer', options: { inputCols: ['image', 'boxes'], preset: 'v6-tiny' } },
        { type: 'PaddleTextDetector', options: { preset: 'v6-tiny' } },
    ])
    expect(models).toHaveLength(1)
    const [paddle] = models
    expect(paddle?.label).toBe('PaddleOCR v6-tiny')
    expect(paddle?.stages).toEqual(['PaddleRecognizer', 'PaddleTextDetector'])
    // Recognition and dictionary from one, detection added by the other.
    expect(paddle?.spec.files.map((f) => f.path.split('/').pop())).toEqual([
        'PP-OCRv6_tiny_rec.onnx',
        'ppocrv6_tiny_dict.txt',
        'PP-OCRv6_tiny_det.onnx',
    ])

    const [before] = await modelStatus(models)
    expect(before?.cached).toBe(false)
    expect(before?.bytes).toBeGreaterThan(1_000_000)

    const seen: string[] = []
    const [result] = await prefetchModels(models, { onProgress: (_, p) => seen.push(p.phase) })
    expect(result?.ok).toBe(true)
    expect(seen.at(-1)).toBe('ready')
    expect((await modelStatus(models))[0]?.cached).toBe(true)

    await evictModels(models)
    expect((await modelStatus(models))[0]?.cached).toBe(false)
}, 120000)
