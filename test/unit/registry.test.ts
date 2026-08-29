/**
 * The stage catalogue is hand-written metadata about generated-nowhere runtime
 * facts, so the only thing that can keep it honest is a test that reads both
 * sides. These assertions are about drift, not behaviour: add a param to a stage
 * and forget the catalogue, rename a preset id, change a stage's `name`, and one
 * of them fails.
 */
import { describe, expect, it } from 'vitest'
import { BASE_STAGE_DEFAULTS } from '../../src/core/params.js'
import {
    createStage,
    describeStage,
    getStageSpec,
    pipelineFromDescriptors,
    STAGE_CLASSES,
    STAGE_SPECS,
} from '../../src/registry/index.js'

const BASE_KEYS = Object.keys(BASE_STAGE_DEFAULTS)

/**
 * Options good enough to construct any stage.
 *
 * `YoloOnnxDetector.model` has no usable default -- it is `''` and its validator
 * rejects that -- so fill in every param the catalogue marks required whose
 * default is empty. Driving this off `required` rather than naming YOLO keeps it
 * true for the next stage that has no sensible default.
 */
function sampleOptions(spec: (typeof STAGE_SPECS)[number]): Record<string, unknown> {
    const options: Record<string, unknown> = {}
    for (const param of spec.params) {
        if (!param.required) continue
        const value = spec.defaults[param.key]
        if (typeof value === 'string' && value === '') options[param.key] = 'org/model'
        if (Array.isArray(value) && value.length === 0) options[param.key] = ['sample']
    }
    return options
}

describe('stage catalogue', () => {
    it('describes every registered class, and registers every described stage', () => {
        expect(STAGE_SPECS.map((spec) => spec.type).sort()).toEqual(Object.keys(STAGE_CLASSES).sort())
    })

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: the descriptor type is the stage name',
        (type, spec) => {
            // Nothing in the library enforces this -- `name` is an instance
            // field and `type` is the registry key -- but the worker protocol
            // and every saved pipeline assume the two agree.
            const stage = createStage({ type, options: sampleOptions(spec) })
            expect(stage.name).toBe(type)
        }
    )

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: every param is described exactly once',
        (_type, spec) => {
            const described = spec.params.map((param) => param.key)
            expect(described).toEqual([...new Set(described)])
            expect(described.sort()).toEqual(Object.keys(spec.defaults).sort())
        }
    )

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: describes the six base params',
        (_type, spec) => {
            const described = new Set(spec.params.map((param) => param.key))
            for (const key of BASE_KEYS) expect(described).toContain(key)
        }
    )

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: every enum default is one of its options',
        (_type, spec) => {
            for (const param of spec.params) {
                if (param.kind !== 'enum' || param.allowCustom) continue
                const values = (param.options ?? []).map((option) => option.value)
                expect(values).toContain(spec.defaults[param.key])
            }
        }
    )

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: a cache spec names a real param',
        (_type, spec) => {
            if (!spec.cache) return
            expect(Object.keys(spec.defaults)).toContain(spec.cache.param)
        }
    )

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: alsoProduces names real column params',
        (_type, spec) => {
            for (const extra of spec.alsoProduces ?? []) {
                expect(Object.keys(spec.defaults)).toContain(extra.param)
                expect(spec.params.find((p) => p.key === extra.param)?.kind).toBe('column')
            }
        }
    )

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: a columns param agrees with its default about length',
        (_type, spec) => {
            for (const param of spec.params) {
                if (param.kind !== 'columns') continue
                const value = spec.defaults[param.key] as unknown[]
                // Fixed arity is exact; a variable list must start at or above
                // its own minimum, or the default is already invalid.
                if (param.arity !== undefined) expect(value).toHaveLength(param.arity)
                if (param.minArity !== undefined) {
                    expect(value.length).toBeGreaterThanOrEqual(param.minArity)
                }
                // One of the two has to be stated, or a form has no idea
                // whether entries may be added or removed.
                expect(param.arity ?? param.minArity).toBeDefined()
            }
        }
    )

    it('finds a spec by type and returns undefined otherwise', () => {
        expect(getStageSpec('PdfToImage')?.group).toBe('Read')
        expect(getStageSpec('NotAStage')).toBeUndefined()
    })
})

describe('createStage', () => {
    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        'builds %s from its defaults',
        (type, spec) => {
            expect(() => createStage({ type, options: sampleOptions(spec) })).not.toThrow()
        }
    )

    it('names the stage it does not know', () => {
        expect(() => createStage({ type: 'Nope' })).toThrow(/Unknown stage "Nope"/)
    })

    it('lets a stage validator reject a bad param', () => {
        // YoloOnnxDetector requires `model`; the pre-set subclasses supply one.
        expect(() => createStage({ type: 'YoloOnnxDetector', options: { model: '' } })).toThrow(
            /model is required/
        )
        expect(() => createStage({ type: 'GlinerNer', options: { model: 'nope' } })).toThrow(
            /Unknown NER model/
        )
        expect(() => createStage({ type: 'PaddleTextRecognizer', options: { preset: 'nope' } })).toThrow(
            /Unknown OCR preset/
        )
    })

    it('round-trips through describeStage', () => {
        const descriptor = { type: 'PdfToImage', options: { resolution: 200 } }
        const described = describeStage(createStage(descriptor))

        expect(described.type).toBe('PdfToImage')
        expect(described.options?.resolution).toBe(200)
        // The described form is fully resolved, so it re-creates identically.
        expect(describeStage(createStage(described))).toEqual(described)
    })
})

describe('pipelineFromDescriptors', () => {
    it('builds stages in order', () => {
        const pipeline = pipelineFromDescriptors([
            { type: 'PdfToImage', options: { resolution: 200 } },
            { type: 'ImageDrawBoxes', options: { inputCols: ['image', 'text'] } },
        ])
        expect(pipeline.stages.map((stage) => stage.name)).toEqual(['PdfToImage', 'ImageDrawBoxes'])
        expect(pipeline.stages[0]?.params.outputCol).toBe('image')
    })
})
