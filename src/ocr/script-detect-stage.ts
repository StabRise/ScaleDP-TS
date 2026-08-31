/**
 * `TesseractScriptDetector` -- the OSD reading as a pipeline stage.
 *
 * Split from `script-detect.ts` the way `line-orientation-stage.ts` is split
 * from `line-orientation.ts`: the engine call stays usable on its own, and the
 * stage is the thin part that wires it to columns and the error contract.
 *
 * It exists because the answer decides the next stage's model. `presetsForScript`
 * maps a script to the PaddleOCR presets that can read it, and picking the wrong
 * one is the difference between text and noise -- so the suggestion travels in
 * the output rather than making the caller run the lookup separately.
 */

import { OcrError } from '../core/errors.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { createScriptOutput, type ScriptOutput } from '../schemas/script.js'
import { presetsForScript } from './presets.js'
import { detectOsd, disposeScriptDetection, loadScriptDetection } from './script-detect.js'

export interface TesseractScriptDetectorParams extends BaseStageParams {
    /**
     * Minimum OSD score to accept.
     *
     * Not the usual `scoreThreshold` scale: Tesseract's OSD score is unbounded
     * -- typically 1-20 -- rather than a 0-1 confidence. Below it the script is
     * reported as unknown, which is a result and not an error.
     */
    scoreThreshold: number
}

export const TESSERACT_SCRIPT_DETECTOR_DEFAULTS: TesseractScriptDetectorParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'script',
    keepInputData: true,
    scoreThreshold: 0,
})

export class TesseractScriptDetector extends Stage<TesseractScriptDetectorParams> {
    readonly name = 'TesseractScriptDetector'

    constructor(options: Partial<TesseractScriptDetectorParams> = {}) {
        super(
            resolveParams(TESSERACT_SCRIPT_DETECTOR_DEFAULTS, options, {
                scoreThreshold: (value) => {
                    if (!Number.isFinite(value) || value < 0) {
                        throw new RangeError(`scoreThreshold must be 0 or greater, received ${value}`)
                    }
                },
            })
        )
    }

    override async init(): Promise<void> {
        await loadScriptDetection()
    }

    protected async apply(input: unknown, row: Row): Promise<ScriptOutput> {
        const image = input as ScaleDpImage | undefined
        // Check `exception` first. A failed upstream stage returns a well-formed but
        // empty Image, so testing the bytes first would report "no decoded bytes" and
        // bury the real cause.
        if (image?.exception) {
            throw new OcrError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new OcrError('Expected an Image with decoded bytes', this.name)
        }

        const osd = await detectOsd(image)
        const confidence = osd.script_confidence ?? 0
        // An unidentified script is a normal answer on a blank page, so it
        // travels as an empty `script` rather than as an exception.
        const script = osd.script && confidence >= this.params.scoreThreshold ? osd.script : ''

        return createScriptOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            script,
            script_confidence: script ? confidence : 0,
            orientation_degrees: osd.orientation_degrees ?? 0,
            orientation_confidence: osd.orientation_confidence ?? 0,
            presets: script ? presetsForScript(script).map((preset) => preset.value) : [],
        })
    }

    protected onError(message: string, row: Row): ScriptOutput {
        return createScriptOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }

    override async dispose(): Promise<void> {
        await disposeScriptDetection()
    }
}
