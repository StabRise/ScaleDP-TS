/**
 * Benchmark results, read straight from `bench/results/*.json`.
 *
 * Globbed rather than copied into the page, so a new `pnpm bench` run shows up
 * on the site with no edit to the docs -- and a number on the page can never
 * drift from the file it came from.
 */

interface Measurement {
    workers: number
    pagesInFlight: number
    threads: number
    pages: number
    ms: number
    pagesPerSecond: number
    firstPageMs: number
    p50PageMs: number
    p95PageMs: number
    isolated: boolean
    cores: number
}

interface ResultFile {
    date: string
    cpu?: string
    cores: number
    mode: 'isolated' | 'not-isolated'
    results: Measurement[]
}

const files = import.meta.glob<ResultFile>('../../../../../bench/results/*.json', {
    eager: true,
    import: 'default',
})

/** Newest run per CPU and mode. */
function latest(mode: ResultFile['mode']): ResultFile[] {
    const byCpu = new Map<string, ResultFile>()
    for (const file of Object.values(files)) {
        if (file.mode !== mode) continue
        const key = file.cpu ?? 'unknown'
        const seen = byCpu.get(key)
        if (!seen || seen.date < file.date) byCpu.set(key, file)
    }
    return [...byCpu.values()]
}

const setting = (m: Measurement) =>
    `${m.workers} worker${m.workers === 1 ? '' : 's'} × ${m.threads} thread${m.threads === 1 ? '' : 's'}`

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function isBaseline(m: Measurement): boolean {
    return m.workers === 1 && m.threads === 1 && m.pagesInFlight === 1
}

/** One environment's throughput, one bar per setting, fastest first. */
export function BenchmarkChart({
    mode,
    pagesInFlight,
}: {
    mode: ResultFile['mode']
    /** Show only settings with this many pages in flight; omit for every setting. */
    pagesInFlight?: number
}) {
    const runs = latest(mode)
    if (runs.length === 0) {
        return <p className="text-fd-muted-foreground">No {mode} results recorded yet. Run `pnpm bench`.</p>
    }

    return (
        <>
            {runs.map((run) => {
                const baseline = run.results.find(isBaseline)
                const shown = run.results
                    .filter((m) => pagesInFlight === undefined || m.pagesInFlight === pagesInFlight)
                    .sort((a, b) => b.pagesPerSecond - a.pagesPerSecond)
                // One scale per run, so charts of the same run compare bar for bar.
                const max = Math.max(...run.results.map((m) => m.pagesPerSecond))

                return (
                    <figure key={`${run.cpu}-${run.date}`} className="not-prose my-6">
                        <figcaption className="mb-3 text-sm text-fd-muted-foreground">
                            Pages per second, {run.cpu ?? 'unknown CPU'} ({run.cores} cores), {run.date}
                            {pagesInFlight !== undefined &&
                                `, ${pagesInFlight} page${pagesInFlight === 1 ? '' : 's'} in flight per worker`}
                        </figcaption>
                        <ul className="space-y-1.5">
                            {shown.map((m) => {
                                const speedup = baseline ? m.pagesPerSecond / baseline.pagesPerSecond : null
                                const detail =
                                    `${setting(m)}, ${m.pagesInFlight} in flight: ${m.pagesPerSecond} pages/s, ` +
                                    `first page ${seconds(m.firstPageMs)}, p95 page ${seconds(m.p95PageMs)}`
                                return (
                                    <li
                                        key={`${m.workers}-${m.threads}-${m.pagesInFlight}`}
                                        className="group grid grid-cols-[minmax(0,15rem)_1fr] items-center gap-3 rounded-md px-1 py-0.5 hover:bg-fd-accent focus-within:bg-fd-accent"
                                        title={detail}
                                    >
                                        <span className="truncate font-mono text-xs text-fd-muted-foreground">
                                            {setting(m)}
                                            {pagesInFlight === undefined && ` · ${m.pagesInFlight} in flight`}
                                        </span>
                                        <span className="flex items-center gap-2">
                                            <span
                                                role="img"
                                                aria-label={detail}
                                                className={`h-3.5 rounded-r ${isBaseline(m) ? 'bg-fd-muted-foreground/40' : 'bg-fd-primary'}`}
                                                style={{
                                                    width: `${Math.max(1, (m.pagesPerSecond / max) * 100) * 0.8}%`,
                                                }}
                                            />
                                            <span className="whitespace-nowrap font-mono text-xs text-fd-foreground">
                                                {m.pagesPerSecond.toFixed(2)}
                                                {speedup !== null && (
                                                    <span className="text-fd-muted-foreground">
                                                        {isBaseline(m)
                                                            ? ' · baseline'
                                                            : ` · ${speedup.toFixed(1)}×`}
                                                    </span>
                                                )}
                                            </span>
                                        </span>
                                    </li>
                                )
                            })}
                        </ul>
                    </figure>
                )
            })}
        </>
    )
}

/** Every measurement of one environment, as a table: the accessible view of the chart. */
export function BenchmarkTable({ mode }: { mode: ResultFile['mode'] }) {
    return (
        <>
            {latest(mode).map((run) => (
                <table key={`${run.cpu}-${run.date}`}>
                    <thead>
                        <tr>
                            <th>Workers</th>
                            <th>Threads</th>
                            <th>Pages in flight</th>
                            <th>Pages/s</th>
                            <th>First page</th>
                            <th>p50 page</th>
                            <th>p95 page</th>
                        </tr>
                    </thead>
                    <tbody>
                        {run.results.map((m) => (
                            <tr key={`${m.workers}-${m.threads}-${m.pagesInFlight}`}>
                                <td>{m.workers}</td>
                                <td>{m.threads}</td>
                                <td>{m.pagesInFlight}</td>
                                <td>{m.pagesPerSecond.toFixed(2)}</td>
                                <td>{seconds(m.firstPageMs)}</td>
                                <td>{seconds(m.p50PageMs)}</td>
                                <td>{seconds(m.p95PageMs)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ))}
        </>
    )
}
