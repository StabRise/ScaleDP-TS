/**
 * Syntax highlighting for the generated pipeline source.
 *
 * Deliberately not Shiki. The only code this ever colours is what
 * `pipelineCode` emits — imports, `new Stage({ key: value })`, and scalar
 * literals — which is a small enough grammar to tokenise with one regex.
 * Shiki is present in the tree as a Fumadocs dependency, but reaching for it
 * here would mean an undeclared dependency, a WASM grammar and an async render
 * on a route that already loads two ML runtimes.
 */

import type { ReactNode } from 'react'

/**
 * One alternation per token class, in priority order.
 *
 * Strings come first so a keyword inside a module specifier stays a string, and
 * property keys come before capitalised identifiers so nothing depends on which
 * case a key happens to be written in.
 */
const TOKEN =
    /('(?:[^'\\\n]|\\.)*')|(\b(?:import|from|export|default|const|let|new|async|await|function|return)\b)|(\b(?:true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*:)|(\b[A-Z][A-Za-z0-9_]*\b)/g

/** Which capture group means which class, by group index. */
const CLASSES = ['tok--string', 'tok--keyword', 'tok--literal', 'tok--number', 'tok--key', 'tok--type']

/** Colour `code` as React nodes. Anything unmatched is emitted as plain text. */
export function highlightTs(code: string): ReactNode[] {
    const out: ReactNode[] = []
    let last = 0
    let key = 0

    TOKEN.lastIndex = 0
    for (let match = TOKEN.exec(code); match !== null; match = TOKEN.exec(code)) {
        if (match.index > last) out.push(code.slice(last, match.index))

        const group = CLASSES.findIndex((_, index) => match[index + 1] !== undefined)
        out.push(
            <span className={CLASSES[group]} key={key++}>
                {match[group + 1]}
            </span>
        )
        last = match.index + match[0].length
    }
    if (last < code.length) out.push(code.slice(last))
    return out
}
