/**
 * The generated source is something a reader will paste into their own project,
 * so the tests care about two things: that it says what the pipeline is, and
 * that every import in it would actually resolve.
 */
import { describe, expect, it } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { pipelineCode, STAGE_SPECS } from '../../src/registry/index.js'

const EXPORTS = Object.keys(packageJson.exports)

describe('pipelineCode', () => {
    it('writes the pipeline the demo starts from', () => {
        const code = pipelineCode([
            { type: 'PdfToImage', options: { resolution: 200 } },
            { type: 'PaddleTextRecognizer', options: { keepFormatting: true } },
            {
                type: 'ImageDrawBoxes',
                options: { inputCols: ['image', 'text'], outputCol: 'annotated', color: '#3fc9f5' },
            },
        ])

        expect(code).toBe(
            `import { ImageDrawBoxes, Pipeline } from '@stabrise/scaledp'
import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'
import { PdfToImage } from '@stabrise/scaledp/pdf'

const pipeline = new Pipeline([
    new PdfToImage({ resolution: 200 }),
    new PaddleTextRecognizer({ keepFormatting: true }),
    new ImageDrawBoxes({ inputCols: ['image', 'text'], outputCol: 'annotated', color: '#3fc9f5' }),
])`
        )
    })

    it('omits options already at their default', () => {
        const spec = STAGE_SPECS.find((candidate) => candidate.type === 'PdfToImage')
        const code = pipelineCode([
            { type: 'PdfToImage', options: { resolution: spec?.defaults.resolution, pageLimit: 3 } },
        ])

        expect(code).toContain('new PdfToImage({ pageLimit: 3 })')
        expect(code).not.toContain('resolution')
    })

    it('drops the braces when nothing was changed', () => {
        expect(pipelineCode([{ type: 'DataToImage', options: {} }])).toContain('new DataToImage(),')
    })

    it('breaks a long call over several lines', () => {
        const code = pipelineCode([
            {
                type: 'GlinerNer',
                options: {
                    labels: ['person', 'organisation', 'address', 'phone number', 'email address'],
                    threshold: 0.4,
                    normaliseCasing: false,
                },
            },
        ])

        expect(code).toContain('new GlinerNer({\n')
        expect(code).toContain('        threshold: 0.4,\n')
    })

    it('escapes a string that would break out of its quotes', () => {
        const code = pipelineCode([{ type: 'DataToImage', options: { outputCol: "it's\\here" } }])
        expect(code).toContain("outputCol: 'it\\'s\\\\here'")
    })

    it('honours the variable name, indent and import switch', () => {
        const code = pipelineCode([{ type: 'DataToImage', options: { resolution: 72 } }], {
            variable: 'reader',
            imports: false,
            indent: 2,
        })
        expect(code).toBe('const reader = new Pipeline([\n  new DataToImage({ resolution: 72 }),\n])')
    })

    it.each(STAGE_SPECS.map((spec) => [spec.type, spec] as const))(
        '%s: imports it from a subpath the package exports',
        (type, spec) => {
            const code = pipelineCode([{ type, options: {} }])
            const line = code
                .split('\n')
                .find((candidate) => candidate.includes(`{ ${type}`) || candidate.includes(`, ${type}`))

            expect(line, `no import line for ${type}`).toBeDefined()
            expect(line).toContain(`from '${spec.subpath}'`)

            // '@stabrise/scaledp/ocr' -> './ocr', which is what `exports` keys
            // look like. The root is just '.'.
            const key = spec.subpath.replace('@stabrise/scaledp', '.').replace('./', './') || '.'
            expect(EXPORTS).toContain(key === '.' ? '.' : key)
        }
    )

    it('always imports Pipeline from the root', () => {
        for (const spec of STAGE_SPECS) {
            const code = pipelineCode([{ type: spec.type, options: {} }])
            expect(code).toMatch(/import \{[^}]*\bPipeline\b[^}]*\} from '@stabrise\/scaledp'/)
        }
    })

    it('names an unknown stage rather than dropping it', () => {
        const code = pipelineCode([{ type: 'NotAStage', options: { a: 1 } }])
        expect(code).toContain('new NotAStage({ a: 1 })')
    })
})
