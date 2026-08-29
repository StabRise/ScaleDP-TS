import type { RowTime } from '@stabrise/scaledp'
import { useRun } from '../store/run'

/**
 * Where the time went.
 *
 * With one row the bars are the run's per-stage totals, which is all
 * `execution_time` can say. With several, the same stage number covers every
 * page at once and hides the one slow page, so the bars become the selected
 * page's own timings and the footer carries both totals.
 */
export function Trace() {
    const timings = useRun((state) => state.timings)
    const rows = useRun((state) => state.rows)
    const selected = useRun((state) => state.selected)
    const select = useRun((state) => state.select)
    const [mode, setMode] = useModeState(rows.length)

    if (timings.length === 0) return null

    const perPage = rows.length > 1 && mode === 'page'
    const row = rows[selected]
    const rowTime = row?.row_time as RowTime | undefined

    const bars: { name: string; ms: number }[] =
        perPage && rowTime
            ? Object.entries(rowTime.stages).map(([name, ms]) => ({ name, ms: Number(ms) }))
            : timings.map(({ name, ms }) => ({ name, ms }))

    const scale = bars.reduce((sum, bar) => sum + bar.ms, 0) || 1
    // A pipeline can run the same stage twice -- two ImageDrawBoxes passes, one
    // per colour -- so number the repeats rather than showing identical rows.
    // Per page they are already summed under one name by `row_time`.
    const occurrences = new Map<string, number>()
    for (const { name } of bars) occurrences.set(name, (occurrences.get(name) ?? 0) + 1)
    const seen = new Map<string, number>()

    const wall = (rows[0]?.execution_time as { total: number } | undefined)?.total ?? scale
    const pageTotals = rows.map((r) => (r.row_time as RowTime | undefined)?.total ?? 0)
    const slowest = pageTotals.reduce(
        (worst, ms, index) => (ms > (pageTotals[worst] ?? 0) ? index : worst),
        0
    )
    // What the rows actually cost, as against the wall clock for the run: the
    // difference is stage setup, which happens once however many pages there are.
    const measured = pageTotals.reduce((sum, ms) => sum + ms, 0)
    const setup = Math.max(0, wall - measured)

    return (
        <section className="trace" aria-label="Pipeline timings">
            {rows.length > 1 && (
                <div className="trace__modes">
                    <button
                        className={`ghost${mode === 'page' ? ' is-on' : ''}`}
                        type="button"
                        onClick={() => setMode('page')}
                    >
                        This page
                    </button>
                    <button
                        className={`ghost${mode === 'run' ? ' is-on' : ''}`}
                        type="button"
                        onClick={() => setMode('run')}
                    >
                        All pages
                    </button>
                </div>
            )}

            <ol>
                {bars.map(({ name, ms }, index) => {
                    const nth = (seen.get(name) ?? 0) + 1
                    seen.set(name, nth)
                    const shown = (occurrences.get(name) ?? 1) > 1 ? `${name} (${nth})` : name
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: position in the run is the identity
                        <li key={index}>
                            <span className="trace__name">
                                <span
                                    className="trace__bar"
                                    style={{ width: `${Math.max(2, (ms / scale) * 100)}%` }}
                                />
                                <span className="trace__text">{shown}</span>
                            </span>
                            <span className="trace__ms">{ms.toFixed(0)} ms</span>
                        </li>
                    )
                })}
            </ol>

            {rows.length > 1 && (
                <PageBars totals={pageTotals} selected={selected} onSelect={select} slowest={slowest} />
            )}

            <p className="trace__total">
                {rows.length > 1 && rowTime && (
                    <>
                        <span>
                            page {selected + 1}: {rowTime.total.toFixed(0)} ms
                        </span>
                        <span className="trace__sep">·</span>
                    </>
                )}
                {rows.length > 1 && (
                    <>
                        <span>
                            {rows.length} pages: {measured.toFixed(0)} ms,{' '}
                            {(measured / rows.length).toFixed(0)} ms each on average, slowest page{' '}
                            {slowest + 1} at {(pageTotals[slowest] ?? 0).toFixed(0)} ms
                        </span>
                        <span className="trace__sep">·</span>
                    </>
                )}
                <span>
                    {wall.toFixed(0)} ms total
                    {/* The gap is `stage.init()` -- downloading models and
                        creating sessions -- which runs once for the whole file,
                        not per page. Averaging it into a per-page figure would
                        make every page look four seconds slower than it was. */}
                    {setup > 1 && ` (${setup.toFixed(0)} ms of it one-off setup)`}
                </span>
            </p>
        </section>
    )
}

/**
 * Time per page, as bars.
 *
 * One series, so no legend and no categorical palette to separate -- the same
 * cyan the stage bars use, which makes the two charts read as one family. Bars
 * are scaled against the slowest page rather than the total, so the comparison
 * between pages fills the width instead of collapsing into slivers.
 *
 * Each bar is also the control that selects its page, so the chart is not a
 * separate thing to look at beside the pager: it *is* the pager, sorted by cost.
 */
function PageBars({
    totals,
    selected,
    onSelect,
    slowest,
}: {
    totals: number[]
    selected: number
    onSelect: (index: number) => void
    slowest: number
}) {
    const peak = Math.max(...totals, 1)

    return (
        <div className="pages">
            <h3 className="pages__head">Time per page</h3>
            <ol className="pages__list">
                {totals.map((ms, index) => (
                    // Position is the identity: rows carry no id of their own.
                    // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                    <li key={index}>
                        <button
                            className="pages__row"
                            type="button"
                            aria-pressed={index === selected}
                            aria-label={`Page ${index + 1}, ${ms.toFixed(0)} milliseconds`}
                            onClick={() => onSelect(index)}
                        >
                            <span className="pages__n">{index + 1}</span>
                            <span className="pages__track">
                                <span
                                    className="pages__bar"
                                    data-slowest={index === slowest || undefined}
                                    style={{ width: `${Math.max(1.5, (ms / peak) * 100)}%` }}
                                />
                            </span>
                            <span className="pages__ms">{ms.toFixed(0)} ms</span>
                        </button>
                    </li>
                ))}
            </ol>
        </div>
    )
}

/**
 * Which view the bars show, defaulting to per-page as soon as there is more
 * than one and back to the run when a later file has only one.
 */
function useModeState(pages: number): ['page' | 'run', (mode: 'page' | 'run') => void] {
    const mode = useRun((state) => state.traceMode)
    const setMode = useRun((state) => state.setTraceMode)
    return [pages > 1 ? mode : 'run', setMode]
}
