/**
 * @stabrise/scaledp/registry -- describe, build and serialise pipelines as data.
 *
 * A pipeline is an ordered array of stages, each a class with a params object.
 * That is fine to write by hand, but a UI that assembles one needs two things
 * the classes themselves do not carry at run time: a description of each
 * stage's parameters, and a way back from JSON to live objects.
 *
 *     import { STAGE_SPECS, pipelineFromDescriptors } from '@stabrise/scaledp/registry'
 *
 *     const stages = [
 *         { type: 'PdfToImage', options: { resolution: 200 } },
 *         { type: 'PaddleTextRecognizer', options: { keepFormatting: true } },
 *     ]
 *     const rows = await pipelineFromDescriptors(stages).transform(file)
 *
 * `StageDescriptor[]` is plain JSON, and the same shape the worker protocol
 * already sends across the boundary -- so a saved pipeline, a posted message and
 * a pipeline built here are all the same data.
 *
 * This subpath pulls in every stage class. It pulls in no ML runtime: engines
 * are reached through dynamic `import()` and stay lazy.
 */

import { Pipeline, type Stage, type StageDescriptor } from '../core/pipeline.js'
import { STAGE_CLASSES, STAGE_SPECS } from './catalog.js'

// Re-exported so a consumer building pipelines as data needs only this subpath.
export type { StageDescriptor } from '../core/pipeline.js'
export type { PipelineCodeOptions } from './codegen.js'
export { pipelineCode } from './codegen.js'
export type {
    ColumnKind,
    StageCacheSpec,
    StageParamKind,
    StageParamOption,
    StageParamSpec,
    StageSpec,
} from './types.js'
export { STAGE_CLASSES, STAGE_SPECS }

/** Metadata for one stage, by exported class name. */
export function getStageSpec(type: string): (typeof STAGE_SPECS)[number] | undefined {
    return STAGE_SPECS.find((spec) => spec.type === type)
}

/**
 * Build one stage from its serialised form.
 *
 * Throws on an unknown type, and lets the stage's own constructor validators
 * throw on a bad param -- an unknown OCR preset should fail here, where the
 * message can name the offending field, rather than several stages later.
 */
export function createStage(descriptor: StageDescriptor): Stage {
    const Ctor = STAGE_CLASSES[descriptor.type]
    if (!Ctor) {
        throw new Error(
            `Unknown stage "${descriptor.type}". See STAGE_SPECS for the stages this build knows about.`
        )
    }
    return new Ctor(descriptor.options as never)
}

/** Build a whole pipeline from its serialised form. */
export function pipelineFromDescriptors(descriptors: readonly StageDescriptor[]): Pipeline {
    return new Pipeline(descriptors.map(createStage))
}

/**
 * The serialised form of a live stage.
 *
 * `stage.params` is fully resolved -- defaults merged in -- so this round-trips
 * exactly but is more verbose than the options originally passed.
 */
export function describeStage(stage: Stage): StageDescriptor {
    return { type: stage.name, options: { ...stage.params } }
}

/** The serialised form of a live pipeline. */
export function describePipeline(pipeline: Pipeline): StageDescriptor[] {
    return pipeline.stages.map(describeStage)
}
