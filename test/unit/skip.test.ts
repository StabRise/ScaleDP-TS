/**
 * A page with nothing to read is a skip, not a failure: the reason travels
 * down the pipeline verbatim, so every stage reports the one cause and a UI can
 * tell it apart from an error.
 */
import { describe, expect, it } from 'vitest'
import {
    formatException,
    isSkipped,
    NO_EMBEDDED_IMAGES,
    OcrError,
    SkipError,
    upstreamError,
} from '../../src/core/errors.js'
import { BASE_STAGE_DEFAULTS, resolveParams } from '../../src/core/params.js'
import { Pipeline, type Row, Stage } from '../../src/core/pipeline.js'
import { createDocument } from '../../src/schemas/document.js'
import type { NerOutput } from '../../src/schemas/entity.js'
import { RegexNer } from '../../src/stages/regex-ner.js'

class Rows extends Stage {
    readonly name = 'Rows'
    constructor(private readonly rows: Row[]) {
        super(resolveParams(BASE_STAGE_DEFAULTS))
    }
    protected override async expand(): Promise<Row[]> {
        return this.rows.map((row) => ({ ...row }))
    }
    protected async apply(): Promise<never> {
        throw new Error('unreachable')
    }
    protected onError(message: string): unknown {
        return message
    }
}

describe('skips', () => {
    it('recognises a skip reason, and only that', () => {
        expect(isSkipped(NO_EMBEDDED_IMAGES)).toBe(true)
        expect(isSkipped(`OcrError: Upstream stage failed: ${NO_EMBEDDED_IMAGES}`)).toBe(false)
        expect(isSkipped('ImageError: no decoded bytes')).toBe(false)
        expect(isSkipped('')).toBe(false)
        expect(isSkipped(undefined)).toBe(false)
    })

    it('passes a skip through unchanged and wraps a real failure', () => {
        const make = (message: string) => new OcrError(message, 'Stage')
        expect(upstreamError(NO_EMBEDDED_IMAGES, 'Stage', make)).toBeInstanceOf(SkipError)
        expect(formatException('Stage', upstreamError(NO_EMBEDDED_IMAGES, 'Stage', make))).toBe(
            NO_EMBEDDED_IMAGES
        )

        const failure = formatException('Stage', upstreamError('boom', 'Stage', make))
        expect(failure).toMatch(/^Stage: OcrError: Upstream stage failed: boom/)
    })

    it('reaches the end of a pipeline as the same reason, without a stack', async () => {
        const rows = [{ text: createDocument({ exception: NO_EMBEDDED_IMAGES }) }]
        const out = await new Pipeline([new Rows(rows), new RegexNer()]).transform([{}])
        const ner = out[0]?.ner as NerOutput

        expect(ner.exception).toBe(NO_EMBEDDED_IMAGES)
        expect(isSkipped(ner.exception)).toBe(true)
    })

    it('still reports a real upstream failure as one', async () => {
        const rows = [{ text: createDocument({ exception: 'PaddleTextRecognizer: boom' }) }]
        const out = await new Pipeline([new Rows(rows), new RegexNer()]).transform([{}])
        const ner = out[0]?.ner as NerOutput

        expect(ner.exception).toMatch(/RegexNer: NerError: Upstream stage failed: PaddleTextRecognizer: boom/)
        expect(isSkipped(ner.exception)).toBe(false)
    })
})
