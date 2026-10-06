/**
 * Pattern detection is pure text work, so every assertion runs against
 * hand-built strings -- including the OCR misreads the patterns exist to
 * survive.
 */
import { describe, expect, it } from 'vitest'
import { BASE_STAGE_DEFAULTS, resolveParams } from '../../src/core/params.js'
import { Pipeline, type Row, Stage } from '../../src/core/pipeline.js'
import { createBox } from '../../src/schemas/box.js'
import { createDocument, type Document } from '../../src/schemas/document.js'
import type { NerOutput } from '../../src/schemas/entity.js'
import {
    dateValid,
    findPatternEntities,
    findPatternMatches,
    ibanValid,
    loadPatternEngines,
    luhnValid,
    normaliseOcrText,
    type PatternEngines,
    type PatternLabel,
    peselValid,
    RegexNer,
    ssnValid,
} from '../../src/stages/regex-ner.js'

/** A document whose boxes are one per word, laid out left to right. */
function wordDocument(text: string): Document {
    let cursor = 0
    const bboxes = text.split(' ').map((word, index) => {
        cursor += index === 0 ? 0 : 1
        const box = createBox({ text: word, x: cursor * 10, y: 0, width: word.length * 10, height: 10 })
        cursor += word.length
        return box
    })
    return createDocument({ text, type: 'ocr', bboxes })
}

/** The single hit in `text`, as [label, matched text]. */
function only(text: string, options = {}): [PatternLabel, string] | undefined {
    const matches = findPatternMatches(text, options)
    expect(matches.length).toBeLessThanOrEqual(1)
    const [m] = matches
    return m ? [m.label, text.slice(m.start, m.end)] : undefined
}

describe('validators', () => {
    it('checks Luhn', () => {
        expect(luhnValid('4111111111111111')).toBe(true)
        expect(luhnValid('378282246310005')).toBe(true)
        expect(luhnValid('4111111111111112')).toBe(false)
    })

    it('checks the PESEL checksum and its encoded birth date', () => {
        expect(peselValid('44051401359')).toBe(true)
        expect(peselValid('44051401358')).toBe(false)
        // Month 22 is February in the 2000s.
        expect(peselValid('02221512346')).toBe(true)
        // 31 February fails even with a correct check digit.
        expect(peselValid('02223112342')).toBe(false)
    })

    it('rejects never-issued SSNs', () => {
        expect(ssnValid('123456789')).toBe(true)
        expect(ssnValid('000123456')).toBe(false)
        expect(ssnValid('666123456')).toBe(false)
        expect(ssnValid('912345678')).toBe(false)
        expect(ssnValid('123006789')).toBe(false)
        expect(ssnValid('123450000')).toBe(false)
    })

    it("checks IBANs by mod 97 and their country's length", () => {
        expect(ibanValid('DE89370400440532013000')).toBe(true)
        expect(ibanValid('GB29NWBK60161331926819')).toBe(true)
        expect(ibanValid('DE89370400440532013001')).toBe(false)
        // Right checksum arithmetic is not enough: DE is 22 characters.
        expect(ibanValid('DE8937040044053201300')).toBe(false)
        expect(ibanValid('XX89370400440532013000')).toBe(false)
    })

    it('knows the calendar', () => {
        expect(dateValid(2024, 2, 29)).toBe(true)
        expect(dateValid(2023, 2, 29)).toBe(false)
        expect(dateValid(2024, 13, 1)).toBe(false)
    })
})

describe('normaliseOcrText', () => {
    it('repairs lookalikes inside numbers without changing the length', () => {
        const source = 'PESEL 44O5l4O|359, tel +48 600 l23 456'
        const { text, repaired } = normaliseOcrText(source)
        expect(text).toBe('PESEL 44051401359, tel +48 600 123 456')
        expect(text).toHaveLength(source.length)
        expect([...repaired].filter(Boolean)).toHaveLength(5)
    })

    it('leaves words alone', () => {
        for (const word of ['Bill', 'SOS', 'lOl', '1st', 'b2b', 'SSN:', 'Sept12']) {
            expect(normaliseOcrText(word).text).toBe(word)
        }
    })

    it('folds every dash to a hyphen', () => {
        expect(normaliseOcrText('12–34—56').text).toBe('12-34-56')
    })
})

describe('findPatternMatches', () => {
    it.each<[string, PatternLabel, string]>([
        ['Card: 4111 1111 1111 1111.', 'CREDIT_CARD', '4111 1111 1111 1111'],
        ['Card 4111 1lll 1111 1111', 'CREDIT_CARD', '4111 1lll 1111 1111'],
        ['Amex 3782 822463 10005', 'CREDIT_CARD', '3782 822463 10005'],
        ['PESEL: 44051401359', 'PESEL', '44051401359'],
        ['PESEL 44O514O1359', 'PESEL', '44O514O1359'],
        ['PESEL 440514 01359', 'PESEL', '440514 01359'],
        ['SSN 123-45-6789', 'SSN', '123-45-6789'],
        ['SSN 123 – 45 – 678g', 'SSN', '123 – 45 – 678g'],
        ['mail john.doe@example.com now', 'EMAIL', 'john.doe@example.com'],
        ['mail john.doe @ example .com now', 'EMAIL', 'john.doe @ example .com'],
        ['mail john©example.com', 'EMAIL', 'john©example.com'],
        ['Tel. +48 600-l23-456', 'PHONE', '+48 600-l23-456'],
        ['Tel. (555) 123-4567', 'PHONE', '(555) 123-4567'],
        ['Date 12.03.2024', 'DATE', '12.03.2024'],
        ['Date 12.O3.2024', 'DATE', '12.O3.2024'],
        ['Date 2024-03-12', 'DATE', '2024-03-12'],
        ['born 12 stycznia 2024 in', 'DATE', '12 stycznia 2024'],
        ['born 12 wrzesnia 1990', 'DATE', '12 wrzesnia 1990'],
        ['on Jan. 12, 2024 we', 'DATE', 'Jan. 12, 2024'],
        ['on 3rd of March 2021', 'DATE', '3rd of March 2021'],
        ['valid until 10/2024', 'DATE', '10/2024'],
        ['od 03.2023', 'DATE', '03.2023'],
        ['period 2024-10', 'DATE', '2024-10'],
        ['since October 2024', 'DATE', 'October 2024'],
        ['od października 2024', 'DATE', 'października 2024'],
        ['see https://example.com/docs?x=1#y.', 'URL', 'https://example.com/docs?x=1#y'],
        ['visit www.example.pl today', 'URL', 'www.example.pl'],
        ['at http ://example.com/a)', 'URL', 'http ://example.com/a'],
        ['go to stabrise.com/demo, then', 'URL', 'stabrise.com/demo'],
        ['ul. Marszałkowska 1, 00-950 Warszawa', 'ZIP_CODE', '00-950'],
        ['kod pocztowy: 31-042', 'ZIP_CODE', '31-042'],
        ['New York, NY 10001', 'ZIP_CODE', '10001'],
        ['ZIP 94105-1234', 'ZIP_CODE', '94105-1234'],
        ['10115 Berlin', 'ZIP_CODE', '10115'],
        ['London SW1A 1AA', 'ZIP_CODE', 'SW1A 1AA'],
        ['Ottawa ON K1A 0B1', 'ZIP_CODE', 'K1A 0B1'],
        ['Tel: +48790844156', 'PHONE', '+48790844156'],
        ['IBAN: DE89 3704 0044 0532 0130 00.', 'IBAN', 'DE89 3704 0044 0532 0130 00'],
        ['GB29 NWBK 6016 1331 9268 19', 'IBAN', 'GB29 NWBK 6016 1331 9268 19'],
        ['NL91ABNA0417164300', 'IBAN', 'NL91ABNA0417164300'],
        ['konto PL61 1O90 1014 0000 0712 1981 2874', 'IBAN', 'PL61 1O90 1014 0000 0712 1981 2874'],
        ['nr rachunku 61 1090 1014 0000 0712 1981 2874', 'IBAN', '61 1090 1014 0000 0712 1981 2874'],
    ])('finds %j', (text, label, word) => {
        expect(only(text)).toEqual([label, word])
    })

    it.each([
        'SOS Bill is lOl',
        'Page 3 of 12',
        'In 2024 we grew',
        'Version 1.2.3.4',
        'Total 12345',
        'Date 45.13.2024',
        'ref 4111111111111111111111111',
        'Invoice 2024/03/118',
        'version 1.2.3, e.g. file.txt and report.pdf',
        '12345 Main Street',
        'Model XY12 ABCD EFGH',
        'Total 12345 PLN',
        'FV 3/2024',
        'period 13/2024',
        'code 10/3024',
    ])('finds nothing in %j', (text) => {
        expect(findPatternMatches(text)).toEqual([])
    })

    it('scores a failed check below the default threshold', () => {
        expect(findPatternMatches('SSN 000-12-3456')).toEqual([])
        expect(findPatternMatches('SSN 000-12-3456', { threshold: 0 })[0]?.label).toBe('SSN')
        expect(findPatternMatches('ref 4111111111111112')).toEqual([])
    })

    it('still reports an unmistakably shaped number whose check fails, in doubt', () => {
        // Four groups of four is a card to a redactor, whatever its check digit says.
        for (const text of [
            'Card: 1234-4567-7891-1234',
            'IBAN DE89 3704 0044 0532 0130 01',
            // No 30 February, but a date all the same.
            'born 30.02.2000',
            'born 2000-02-31',
        ]) {
            const [m] = findPatternMatches(text)
            expect(m?.score).toBeGreaterThanOrEqual(0.5)
            expect(m?.score).toBeLessThan(0.6)
        }
    })

    it('lets validate: false accept numbers that do not check out', () => {
        expect(only('PESEL 44051401358', { validate: false })?.[0]).toBe('PESEL')
    })

    it('rejects lookalikes in strict mode', () => {
        const strict = { ocrTolerant: false }
        expect(findPatternMatches('PESEL 44O514O1359', strict)).toEqual([])
        expect(findPatternMatches('Date 12.O3.2024', strict)).toEqual([])
        expect(findPatternMatches('mail john.doe @ example .com', strict)).toEqual([])
        expect(only('PESEL 44051401359', strict)?.[0]).toBe('PESEL')
    })

    it('scores a repaired lookalike a little lower', () => {
        const [clean] = findPatternMatches('44051401359')
        const [repaired] = findPatternMatches('44O51401359')
        expect(repaired?.score).toBeLessThan(clean?.score ?? 0)
    })

    it('never reads the digits after a + as anything but a phone number', () => {
        // 48790844156 is eleven digits, PESEL-shaped; the + says it is +48 790 844 156.
        for (const text of ['+48790844156', 'tel. +48 790844156']) {
            expect(findPatternMatches(text, { threshold: 0 }).map((m) => m.label)).toEqual(['PHONE'])
        }
    })

    it('does not let a failed bare PESEL hide the phone number it really is', () => {
        expect(findPatternMatches('call 48790844156').map((m) => m.label)).not.toContain('PESEL')
    })

    it('does not let the same digits be claimed twice', () => {
        // A PESEL is also an eleven-digit phone; a card is also several phones.
        expect(findPatternMatches('ID 44051401359').map((m) => m.label)).toEqual(['PESEL'])
        expect(findPatternMatches('4111 1111 1111 1111').map((m) => m.label)).toEqual(['CREDIT_CARD'])
        expect(findPatternMatches('SSN 123-45-6789').map((m) => m.label)).toEqual(['SSN'])
        expect(findPatternMatches('mail jan@example.com').map((m) => m.label)).toEqual(['EMAIL'])
    })

    it('does not let a phone swallow the number after it', () => {
        const text = 'Tel 600 123 456 12.03.2024'
        const found = findPatternMatches(text).map((m) => [m.label, text.slice(m.start, m.end)])
        expect(found).toEqual([
            ['PHONE', '600 123 456'],
            ['DATE', '12.03.2024'],
        ])
    })

    it('runs only the detectors asked for', () => {
        const text = 'mail a@b.com on 12.03.2024'
        expect(findPatternMatches(text, { labels: ['DATE'] }).map((m) => m.label)).toEqual(['DATE'])
    })

    it('absorbs a stray symbol within maxEdits, at a cost', () => {
        const [clean] = findPatternMatches('SSN 123-45-6789')
        const [stray] = findPatternMatches('SSN 123-45-67,89')
        expect(stray).toMatchObject({ label: 'SSN', start: 4, end: 16 })
        expect(stray?.score).toBeLessThan(clean?.score ?? 0)
        expect(findPatternMatches('SSN 123-45-67,89', { maxEdits: 0 })).toEqual([])
    })

    it('lets a garbled symbol stand in for a digit, unverified', () => {
        const [m] = findPatternMatches('Card 4111 1111 1111 111*')
        expect(m?.label).toBe('CREDIT_CARD')
        expect(m?.score).toBeLessThan(0.7)
    })

    it('never absorbs a stray digit or letter', () => {
        expect(findPatternMatches('SSN 123-45-678x9')).toEqual([])
        // Read as a phone, which it could be; never as the SSN 123-45-6780.
        expect(findPatternMatches('SSN 123-45-6780-1').map((m) => m.label)).not.toContain('SSN')
    })

    it('follows a number across an OCR line break', () => {
        expect(only('Card 4111 1111\n1111 1111')?.[0]).toBe('CREDIT_CARD')
    })
})

describe('libraries', () => {
    const phones: PatternEngines = {
        findPhones: (text) => {
            const at = text.indexOf('123-4567')
            return at < 0 ? [] : [{ start: at, end: at + 8, score: 0.85 }]
        },
    }

    it('adds what a library finds', () => {
        const text = 'call 123-4567 now'
        expect(findPatternMatches(text, { engines: phones }).map((m) => text.slice(m.start, m.end))).toEqual([
            '123-4567',
        ])
    })

    it('prefers a pattern that read the whole number over a library that read part of it', () => {
        const text = 'call (555) 123-4567 now'
        const found = findPatternMatches(text, { engines: phones }).map((m) => text.slice(m.start, m.end))
        expect(found).toEqual(['(555) 123-4567'])
    })

    it('loads libphonenumber-js and chrono-node when installed', async () => {
        const engines = await loadPatternEngines()
        const text = 'Tel. +44 20 7946 0958, born on 3 Feb 1990 and 12. März 2024'
        const found = findPatternMatches(text, { engines, dateLocales: ['en', 'de'] }).map((m) => [
            m.label,
            text.slice(m.start, m.end),
        ])
        expect(found).toEqual([
            ['PHONE', '+44 20 7946 0958'],
            ['DATE', '3 Feb 1990'],
            ['DATE', '12. März 2024'],
        ])
    })

    it('ignores a day and month with no year', async () => {
        // A card expiry, not 27 April.
        const engines = await loadPatternEngines()
        expect(findPatternMatches('exp 04/27', { engines })).toEqual([])
    })

    it('reads national numbers with a default country', async () => {
        const engines = await loadPatternEngines()
        const text = 'mobile 600123456.'
        expect(findPatternMatches(text, { engines })).toEqual([])
        expect(findPatternMatches(text, { engines, defaultCountry: 'PL' })[0]?.label).toBe('PHONE')
    })
})

describe('findPatternEntities', () => {
    it('maps a match onto every word box it spans, in raw-text offsets', () => {
        const document = wordDocument('Card no 4111 1lll 1111 1111 expires')
        const [entity] = findPatternEntities(document)

        expect(entity).toMatchObject({
            entity_group: 'CREDIT_CARD',
            word: '4111 1lll 1111 1111',
            source: 'pattern',
        })
        expect(document.text.slice(entity?.start, entity?.end)).toBe(entity?.word)
        expect(entity?.boxes.map((b) => b.text)).toEqual(['4111', '1lll', '1111', '1111'])
    })
})

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

const nerOf = (row: Row | undefined) => row?.ner as NerOutput

describe('RegexNer', () => {
    it('writes entities and their JSON to ner', async () => {
        const rows = [{ path: 'a.pdf', text: wordDocument('SSN 123-45-6789 and a@b.com') }]
        const out = await new Pipeline([new Rows(rows), new RegexNer()]).transform([{}])
        const ner = nerOf(out[0])

        expect(ner.exception).toBe('')
        expect(ner.path).toBe('a.pdf')
        expect(ner.entities.map((e) => e.entity_group)).toEqual(['SSN', 'EMAIL'])
        expect(JSON.parse(ner.json)).toEqual(ner.entities)
    })

    it('records an upstream failure without losing the other rows', async () => {
        const rows = [
            { text: createDocument({ exception: 'PaddleTextRecognizer: boom' }) },
            { text: wordDocument('a@b.com') },
        ]
        const out = await new Pipeline([new Rows(rows), new RegexNer()]).transform([{}])

        expect(nerOf(out[0]).exception).toMatch(/RegexNer.*boom/)
        expect(nerOf(out[1]).entities).toHaveLength(1)
    })

    it('names the column it could not find', async () => {
        const stage = new RegexNer({ inputCol: 'document' })
        const out = await new Pipeline([new Rows([{ text: wordDocument('x') }]), stage]).transform([{}])
        expect(nerOf(out[0]).exception).toMatch(/Expected a Document in "document"/)
    })

    it('rejects params it cannot honour', () => {
        expect(() => new RegexNer({ threshold: 2 })).toThrow(/threshold/)
        expect(() => new RegexNer({ labels: ['PASSPORT' as PatternLabel] })).toThrow(/unknown: PASSPORT/)
        expect(() => new RegexNer({ maxEdits: 1.5 })).toThrow(/maxEdits/)
        expect(() => new RegexNer({ defaultCountry: 'pl' })).toThrow(/defaultCountry/)
        expect(() => new RegexNer({ dateLocales: ['pl'] })).toThrow(/unknown: pl/)
    })
})
