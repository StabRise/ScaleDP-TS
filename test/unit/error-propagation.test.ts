/**
 * A failed stage must name the stage that actually failed.
 *
 * Every stage returns a well-formed but *empty* output on failure, so a
 * downstream stage that validates its input shape before checking `exception`
 * reports "no decoded bytes" and buries the real cause. That is exactly what
 * happened with a missing pdf.js worker: the user saw an OCR complaint about
 * image bytes instead of the PDF stage's actual error.
 */
import { describe, expect, it } from 'vitest'
import { configure, resetConfig } from '../../src/core/config.js'
import { OcrError } from '../../src/core/errors.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../../src/core/params.js'
import { Pipeline, type Row, Stage } from '../../src/core/pipeline.js'
import { describePdfError } from '../../src/pdf/pdfjs.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'

/** Stands in for PdfToImage: always fails, returning an empty Image. */
class FailingReader extends Stage<BaseStageParams> {
    readonly name = 'FailingReader'
    constructor() {
        super(resolveParams({ ...BASE_STAGE_DEFAULTS, inputCol: 'content', outputCol: 'image' }))
    }
    protected async apply(): Promise<never> {
        throw new Error('worker not found')
    }
    protected onError(message: string): ScaleDpImage {
        return createImage({ exception: message })
    }
}

/** Stands in for an OCR stage, with the corrected check order. */
class Consumer extends Stage<BaseStageParams> {
    readonly name = 'Consumer'
    constructor() {
        super(
            resolveParams({
                ...BASE_STAGE_DEFAULTS,
                inputCol: 'image',
                outputCol: 'text',
                keepInputData: true,
            })
        )
    }
    protected async apply(input: unknown): Promise<string> {
        const image = input as ScaleDpImage | undefined
        if (image?.exception) {
            throw new OcrError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || image.data.byteLength === 0) {
            throw new OcrError('Expected an Image with decoded bytes', this.name)
        }
        return 'ok'
    }
    protected onError(message: string): { exception: string } {
        return { exception: message }
    }
}

describe('upstream failures', () => {
    it('surface the original cause rather than a shape complaint', async () => {
        const rows = await new Pipeline([new FailingReader(), new Consumer()]).transform([
            { content: new Uint8Array([1]) },
        ])
        const text = rows[0]?.text as { exception: string } | undefined

        expect(text?.exception).toContain('Upstream stage failed')
        // The stage that actually failed, and why.
        expect(text?.exception).toContain('FailingReader')
        expect(text?.exception).toContain('worker not found')
        // Not the misleading downstream message.
        expect(text?.exception).not.toContain('Expected an Image with decoded bytes')
    })

    it('still reports a genuinely malformed input', async () => {
        const rows = await new Pipeline([new Consumer()]).transform([
            { image: createImage({ data: new Uint8Array(0) }) },
        ])
        expect((rows[0]?.text as { exception: string }).exception).toContain(
            'Expected an Image with decoded bytes'
        )
    })
})

describe('describePdfError', () => {
    it('turns a worker failure into instructions', () => {
        resetConfig()
        configure({ pdf: { workerSrc: '/pdf.worker.min.mjs' } })

        const described = describePdfError(
            new Error('Setting up fake worker failed: "Failed to fetch dynamically imported module"')
        )
        expect(described.message).toContain('/pdf.worker.min.mjs')
        expect(described.message).toContain('cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs')
        expect(described.message).toContain('configure({ pdf: { workerSrc')
        // The original is preserved for anyone who needs it.
        expect(described.message).toContain('Setting up fake worker failed')
    })

    it('says so when no worker is configured at all', () => {
        resetConfig()
        expect(describePdfError(new Error('Setting up fake worker failed')).message).toContain(
            'no worker configured'
        )
    })

    it('passes unrelated errors through untouched', () => {
        resetConfig()
        const original = new Error('Invalid PDF structure')
        expect(describePdfError(original)).toBe(original)
    })
})
