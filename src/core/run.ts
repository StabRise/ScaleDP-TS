/**
 * The vocabulary of a pipeline run: its options, the events it emits and the
 * row updates it streams.
 *
 * Everything here is structured-cloneable except the callbacks and the signal,
 * which is what lets the worker host forward a run's events verbatim -- see
 * `TransferableRunOptions` in `@stabrise/scaledp/worker`.
 */

import type { Json } from './condition.js'
import type { ModelProgress } from './config.js'
import type { Row, StageScope } from './pipeline.js'

export type RunOrder = 'page' | 'stage'

export interface RowUpdateOptions {
    /**
     * What a row update carries. `delta` (default) is only the columns the
     * stage wrote plus path and page; `full` the whole row; `none` disables
     * row updates altogether.
     */
    payload?: 'delta' | 'full' | 'none'
    /** Stage ids (or names) to report. Omitted means every stage. */
    stages?: readonly string[]
    /**
     * Replace binary data -- encoded images, canvases, bitmaps -- with
     * `{ bytes }`. A UI drawing OCR words or entities over a page it already
     * rendered does not need each stage's copy of the pixels, and across a
     * worker boundary every copy is a structured clone. Default `false` in the
     * same realm, where nothing is copied, and `true` through the worker.
     */
    stripBinary?: boolean
}

export interface StageRunOptions {
    /**
     * Calls of this stage allowed at once in this run. It can only *lower* the
     * stage's own `maxConcurrency`: a stage holding an ONNX session declares 1
     * because the session cannot run two inferences at once, and no run option
     * can make that safe.
     */
    maxConcurrency?: number
}

export interface RunOptions {
    /**
     * `page` (the default for `run()`) streams: once a document is split into
     * pages, each page walks the remaining stages on its own and its results
     * arrive as soon as it is done. `stage` is Python's order -- every row
     * through stage 1, then every row through stage 2 -- and is what
     * `transform()` uses. Both produce the same rows in the same order.
     */
    order?: RunOrder
    signal?: AbortSignal
    /**
     * Pages walking the pipeline at once. 1 (default) processes one page at a
     * time. Higher values overlap stages that do not compete -- page 2 in OCR
     * while page 1 is in NER -- and bound memory, since every page in flight
     * holds its images.
     */
    pagesInFlight?: number
    /** Override a stage's `enabled`, by stage id or by stage name. */
    enabled?: Readonly<Record<string, boolean>>
    /** Values for `{ var }` conditions. */
    vars?: Readonly<Record<string, Json>>
    /** Per-stage run settings, by stage id or name. */
    stages?: Readonly<Record<string, StageRunOptions>>
    /**
     * After a stage fails to initialise -- a model that will not download --
     * `run` (default) fails its rows for the rest of this run without retrying,
     * so a forty-page document does not try the download forty times. `row`
     * retries for every page. The next run always retries.
     */
    initRetry?: 'run' | 'row'
    rowUpdates?: RowUpdateOptions
    onEvent?: (event: PipelineEvent) => void
    onRow?: (update: RowUpdate) => void
}

/** Identifies one unit of work -- normally one page -- in events and row updates. */
export interface UnitRef {
    /** Dotted position, e.g. `0.3` for the fourth page of the first input. Sorts like the result. */
    key: string
    /** Index of the input row this unit descends from; -1 after a barrier merged every input. */
    input: number
    page?: number
    path?: string
}

export interface PlannedStage {
    id: string
    name: string
    enabled: boolean
    scope: StageScope
    conditional: boolean
}

export type PipelineEvent =
    | {
          type: 'run:start'
          runId: string
          order: RunOrder
          pagesInFlight: number
          stages: PlannedStage[]
          /** Stage ids per segment; every segment after the first begins with its barrier. */
          segments: string[][]
      }
    | { type: 'unit:start'; runId: string; unit: UnitRef; segment: number }
    | { type: 'unit:end'; runId: string; unit: UnitRef; segment: number; ms: number }
    | {
          type: 'stage:init'
          runId: string
          stageId: string
          phase: 'start' | 'end' | 'error'
          ms?: number
          message?: string
      }
    | { type: 'model:progress'; runId: string; stageId: string; progress: ModelProgress }
    | { type: 'stage:start'; runId: string; stageId: string; index: number; unit: UnitRef; rows: number }
    | {
          type: 'stage:end'
          runId: string
          stageId: string
          index: number
          unit: UnitRef
          rowsIn: number
          rowsOut: number
          /** Rows the stage's `when` admitted. */
          matched: number
          /** Output rows carrying a real (non-skip) exception from this stage. */
          failed: number
          /** Time spent in the stage. */
          ms: number
          /** Time spent waiting for the stage, or a resource it shares, to be free. */
          waitMs: number
      }
    | {
          type: 'stage:skip'
          runId: string
          stageId: string
          index: number
          unit?: UnitRef
          reason: 'disabled' | 'when' | 'no-rows'
          rows: number
      }
    | {
          type: 'stage:row-error'
          runId: string
          stageId: string
          unit: UnitRef
          rowIndex: number
          message: string
          phase: 'init' | 'apply'
          /** The row failed earlier and this stage is reporting it again. */
          upstream: boolean
      }
    | { type: 'barrier:wait'; runId: string; stageId: string; arrived: number }
    | {
          type: 'run:end'
          runId: string
          status: 'done' | 'aborted' | 'failed'
          ms: number
          rows: number
          message?: string
      }

export type PipelineEventType = PipelineEvent['type']

export interface RowUpdate {
    runId: string
    stageId: string
    unit: UnitRef
    /** Position of this row among the rows the stage produced for the unit. */
    rowIndex: number
    rowCount: number
    row: Row
}
