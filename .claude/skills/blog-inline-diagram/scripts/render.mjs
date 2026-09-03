/**
 * Render standalone HTML files to PNG at exact CSS-pixel dimensions.
 *
 * Uses the repo's own Playwright devDependency -- run from the repo root so
 * `node` resolves `node_modules/playwright`. No install step, no CDN service.
 *
 *   node <this> <input.html|dir> <outDir> [width] [height]
 *
 * Width/height are a FALLBACK. If the page sizes its own body (every template
 * here does), those dimensions win -- so a directory of differently-sized
 * figures renders correctly in one call, and a template whose height you edited
 * cannot silently disagree with the number you passed on the command line.
 *
 * deviceScaleFactor 2 gives a retina PNG at 2x the pixel size; the viewport is
 * exact CSS pixels, so there is no window chrome or DPI mismatch to crop away.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const [, , input, outDir, w = '1000', h = '420'] = process.argv
if (!input || !outDir) {
    console.error('usage: render.mjs <input.html|dir> <outDir> [width] [height]')
    process.exit(1)
}

const files = fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter((f) => f.endsWith('.html')).map((f) => path.join(input, f))
    : [input]

fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({
    viewport: { width: Number(w), height: Number(h) },
    deviceScaleFactor: 2,
})

for (const file of files) {
    await page.goto(`file://${path.resolve(file)}`)
    // Webfonts arrive over the network; screenshotting before they land gives a
    // fallback-face image that looks subtly wrong and is easy to miss.
    await page.evaluate(() => document.fonts.ready)

    // Measure the body's own border box -- getComputedStyle's `height` is the
    // content box, so it drops the padding and clips whatever sits last.
    // A page whose height is `auto` reflows once the viewport changes, so
    // measure, resize, and measure again until it settles.
    const measure = () =>
        page.evaluate(() => {
            const r = document.body.getBoundingClientRect()
            return {
                width: Math.ceil(r.width),
                height: Math.max(Math.ceil(r.height), document.body.scrollHeight),
            }
        })

    let size = await measure()
    for (let i = 0; i < 3; i++) {
        await page.setViewportSize(size)
        const next = await measure()
        if (next.width === size.width && next.height === size.height) break
        size = next
    }

    const out = path.join(outDir, path.basename(file).replace(/\.html$/, '.png'))
    await page.screenshot({ path: out })
    console.log('rendered', out, `${size.width}x${size.height}`)
}

await browser.close()
