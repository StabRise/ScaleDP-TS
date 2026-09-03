/**
 * Screenshot a real pipeline run on the ScaleDP-TS playground.
 *
 * A post's figures come in three kinds and this script owns exactly one:
 * *evidence*. A diagram explains what should happen; a screenshot from here
 * proves what did, on a page the reader can open themselves. Headers come from
 * `blog-header-image`, explanatory figures from `blog-inline-diagram`.
 *
 *   node <this> --out examples/images/blog/<slug>-<what>.png [options]
 *
 * Options:
 *   --url <url>       Demo URL. Default https://scaledp-ts.stabrise.com/demo
 *   --pipeline <json> StageDescriptor[] as JSON; encoded into `?p=` for you, so
 *                     the URL this shoots is the URL the post links to.
 *   --preset <id>     Built-in preset id instead of a pipeline (`?preset=`).
 *   --sample <label>  Sample pill to click: "Rotated text", "Signatures",
 *                     "Face", "Face, scanned", "Face, Cyrillic".
 *   --file <path>     Local file to upload instead of a sample.
 *   --clip <sel>      Screenshot this element only. Default: the whole page.
 *                     Useful: .results, .col--page, .col--read, .trace, .rail
 *   --click <sel,..>  Click these after the run, before the shot. The one you
 *                     will want is `text=Wrap` -- layout-preserved text is laid
 *                     out for a monospace column and clips at the panel edge
 *                     unless wrapping is on, which reads as truncated output.
 *   --no-run          Shoot the seeded builder without running anything.
 *   --wait <ms>       How long a run may take. Default 240000 -- the deployed
 *                     site is not cross-origin isolated, so ORT runs
 *                     single-threaded there, and a first run also downloads
 *                     weights.
 *   --width <px>      Viewport width. Default 1440.
 *   --height <px>     Viewport height. Default 900.
 *
 * Run from the repo root so `node` resolves the repo's own playwright.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? fallback : argv[i + 1]
}
const flag = (name) => argv.includes(`--${name}`)

const out = arg('out')
if (!out) {
    console.error('usage: capture-demo.mjs --out <file.png> [--pipeline <json>] [--sample <label>] ...')
    process.exit(1)
}

const base = arg('url', 'https://scaledp-ts.stabrise.com/demo')
const pipeline = arg('pipeline')
const preset = arg('preset')
const sample = arg('sample')
const file = arg('file')
const clip = arg('clip')
const waitMs = Number(arg('wait', '240000'))
const width = Number(arg('width', '1440'))
const height = Number(arg('height', '900'))

// base64url, matching examples/vite-demo/src/lib/deeplink.ts. Encoding here
// rather than pasting a link is the point: the same descriptors go in the
// post's code block, so the screenshot and the `Try it` link cannot drift.
const encode = (descriptors) =>
    Buffer.from(JSON.stringify(descriptors), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

let url = base
if (pipeline) url = `${base}?p=${encode(JSON.parse(pipeline))}`
else if (preset) url = `${base}?preset=${encodeURIComponent(preset)}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
page.on('console', (m) => {
    if (m.type() === 'error') console.error('  page error:', m.text())
})

console.log('opening', url)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.platen', { timeout: 60000 })
await page.evaluate(() => document.fonts.ready)

if (!flag('no-run')) {
    if (file) {
        await page.setInputFiles('input[type=file]', path.resolve(file))
    } else if (sample) {
        await page.getByRole('button', { name: sample, exact: true }).click()
    } else {
        console.error('nothing to run: pass --sample, --file, or --no-run')
        process.exit(1)
    }

    // The run button reads "Cancel" while busy and "Run again" when it is not,
    // so the pair of waits is start-then-finish. Waiting on results alone would
    // shoot a stale result from a previous run on a re-seeded builder.
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
    await cancel.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {
        console.log('  (run finished before it could be observed starting)')
    })
    console.log('running...')
    await cancel.waitFor({ state: 'detached', timeout: waitMs })
    await page.waitForSelector('.results', { timeout: 30000 })
    // Box overlays are drawn to a canvas after the row lands.
    await page.waitForTimeout(1500)
}

for (const selector of (arg('click', '') || '').split(',').filter(Boolean)) {
    await page.locator(selector.trim()).first().click()
    await page.waitForTimeout(400)
}

if (await page.locator('.warn--error').count()) {
    console.error('  !! the page is showing an error state -- read the PNG before using it')
}

fs.mkdirSync(path.dirname(out), { recursive: true })
const target = clip ? page.locator(clip).first() : page
await target.screenshot({ path: out, ...(clip ? {} : { fullPage: true }) })
console.log('wrote', out)

await browser.close()
