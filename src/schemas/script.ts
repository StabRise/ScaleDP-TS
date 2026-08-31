/**
 * The result of Tesseract's OSD (orientation and script detection) pass.
 *
 * No Python original: ScaleDP has no OSD stage, so this is a TS-only schema
 * following the house shape -- `path`, `type`, `exception`, and the payload
 * between them, with the payload's field names taken from Tesseract's own.
 */

export interface ScriptOutput {
    path: string
    /** Engine that produced it: 'tesseract-osd'. */
    type: string
    /**
     * Script as Tesseract names it, e.g. 'Latin', 'Cyrillic', 'Han'.
     *
     * Empty when OSD could not identify one, which is a normal answer on a
     * blank or near-blank page rather than a failure -- `exception` stays empty.
     */
    script: string
    /** Tesseract's OSD score. Unbounded, typically 1-20 -- not a probability. */
    script_confidence: number
    /** Page rotation Tesseract reports: 0, 90, 180 or 270. */
    orientation_degrees: number
    orientation_confidence: number
    /** PaddleOCR preset ids able to read `script`, best-first. Empty when unknown. */
    presets: string[]
    exception: string
}

export function createScriptOutput(init: Partial<ScriptOutput> = {}): ScriptOutput {
    return {
        path: init.path ?? 'memory',
        type: init.type ?? 'tesseract-osd',
        script: init.script ?? '',
        script_confidence: init.script_confidence ?? 0,
        orientation_degrees: init.orientation_degrees ?? 0,
        orientation_confidence: init.orientation_confidence ?? 0,
        presets: init.presets ?? [],
        exception: init.exception ?? '',
    }
}
