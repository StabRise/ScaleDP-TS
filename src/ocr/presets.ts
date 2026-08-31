/**
 * PaddleOCR language presets.
 *
 * Each preset pairs a detection model, a recognition model and a character
 * dictionary. There is no single model covering every script, so the choice is
 * a real one: pick the pairing that matches the documents being processed.
 *
 * Curated from ppu-paddle-ocr's catalogue -- the full list also carries v3/v4
 * models that v5/v6 supersede.
 */

export interface OcrPreset {
    /** Key accepted by `PaddleTextDetector`/`PaddleTextRecognizer`. */
    value: string
    /** Human-readable name, suitable for a language picker. */
    label: string
    /** Scripts this preset can read. */
    scripts: readonly string[]
}

export const PADDLE_OCR_PRESETS: readonly OcrPreset[] = Object.freeze([
    { value: 'v6-small', label: 'Latin / CJK (default)', scripts: ['Latin', 'Han', 'Hiragana', 'Katakana'] },
    {
        value: 'v6-medium',
        label: 'Latin / CJK (medium, more accurate)',
        scripts: ['Latin', 'Han', 'Hiragana', 'Katakana'],
    },
    { value: 'v6-tiny', label: 'Latin / CJK (tiny, fastest)', scripts: ['Latin', 'Han'] },
    { value: 'v5-latin-mobile', label: 'Latin (French, German, Spanish, ...)', scripts: ['Latin'] },
    {
        value: 'v5-eslav-mobile',
        label: 'Latin + Cyrillic (Russian, Ukrainian, ...)',
        scripts: ['Latin', 'Cyrillic'],
    },
    { value: 'v5-cyrillic-mobile', label: 'Cyrillic only', scripts: ['Cyrillic'] },
    { value: 'v5-devanagari-mobile', label: 'Latin + Hindi (Devanagari)', scripts: ['Latin', 'Devanagari'] },
    { value: 'v5-arabic-mobile', label: 'Latin + Arabic', scripts: ['Latin', 'Arabic'] },
    { value: 'v5-greek-mobile', label: 'Latin + Greek', scripts: ['Latin', 'Greek'] },
    { value: 'v5-korean-mobile', label: 'Latin + Korean', scripts: ['Latin', 'Hangul'] },
    { value: 'v5-thai-mobile', label: 'Latin + Thai', scripts: ['Latin', 'Thai'] },
    { value: 'v5-tamil-mobile', label: 'Latin + Tamil', scripts: ['Latin', 'Tamil'] },
    { value: 'v5-telugu-mobile', label: 'Latin + Telugu', scripts: ['Latin', 'Telugu'] },
    { value: 'v5-en-mobile', label: 'English only (fastest)', scripts: ['Latin'] },
])

export const DEFAULT_OCR_PRESET = 'v6-small'

export function isKnownPreset(value: string): boolean {
    return PADDLE_OCR_PRESETS.some((p) => p.value === value)
}

/** Shared by every Paddle stage, so an unknown preset fails at construction. */
export function validatePreset(value: string): void {
    if (!isKnownPreset(value)) {
        throw new RangeError(`Unknown OCR preset "${value}". See PADDLE_OCR_PRESETS for valid values.`)
    }
}

/** Presets able to read a script name as reported by OSD script detection. */
export function presetsForScript(script: string): OcrPreset[] {
    return PADDLE_OCR_PRESETS.filter((p) => p.scripts.includes(script))
}

/**
 * The preset a row asks for, or `fallback` when it does not ask.
 *
 * `presetCol` names a column written by an upstream stage --
 * `TesseractScriptDetector`, whose `ScriptOutput.presets` are ordered
 * best-first, so the head is the pick. A plain preset id is accepted too, so a
 * UI or a hand-written column can name one directly.
 *
 * Everything unusable falls back rather than throwing: no column, a failed
 * detection, a script no preset here covers. A page read by the configured
 * model is better than a page not read at all, and the detector's own output
 * already carries why it had no answer.
 */
export function presetForRow(
    row: Record<string, unknown>,
    presetCol: string,
    fallback: string = DEFAULT_OCR_PRESET
): string {
    if (!presetCol) return fallback

    const value = row[presetCol]
    if (typeof value === 'string') return isKnownPreset(value) ? value : fallback
    if (typeof value !== 'object' || value === null) return fallback

    const { presets } = value as { presets?: unknown }
    if (!Array.isArray(presets)) return fallback

    const pick = presets.find((entry) => typeof entry === 'string' && isKnownPreset(entry))
    return typeof pick === 'string' ? pick : fallback
}
