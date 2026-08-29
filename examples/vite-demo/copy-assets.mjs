// pdf.js loads its worker and data files at runtime from URLs the app provides,
// so they have to be served from this app's own origin.
//
// onnxruntime-web's WASM runtime is deliberately NOT copied here. It defaults to
// a version-matched CDN and the browser caches it on disk after the first load,
// and Vite refuses to `import` anything out of public/, which is how ORT loads
// its .mjs glue -- pointing ortWasmPaths at public/ breaks it outright.
import { existsSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'

const from = 'node_modules/pdfjs-dist'
await mkdir('public', { recursive: true })
await cp(`${from}/build/pdf.worker.min.mjs`, 'public/pdf.worker.min.mjs')
await cp(`${from}/cmaps`, 'public/cmaps', { recursive: true })
await cp(`${from}/standard_fonts`, 'public/standard_fonts', { recursive: true })
console.log('copied pdf.js assets into public/')

// tesseract-wasm spawns a worker whose default URL points inside the package.
// Vite's dependency optimizer rewrites that path and the worker 404s, so the
// worker and the two core .wasm builds it loads beside itself are served from
// this app instead.
const tess = 'node_modules/tesseract-wasm/dist'
await mkdir('public/tesseract', { recursive: true })
for (const file of ['tesseract-worker.js', 'tesseract-core.wasm', 'tesseract-core-fallback.wasm']) {
    await cp(`${tess}/${file}`, `public/tesseract/${file}`)
}
console.log('copied tesseract-wasm runtime into public/tesseract/')

// Language data is fetched at runtime. Serving it locally keeps it out of the
// cross-origin path, which matters because the page sets COEP require-corp.
const trained = 'public/tesseract/eng.traineddata'
if (!existsSync(trained)) {
    const url = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata'
    console.log('downloading eng.traineddata (once)...')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
    await writeFile(trained, Buffer.from(await response.arrayBuffer()))
}
console.log('tesseract language data ready')

// The sample documents the demo offers beside the drop target. They live at
// examples/pdfs so the repository has one copy, and are served from this app
// because fetching them cross-origin would be blocked by COEP require-corp.
await cp('../pdfs', 'public/samples', { recursive: true })
console.log('copied sample documents into public/samples/')
