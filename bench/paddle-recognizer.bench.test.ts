/**
 * PaddleRecognizer across execution providers and thread counts.
 *
 * The lines come from DBNet over a real embedded scan, then each configuration
 * reads the same lines in its own worker (thread count is fixed per realm).
 *
 *   BENCH_ISOLATED=1 BENCH_HEADED=1 npx vitest run --project bench bench/paddle-recognizer.bench.test.ts --reporter=verbose
 */
import { describe, expect, it } from 'vitest'
import { configure } from '../src/core/config.js'
import { Pipeline, type Row } from '../src/core/pipeline.js'
import { DbnetOnnxDetector } from '../src/ocr/index.js'
import { PdfEmbeddedImages, PdfToDocument } from '../src/pdf/index.js'
import { ScaleDpWorkerClient } from '../src/worker/client.js'

configure({ pdf: { workerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs' } })

const RUNS = 4
const configurations = [
    { label: 'wasm, 1 thread', executionProviders: ['wasm'], numThreads: 1, recBatchSize: 1 },
    { label: 'wasm, 1 thread', executionProviders: ['wasm'], numThreads: 1, recBatchSize: 6 },
    { label: 'wasm, 8 threads', executionProviders: ['wasm'], numThreads: 8, recBatchSize: 1 },
    { label: 'wasm, 8 threads', executionProviders: ['wasm'], numThreads: 8, recBatchSize: 6 },
]

describe('PaddleRecognizer', () => {
    it('per provider and thread count', async () => {
        const content = new Uint8Array(
            await (await fetch('/examples/pdfs/SampleWithFaceRussianImage.pdf')).arrayBuffer()
        )
        const rows = await new Pipeline([
            new PdfToDocument({ resolution: 200 }),
            new PdfEmbeddedImages({ resolution: 200, outputCol: 'embedded' }),
            new DbnetOnnxDetector({ inputCol: 'embedded', outputCol: 'detected' }),
        ]).transform(content)
        const input = rows.map((row) => ({ embedded: row.embedded, detected: row.detected }) as Row)
        const lines = input.reduce((n, row) => n + ((row.detected as { bboxes: unknown[] }).bboxes?.length ?? 0), 0)

        for (const config of configurations) {
            const client = new ScaleDpWorkerClient({
                worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
            })
            await client.configure({ executionProviders: config.executionProviders, numThreads: config.numThreads })
            const stages = [
                {
                    type: 'PaddleRecognizer',
                    options: {
                        inputCols: ['embedded', 'detected'],
                        outputCol: 'text',
                        detectLineOrientation: true,
                        preset: 'v5-eslav-mobile',
                        recBatchSize: config.recBatchSize,
                    },
                },
            ]
            const times: number[] = []
            let text = ''
            for (let i = 0; i <= RUNS; i++) {
                const started = performance.now()
                const out = await client.transform(stages, input)
                if (i > 0) times.push(performance.now() - started)
                text = out.map((row) => (row.text as { text: string; exception: string }).text || (row.text as { exception: string }).exception.split('\n')[0]).join(' | ')
            }
            await client.dispose()
            times.sort((a, b) => a - b)
            console.log(
                `RECBENCH ${JSON.stringify({ label: config.label, recBatchSize: config.recBatchSize, lines, medianMs: Math.round(times[times.length >> 1] ?? 0), text: text.slice(0, 160) })}`
            )
            expect(times).toHaveLength(RUNS)
        }
    }, 900_000)
})
