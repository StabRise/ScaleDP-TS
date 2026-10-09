import type { PipelineEvent } from '@stabrise/scaledp'
import { pipelineFromDescriptors } from '@stabrise/scaledp/registry'
import { toDescriptors, usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'
import { useRuntime } from '../store/runtime'
import { LiveRows } from './live'

const isPdf = (file: File): boolean =>
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

/**
 * Keep the first stage matching the file that was dropped.
 *
 * The old demo chose PdfToImage or DataToImage by sniffing the file. Here the
 * reader is the user's stage, so swapping it silently would be a lie -- but so
 * would failing on a PNG because the pipeline starts with PdfToImage. Swap it
 * and say so.
 */
export function reconcileReader(file: File): string {
    const { stages, swapStageType } = usePipeline.getState()
    const first = stages[0]
    if (!first) return ''

    const wanted = isPdf(file) ? 'PdfToImage' : 'DataToImage'
    const other = isPdf(file) ? 'DataToImage' : 'PdfToImage'
    if (first.type !== other) return ''

    swapStageType(first.id, wanted)
    return `Switched the first stage to ${wanted}, to match ${file.name}.`
}

/** Build the pipeline described by the store and run it over one file, showing pages as they finish. */
export async function run(file: File): Promise<void> {
    const run = useRun.getState()
    const controller = new AbortController()
    run.start(file, controller)

    const swapped = reconcileReader(file)
    const descriptors = toDescriptors(usePipeline.getState().stages)

    let pipeline: ReturnType<typeof pipelineFromDescriptors>
    try {
        // A stage validator throws from its constructor, so a bad param fails
        // here rather than mid-run. Report it as the note; the pipeline never
        // started, so there is nothing to dispose.
        pipeline = pipelineFromDescriptors(descriptors)
    } catch (error) {
        useRun.getState().fail((error as Error).message)
        return
    }

    const live = new LiveRows()
    // Results are repainted when a page is done, not after every stage. The
    // repaint runs on this thread, between the awaits of whatever stage is
    // running; per stage, it redrew the page being worked on and its time was
    // billed to that stage -- 0.9 s on a FitBoxesToInk that takes 20 ms. Per
    // page, a long document still fills in as it goes.
    let frame = 0
    let lastSegment = 0
    const repaint = () => {
        if (frame) return
        frame = requestAnimationFrame(() => {
            frame = 0
            if (!controller.signal.aborted) useRun.getState().stream(live.rows())
        })
    }

    try {
        const rows = await pipeline.run(file, {
            signal: controller.signal,
            pagesInFlight: useRuntime.getState().pagesInFlight,
            // Same realm: a full row is a reference, not a copy.
            rowUpdates: { payload: 'full' },
            onRow: (update) => live.apply(update),
            onEvent: (event) => {
                if (event.type === 'run:start') lastSegment = event.segments.length - 1
                if (event.type === 'unit:end' && event.segment === lastSegment) repaint()
                track(event)
            },
        })
        cancelAnimationFrame(frame)
        const timings = pipeline.entries.map((entry) => ({
            name: entry.stage.name,
            ms:
                (rows[0]?.execution_time as { stages: Record<string, number> } | undefined)?.stages[
                    entry.timingKey
                ] ?? 0,
        }))
        useRun.getState().finish(rows, timings)
        if (swapped) useRun.getState().setNote(swapped)
    } catch (error) {
        cancelAnimationFrame(frame)
        if (controller.signal.aborted) return
        useRun.getState().fail((error as Error).message)
    } finally {
        await pipeline.dispose()
    }
}

/** Fold a pipeline event into the stage cards' live state. */
function track(event: PipelineEvent): void {
    const { setLive, live } = useRun.getState()
    switch (event.type) {
        case 'run:start':
            event.stages.forEach((stage, index) => {
                setLive(index, { state: stage.enabled ? 'waiting' : 'disabled', done: 0, failed: 0 })
            })
            return
        case 'stage:init':
            if (event.phase === 'start') setLive(indexOf(event.stageId), { state: 'loading' })
            return
        case 'model:progress': {
            const { loaded, total, phase } = event.progress
            if (phase === 'downloading' && total > 0) {
                setLive(indexOf(event.stageId), { percent: Math.round((loaded / total) * 100) })
            }
            return
        }
        case 'stage:start':
            setLive(event.index, { state: 'running', percent: undefined })
            return
        case 'stage:end': {
            const current = live[event.index]
            setLive(event.index, {
                state: 'done',
                done: (current?.done ?? 0) + 1,
                failed: (current?.failed ?? 0) + event.failed,
            })
            return
        }
        case 'stage:skip':
            if (event.reason !== 'disabled' && live[event.index]?.state === 'waiting') {
                setLive(event.index, { state: 'skipped' })
            }
            return
    }
}

/** Stage ids default to the stage name, or `Name#index` when it repeats. */
function indexOf(stageId: string): number {
    const hash = stageId.lastIndexOf('#')
    if (hash >= 0) return Number(stageId.slice(hash + 1))
    return usePipeline.getState().stages.findIndex((stage) => stage.type === stageId)
}
