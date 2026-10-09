#!/usr/bin/env node
/**
 * Run the throughput benchmark and record it.
 *
 * Runs the `bench` vitest project, collects the `BENCH_RESULT` lines it logs,
 * prints them as a table, and writes `bench/results/<date>-<cpu>-<mode>.json`
 * so the defaults in `src/core/parallelism.ts` can cite a measurement.
 *
 *   pnpm bench                       not isolated: workers only
 *   BENCH_ISOLATED=1 pnpm bench      isolated: threads too
 *   VITE_BENCH_PAGES=24 pnpm bench   more pages per run
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'

const results = []

/**
 * Run the bench project once, collecting its results.
 *
 * Verbose, because in a non-TTY the default reporter drops a passing test's
 * console output.
 */
function runOnce() {
    return new Promise((resolve) => {
        const child = spawn('npx', ['vitest', 'run', '--project', 'bench', 'bench/throughput.bench.test.ts', '--reporter=verbose'], {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: process.env,
        })
        let buffer = ''
        let reloaded = false
        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                if (line.includes('unexpectedly reloaded')) reloaded = true
                const at = line.indexOf('BENCH_RESULT ')
                if (at < 0) continue
                const result = JSON.parse(line.slice(at + 'BENCH_RESULT '.length))
                results.push(result)
                console.log(
                    `workers=${result.workers} pagesInFlight=${result.pagesInFlight} threads=${result.threads}: ` +
                        `${result.pagesPerSecond} pages/s, first ${result.firstPageMs} ms, p95 ${result.p95PageMs} ms`
                )
            }
        })
        child.on('close', (code) => resolve({ code, reloaded }))
    })
}

let { code, reloaded } = await runOnce()
// On a cold dependency cache Vite discovers onnxruntime-web inside the worker
// mid-run and reloads the page under it, failing every engine stage. The cache
// is warm the second time.
if (results.length === 0 && reloaded) {
    console.log('Vite re-optimised dependencies mid-run; running again on a warm cache.')
    ;({ code } = await runOnce())
}
finish(code)

function finish(code) {
    if (results.length === 0) {
        console.error('No results recorded.')
        process.exit(code || 1)
    }
    const best = [...results].sort((a, b) => b.pagesPerSecond - a.pagesPerSecond)[0]
    const baseline = results.find((r) => r.workers === 1 && r.pagesInFlight === 1 && r.threads === 1)
    console.log('\n| workers | pages in flight | threads | pages/s | first page ms | p50 ms | p95 ms |')
    console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const r of results) {
        console.log(
            `| ${r.workers} | ${r.pagesInFlight} | ${r.threads} | ${r.pagesPerSecond} | ${r.firstPageMs} | ${r.p50PageMs} | ${r.p95PageMs} |`
        )
    }
    if (baseline && best) {
        console.log(
            `\nBest: workers=${best.workers} pagesInFlight=${best.pagesInFlight} threads=${best.threads}, ` +
                `${(best.pagesPerSecond / baseline.pagesPerSecond).toFixed(2)}x the one-worker one-page baseline.`
        )
    }

    const date = new Date().toISOString().slice(0, 10)
    const cpu = (cpus()[0]?.model ?? 'cpu').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const mode = results[0]?.isolated ? 'isolated' : 'not-isolated'
    mkdirSync('bench/results', { recursive: true })
    const file = `bench/results/${date}-${cpu}-${mode}.json`
    writeFileSync(
        file,
        `${JSON.stringify({ date, cpu: cpus()[0]?.model, cores: cpus().length, mode, results }, null, 4)}\n`
    )
    console.log(`\nWrote ${file}`)
    process.exit(code ?? 0)
}
