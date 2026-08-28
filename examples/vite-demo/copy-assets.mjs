// pdf.js needs its worker and data files served from the app's own origin.
// A library cannot know where they live, so copying them is the app's job.
import { cp, mkdir } from 'node:fs/promises'

const from = 'node_modules/pdfjs-dist'
await mkdir('public', { recursive: true })
await cp(`${from}/build/pdf.worker.min.mjs`, 'public/pdf.worker.min.mjs')
await cp(`${from}/cmaps`, 'public/cmaps', { recursive: true })
await cp(`${from}/standard_fonts`, 'public/standard_fonts', { recursive: true })
console.log('copied pdf.js assets into public/')
