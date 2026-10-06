/**
 * Country detection: the ISO table is diffed against i18n-iso-countries, which
 * it was generated from, and the scoring is checked against the collisions a
 * country list invites -- words, acronyms and people's names.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { countryLocalesSupported, ISO_COUNTRIES } from '../../src/stages/countries.js'
import { findPatternMatches, RegexNer } from '../../src/stages/regex-ner.js'

const require = createRequire(import.meta.url)
const iso = require('i18n-iso-countries') as {
    getAlpha2Codes(): Record<string, string>
    alpha2ToAlpha3(code: string): string
}

const found = (text: string) =>
    findPatternMatches(text, { labels: ['COUNTRY'] }).map((m) => text.slice(m.start, m.end))

describe('ISO_COUNTRIES', () => {
    it('matches i18n-iso-countries exactly', () => {
        const expected = Object.keys(iso.getAlpha2Codes())
            .sort()
            .map((code) => [code, iso.alpha2ToAlpha3(code)])
        expect([...ISO_COUNTRIES].sort()).toEqual(expected)
    })
})

describe('findPatternMatches, COUNTRY', () => {
    it.each([
        ['born in Poland, lives in the United States', ['Poland', 'United States']],
        ['HONG KONG office', ['HONG KONG']],
        ['Myanmar and Bosnia and Herzegovina', ['Myanmar', 'Bosnia and Herzegovina']],
        ['from Czech Republic', ['Czech Republic']],
        ['Côte d’Ivoire', ['Côte d’Ivoire']],
        ['kraj urodzenia: Niemcy', ['Niemcy']],
        ['USA, DEU, GBR', ['USA', 'DEU', 'GBR']],
        ['Nationality: POL', ['POL']],
        ['Country: PL', ['PL']],
        ['Nationality: Jordan', ['Jordan']],
    ])('finds countries in %j', (text, expected) => {
        expect(found(text)).toEqual(expected)
    })

    it.each([
        // Two-letter codes are words without a label.
        'IT department in AT&T',
        // Three-letter codes that are words or acronyms.
        'AND THE CAN OF PNG',
        // Names that are people's names.
        'Chad Smith met Jordan',
        // Not a country code, the start of an IBAN.
        'PL61109010140000071219812874',
    ])('finds nothing in %j', (text) => {
        expect(found(text)).toEqual([])
    })

    it('reads names in the locales asked for', () => {
        expect(findPatternMatches('Deutschland', { labels: ['COUNTRY'], countryLocales: ['en'] })).toEqual([])
        expect(
            findPatternMatches('Deutschland', { labels: ['COUNTRY'], countryLocales: ['de'] })
        ).toHaveLength(1)
    })

    it('rejects locales Intl cannot name countries in', () => {
        expect(countryLocalesSupported(['en', 'pl'])).toBe(true)
        expect(() => new RegexNer({ countryLocales: ['not a locale'] })).toThrow(/countryLocales/)
    })
})
