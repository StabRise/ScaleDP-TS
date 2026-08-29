/**
 * Run a pipeline off the main thread.
 *
 * Two halves. In your worker entry:
 *
 *   import { registerStages, startScaleDpWorker } from '@stabrise/scaledp/worker'
 *   import { PdfToImage } from '@stabrise/scaledp/pdf'
 *   import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'
 *
 *   registerStages({ PdfToImage, PaddleTextRecognizer })
 *   startScaleDpWorker()
 *
 * On the main thread:
 *
 *   const client = createScaleDpWorker({
 *     worker: new Worker(new URL('./my-worker.ts', import.meta.url), { type: 'module' }),
 *   })
 *   const rows = await client.transform(
 *     [{ type: 'PdfToImage' }, { type: 'PaddleTextRecognizer' }],
 *     [{ content: bytes, path: 'doc.pdf' }]
 *   )
 *
 * Stages are registered explicitly rather than imported wholesale, so a worker
 * bundle carries only the engines it actually uses.
 */

export type { ScaleDpWorkerOptions } from './client.js'
export { createScaleDpWorker, ScaleDpWorkerClient } from './client.js'
export type { StageFactory } from './host.js'
export { registerStages, startScaleDpWorker } from './host.js'

export type {
    StageDescriptor,
    TransferableConfig,
    WorkerRequest,
    WorkerResponse,
} from './protocol.js'
