/**
 * Pages per second across parallelism settings, on a pdf-redaction-shaped
 * workload: render, detect text, read it, find faces.
 *
 * Not part of any test run -- `pnpm bench` runs it and records the numbers in
 * `bench/results/`, which is what `resolveParallelism`'s defaults cite. Each
 * setting gets a warm-up run first, so model downloads and session creation
 * are excluded: what is measured is steady-state throughput.
 *
 *   BENCH_PAGES=24      page units per run (default 16)
 *   BENCH_ISOLATED=1    serve the page cross-origin isolated, so threads engage
 */
import { describe, expect, it } from 'vitest'
import type { StageDescriptor } from '../src/core/pipeline.js'
import type { RowUpdate } from '../src/core/run.js'
import { ScaleDpWorkerClient } from '../src/worker/client.js'
import { ScaleDpWorkerPool } from '../src/worker/pool.js'

const PAGES = Number((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_BENCH_PAGES ?? 16)

const stages: StageDescriptor[] = [
    { type: 'PdfToDocument', options: { resolution: 144, keepInputData: true } },
    { type: 'PdfToImage', options: { resolution: 144, keepInputData: false } },
    { type: 'DbnetOnnxDetector', id: 'detect', options: { inputCol: 'image', outputCol: 'regions' } },
    {
        type: 'PaddleRecognizer',
        id: 'read',
        options: { inputCols: ['image', 'regions'], outputCol: 'ocr', keepInputData: true },
    },
    { type: 'FaceDetector', id: 'faces' },
]

const makeWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

interface Setting {
    workers: number
    pagesInFlight: number
    threads: number
}

interface Measurement extends Setting {
    pages: number
    ms: number
    pagesPerSecond: number
    firstPageMs: number
    p50PageMs: number
    p95PageMs: number
    isolated: boolean
    cores: number
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

async function measure(setting: Setting, content: Uint8Array): Promise<Measurement> {
    const pool = new ScaleDpWorkerPool({
        createWorker: makeWorker,
        size: setting.workers,
        threadsPerWorker: setting.threads,
        pagesPerWorker: setting.pagesInFlight,
    })
    await pool.configure({ numThreads: setting.threads })
    await pool.putContent('doc', content)
    const rows = Array.from({ length: PAGES }, (_, i) => ({ contentRef: 'doc', path: `copy-${i}.pdf` }))

    const once = async () => {
        const started = performance.now()
        const firstSeen = new Map<string, number>()
        let first = Number.POSITIVE_INFINITY
        const out = await pool.run(stages, rows, {
            pagesInFlight: setting.pagesInFlight,
            // A page is done when its last stage reports it.
            rowUpdates: { stages: ['faces'] },
            onEvent: (event) => {
                if (event.type === 'unit:start' && !firstSeen.has(event.unit.key)) {
                    firstSeen.set(event.unit.key, performance.now())
                }
            },
            onRow: (update: RowUpdate) => {
                const at = performance.now()
                first = Math.min(first, at - started)
                const began = firstSeen.get(update.unit.key) ?? started
                latencies.push(at - began)
            },
        }).result
        return { out, ms: performance.now() - started, first }
    }

    let latencies: number[] = []
    await once() // warm-up: downloads and session creation
    latencies = []
    const { out, ms, first } = await once()
    await pool.dispose()

    expect(out).toHaveLength(PAGES)
    // A stage that fails returns at once, and a benchmark of failures is a
    // very fast benchmark of nothing.
    const failures = out.flatMap((row) =>
        ['regions', 'ocr', 'faces']
            .map((col) => (row[col] as { exception?: string } | undefined)?.exception)
            .filter((exception): exception is string => Boolean(exception))
    )
    expect(failures, failures[0]).toEqual([])
    return {
        ...setting,
        pages: PAGES,
        ms: Math.round(ms),
        pagesPerSecond: Number(((PAGES / ms) * 1000).toFixed(3)),
        firstPageMs: Math.round(first),
        p50PageMs: Math.round(percentile(latencies, 50)),
        p95PageMs: Math.round(percentile(latencies, 95)),
        isolated: typeof crossOriginIsolated === 'boolean' && crossOriginIsolated,
        cores: navigator.hardwareConcurrency,
    }
}

describe('throughput', () => {
    it('across workers, pages in flight and threads', async () => {
        const response = await fetch('/examples/pdfs/SampleWithFace.pdf')
        const content = new Uint8Array(await response.arrayBuffer())
        const isolated = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated
        const cores = navigator.hardwareConcurrency

        const settings: Setting[] = []
        for (const workers of [1, 2, 4].filter((n) => n <= cores)) {
            for (const pagesInFlight of [1, 2, 4]) {
                for (const threads of isolated ? [1, 2, 4] : [1]) {
                    if (workers * threads > cores) continue
                    settings.push({ workers, pagesInFlight, threads })
                }
            }
        }

        const results: Measurement[] = []
        for (const setting of settings) {
            const result = await measure(setting, content)
            results.push(result)
            console.log(`BENCH_RESULT ${JSON.stringify(result)}`)
        }
        expect(results.length).toBe(settings.length)
    }, 3_600_000)
})
