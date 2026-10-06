/**
 * Find structured identifiers -- dates, phone numbers, e-mail addresses, card
 * numbers, PESEL and SSN -- in OCR text, which is too noisy for a strict regex.
 *
 * A NER model is good at names and poor at numbers, and numbers are exactly
 * what redaction cannot afford to miss. OCR defeats an exact pattern in three
 * ways, and each gets its own remedy:
 *
 * - **Lookalikes** (`O` for `0`, `l` or `|` for `1`, `S` for `5`) are repaired
 *   by `normaliseOcrText` before anything else looks at the text. It changes
 *   characters but never the length, so every offset still lands on the OCR
 *   box it came from.
 * - **Stray or garbled characters** (a comma inside a card number, a `*` where
 *   a digit smudged) are absorbed by matching with `FuzzyRegex` within an edit
 *   budget, `maxEdits`.
 * - **Formats the patterns don't know** are left to the industry-standard
 *   libraries where they are installed: libphonenumber-js for phone numbers and
 *   chrono-node for dates. Both are optional peers, loaded lazily. Without them
 *   the built-in patterns still run.
 *
 * Every candidate is then validated -- Luhn, the PESEL checksum and its encoded
 * birth date, the calendar, the SSN allocation rules. A failed check lowers the
 * score rather than dropping the match, so `threshold` remains the one knob.
 *
 * This stage has no equivalent in Python ScaleDP.
 */

import { boxesForRange, buildCharToBoxMap } from '../core/entities.js'
import { NerError, upstreamError } from '../core/errors.js'
import { type FuzzyCosts, type FuzzyEdit, FuzzyRegex } from '../core/fuzzy-regex.js'
import { assertInRange, BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import type { Document } from '../schemas/document.js'
import { createNerOutput, type Entity, type NerOutput } from '../schemas/entity.js'
import { countryLocalesSupported, findCountries } from './countries.js'

/** Entity groups this stage can emit. Names follow pdf-redaction's PII categories. */
export type PatternLabel =
    | 'DATE'
    | 'PHONE'
    | 'EMAIL'
    | 'URL'
    | 'IBAN'
    | 'CREDIT_CARD'
    | 'PESEL'
    | 'SSN'
    | 'ZIP_CODE'
    | 'COUNTRY'

export const PATTERN_LABELS: readonly PatternLabel[] = Object.freeze([
    'DATE',
    'PHONE',
    'EMAIL',
    'URL',
    'IBAN',
    'CREDIT_CARD',
    'PESEL',
    'SSN',
    'ZIP_CODE',
    'COUNTRY',
])

/** chrono-node locales with a parser worth using. */
export const DATE_LOCALES: readonly string[] = Object.freeze([
    'en',
    'de',
    'es',
    'fi',
    'fr',
    'it',
    'ja',
    'nl',
    'pt',
    'ru',
    'sv',
    'uk',
    'vi',
    'zh',
])

export interface RegexNerParams extends BaseStageParams {
    /** Detectors to run. */
    labels: PatternLabel[]
    /** Drop matches scoring below this. */
    threshold: number
    /**
     * Repair OCR lookalikes and allow `maxEdits`. Off matches the text exactly
     * as written.
     */
    ocrTolerant: boolean
    /**
     * Stray or garbled characters a match may absorb. Each one costs score.
     * Only punctuation and symbols count: a stray digit or letter is never
     * absorbed, since that is how one number turns into another.
     */
    maxEdits: number
    /**
     * Score candidates by checksum and calendar validity. Off scores every
     * well-shaped candidate the same, which is the setting for synthetic or
     * test data whose numbers do not check out.
     */
    validate: boolean
    /**
     * Use libphonenumber-js and chrono-node when they are installed. Off runs
     * the built-in patterns alone, which is deterministic across installs.
     */
    useLibraries: boolean
    /**
     * ISO 3166 country for phone numbers written without a country code, such
     * as `PL` or `US`. Empty finds only numbers with a `+` prefix through
     * libphonenumber-js; the built-in pattern is unaffected.
     */
    defaultCountry: string
    /** chrono-node locales to parse dates in. Numeric and Polish dates are built in. */
    dateLocales: string[]
    /**
     * Languages to recognise country names in, through `Intl.DisplayNames` --
     * any BCP 47 locale the runtime knows. ISO codes are language-independent.
     */
    countryLocales: string[]
}

export const REGEX_NER_DEFAULTS: RegexNerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'text',
    outputCol: 'ner',
    keepInputData: true,
    labels: [...PATTERN_LABELS],
    threshold: 0.5,
    ocrTolerant: true,
    maxEdits: 1,
    validate: true,
    useLibraries: true,
    defaultCountry: '',
    dateLocales: ['en'],
    countryLocales: ['en', 'pl'],
})

/* ── Normalisation and validators ────────────────────────────────────────── */

/** OCR lookalikes for each digit. */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
    O: '0',
    o: '0',
    Q: '0',
    D: '0',
    I: '1',
    l: '1',
    i: '1',
    '|': '1',
    '!': '1',
    Z: '2',
    z: '2',
    S: '5',
    s: '5',
    G: '6',
    b: '6',
    B: '8',
    g: '9',
    q: '9',
})

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c)
const isDigitLike = (c: string) => isDigit(c) || LOOKALIKES[c] !== undefined

export interface NormalisedText {
    /** Same length as the input; lookalikes inside numbers replaced by digits. */
    text: string
    /** `repaired[i]` is 1 where a lookalike was replaced. */
    repaired: Uint8Array
}

/**
 * Repair lookalike characters inside numbers, keeping the text's length.
 *
 * Text is read as runs of digits and lookalikes. A run is a candidate when it
 * holds at least one real digit and no letter touches it, which leaves `Bill`,
 * `SOS` and the `1s` of `1st` alone. Runs joined by single separators form one
 * number -- the four groups of a card, the parts of a date -- and a number's
 * candidates are repaired when at least half its characters are real digits.
 * Judging the whole number is what lets `4111 1lll 1111 1111` through: `1lll`
 * on its own is mostly letters.
 *
 * Dashes of every width become `-`, so patterns need to know only one.
 */
export function normaliseOcrText(text: string): NormalisedText {
    // Code units, not code points: surrogate pairs stay two entries, so the
    // join is exactly as long as the input.
    const out = text.replace(/[‒–—]/g, '-').split('')
    const repaired = new Uint8Array(text.length)

    interface Run {
        start: number
        end: number
        real: number
    }
    const runs: Run[] = []
    for (let i = 0; i < out.length; ) {
        if (!isDigitLike(out[i] as string)) {
            i++
            continue
        }
        let j = i
        let real = 0
        while (j < out.length && isDigitLike(out[j] as string)) {
            if (isDigit(out[j])) real++
            j++
        }
        if (real > 0 && !isLetter(out[i - 1]) && !isLetter(out[j])) runs.push({ start: i, end: j, real })
        i = j
    }

    const repair = (group: Run[]) => {
        const real = group.reduce((n, r) => n + r.real, 0)
        const length = group.reduce((n, r) => n + r.end - r.start, 0)
        if (real === length || real * 2 < length) return
        for (const run of group) {
            for (let k = run.start; k < run.end; k++) {
                const digit = LOOKALIKES[out[k] as string]
                if (digit !== undefined) {
                    out[k] = digit
                    repaired[k] = 1
                }
            }
        }
    }

    let group: Run[] = []
    for (const run of runs) {
        const previous = group[group.length - 1]
        const joined =
            previous && run.start === previous.end + 1 && /[ \-./]/.test(out[previous.end] as string)
        if (!joined && group.length > 0) {
            repair(group)
            group = []
        }
        group.push(run)
    }
    if (group.length > 0) repair(group)

    return { text: out.join(''), repaired }
}

export function luhnValid(digits: string): boolean {
    if (!/^\d{2,}$/.test(digits)) return false
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i])
        if (i % 2 === 1) {
            d *= 2
            if (d > 9) d -= 9
        }
        sum += d
    }
    return sum % 10 === 0
}

export function dateValid(year: number, month: number, day: number): boolean {
    if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return false
    return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Month offsets encode the century: +80 for the 1800s, +20 for the 2000s, and so on. */
const PESEL_CENTURIES: readonly [offset: number, century: number][] = [
    [80, 1800],
    [60, 2200],
    [40, 2100],
    [20, 2000],
    [0, 1900],
]
const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]

export function peselValid(digits: string): boolean {
    if (!/^\d{11}$/.test(digits)) return false
    const d = [...digits].map(Number)
    const sum = PESEL_WEIGHTS.reduce((acc, w, i) => acc + w * (d[i] as number), 0)
    if ((10 - (sum % 10)) % 10 !== d[10]) return false

    const yy = Number(digits.slice(0, 2))
    const mm = Number(digits.slice(2, 4))
    const dd = Number(digits.slice(4, 6))
    const [offset, century] = PESEL_CENTURIES.find(([o]) => mm > o) ?? [0, 1900]
    return dateValid(century + yy, mm - offset, dd)
}

/** The SSA's never-issued ranges: area 000, 666 and 9xx, group 00, serial 0000. */
export function ssnValid(digits: string): boolean {
    if (!/^\d{9}$/.test(digits)) return false
    const area = digits.slice(0, 3)
    return (
        area !== '000' &&
        area !== '666' &&
        area[0] !== '9' &&
        digits.slice(3, 5) !== '00' &&
        digits.slice(5) !== '0000'
    )
}

/** IBAN length by country, from the SWIFT IBAN registry. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
    AD: 24,
    AE: 23,
    AL: 28,
    AT: 20,
    AZ: 28,
    BA: 20,
    BE: 16,
    BG: 22,
    BH: 22,
    BI: 27,
    BR: 29,
    BY: 28,
    CH: 21,
    CR: 22,
    CY: 28,
    CZ: 24,
    DE: 22,
    DJ: 27,
    DK: 18,
    DO: 28,
    EE: 20,
    EG: 29,
    ES: 24,
    FI: 18,
    FK: 18,
    FO: 18,
    FR: 27,
    GB: 22,
    GE: 22,
    GI: 23,
    GL: 18,
    GR: 27,
    GT: 28,
    HN: 28,
    HR: 21,
    HU: 28,
    IE: 22,
    IL: 23,
    IQ: 23,
    IS: 26,
    IT: 27,
    JO: 30,
    KW: 30,
    KZ: 20,
    LB: 28,
    LC: 32,
    LI: 21,
    LT: 20,
    LU: 20,
    LV: 21,
    LY: 25,
    MC: 27,
    MD: 24,
    ME: 22,
    MK: 19,
    MN: 20,
    MR: 27,
    MT: 31,
    MU: 30,
    NI: 28,
    NL: 18,
    NO: 15,
    OM: 23,
    PK: 24,
    PL: 28,
    PS: 29,
    PT: 25,
    QA: 29,
    RO: 24,
    RS: 22,
    RU: 33,
    SA: 24,
    SC: 31,
    SD: 18,
    SE: 24,
    SI: 19,
    SK: 24,
    SM: 27,
    SO: 23,
    ST: 25,
    SV: 28,
    TL: 23,
    TN: 24,
    TR: 26,
    UA: 29,
    VA: 22,
    VG: 24,
    XK: 20,
    YE: 30,
})

/** Whether `iban` -- compact, upper-case -- has its country's length and passes ISO 7064 mod 97-10. */
export function ibanValid(iban: string): boolean {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) || IBAN_LENGTHS[iban.slice(0, 2)] !== iban.length) return false
    const rearranged = iban.slice(4) + iban.slice(0, 4)
    let remainder = 0
    for (const char of rearranged) {
        // A=10 ... Z=35, digits as themselves; folded in piecewise so the number never overflows.
        const value = char >= 'A' ? String(char.charCodeAt(0) - 55) : char
        for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
    }
    return remainder === 1
}

/* ── Built-in patterns ──────────────────────────────────────────────────── */

/**
 * Month names, matched case-insensitively. Polish appears in nominative and
 * genitive, and OCR routinely drops its diacritics, so each accented letter
 * also accepts its plain form.
 */
const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'sept',
    'jan',
    'feb',
    'mar',
    'apr',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
    'stycze[ńn]',
    'stycznia',
    'luty',
    'lutego',
    'marzec',
    'marca',
    'kwiecie[ńn]',
    'kwietnia',
    'maj',
    'maja',
    'czerwiec',
    'czerwca',
    'lipiec',
    'lipca',
    'sierpie[ńn]',
    'sierpnia',
    'wrzesie[ńn]',
    'wrze[śs]nia',
    'pa[źz]dziernik',
    'pa[źz]dziernika',
    'listopad',
    'listopada',
    'grudzie[ńn]',
    'grudnia',
]
const MONTH = `(?:${MONTHS.join('|')})`
const MONTH_WORD = new RegExp(`(?<!\\p{L})${MONTH}(?!\\p{L})`, 'giu')

/** An optional separator between digit groups: one dash, dot or slash, a space or two, or a line break. */
const SEP = '(?:[ \\t]?[-./][ \\t]?|[ \\t]{1,2}|\\r?\\n)?'
/** The same, required. */
const GROUP_SEP = '(?:[ \\t]?[-./][ \\t]?|[ \\t]{1,2}|\\r?\\n)'
/** Phone groups are joined by dashes, dots and spaces -- never slashes, which belong to dates and references. */
const PHONE_SEP = '(?:[ \\t]?[-.][ \\t]?|[ \\t]{1,2}|\\r?\\n)?'
/** The separator a numeric date requires. */
const DATE_SEP = '[ \\t]?[-./][ \\t]?'

/** A candidate as a detector scores it. */
interface Candidate {
    text: string
    /**
     * The digits it spells, separators dropped. A `?` stands for a character
     * matched by substitution, whose true digit is unknown.
     */
    digits: string
    validate: boolean
    /** Up to 30 characters before the match, for detectors that read their context. */
    before: string
    /** Up to 40 characters after it. */
    after: string
}

interface Detector {
    pattern: string
    flags?: string
    /** Edits allowed; email addresses get none. */
    fuzzy: boolean
    /** Allow substitution, which leaves a digit unknown. Off where nothing could validate it. */
    substitute: boolean
    /** Run on the raw text instead of the normalised one. */
    raw?: boolean
    /** Score in [0, 1], or null to reject the candidate outright. */
    score(c: Candidate): number | null
    /**
     * Whether the shape alone proves nothing -- a bare digit run. A weak
     * candidate below threshold is simply dropped; a strong one still holds
     * its digits against other labels (see `findPatternMatches`).
     */
    weak?(c: Candidate): boolean
}

const hasSeparator = (text: string) => /[^0-9A-Za-z]/.test(text)

/**
 * What a candidate scores when its check fails but its shape is unmistakable:
 * four groups of four, a country code and that country's IBAN length, a date
 * like `30.02.2000` that the calendar has no room for. Just
 * over the default threshold -- reported, but plainly in doubt.
 */
const FAILED_BUT_SHAPED = 0.55

const IBAN_PATTERN = '[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?'

function scoreIban(c: Candidate): number | null {
    const compact = c.text.replace(/[^A-Z0-9]/g, '')
    // Not an IBAN shape at all unless the country is known and the length is its own.
    if (IBAN_LENGTHS[compact.slice(0, 2)] !== compact.length) return null
    if (!c.validate) return UNVERIFIED
    return ibanValid(compact) ? 0.95 : FAILED_BUT_SHAPED
}

/** What an unverifiable but well-shaped candidate scores -- with `validate: false`, or with a digit unknown. */
const UNVERIFIED = 0.7

/** Two- and four-digit years; a two-digit one is read as 1950-2049. */
function fullYear(yy: string): number {
    const y = Number(yy)
    return yy.length === 4 ? y : y < 50 ? 2000 + y : 1900 + y
}

function numericDateValid(text: string): boolean {
    const parts = text.split(/[^0-9]+/).filter(Boolean)
    if (parts.length !== 3) return false
    const [a, b, c] = parts as [string, string, string]
    if (a.length === 4) return c.length <= 2 && b.length <= 2 && dateValid(Number(a), Number(b), Number(c))
    if (a.length > 2 || b.length > 2 || (c.length !== 2 && c.length !== 4)) return false
    const year = fullYear(c)
    // Day-first and month-first are both in use; either reading will do.
    return dateValid(year, Number(b), Number(a)) || dateValid(year, Number(a), Number(b))
}

/**
 * A numeric date the calendar rejects but nothing else would: a four-digit
 * year, one separator used twice, a day of 1-31 and a month of 1-12 in either
 * order. `30.02.2000` is a typo or an OCR misread of a date, not a version
 * number, and it is still someone's date to redact.
 */
function numericDateShaped(text: string): boolean {
    const separators = text.match(/[-./]/g) ?? []
    if (separators.length !== 2 || separators[0] !== separators[1]) return false
    const parts = text.split(/[^0-9]+/).filter(Boolean)
    if (parts.length !== 3) return false
    const [a, b, c] = parts as [string, string, string]
    const [x, y] = a.length === 4 ? [c, b] : c.length === 4 ? [a, b] : []
    if (x === undefined || y === undefined || x.length > 2 || y.length > 2) return false
    const inRange = (day: number, month: number) => day >= 1 && day <= 31 && month >= 1 && month <= 12
    return inRange(Number(x), Number(y)) || inRange(Number(y), Number(x))
}

function namedDateValid(text: string): boolean {
    const numbers = text
        .replace(MONTH_WORD, ' ')
        .replace(/(?<=\d)(?:st|nd|rd|th)(?!\p{L})/giu, '')
        .split(/[^0-9]+/)
        .filter(Boolean)
    if (numbers.length !== 2) return false
    const [first, second] = numbers as [string, string]
    const [day, year] = first.length === 4 ? [second, first] : [first, second]
    return day.length <= 2 && Number(day) >= 1 && Number(day) <= 31 && year.length === 4
}

/** Host labels joined by dots. */
const HOST =
    '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)*'
/** An optional path, query or fragment: anything up to whitespace or a quote. */
const URL_PATH = '(?:[/?#][^\\s<>"\'`]*)?'
const COMMON_TLDS = [
    'com',
    'org',
    'net',
    'edu',
    'gov',
    'io',
    'co',
    'eu',
    'pl',
    'de',
    'uk',
    'fr',
    'it',
    'es',
    'nl',
    'info',
    'biz',
]
/** A URL does not end in the sentence's own punctuation. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]$/

const POSTAL_KEYWORD =
    /(?:zip(?: ?code)?|postal(?: ?code)?|post ?code|kod(?: pocztowy)?|plz|code postal|c\.? ?p\.?)\s*[:.#-]?\s*$/i
/** `NY 10001`, `CA, 94105`. */
const US_STATE_BEFORE = /(?<!\p{L})[A-Z]{2},?\s+$/u
/** A Polish code is written before its town: `00-950 Warszawa`. */
const CITY_AFTER = /^\s+\p{Lu}\p{Ll}/u
const STREET_WORDS =
    /^\s+\p{Lu}[\p{L}-]*\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl)\b/iu

/** A capitalised town after the code, `10115 Berlin`, and not the street after a house number, `12345 Main Street`. */
function cityFollows(after: string): boolean {
    return CITY_AFTER.test(after) && !STREET_WORDS.test(after)
}

/**
 * Detectors by label. Most labels have one; a label whose forms need different
 * handling -- a postal code with letters must not have them repaired into
 * digits -- has several.
 */
export const PATTERN_DETECTORS: Readonly<Record<PatternLabel, readonly Detector[]>> = Object.freeze({
    EMAIL: [
        {
            // Stray spaces around '@' and '.', and '©' read for '@'. The final dot
            // must touch its TLD, so "x@example. Then" does not swallow the next word.
            pattern:
                '[\\p{L}\\p{N}._%+-]+ ?[@©] ?[\\p{L}\\p{N}-]+(?: ?\\.[\\p{L}\\p{N}-]+)* ?\\.[A-Za-z]{2,24}',
            fuzzy: false,
            substitute: false,
            raw: true,
            score: (c) => (/^[^ ©]+@[^ ]+$/.test(c.text) ? 0.95 : 0.75),
        },
    ],
    IBAN: [
        {
            // Country code, check digits, then the account in groups of four.
            // Read from the normalised text, so a lookalike in a digit group is
            // repaired...
            pattern: IBAN_PATTERN,
            fuzzy: true,
            substitute: false,
            score: scoreIban,
        },
        {
            // ...and from the raw one, since the repair can also turn a letter of
            // the account into a digit -- the B of a `0B12` group into an 8.
            pattern: IBAN_PATTERN,
            fuzzy: true,
            substitute: false,
            raw: true,
            score: scoreIban,
        },
        {
            // A Polish account number (NRB) is the IBAN without its `PL`: 26
            // digits, written 2-4-4-4-4-4-4.
            pattern: '\\d{2}(?: ?\\d{4}){6}',
            fuzzy: true,
            substitute: false,
            score: (c) => {
                if (c.digits.length !== 26) return null
                if (!c.validate) return UNVERIFIED
                if (ibanValid(`PL${c.digits}`)) return 0.9
                return hasSeparator(c.text) ? FAILED_BUT_SHAPED : 0.3
            },
            weak: (c) => !hasSeparator(c.text),
        },
    ],
    CREDIT_CARD: [
        {
            // Amex 4-6-5, or 13-19 digits in groups of four.
            pattern: `\\d{4}${SEP}\\d{6}${SEP}\\d{5}|\\d{4}(?:${SEP}\\d{4}){2}${SEP}\\d{1,4}(?:${SEP}\\d{1,3})?`,
            fuzzy: true,
            substitute: true,
            score: (c) => {
                if (c.digits.length < 13 || c.digits.length > 19) return null
                if (!c.validate || c.digits.includes('?')) return UNVERIFIED
                if (luhnValid(c.digits)) return 0.95
                // Grouped in fours, a number that fails Luhn is still a card --
                // one OCR misread, a typo, a test number -- and redaction would
                // rather over-cover it. As one bare run it could be anything.
                return hasSeparator(c.text) ? FAILED_BUT_SHAPED : 0.3
            },
            weak: (c) => !hasSeparator(c.text),
        },
    ],
    PESEL: [
        {
            // Eleven digits; OCR may split them once.
            pattern: '(?:\\d ?){10}\\d',
            fuzzy: true,
            substitute: true,
            score: (c) => {
                if ((c.text.match(/ /g)?.length ?? 0) > 1) return null
                if (!c.validate || c.digits.includes('?')) return UNVERIFIED
                return peselValid(c.digits) ? 0.95 : 0.3
            },
            // Eleven bare digits that fail the checksum and the date are a phone
            // number or a reference far more often than a mistyped PESEL.
            weak: () => true,
        },
    ],
    SSN: [
        {
            // Grouped 3-2-4 with both separators, or nine bare digits. One separator
            // alone is a different number: `94105-1234` is a ZIP+4.
            pattern: `\\d{3}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{4}|\\d{9}`,
            fuzzy: true,
            substitute: true,
            score: (c) => {
                // A bare nine-digit run is as likely an account number as an SSN.
                const separated = hasSeparator(c.text)
                if (!c.validate || c.digits.includes('?')) return separated ? UNVERIFIED : 0.45
                if (!ssnValid(c.digits)) return 0.3
                return separated ? 0.9 : 0.45
            },
            weak: (c) => !hasSeparator(c.text),
        },
    ],
    DATE: [
        {
            pattern: [
                `\\d{1,4}${DATE_SEP}\\d{1,2}${DATE_SEP}\\d{2,4}`,
                // 12 Jan 2024, 12th of January 2024, 12 stycznia 2024
                `\\d{1,2}(?:st|nd|rd|th)?\\.?[ \\t]*(?:of[ \\t]+)?${MONTH}\\.?,?[ \\t]*\\d{4}`,
                // Jan. 12, 2024
                `${MONTH}\\.?[ \\t]*\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]*\\d{4}`,
            ].join('|'),
            flags: 'i',
            fuzzy: true,
            // A date with an unknown digit cannot be checked against the calendar.
            substitute: false,
            score: (c) => {
                if (!c.validate) return UNVERIFIED
                if (/\p{L}{3}/u.test(c.text)) return namedDateValid(c.text) ? 0.9 : null
                if (numericDateValid(c.text)) return 0.9
                return numericDateShaped(c.text) ? FAILED_BUT_SHAPED : null
            },
        },
        {
            // A month and year with no day: `10/2024`, `10.2024`, `2024-10`,
            // `October 2024`, `paźdz. 2024`. The month needs two digits -- `3/2024`
            // is how invoices are numbered, `FV 3/2024`, far more often than a date.
            pattern: [`\\d{2}[./-]\\d{4}`, `\\d{4}-\\d{2}`, `${MONTH}\\.?,?[ \\t]*\\d{4}`].join('|'),
            flags: 'i',
            fuzzy: false,
            substitute: false,
            score: (c) => {
                const numbers = c.text.split(/[^0-9]+/).filter(Boolean)
                const year = Number(numbers.find((n) => n.length === 4))
                if (!(year >= 1900 && year <= 2099)) return null
                // A named month says "date" by itself; a bare 10/2024 less so.
                if (/\p{L}{3}/u.test(c.text)) return c.validate ? 0.8 : UNVERIFIED
                const month = Number(numbers.find((n) => n.length === 2))
                return month >= 1 && month <= 12 ? 0.7 : null
            },
        },
    ],
    PHONE: [
        {
            // Optional '+' country code and '(area)', then digit groups.
            pattern: `(?:\\+ ?)?\\(?\\d{1,4}\\)?(?:${PHONE_SEP}\\(?\\d{1,5}\\)?){0,5}`,
            fuzzy: true,
            substitute: true,
            score: (c) => {
                if (c.digits.length < 9 || c.digits.length > 15) return null
                if (c.text.startsWith('+')) return 0.85
                // A bare digit run is an invoice number as often as a phone number.
                return hasSeparator(c.text) ? UNVERIFIED : 0.45
            },
            weak: (c) => !hasSeparator(c.text) && !c.text.startsWith('+'),
        },
    ],
    URL: [
        {
            // A scheme or `www.`, which OCR often prints with spaces in it.
            pattern: `(?:https? ?: ?/ ?/ ?|www ?\\. ?)${HOST}(?::\\d{1,5})?${URL_PATH}`,
            flags: 'i',
            fuzzy: false,
            substitute: false,
            raw: true,
            score: (c) => {
                if (TRAILING_PUNCTUATION.test(c.text)) return null
                return /\s/.test(c.text) ? 0.8 : 0.95
            },
        },
        {
            // A bare domain is only trusted with a TLD people actually type.
            pattern: `${HOST}\\.(?:${COMMON_TLDS.join('|')})(?::\\d{1,5})?${URL_PATH}`,
            flags: 'i',
            fuzzy: false,
            substitute: false,
            raw: true,
            score: (c) => {
                if (TRAILING_PUNCTUATION.test(c.text)) return null
                return /[/?#]/.test(c.text) ? 0.75 : 0.6
            },
        },
    ],
    // Countries are matched against `Intl`'s names and the ISO tables rather
    // than a pattern; see `findCountries`.
    COUNTRY: [],
    ZIP_CODE: [
        {
            // Polish 00-000, US 12345 and ZIP+4 12345-6789. Five bare digits are
            // also German, French, Italian and Spanish codes -- and prices, and
            // house numbers -- so those need their context to count.
            pattern: '\\d{2}-\\d{3}|\\d{5}(?: ?- ?\\d{4})?',
            fuzzy: false,
            substitute: false,
            score: (c) => {
                const labelled = POSTAL_KEYWORD.test(c.before)
                if (/^\d{2}-\d{3}$/.test(c.text)) return labelled || CITY_AFTER.test(c.after) ? 0.9 : 0.75
                if (c.digits.length === 9) return 0.85
                if (labelled) return 0.9
                if (US_STATE_BEFORE.test(c.before)) return 0.85
                if (cityFollows(c.after)) return 0.6
                return 0.4
            },
            weak: (c) => c.digits.length === 5 && !c.text.includes('-'),
        },
        {
            // UK (SW1A 1AA) and Canadian (K1A 0B1) codes. Their letters are part
            // of the code, so they are read from the raw text: the lookalike
            // repair would turn the B of 0B1 into an 8.
            pattern:
                '[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[ABD-HJLNP-UW-Z]{2}|[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d',
            fuzzy: false,
            substitute: false,
            raw: true,
            score: (c) => (POSTAL_KEYWORD.test(c.before) ? 0.9 : 0.75),
        },
    ],
})

/** Overlaps go to the more specific label. */
const PRIORITY: readonly PatternLabel[] = [
    'EMAIL',
    'URL',
    'IBAN',
    'CREDIT_CARD',
    'PESEL',
    'SSN',
    'DATE',
    'ZIP_CODE',
    'COUNTRY',
    'PHONE',
]

/** Score kept per unit of edit cost, and for a match that needed lookalikes repaired. */
const EDIT_PENALTY = 0.85
const REPAIR_PENALTY = 0.95

/**
 * What a stray character costs to absorb. Only punctuation and symbols are
 * forgiven: a stray letter or digit is how one number becomes another, and
 * lookalike letters are the normaliser's job.
 */
const insertCost = (c: string) => (/[\p{L}\p{N}\r\n]/u.test(c) ? Number.POSITIVE_INFINITY : 1)

/**
 * What it costs for a character to stand in for a digit. Only junk does --
 * `*`, `#`, `~`, the marks a smudge becomes. A separator never does, or
 * `12.03.2024` could be read as an SSN with its dot for a digit.
 */
const substituteCost = (c: string) => (/[\p{L}\p{N}\s\-./,:;()+@]/u.test(c) ? Number.POSITIVE_INFINITY : 1)

const compiled = new WeakMap<Detector, FuzzyRegex>()

function regexFor(detector: Detector): FuzzyRegex {
    let regex = compiled.get(detector)
    if (!regex) {
        regex = new FuzzyRegex(detector.pattern, detector.flags ?? '')
        compiled.set(detector, regex)
    }
    return regex
}

/** A country code just before: `+48`, `+48 `, `+1-`. */
const AFTER_COUNTRY_CODE = /\+(?:\d{1,4}[ \t.-]?)?$/

/**
 * Not inside a longer word or number, not the tail of a `1.2.3`-style chain,
 * and not straight after a country code: digits there are the rest of a phone
 * number, which only the phone pattern -- matching the `+` itself -- may read.
 */
function boundaries(text: string) {
    const isAlnum = (c: string | undefined) => isDigit(c) || isLetter(c)
    const isJoin = (c: string | undefined) => c === '-' || c === '.' || c === '/'
    return {
        canStart: (i: number) =>
            !isAlnum(text[i - 1]) &&
            !(isJoin(text[i - 1]) && isDigit(text[i - 2])) &&
            !AFTER_COUNTRY_CODE.test(text.slice(Math.max(0, i - 6), i)),
        canEnd: (i: number) => !isAlnum(text[i]) && !(isJoin(text[i]) && isDigit(text[i + 1])),
    }
}

/** Digits spelled by `text[start, end)`, with substituted characters as `?` and inserted ones dropped. */
function spelledDigits(text: string, start: number, end: number, edits: readonly FuzzyEdit[]): string {
    const kinds = new Map(edits.map((e) => [e.index, e.kind]))
    let out = ''
    for (let i = start; i < end; i++) {
        const kind = kinds.get(i)
        if (kind === 'insert') continue
        if (kind === 'substitute') out += '?'
        else if (isDigit(text[i])) out += text[i]
    }
    return out
}

/* ── Libraries ──────────────────────────────────────────────────────────── */

/** A span a library vouches for, with its score. */
export interface LibraryMatch {
    start: number
    end: number
    score: number
}

/**
 * The optional libraries, adapted to plain functions over a string. Tests and
 * callers with their own engines can supply these directly.
 */
export interface PatternEngines {
    findPhones?: (text: string, defaultCountry: string) => LibraryMatch[]
    findDates?: (text: string, locales: readonly string[]) => LibraryMatch[]
}

/** The slice of chrono-node's API used here. */
interface ChronoParser {
    parse(text: string): {
        index: number
        text: string
        start: { isCertain(component: 'day' | 'month' | 'year'): boolean }
    }[]
}

let enginesPromise: Promise<PatternEngines> | null = null

/**
 * Import whichever of libphonenumber-js and chrono-node is installed.
 *
 * Neither is required, so a missing one is not an error: its detector falls
 * back to the built-in pattern. The promise is cached, and cleared if loading
 * throws for any other reason, so a transient failure is retried.
 */
export function loadPatternEngines(): Promise<PatternEngines> {
    if (enginesPromise) return enginesPromise
    enginesPromise = (async () => {
        const [phone, chrono] = await Promise.all([
            import('libphonenumber-js').catch(() => null),
            import('chrono-node').catch(() => null),
        ])
        const engines: PatternEngines = {}

        if (phone) {
            engines.findPhones = (text, defaultCountry) =>
                phone
                    .findPhoneNumbersInText(
                        text,
                        defaultCountry ? { defaultCountry: defaultCountry as never } : {}
                    )
                    .map((m) => ({
                        start: m.startsAt,
                        end: m.endsAt,
                        // Found numbers are already valid for their country; one
                        // carrying its own country code is beyond doubt.
                        score: text[m.startsAt] === '+' ? 0.95 : 0.85,
                    }))
        }

        if (chrono) {
            const locales = chrono as unknown as Record<string, { strict?: ChronoParser } | undefined>
            engines.findDates = (text, wanted) =>
                wanted.flatMap((locale) => {
                    // Strict mode: formal dates only, never "today" or "next Friday".
                    const parser = locale === 'en' ? (chrono.strict as ChronoParser) : locales[locale]?.strict
                    if (!parser) return []
                    return (
                        parser
                            .parse(text)
                            // A day and month without a year -- `04/27` -- is as often a
                            // card expiry or a reference as a date.
                            .filter((r) =>
                                (['day', 'month', 'year'] as const).every((c) => r.start.isCertain(c))
                            )
                            .map((r) => ({ start: r.index, end: r.index + r.text.length, score: 0.85 }))
                    )
                })
        }
        return engines
    })()
    enginesPromise.catch(() => {
        enginesPromise = null
    })
    return enginesPromise
}

/* ── Matching ───────────────────────────────────────────────────────────── */

/** A pattern hit, before it is mapped onto boxes. */
export interface PatternMatch {
    label: PatternLabel
    score: number
    start: number
    end: number
}

export interface FindPatternOptions {
    labels?: readonly PatternLabel[]
    threshold?: number
    ocrTolerant?: boolean
    maxEdits?: number
    validate?: boolean
    /** Library adapters, from `loadPatternEngines` or supplied directly. */
    engines?: PatternEngines
    defaultCountry?: string
    dateLocales?: readonly string[]
    countryLocales?: readonly string[]
}

interface Scored extends PatternMatch {
    fromLibrary: boolean
    /** Needed a character absorbed to match, which can regroup digits into a different shape. */
    regrouped: boolean
    weak: boolean
}

/**
 * Every non-overlapping identifier in `text`.
 *
 * Detectors run independently, so the same digits are often claimed twice --
 * an eleven-digit PESEL is also a plausible phone number. A match as written beats
 * one that absorbed a character, since a stray space can regroup any digits
 * into any shape; then the more specific label wins. Within one label the higher score
 * wins, then the longer span.
 *
 * A candidate below `threshold` still takes part in that contest before it is
 * dropped, unless its shape is weak. A card number that fails Luhn is not
 * thereby a phone number, and letting the next detector down have its digits
 * would only relabel the mistake. A bare nine-digit run that is not a valid
 * SSN, though, may well be a phone.
 */
export function findPatternMatches(text: string, options: FindPatternOptions = {}): PatternMatch[] {
    const labels = options.labels ?? PATTERN_LABELS
    const threshold = options.threshold ?? REGEX_NER_DEFAULTS.threshold
    const tolerant = options.ocrTolerant ?? REGEX_NER_DEFAULTS.ocrTolerant
    const maxEdits = tolerant ? (options.maxEdits ?? REGEX_NER_DEFAULTS.maxEdits) : 0
    const validate = options.validate ?? REGEX_NER_DEFAULTS.validate
    const engines = options.engines ?? {}

    const { text: normalised, repaired } = tolerant
        ? normaliseOcrText(text)
        : { text, repaired: new Uint8Array(text.length) }
    const anyRepaired = (start: number, end: number) => repaired.subarray(start, end).some((r) => r === 1)

    const candidates: Scored[] = []

    const bounds = { raw: boundaries(text), normalised: boundaries(normalised) }

    for (const label of labels) {
        for (const detector of PATTERN_DETECTORS[label]) {
            const haystack = detector.raw ? text : normalised
            const costs: FuzzyCosts = {
                insert: insertCost,
                substitute: detector.substitute ? substituteCost : Number.POSITIVE_INFINITY,
                // A missing digit can never be told apart from a different number.
                delete: Number.POSITIVE_INFINITY,
            }
            const matches = regexFor(detector).search(haystack, {
                maxCost: detector.fuzzy ? maxEdits : 0,
                costs,
                ...(detector.raw ? bounds.raw : bounds.normalised),
            })
            for (const m of matches) {
                const raw = haystack.slice(m.start, m.end)
                // Strict mode reads an address only as written: no spaces, no '©'.
                if ((label === 'EMAIL' || label === 'URL') && !tolerant && /[\s©]/.test(raw)) continue
                const candidate: Candidate = {
                    text: raw,
                    digits: spelledDigits(haystack, m.start, m.end, m.edits),
                    validate,
                    before: haystack.slice(Math.max(0, m.start - 30), m.start),
                    after: haystack.slice(m.end, m.end + 40),
                }
                let score = detector.score(candidate)
                if (score === null) continue
                score *= EDIT_PENALTY ** m.cost
                if (!detector.raw && anyRepaired(m.start, m.end)) score *= REPAIR_PENALTY
                candidates.push({
                    label,
                    score,
                    start: m.start,
                    end: m.end,
                    fromLibrary: false,
                    regrouped: m.edits.some((e) => e.kind === 'insert'),
                    weak: detector.weak?.(candidate) ?? false,
                })
            }
        }
    }

    const fromLibrary = (label: PatternLabel, found: LibraryMatch[]) => {
        for (const m of found) {
            const score = anyRepaired(m.start, m.end) ? m.score * REPAIR_PENALTY : m.score
            candidates.push({
                label,
                score,
                start: m.start,
                end: m.end,
                fromLibrary: true,
                regrouped: false,
                weak: false,
            })
        }
    }
    if (labels.includes('COUNTRY')) {
        // Raw text: a country is letters, and the lookalike repair is for digits.
        for (const m of findCountries(text, options.countryLocales ?? REGEX_NER_DEFAULTS.countryLocales)) {
            candidates.push({
                label: 'COUNTRY',
                score: m.score,
                start: m.start,
                end: m.end,
                fromLibrary: false,
                regrouped: false,
                weak: m.weak,
            })
        }
    }
    if (labels.includes('PHONE') && engines.findPhones) {
        fromLibrary('PHONE', engines.findPhones(normalised, options.defaultCountry ?? ''))
    }
    if (labels.includes('DATE') && engines.findDates) {
        fromLibrary(
            'DATE',
            engines.findDates(normalised, options.dateLocales ?? REGEX_NER_DEFAULTS.dateLocales)
        )
    }

    // A library reading a fragment of something a pattern read whole -- the
    // `123-4567` of `(555) 123-4567` under the wrong default country -- has
    // seen less of it, not more.
    const passing = candidates.filter((c) => !c.fromLibrary && c.score >= threshold)
    const pool = candidates.filter(
        (c) =>
            !c.fromLibrary ||
            !passing.some(
                (p) =>
                    p.label === c.label &&
                    p.start <= c.start &&
                    p.end >= c.end &&
                    p.end - p.start > c.end - c.start
            )
    )

    const overlaps = (a: Scored, b: Scored) => a.start < b.end && a.end > b.start
    const keep = (sorted: Scored[]) => {
        const claimed: Scored[] = []
        for (const candidate of sorted) {
            if (candidate.weak && candidate.score < threshold) continue
            if (claimed.some((k) => overlaps(k, candidate))) continue
            claimed.push(candidate)
        }
        return claimed
    }
    const byScore = (a: Scored, b: Scored) => b.score - a.score || b.end - b.start - (a.end - a.start)

    // Within a label, the better reading wins outright: a 16-digit card with a
    // smudged last digit over the 15 clean digits in front of the smudge.
    const perLabel = PRIORITY.flatMap((label) => keep(pool.filter((c) => c.label === label).sort(byScore)))
    // Across labels, a reading that kept the text's own grouping first, then specificity.
    const claimed = keep(
        perLabel.sort(
            (a, b) =>
                Number(a.regrouped) - Number(b.regrouped) ||
                PRIORITY.indexOf(a.label) - PRIORITY.indexOf(b.label) ||
                byScore(a, b)
        )
    )
    return claimed
        .filter((m) => m.score >= threshold)
        .sort((a, b) => a.start - b.start)
        .map(({ label, score, start, end }) => ({ label, score, start, end }))
}

/** `findPatternMatches`, with each hit turned into an `Entity` carrying its boxes. */
export function findPatternEntities(
    document: Pick<Document, 'text' | 'bboxes'>,
    options: FindPatternOptions = {}
): Entity[] {
    const matches = findPatternMatches(document.text, options)
    if (matches.length === 0) return []
    const mapping = buildCharToBoxMap(document.text, document.bboxes)
    return matches.map(({ label, score, start, end }) => ({
        entity_group: label,
        score,
        word: document.text.slice(start, end),
        start,
        end,
        boxes: boxesForRange(mapping, document.bboxes, start, end),
        source: 'pattern',
    }))
}

export class RegexNer extends Stage<RegexNerParams> {
    readonly name = 'RegexNer'

    private engines: PatternEngines = {}

    constructor(options: Partial<RegexNerParams> = {}) {
        super(
            resolveParams(REGEX_NER_DEFAULTS, options, {
                labels: (value) => {
                    const unknown = value.filter((label) => !PATTERN_LABELS.includes(label))
                    if (unknown.length > 0) {
                        throw new RangeError(
                            `labels must be drawn from ${PATTERN_LABELS.join(', ')}; unknown: ${unknown.join(', ')}`
                        )
                    }
                },
                threshold: (value) => assertInRange('threshold', value, 0, 1),
                maxEdits: (value) => {
                    if (!Number.isInteger(value) || value < 0 || value > 3) {
                        throw new RangeError(`maxEdits must be an integer from 0 to 3, received ${value}`)
                    }
                },
                defaultCountry: (value) => {
                    if (value !== '' && !/^[A-Z]{2}$/.test(value)) {
                        throw new RangeError(
                            `defaultCountry must be an ISO 3166 code such as "PL", received "${value}"`
                        )
                    }
                },
                countryLocales: (value) => {
                    if (!countryLocalesSupported(value)) {
                        throw new RangeError(
                            `countryLocales must be locales Intl.DisplayNames supports: ${value}`
                        )
                    }
                },
                dateLocales: (value) => {
                    const unknown = value.filter((locale) => !DATE_LOCALES.includes(locale))
                    if (unknown.length > 0) {
                        throw new RangeError(
                            `dateLocales must be drawn from ${DATE_LOCALES.join(', ')}; unknown: ${unknown.join(', ')}`
                        )
                    }
                },
            })
        )
    }

    override async init(): Promise<void> {
        const { useLibraries, labels } = this.params
        if (useLibraries && (labels.includes('PHONE') || labels.includes('DATE'))) {
            this.engines = await loadPatternEngines()
        }
    }

    protected async apply(input: unknown, row: Row): Promise<NerOutput> {
        const document = input as Document | undefined
        if (!document || typeof document.text !== 'string') {
            throw new NerError(`Expected a Document in "${this.params.inputCol}"`, this.name)
        }
        if (document.exception) {
            throw upstreamError(document.exception, this.name, (message) => new NerError(message, this.name))
        }

        const {
            labels,
            threshold,
            ocrTolerant,
            maxEdits,
            validate,
            useLibraries,
            defaultCountry,
            dateLocales,
            countryLocales,
        } = this.params
        const entities = findPatternEntities(document, {
            labels,
            threshold,
            ocrTolerant,
            maxEdits,
            validate,
            engines: useLibraries ? this.engines : {},
            defaultCountry,
            dateLocales,
            countryLocales,
        })
        return createNerOutput({
            path: String(row[this.params.pathCol] ?? document.path ?? 'memory'),
            entities,
            json: JSON.stringify(entities),
        })
    }

    protected onError(message: string, row: Row): NerOutput {
        return createNerOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }
}
