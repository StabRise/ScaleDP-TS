/**
 * Message protocol between the main thread and the pipeline worker.
 *
 * A discriminated union correlated by a numeric requestId, following the shape
 * the pdftools prototype settled on -- generalised here from NER-only to the
 * whole pipeline.
 */

import type { ModelProgress, ScaleDpConfig } from '../core/config.js'
import type { Row } from '../core/pipeline.js'

/** A stage described well enough for the worker to reconstruct it. */
export interface StageDescriptor {
    /** Exported class name, e.g. 'PdfToImage'. */
    type: string
    /** Constructor options. Must be structured-cloneable. */
    options?: Record<string, unknown>
}

export type WorkerRequest =
    | { type: 'configure'; requestId: number; config: Partial<ScaleDpConfig> }
    | { type: 'transform'; requestId: number; stages: StageDescriptor[]; rows: Row[] }
    | { type: 'dispose'; requestId: number }

export type WorkerResponse =
    | { type: 'progress'; requestId: number; progress: ModelProgress }
    | { type: 'stage'; requestId: number; name: string; ms: number; rows: number }
    | { type: 'result'; requestId: number; rows: Row[] }
    | { type: 'configured'; requestId: number }
    | { type: 'disposed'; requestId: number }
    | { type: 'error'; requestId: number; message: string }

/**
 * Config minus its function-valued fields.
 *
 * `auth` and `onProgress` are callbacks and cannot cross a postMessage
 * boundary; the client re-implements both on the worker side.
 */
export type TransferableConfig = Omit<Partial<ScaleDpConfig>, 'auth' | 'onProgress'>

/**
 * Omit that distributes over a union.
 *
 * A plain `Omit<WorkerRequest, 'requestId'>` collapses the union to only the
 * keys every member shares, losing `config`, `stages` and `rows`.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A request as callers build it, before the client assigns a requestId. */
export type WorkerRequestInit = DistributiveOmit<WorkerRequest, 'requestId'>
