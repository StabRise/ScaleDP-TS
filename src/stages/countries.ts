/**
 * Countries in text: names in any language `Intl` knows, and ISO 3166 codes.
 *
 * Names come from `Intl.DisplayNames`, built into every browser and worker, so
 * no list of names is shipped. Alpha-3 codes have no `Intl` source; the table
 * below is generated from `i18n-iso-countries`, and
 * `test/unit/countries.test.ts` fails if the two ever disagree.
 *
 * A country is weaker evidence than a number. Two-letter codes collide with
 * ordinary words (`IT`, `IN`, `AT`), some three-letter ones are words or
 * acronyms (`AND`, `CAN`, `PNG`), and some names are people or things (Chad,
 * Jordan, Georgia, Turkey, China). Those count only after a label --
 * `Country:`, `Nationality:`, `Obywatelstwo:` -- which is where a country is
 * personal data anyway: a nationality, a country of birth or residence.
 */

/** ISO 3166-1 alpha-2 followed by alpha-3, generated from i18n-iso-countries. */
const ISO_TABLE =
    'ADAND AEARE AFAFG AGATG AIAIA ALALB AMARM AOAGO AQATA ARARG ASASM ATAUT AUAUS AWABW AXALA AZAZE ' +
    'BABIH BBBRB BDBGD BEBEL BFBFA BGBGR BHBHR BIBDI BJBEN BLBLM BMBMU BNBRN BOBOL BQBES BRBRA BSBHS ' +
    'BTBTN BVBVT BWBWA BYBLR BZBLZ CACAN CCCCK CDCOD CFCAF CGCOG CHCHE CICIV CKCOK CLCHL CMCMR CNCHN ' +
    'COCOL CRCRI CUCUB CVCPV CWCUW CXCXR CYCYP CZCZE DEDEU DJDJI DKDNK DMDMA DODOM DZDZA ECECU EEEST ' +
    'EGEGY EHESH ERERI ESESP ETETH FIFIN FJFJI FKFLK FMFSM FOFRO FRFRA GAGAB GBGBR GDGRD GEGEO GFGUF ' +
    'GGGGY GHGHA GIGIB GLGRL GMGMB GNGIN GPGLP GQGNQ GRGRC GSSGS GTGTM GUGUM GWGNB GYGUY HKHKG HMHMD ' +
    'HNHND HRHRV HTHTI HUHUN IDIDN IEIRL ILISR IMIMN ININD IOIOT IQIRQ IRIRN ISISL ITITA JEJEY JMJAM ' +
    'JOJOR JPJPN KEKEN KGKGZ KHKHM KIKIR KMCOM KNKNA KPPRK KRKOR KWKWT KYCYM KZKAZ LALAO LBLBN LCLCA ' +
    'LILIE LKLKA LRLBR LSLSO LTLTU LULUX LVLVA LYLBY MAMAR MCMCO MDMDA MEMNE MFMAF MGMDG MHMHL MKMKD ' +
    'MLMLI MMMMR MNMNG MOMAC MPMNP MQMTQ MRMRT MSMSR MTMLT MUMUS MVMDV MWMWI MXMEX MYMYS MZMOZ NANAM ' +
    'NCNCL NENER NFNFK NGNGA NINIC NLNLD NONOR NPNPL NRNRU NUNIU NZNZL OMOMN PAPAN PEPER PFPYF PGPNG ' +
    'PHPHL PKPAK PLPOL PMSPM PNPCN PRPRI PSPSE PTPRT PWPLW PYPRY QAQAT REREU ROROU RSSRB RURUS RWRWA ' +
    'SASAU SBSLB SCSYC SDSDN SESWE SGSGP SHSHN SISVN SJSJM SKSVK SLSLE SMSMR SNSEN SOSOM SRSUR SSSSD ' +
    'STSTP SVSLV SXSXM SYSYR SZSWZ TCTCA TDTCD TFATF TGTGO THTHA TJTJK TKTKL TLTLS TMTKM TNTUN TOTON ' +
    'TRTUR TTTTO TVTUV TWTWN TZTZA UAUKR UGUGA UMUMI USUSA UYURY UZUZB VAVAT VCVCT VEVEN VGVGB VIVIR ' +
    'VNVNM VUVUT WFWLF WSWSM XKXKK YEYEM YTMYT ZAZAF ZMZMB ZWZWE'

/** Alpha-2 code -> alpha-3 code, for every officially assigned ISO 3166-1 country. */
export const ISO_COUNTRIES: ReadonlyMap<string, string> = new Map(
    ISO_TABLE.split(' ').map((pair) => [pair.slice(0, 2), pair.slice(2)] as const)
)

const ALPHA3: ReadonlySet<string> = new Set(ISO_COUNTRIES.values())

/** Alpha-3 codes that are also English words or common acronyms, and so need a label. */
const AMBIGUOUS_ALPHA3: ReadonlySet<string> = new Set(
    (
        'AND ARE CAN PER COL MAR BEL NOR TON GIN MAC BEN CUB GAB GUM HUN JAM LIE PAN SEN SOM VAT COM CAF ' +
        'DOM FIN TUN TUR ARM IND NIC SUR MDA PRT AUT NAM BRA BRB GEO ALA ASM FRO IOT KEN MUS PNG TUV VIR ' +
        'EST ETH PRI TLS ATA BES MAF'
    ).split(' ')
)

/** Names that are also given names, surnames or common nouns, by alpha-2. */
const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set(
    'TD JO GE TR CN GN NE TG ML JE GG DM CU PE IL VA MO'.split(' ')
)

/** Names people write that `Intl` does not give, by locale. */
const ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    en: {
        'United States of America': 'US',
        'Great Britain': 'GB',
        'Czech Republic': 'CZ',
        'Russian Federation': 'RU',
        Turkey: 'TR',
        'Ivory Coast': 'CI',
        Burma: 'MM',
        Swaziland: 'SZ',
        Macedonia: 'MK',
        'Republic of Korea': 'KR',
        'Democratic Republic of the Congo': 'CD',
        'Republic of the Congo': 'CG',
        Palestine: 'PS',
    },
}

/** What precedes a country that is personal data. */
const COUNTRY_LABEL =
    /(?:country(?: of (?:birth|residence|issue|origin))?|nationality|citizenship|kraj(?: urodzenia| pochodzenia| zamieszkania)?|obywatelstwo|narodowo[śs][ćc]|pa[ńn]stwo|staatsangeh[öo]rigkeit|nationalit[ée]|pays|land)\s*[:.\-/]?\s*$/iu

/** Every name a locale writes for one country, as written and in capitals. */
function namesFor(locale: string): Map<string, string> {
    const names = new Map<string, string>()
    const add = (name: string | undefined, code: string) => {
        if (!name || name.length < 4) return
        for (const form of [name, name.toLocaleUpperCase(locale)]) if (!names.has(form)) names.set(form, code)
    }
    const long = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' })
    const short = new Intl.DisplayNames([locale], { type: 'region', style: 'short', fallback: 'none' })
    for (const code of ISO_COUNTRIES.keys()) {
        for (const name of [long.of(code), short.of(code)]) {
            if (!name) continue
            add(name, code)
            // "Myanmar (Burma)", "Hong Kong SAR China", "Bosnia & Herzegovina".
            add(name.replace(/\s*\(.*\)$/, ''), code)
            add(name.replace(/ SAR China$/, ''), code)
            add(name.replace(/ & /g, ' and '), code)
        }
    }
    for (const [name, code] of Object.entries(ALIASES[locale] ?? {})) add(name, code)
    return names
}

interface CountryIndex {
    names: Map<string, string>
    regex: RegExp
}

const indexes = new Map<string, CountryIndex>()

function indexFor(locales: readonly string[]): CountryIndex {
    const key = locales.join(',')
    let index = indexes.get(key)
    if (!index) {
        const names = new Map<string, string>()
        for (const locale of locales)
            for (const [name, code] of namesFor(locale)) if (!names.has(name)) names.set(name, code)
        const alternatives = [...names.keys()]
            .sort((a, b) => b.length - a.length)
            .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        const words = `${alternatives.join('|')}|[A-Z]{2,3}`
        index = { names, regex: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'gu') }
        indexes.set(key, index)
    }
    return index
}

/** A country found in text. */
export interface CountryMatch {
    start: number
    end: number
    /** ISO 3166-1 alpha-2. */
    code: string
    score: number
    /** Ambiguous without a label, so it holds no span when below threshold. */
    weak: boolean
}

/** Whether `locales` are all usable with `Intl.DisplayNames`. */
export function countryLocalesSupported(locales: readonly string[]): boolean {
    return locales.every((locale) => {
        try {
            return Intl.DisplayNames.supportedLocalesOf([locale]).length === 1
        } catch {
            return false
        }
    })
}

/** Country names and codes in `text`, scored by how sure the context makes them. */
export function findCountries(text: string, locales: readonly string[]): CountryMatch[] {
    const { names, regex } = indexFor(locales)
    const found: CountryMatch[] = []
    for (const match of text.matchAll(regex)) {
        const word = match[0]
        const start = match.index
        const labelled = COUNTRY_LABEL.test(text.slice(Math.max(0, start - 30), start))
        const named = names.get(word)
        let code: string | undefined
        let score: number
        let weak = false

        if (named) {
            code = named
            score = labelled ? 0.9 : AMBIGUOUS_NAMES.has(code) ? 0.4 : 0.75
            weak = !labelled && AMBIGUOUS_NAMES.has(code)
        } else if (word.length === 3 && ALPHA3.has(word)) {
            code = [...ISO_COUNTRIES].find(([, a3]) => a3 === word)?.[0]
            score = labelled ? 0.9 : AMBIGUOUS_ALPHA3.has(word) ? 0.4 : 0.6
            weak = !labelled && AMBIGUOUS_ALPHA3.has(word)
        } else if (word.length === 2 && ISO_COUNTRIES.has(word) && labelled) {
            code = word
            score = 0.85
        } else {
            continue
        }
        if (code) found.push({ start, end: start + word.length, code, score, weak })
    }
    return found
}
