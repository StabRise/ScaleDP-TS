/**
 * The rows of a run as they stand mid-run, assembled from its row updates.
 *
 * `Pipeline.run` reports each stage's rows for one unit -- normally a page --
 * as soon as they exist. Keeping the latest per unit, in unit order, gives the
 * same list the run will finish with, filled in page by page.
 */

import type { Row, RowUpdate } from '@stabrise/scaledp'

const parse = (key: string): number[] => (key === '' ? [] : key.split('.').map(Number))

function compare(a: number[], b: number[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = (a[i] as number) - (b[i] as number)
        if (d !== 0) return d
    }
    return a.length - b.length
}

/** `a` is `b`'s ancestor or descendant: one unit split into, or merged from, the other. */
function related(a: number[], b: number[]): boolean {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
    return a.length !== b.length
}

export class LiveRows {
    private readonly units = new Map<string, Row[]>()

    apply(update: RowUpdate): void {
        const key = parse(update.unit.key)
        // A document split into pages, or pages merged at a barrier, supersedes
        // what was shown for the unit it came from.
        for (const other of [...this.units.keys()]) {
            if (related(parse(other), key)) this.units.delete(other)
        }
        const rows = this.units.get(update.unit.key) ?? []
        rows.length = update.rowCount
        rows[update.rowIndex] = update.row
        this.units.set(update.unit.key, rows)
    }

    rows(): Row[] {
        return [...this.units.entries()]
            .sort(([a], [b]) => compare(parse(a), parse(b)))
            .flatMap(([, rows]) => rows.filter((row): row is Row => row !== undefined))
    }
}
