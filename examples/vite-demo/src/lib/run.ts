import { pipelineFromDescriptors } from '@stabrise/scaledp/registry'
import { toDescriptors, usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'

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

/** Build the pipeline described by the store and run it over one file. */
export async function run(file: File): Promise<void> {
    const run = useRun.getState()
    const controller = new AbortController()
    run.start(file, controller)

    const swapped = reconcileReader(file)
    const descriptors = toDescriptors(usePipeline.getState().stages)

    const timings: { name: string; ms: number }[] = []
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

    try {
        const rows = await pipeline.transform(file, {
            signal: controller.signal,
            onStage: (name, ms) => timings.push({ name, ms }),
        })
        useRun.getState().finish(rows, timings)
        if (swapped) useRun.getState().setNote(swapped)
    } catch (error) {
        if (controller.signal.aborted) return
        useRun.getState().fail((error as Error).message)
    } finally {
        await pipeline.dispose()
    }
}
