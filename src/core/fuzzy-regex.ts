/**
 * Approximate regular expressions: find text that matches a pattern within a
 * budget of edits.
 *
 * OCR text is a regex's worst case. A stray comma inside a card number, a
 * smudge read as `A` where a `4` was printed -- one wrong character and an exact
 * pattern sees nothing. Python has this built in (`regex` module, `{e<=1}`), and
 * Node has it through TRE (`fuzzy-regex`), but that is a native addon and does
 * not run in a browser or a worker. This is the same idea in plain TypeScript.
 *
 * The pattern is compiled to a Thompson NFA and simulated over the text keeping,
 * for every NFA state, the cheapest way to be there: the classic
 * Myers-Miller approach to approximate regex matching. Each kind of edit has
 * its own cost, and the insert and substitute costs can depend on the character,
 * so a caller can allow a stray separator for free-ish while forbidding a stray
 * digit outright.
 *
 * Supported syntax: literals and escapes, `.`, classes `[...]` / `[^...]` with
 * ranges, `\d \D \s \S \w \W \p{L} \p{N} \P{..}` (any Unicode property the host
 * RegExp knows), groups `(...)` / `(?:...)`, `|`, and `? * + {n} {n,} {n,m}`.
 * Flag `i` is honoured. Lookarounds, anchors and back-references are not: use
 * `canStart`/`canEnd` for boundaries instead.
 */

/** One kind of change between the pattern and the text. */
export type FuzzyEditKind = 'substitute' | 'insert' | 'delete'

export interface FuzzyEdit {
    kind: FuzzyEditKind
    /**
     * Text index the edit applies at: the substituted or inserted character,
     * or, for a deletion, the index the missing character would have stood at.
     */
    index: number
}

export interface FuzzyMatch {
    start: number
    end: number
    /** Total cost of `edits`. Zero is an exact match. */
    cost: number
    edits: FuzzyEdit[]
}

type CharCost = number | ((char: string) => number)

export interface FuzzyCosts {
    /** A pattern character matched by a different text character. Default 1. */
    substitute?: CharCost
    /** A text character the pattern has no place for. Default 1. */
    insert?: CharCost
    /** A pattern character missing from the text. Default 1. */
    delete?: number
}

export interface FuzzySearchOptions {
    /** Largest total edit cost a match may have. Default 0, which is exact matching. */
    maxCost?: number
    costs?: FuzzyCosts
    /** Whether a match may begin at this text index. Default: anywhere. */
    canStart?: (index: number) => boolean
    /** Whether a match may end at this text index (exclusive). Default: anywhere. */
    canEnd?: (index: number) => boolean
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

type CharTest = (char: string) => boolean

type Node =
    | { type: 'char'; test: CharTest }
    | { type: 'seq'; items: Node[] }
    | { type: 'alt'; options: Node[] }
    | { type: 'repeat'; node: Node; min: number; max: number }

const property = (name: string, negated: boolean): CharTest => {
    let regex: RegExp
    try {
        regex = new RegExp(`^\\p{${name}}$`, 'u')
    } catch {
        throw new SyntaxError(`Unknown Unicode property \\p{${name}}`)
    }
    return negated ? (c) => !regex.test(c) : (c) => regex.test(c)
}

const DIGIT: CharTest = (c) => c >= '0' && c <= '9'
const SPACE: CharTest = (c) => /^\s$/.test(c)
const WORD: CharTest = (c) => /^\w$/.test(c)
const not =
    (test: CharTest): CharTest =>
    (c) =>
        !test(c)

class Parser {
    private pos = 0

    constructor(private readonly source: string) {}

    parse(): Node {
        const node = this.alternation()
        if (this.pos < this.source.length) this.fail(`Unexpected "${this.source[this.pos]}"`)
        return node
    }

    private fail(message: string): never {
        throw new SyntaxError(`${message} at ${this.pos} in /${this.source}/`)
    }

    private peek(): string | undefined {
        return this.source[this.pos]
    }

    private alternation(): Node {
        const options = [this.sequence()]
        while (this.peek() === '|') {
            this.pos++
            options.push(this.sequence())
        }
        return options.length === 1 ? (options[0] as Node) : { type: 'alt', options }
    }

    private sequence(): Node {
        const items: Node[] = []
        while (this.pos < this.source.length && this.peek() !== '|' && this.peek() !== ')') {
            items.push(this.quantified(this.atom()))
        }
        return items.length === 1 ? (items[0] as Node) : { type: 'seq', items }
    }

    private quantified(node: Node): Node {
        for (;;) {
            const c = this.peek()
            let min: number
            let max: number
            if (c === '?') [min, max] = [0, 1]
            else if (c === '*') [min, max] = [0, Number.POSITIVE_INFINITY]
            else if (c === '+') [min, max] = [1, Number.POSITIVE_INFINITY]
            else if (c === '{') {
                const m = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.pos))
                if (!m) return node
                min = Number(m[1])
                max = m[2] === undefined ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3])
                if (max < min) this.fail('Quantifier range out of order')
                this.pos += m[0].length - 1
            } else return node
            this.pos++
            // Laziness changes which match a backtracker reports first. Here every
            // match is reported, so a lazy quantifier means the same as a greedy one.
            if (this.peek() === '?') this.pos++
            node = { type: 'repeat', node, min, max }
        }
    }

    private atom(): Node {
        const c = this.peek() as string
        if (c === '(') {
            this.pos++
            if (this.source.startsWith('?:', this.pos)) this.pos += 2
            else if (this.peek() === '?') this.fail('Lookarounds and named groups are not supported')
            const node = this.alternation()
            if (this.peek() !== ')') this.fail('Unclosed group')
            this.pos++
            return node
        }
        if (c === '[') return { type: 'char', test: this.charClass() }
        if (c === '.') {
            this.pos++
            return { type: 'char', test: (ch) => ch !== '\n' && ch !== '\r' }
        }
        if (c === '\\') return { type: 'char', test: this.escape() }
        if (c === '^' || c === '$') this.fail('Anchors are not supported; use canStart/canEnd')
        if (c === '*' || c === '+' || c === '?' || c === '{') this.fail('Nothing to repeat')
        this.pos++
        return { type: 'char', test: (ch) => ch === c }
    }

    /** Consume an escape and return what it matches. */
    private escape(): CharTest {
        this.pos++ // the backslash
        const c = this.source[this.pos++]
        switch (c) {
            case undefined:
                return this.fail('Trailing backslash')
            case 'd':
                return DIGIT
            case 'D':
                return not(DIGIT)
            case 's':
                return SPACE
            case 'S':
                return not(SPACE)
            case 'w':
                return WORD
            case 'W':
                return not(WORD)
            case 'n':
                return (ch) => ch === '\n'
            case 'r':
                return (ch) => ch === '\r'
            case 't':
                return (ch) => ch === '\t'
            case 'p':
            case 'P': {
                const m = /^\{([\w=]+)\}/.exec(this.source.slice(this.pos))
                if (!m) this.fail('Expected \\p{Name}')
                this.pos += m[0].length
                return property(m[1] as string, c === 'P')
            }
            case 'b':
            case 'B':
                return this.fail('Word boundaries are not supported; use canStart/canEnd')
            default:
                if (/[1-9]/.test(c)) this.fail('Back-references are not supported')
                return (ch) => ch === c
        }
    }

    private charClass(): CharTest {
        this.pos++ // [
        const negated = this.peek() === '^'
        if (negated) this.pos++
        const tests: CharTest[] = []
        let first = true
        while (this.peek() !== ']' || first) {
            first = false
            if (this.pos >= this.source.length) this.fail('Unclosed character class')
            // A class escape (\d, \p{L}) stands alone; a single-character one can start a range.
            let low: string | null = null
            if (this.peek() === '\\') {
                const next = this.source[this.pos + 1] as string
                if ('dDsSwWpP'.includes(next)) {
                    tests.push(this.escape())
                    continue
                }
                this.pos += 2
                low = { n: '\n', r: '\r', t: '\t' }[next] ?? next
            } else {
                low = this.source[this.pos++] as string
            }
            if (
                this.peek() === '-' &&
                this.source[this.pos + 1] !== ']' &&
                this.pos + 1 < this.source.length
            ) {
                this.pos++
                let high = this.source[this.pos++] as string
                if (high === '\\') high = this.source[this.pos++] as string
                if (high < low) this.fail('Character range out of order')
                const [lo, hi] = [low, high]
                tests.push((ch) => ch >= lo && ch <= hi)
            } else {
                const only = low
                tests.push((ch) => ch === only)
            }
        }
        this.pos++ // ]
        const any: CharTest = (ch) => tests.some((t) => t(ch))
        return negated ? not(any) : any
    }
}

/* ── NFA ────────────────────────────────────────────────────────────────── */

interface State {
    /** Free transitions. */
    eps: number[]
    /** At most one character transition, as in Thompson's construction. */
    test: CharTest | null
    to: number
}

/** Above this, unbounded or huge repeats are expanded no further. */
const MAX_EXPANSION = 1000

class Nfa {
    readonly states: State[] = []

    add(): number {
        this.states.push({ eps: [], test: null, to: -1 })
        return this.states.length - 1
    }

    /** Build `node` between fresh states; returns [start, end]. */
    build(node: Node): [number, number] {
        switch (node.type) {
            case 'char': {
                const start = this.add()
                const end = this.add()
                const state = this.states[start] as State
                state.test = node.test
                state.to = end
                return [start, end]
            }
            case 'seq': {
                const start = this.add()
                let tail = start
                for (const item of node.items) {
                    const [s, e] = this.build(item)
                    ;(this.states[tail] as State).eps.push(s)
                    tail = e
                }
                return [start, tail]
            }
            case 'alt': {
                const start = this.add()
                const end = this.add()
                for (const option of node.options) {
                    const [s, e] = this.build(option)
                    ;(this.states[start] as State).eps.push(s)
                    ;(this.states[e] as State).eps.push(end)
                }
                return [start, end]
            }
            case 'repeat': {
                const start = this.add()
                let tail = start
                for (let i = 0; i < node.min; i++) {
                    if (i > MAX_EXPANSION) throw new SyntaxError('Repeat count too large')
                    const [s, e] = this.build(node.node)
                    ;(this.states[tail] as State).eps.push(s)
                    tail = e
                }
                if (node.max === Number.POSITIVE_INFINITY) {
                    const [s, e] = this.build(node.node)
                    const loop = this.add()
                    ;(this.states[tail] as State).eps.push(loop)
                    ;(this.states[loop] as State).eps.push(s)
                    ;(this.states[e] as State).eps.push(loop)
                    tail = loop
                } else {
                    // Optional copies, each skippable straight to the end.
                    const end = this.add()
                    for (let i = node.min; i < node.max; i++) {
                        if (i > MAX_EXPANSION) throw new SyntaxError('Repeat count too large')
                        const [s, e] = this.build(node.node)
                        ;(this.states[tail] as State).eps.push(s, end)
                        tail = e
                    }
                    ;(this.states[tail] as State).eps.push(end)
                    tail = end
                }
                return [start, tail]
            }
        }
    }
}

const caseInsensitive =
    (test: CharTest): CharTest =>
    (c) =>
        test(c) || test(c.toLowerCase()) || test(c.toUpperCase())

function applyFlag(node: Node, fold: (t: CharTest) => CharTest): Node {
    switch (node.type) {
        case 'char':
            return { type: 'char', test: fold(node.test) }
        case 'seq':
            return { type: 'seq', items: node.items.map((n) => applyFlag(n, fold)) }
        case 'alt':
            return { type: 'alt', options: node.options.map((n) => applyFlag(n, fold)) }
        case 'repeat':
            return { ...node, node: applyFlag(node.node, fold) }
    }
}

const costOf = (cost: CharCost | undefined, char: string): number =>
    cost === undefined ? 1 : typeof cost === 'number' ? cost : cost(char)

/* ── Search ─────────────────────────────────────────────────────────────── */

export class FuzzyRegex {
    private readonly states: State[]
    private readonly start: number
    private readonly accept: number

    constructor(
        readonly source: string,
        readonly flags = ''
    ) {
        for (const flag of flags) {
            // `g` and `u` describe how a native RegExp iterates; search is always global here.
            if (!'igu'.includes(flag)) throw new SyntaxError(`Unsupported flag "${flag}"`)
        }
        let ast = new Parser(source).parse()
        if (flags.includes('i')) ast = applyFlag(ast, caseInsensitive)
        const nfa = new Nfa()
        ;[this.start, this.accept] = nfa.build(ast)
        this.states = nfa.states
    }

    /**
     * Every match within budget, keyed by where it ends.
     *
     * For each end index the cheapest match ending there is reported, and among
     * equally cheap ones the leftmost start. Matches overlap freely; choosing
     * among them is the caller's business, or `matchAll`'s.
     */
    search(text: string, options: FuzzySearchOptions = {}): FuzzyMatch[] {
        const maxCost = options.maxCost ?? 0
        const costs = options.costs ?? {}
        const del = costs.delete ?? 1
        const canStart = options.canStart ?? (() => true)
        const canEnd = options.canEnd ?? (() => true)
        const states = this.states
        const m = states.length

        let cost = new Float64Array(m).fill(Number.POSITIVE_INFINITY)
        let from = new Int32Array(m)
        let edits: (FuzzyEdit[] | null)[] = new Array(m).fill(null)
        let active: number[] = []
        let nextCost = new Float64Array(m).fill(Number.POSITIVE_INFINITY)
        let nextFrom = new Int32Array(m)
        let nextEdits: (FuzzyEdit[] | null)[] = new Array(m).fill(null)
        let nextActive: number[] = []

        const matches: FuzzyMatch[] = []

        /** Offer (c, s, e) for state `to` in the given buffers; true if it improved. */
        const relax = (
            buf: { cost: Float64Array; from: Int32Array; edits: (FuzzyEdit[] | null)[]; active: number[] },
            to: number,
            c: number,
            s: number,
            e: FuzzyEdit[] | null
        ): boolean => {
            if (c > maxCost) return false
            const old = buf.cost[to] as number
            if (c > old || (c === old && s >= (buf.from[to] as number))) return false
            if (old === Number.POSITIVE_INFINITY) buf.active.push(to)
            buf.cost[to] = c
            buf.from[to] = s
            buf.edits[to] = e
            return true
        }

        for (let i = 0; ; i++) {
            const cur = { cost, from, edits, active }
            if (canStart(i)) relax(cur, this.start, 0, i, null)

            // Epsilon closure, with deletions: skipping a pattern character
            // is a transition that consumes nothing.
            const work = [...active]
            while (work.length > 0) {
                const s = work.pop() as number
                const state = states[s] as State
                const c = cost[s] as number
                const st = from[s] as number
                const e = edits[s] as FuzzyEdit[] | null
                for (const t of state.eps) if (relax(cur, t, c, st, e)) work.push(t)
                if (state.test && c + del <= maxCost) {
                    const withDelete = [...(e ?? []), { kind: 'delete' as const, index: i }]
                    if (relax(cur, state.to, c + del, st, withDelete)) work.push(state.to)
                }
            }

            const acc = cost[this.accept] as number
            if (acc <= maxCost && (from[this.accept] as number) < i && canEnd(i)) {
                matches.push({
                    start: from[this.accept] as number,
                    end: i,
                    cost: acc,
                    edits: edits[this.accept] ?? [],
                })
            }
            if (i >= text.length) break

            const ch = text[i] as string
            const next = { cost: nextCost, from: nextFrom, edits: nextEdits, active: nextActive }
            let insertCost: number | null = null
            for (const s of active) {
                const state = states[s] as State
                if (!state.test) continue
                const c = cost[s] as number
                const st = from[s] as number
                const e = edits[s] as FuzzyEdit[] | null
                if (state.test(ch)) {
                    relax(next, state.to, c, st, e)
                } else {
                    const sub = costOf(costs.substitute, ch)
                    if (c + sub <= maxCost) {
                        relax(next, state.to, c + sub, st, [...(e ?? []), { kind: 'substitute', index: i }])
                    }
                }
                // Only a state waiting on a character can absorb a stray one, so
                // a match never grows junk at either end.
                insertCost ??= costOf(costs.insert, ch)
                if (c + insertCost <= maxCost) {
                    relax(next, s, c + insertCost, st, [...(e ?? []), { kind: 'insert', index: i }])
                }
            }

            // Swap buffers, clearing the one being retired.
            for (const s of active) {
                cost[s] = Number.POSITIVE_INFINITY
                edits[s] = null
            }
            active.length = 0
            ;[cost, nextCost] = [nextCost, cost]
            ;[from, nextFrom] = [nextFrom, from]
            ;[edits, nextEdits] = [nextEdits, edits]
            ;[active, nextActive] = [nextActive, active]
        }
        return matches
    }

    /**
     * Non-overlapping matches, the way a regex scan reports them: cheapest
     * first where they compete, then leftmost, then longest.
     */
    matchAll(text: string, options: FuzzySearchOptions = {}): FuzzyMatch[] {
        const all = this.search(text, options).sort(
            (a, b) => a.cost - b.cost || a.start - b.start || b.end - b.start - (a.end - a.start)
        )
        const kept: FuzzyMatch[] = []
        for (const match of all) {
            if (kept.some((k) => match.start < k.end && match.end > k.start)) continue
            kept.push(match)
        }
        return kept.sort((a, b) => a.start - b.start)
    }
}
