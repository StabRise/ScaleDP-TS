/**
 * Script detection: the OSD reading, and the stage that carries it.
 *
 * tesseract.js is stubbed at the module boundary -- what is worth pinning is
 * what the stage does with a reading, not tesseract's OSD accuracy. The canvas
 * conversion is real, because that is the part with a trap in it: `detect()`
 * cannot take a bare ImageBitmap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, resetConfig } from '../../src/core/config.js'
import { context2d, createCanvas, encodeImage } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { detectOsd, detectScript, disposeScriptDetection } from '../../src/ocr/script-detect.js'
import { TesseractScriptDetector } from '../../src/ocr/script-detect-stage.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'
import type { ScriptOutput } from '../../src/schemas/script.js'

interface FakeOsd {
    tesseract_script_id: number | null
    script: string | null
    script_confidence: number | null
    orientation_degrees: number | null
    orientation_confidence: number | null
}

/** The all-null record tesseract.js resolves when `DetectOS` fails. */
const NOTHING: FakeOsd = {
    tesseract_script_id: null,
    script: null,
    script_confidence: null,
    orientation_degrees: null,
    orientation_confidence: null,
}

const fake = {
    data: NOTHING as FakeOsd,
    /** What was handed to `detect`, per call. */
    seen: [] as unknown[],
    /** `createWorker`'s arguments, per worker built. */
    built: [] as unknown[][],
    terminated: 0,
}

vi.mock('tesseract.js', () => ({
    OEM: { TESSERACT_ONLY: 0, LSTM_ONLY: 1, TESSERACT_LSTM_COMBINED: 2, DEFAULT: 3 },
    createWorker: async (...args: unknown[]) => {
        fake.built.push(args)
        return {
            detect: async (image: unknown) => {
                fake.seen.push(image)
                return { jobId: 'stub', data: fake.data }
            },
            terminate: async () => {
                fake.terminated++
            },
        }
    },
}))

const LATIN: FakeOsd = {
    tesseract_script_id: 1,
    script: 'Latin',
    script_confidence: 4.5,
    orientation_degrees: 90,
    orientation_confidence: 12.75,
}

async function page(): Promise<ScaleDpImage> {
    const canvas = createCanvas(120, 80)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 120, 80)
    return createImage({ data: await encodeImage(canvas), width: 120, height: 80 })
}

const run = async (stage: TesseractScriptDetector, row: Record<string, unknown>) =>
    (await new Pipeline([stage]).transform([row]))[0]?.script as ScriptOutput

beforeEach(async () => {
    fake.data = NOTHING
    fake.seen = []
    fake.built = []
    fake.terminated = 0
    resetConfig()
    await disposeScriptDetection()
})

afterEach(async () => {
    await disposeScriptDetection()
    resetConfig()
})

describe('detectOsd', () => {
    it('hands tesseract a blob, never a bare ImageBitmap', async () => {
        fake.data = LATIN
        const canvas = createCanvas(20, 20)
        context2d(canvas).fillRect(0, 0, 20, 20)

        const reading = await detectOsd(canvas)

        expect(reading).toEqual({
            script: 'Latin',
            script_confidence: 4.5,
            orientation_degrees: 90,
            orientation_confidence: 12.75,
        })
        expect(fake.seen[0]).toBeInstanceOf(Blob)
    })

    it('reports every field as null when OSD could not classify', async () => {
        expect(await detectOsd(await page())).toEqual({
            script: null,
            script_confidence: null,
            orientation_degrees: null,
            orientation_confidence: null,
        })
        expect(await detectScript(await page())).toBeNull()
    })

    it('builds the OSD worker with the legacy engine', async () => {
        fake.data = LATIN
        await detectOsd(await page())
        // OEM 0: the LSTM engine carries no OSD data, and tesseract.js fixes the
        // core at createWorker time, so this cannot be corrected later.
        expect(fake.built[0]?.slice(0, 2)).toEqual(['osd', 0])
    })

    it('reuses one worker, and rebuilds it when the asset paths change', async () => {
        fake.data = LATIN
        await detectOsd(await page())
        await detectOsd(await page())
        expect(fake.built).toHaveLength(1)
        expect(fake.built[0]?.[2]).toEqual({})

        configure({ tesseract: { osdLangPath: 'https://example.test/tessdata', osdGzip: false } })
        await detectOsd(await page())

        expect(fake.built).toHaveLength(2)
        expect(fake.built[1]?.[2]).toEqual({
            langPath: 'https://example.test/tessdata',
            gzip: false,
        })
        expect(fake.terminated).toBe(1)
    })
})

describe('TesseractScriptDetector', () => {
    it('reports the script, the rotation and the presets that can read it', async () => {
        fake.data = LATIN
        const output = await run(new TesseractScriptDetector(), { image: await page() })

        expect(output.exception).toBe('')
        expect(output.type).toBe('tesseract-osd')
        expect(output.script).toBe('Latin')
        expect(output.script_confidence).toBe(4.5)
        expect(output.orientation_degrees).toBe(90)
        expect(output.orientation_confidence).toBe(12.75)
        expect(output.presets).toContain('v5-latin-mobile')
    })

    it('suggests the Cyrillic presets for a Cyrillic page', async () => {
        fake.data = { ...LATIN, script: 'Cyrillic' }
        const output = await run(new TesseractScriptDetector(), { image: await page() })

        expect(output.presets).toContain('v5-cyrillic-mobile')
        expect(output.presets).not.toContain('v5-latin-mobile')
    })

    it('treats an unidentified script as a result, not a failure', async () => {
        const output = await run(new TesseractScriptDetector(), { image: await page() })

        expect(output.exception).toBe('')
        expect(output.script).toBe('')
        expect(output.presets).toEqual([])
    })

    it('reports a reading under scoreThreshold as unknown', async () => {
        fake.data = LATIN
        const output = await run(new TesseractScriptDetector({ scoreThreshold: 10 }), {
            image: await page(),
        })

        expect(output.exception).toBe('')
        expect(output.script).toBe('')
        expect(output.script_confidence).toBe(0)
        // The rotation is a separate reading and survives the threshold.
        expect(output.orientation_degrees).toBe(90)
    })

    it('surfaces an upstream failure rather than complaining about the shape', async () => {
        const output = await run(new TesseractScriptDetector(), {
            image: createImage({ exception: 'PdfToImage: no pages' }),
        })

        expect(output.exception).toContain('PdfToImage: no pages')
        expect(output.exception).not.toContain('decoded bytes')
    })

    it('records a missing image and lets the pipeline finish', async () => {
        const rows = await new Pipeline([new TesseractScriptDetector()]).transform([{ image: null }])

        expect(rows).toHaveLength(1)
        const output = rows[0]?.script as ScriptOutput
        expect(output.exception).toContain('TesseractScriptDetector')
        expect(output.script).toBe('')
    })

    it('throws instead when propagateError is set', async () => {
        await expect(
            new Pipeline([new TesseractScriptDetector({ propagateError: true })]).transform([{ image: null }])
        ).rejects.toThrow(/decoded bytes/)
    })

    it('rejects a negative scoreThreshold at construction', () => {
        expect(() => new TesseractScriptDetector({ scoreThreshold: -1 })).toThrow(/0 or greater/)
    })
})
