// pdf.js loads its worker and data files at runtime from URLs the app provides,
// so they have to be served from this app's own origin.
//
// onnxruntime-web's WASM runtime is deliberately NOT copied here. It defaults to
// a version-matched CDN and the browser caches it on disk after the first load,
// and Vite refuses to `import` anything out of public/, which is how ORT loads
// its .mjs glue -- pointing ortWasmPaths at public/ breaks it outright.
import { cp, mkdir } from 'node:fs/promises'

const from = 'node_modules/pdfjs-dist'
await mkdir('public', { recursive: true })
await cp(`${from}/build/pdf.worker.min.mjs`, 'public/pdf.worker.min.mjs')
await cp(`${from}/cmaps`, 'public/cmaps', { recursive: true })
await cp(`${from}/standard_fonts`, 'public/standard_fonts', { recursive: true })
console.log('copied pdf.js assets into public/')
