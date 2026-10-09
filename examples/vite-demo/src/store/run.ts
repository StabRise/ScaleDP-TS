/**
 * What is happening right now: the file, the run, the result.
 *
 * Separate from the pipeline store and deliberately not persisted -- it holds a
 * File and decoded page images, and the point of the library is that neither is
 * written anywhere.
 */

import type { Row } from '@stabrise/scaledp'
import { create } from 'zustand'

export interface Timing {
    name: string
    ms: number
}

export type RunStatus = 'idle' | 'running' | 'done' | 'error'

/** One stage's state during the current run, from the pipeline's events. */
export interface StageLive {
    state: 'waiting' | 'loading' | 'running' | 'done' | 'skipped' | 'disabled'
    /** Units (pages) the stage has finished. */
    done: number
    /** Rows it recorded a real failure on. */
    failed: number
    /** Model download percentage while loading, when known. */
    percent?: number
}

interface RunStore {
    status: RunStatus
    /** The file most recently read, kept so a param change can be re-applied to it. */
    file: File | null
    /**
     * Every row the pipeline produced.
     *
     * A page of a PDF is a row, and so is each crop from `ImageCropBoxes` --
     * stages that `expand` turn one input row into several, so this is a list
     * even for a single file.
     */
    rows: Row[]
    /** Which of them the results are showing. */
    selected: number
    /** Whether the trace shows the selected page's time or the whole run's. */
    traceMode: 'page' | 'run'
    timings: Timing[]
    /** A message for the reader: an error, a download, something that was noticed. */
    note: string
    /** Set when the pipeline changed after the result on screen was produced. */
    stale: string
    controller: AbortController | null
    /** Per-stage state, by position in the pipeline. */
    live: Record<number, StageLive>

    start: (file: File, controller: AbortController) => void
    /** Rows as they stand mid-run, shown before the run finishes. */
    stream: (rows: Row[]) => void
    setLive: (index: number, patch: Partial<StageLive>) => void
    finish: (rows: Row[], timings: Timing[]) => void
    select: (index: number) => void
    setTraceMode: (mode: 'page' | 'run') => void
    fail: (message: string) => void
    cancel: () => void
    setNote: (note: string) => void
    markStale: (what: string) => void
}

export const useRun = create<RunStore>()((set, get) => ({
    status: 'idle',
    file: null,
    rows: [],
    selected: 0,
    traceMode: 'page',
    timings: [],
    note: '',
    stale: '',
    controller: null,
    live: {},

    start: (file, controller) =>
        set({
            status: 'running',
            file,
            controller,
            note: '',
            stale: '',
            rows: [],
            selected: 0,
            timings: [],
            live: {},
        }),

    // The selection is kept: a reader looking at page 1 while page 5 arrives
    // should not be thrown back to page 1 of a list that grew under them.
    stream: (rows) => set({ rows }),

    setLive: (index, patch) =>
        set((state) => {
            const current = state.live[index] ?? { state: 'waiting', done: 0, failed: 0 }
            return { live: { ...state.live, [index]: { ...current, ...patch } } }
        }),

    finish: (rows, timings) =>
        set({
            status: 'done',
            rows,
            selected: Math.min(get().selected, Math.max(0, rows.length - 1)),
            timings,
            controller: null,
            note: rows.length > 0 ? '' : 'No rows were produced. Check the first stage matches the file.',
        }),

    select: (index) => set((state) => ({ selected: Math.min(Math.max(index, 0), state.rows.length - 1) })),

    fail: (message) => set({ status: 'error', note: message, controller: null }),

    cancel: () => {
        get().controller?.abort()
        set({ status: 'idle', controller: null, note: 'Cancelled.' })
    },

    setTraceMode: (traceMode) => set({ traceMode }),

    setNote: (note) => set({ note }),

    // Changing a stage does not re-run on its own: a re-read is seconds of work
    // and, for a model not yet cached, hundreds of megabytes. Surfacing the
    // choice is better than making it silently.
    markStale: (what) => set((state) => (state.file ? { stale: what } : state)),
}))
