/**
 * DbnetOnnxDetector inference across execution providers and thread counts.
 *
 * Thread count is fixed per realm when the first session is created, so each
 * configuration runs in its own worker. Run cross-origin isolated, or every
 * WASM configuration is single-threaded whatever it asks for:
 *
 *   BENCH_ISOLATED=1 npx vitest run --project bench bench/dbnet.bench.test.ts --reporter=verbose
 *
 * Add BENCH_HEADED=1 for WebGPU: headless Chromium only has SwiftShader, a
 * software adapter, and times the emulator rather than the GPU.
 */
import { describe, expect, it } from 'vitest'
import { Pipeline, type Row } from '../src/core/pipeline.js'
import { PdfEmbeddedImages, PdfToDocument, PdfToImage } from '../src/pdf/index.js'
import { configure } from '../src/core/config.js'
import { ScaleDpWorkerClient } from '../src/worker/client.js'

configure({ pdf: { workerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs' } })

const RUNS = 5

const configurations = [
    { label: 'wasm, 1 thread', executionProviders: ['wasm'], numThreads: 1 },
    { label: 'wasm, 4 threads', executionProviders: ['wasm'], numThreads: 4 },
    { label: 'wasm, 8 threads', executionProviders: ['wasm'], numThreads: 8 },
    { label: 'webgpu', executionProviders: ['webgpu'], numThreads: 1 },
]

describe('DbnetOnnxDetector', () => {
    it('per provider and thread count', async () => {
        const content = new Uint8Array(
            await (await fetch('/examples/pdfs/SampleWithRotatedText.pdf')).arrayBuffer()
        )
        const [page] = await new Pipeline([
            new PdfToDocument({ resolution: 200 }),
            new PdfToImage({ resolution: 200, keepInputData: true }),
            new PdfEmbeddedImages({ resolution: 200, outputCol: 'embedded' }),
        ]).transform(content)
        const image = (page as Row).image

        const adapter = await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { architecture?: string; vendor?: string } } | null> } }).gpu?.requestAdapter()
        console.log(`DBNET adapter ${adapter?.info?.vendor ?? 'none'} ${adapter?.info?.architecture ?? ''}`)

        for (const config of configurations) {
            const client = new ScaleDpWorkerClient({
                worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
            })
            const environment = await client.configure({
                executionProviders: config.executionProviders,
                numThreads: config.numThreads,
            })
            const stages = [{ type: 'DbnetOnnxDetector', options: { inputCol: 'image', outputCol: 'regions' } }]
            const times: number[] = []
            let boxes = 0
            let failure = ''
            for (let i = 0; i <= RUNS; i++) {
                const started = performance.now()
                const [row] = await client.transform(stages, [{ image }])
                const regions = row?.regions as { bboxes: unknown[]; exception: string }
                if (i > 0) times.push(performance.now() - started) // the first run builds the session
                boxes = regions.bboxes.length
                failure = regions.exception
            }
            await client.dispose()
            times.sort((a, b) => a - b)
            const result = {
                label: config.label,
                isolated: environment?.crossOriginIsolated,
                webgpu: environment?.webgpu,
                medianMs: Math.round(times[times.length >> 1] ?? 0),
                minMs: Math.round(times[0] ?? 0),
                boxes,
                failure: failure.split('\n')[0]?.slice(0, 160),
            }
            console.log(`DBNET ${JSON.stringify(result)}`)
            expect(times).toHaveLength(RUNS)
        }
    }, 600_000)
})
