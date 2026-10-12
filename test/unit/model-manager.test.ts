import { describe, expect, it } from 'vitest'
import { pipelineModels } from '../../src/registry/index.js'

describe('pipelineModels', () => {
    it('reports each enabled stage’s model, merged by repo', async () => {
        const models = await pipelineModels([
            { type: 'PdfToImage' },
            { type: 'DbnetOnnxDetector' },
            { type: 'FaceDetector', id: 'faces' },
            { type: 'LineOrientationDetector', options: { inputCols: ['image', 'boxes'] } },
            {
                type: 'TesseractRecognizer',
                options: { inputCols: ['image', 'boxes'], detectLineOrientation: true },
            },
            { type: 'GlinerNer', id: 'ner' },
        ])
        const keys = models.map((m) => m.key)
        expect(keys).toEqual(
            expect.arrayContaining([
                'StabRise/text_detection_dbnet_ml_v0.2@main',
                'StabRise/face_detection@main',
                'StabRise/line_orientation_detection_v0.1@main',
            ])
        )
        // Two stages on the orientation model: one entry, both named.
        const orientation = models.find((m) => m.key.startsWith('StabRise/line_orientation'))
        expect(orientation?.stages).toEqual(['LineOrientationDetector', 'TesseractRecognizer'])
        expect(orientation?.spec.files).toHaveLength(1)
        // GLiNER's model files come from the NER registry.
        const ner = models.find((m) => m.stages.includes('ner'))
        expect(ner?.spec.files.length).toBeGreaterThan(0)
        // Engine-free stages need nothing.
        expect(models.some((m) => m.stages.includes('PdfToImage'))).toBe(false)
    })

    it('leaves out what is disabled, by id or name', async () => {
        const stages = [{ type: 'DbnetOnnxDetector' }, { type: 'FaceDetector', id: 'faces' }]
        expect((await pipelineModels(stages, { enabled: { faces: false } })).map((m) => m.stages)).toEqual([
            ['DbnetOnnxDetector'],
        ])
        expect(await pipelineModels([{ type: 'FaceDetector', enabled: false }])).toEqual([])
    })
})
