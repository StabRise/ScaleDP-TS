/**
 * Message protocol between the main thread and the pipeline worker.
 *
 * A discriminated union correlated by a numeric requestId, following the shape
 * the pdftools prototype settled on -- generalised here from NER-only to the
 * whole pipeline.
 */

import type { ModelProgress, ScaleDpConfig } from '../core/config.js'
import type { Row, StageDescriptor } from '../core/pipeline.js'

// The descriptor lives in the core so `/registry` and `/worker` share one
// definition of the serialised pipeline shape. Re-exported here because the
// worker protocol is where callers expect to find it.
export type { StageDescriptor }

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
