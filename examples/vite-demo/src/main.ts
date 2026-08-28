import { DataToImage, ImageDrawBoxes, Pipeline, configure, type Row } from '@stabrise/scaledp'
import {
    renderInto,
    showBoxes,
    showImage,
    showNer,
    showText,
    visualizeNer,
} from '@stabrise/scaledp/display'
import { GlinerNer } from '@stabrise/scaledp/ner'
import {
    PaddleTextRecognizer,
    isCrossOriginIsolated,
    isPresetCached,
    isWebGpuAvailable,
} from '@stabrise/scaledp/ocr'
import { PdfToImage } from '@stabrise/scaledp/pdf'

import type { Document, NerOutput, ScaleDpImage } from '@stabrise/scaledp/display'

const OCR_PRESET = 'v6-small'
const NER_LABELS = ['person', 'organization', 'email', 'phone', 'address', 'date']

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const progressEl = el('progress')
const statusEl = el('status')
const timingsEl = el('timings')
const dropEl = el('drop')
const fileEl = el<HTMLInputElement>('file')
const nerEl = el<HTMLInputElement>('ner')
const copyEl = el<HTMLButtonElement>('copy')
const wrapEl = el<HTMLInputElement>('wrap')
const textMetaEl = el('textMeta')

const panels = {
    text: el<HTMLDetailsElement>('panel-text'),
    entities: el<HTMLDetailsElement>('panel-entities'),
    boxes: el<HTMLDetailsElement>('panel-boxes'),
    image: el<HTMLDetailsElement>('panel-image'),
}

const log = (message: string) => {
    statusEl.textContent = `${statusEl.textContent}\n${message}`.trim()
}

async function setup() {
    const webgpu = await isWebGpuAvailable()
    configure({
        cache: 'indexeddb',
        // WebGPU is typically 2-5x faster and needs no cross-origin isolation.
        executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
        pdf: {
            workerSrc: '/pdf.worker.min.mjs',
            cMapUrl: '/cmaps/',
            standardFontDataUrl: '/standard_fonts/',
        },
        // Progress gets its own element: writing it into #status would wipe the
        // running log. The terminal 'ready' event carries no filename, so fall
        // back to the repo name.
        onProgress: ({ repo, file, loaded, total, phase }) => {
            if (phase === 'ready') {
                progressEl.textContent = ''
                return
            }
            const what = file || repo
            progressEl.textContent =
                total > 0
                    ? `${phase} ${what}: ${Math.round((loaded / total) * 100)}%`
                    : `${phase} ${what}...`
        },
    })

    log(`WebGPU: ${webgpu ? 'yes' : 'no'} | cross-origin isolated: ${isCrossOriginIsolated()}`)

    // The cache is scoped per origin, port included, so a dev server that moved
    // to a different port has an empty cache and looks like caching is broken.
    const cached = await isPresetCached(OCR_PRESET).catch(() => false)
    log(
        `OCR models (${OCR_PRESET}) at ${location.origin}: ` +
            (cached ? 'cached, no download needed' : 'not cached, first run will download')
    )
}

async function run(file: File) {
    statusEl.textContent = ''
    progressEl.textContent = ''
    for (const panel of Object.values(panels)) panel.hidden = true

    log(`processing ${file.name} (${(file.size / 1024).toFixed(0)} KB)`)
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

    const stages = [
        isPdf ? new PdfToImage({ resolution: 200 }) : new DataToImage(),
        new PaddleTextRecognizer({ preset: OCR_PRESET, keepFormatting: true }),
    ]
    if (nerEl.checked) {
        stages.push(new GlinerNer({ labels: NER_LABELS }))
    }
    // Draw the boxes as a pipeline stage rather than by hand, which is how
    // ScaleDP does it -- the annotated page is just another Image column.
    stages.push(
        new ImageDrawBoxes({
            inputCols: nerEl.checked ? ['image', 'text', 'ner'] : ['image', 'text'],
            outputCol: 'annotated',
            lineWidth: 2,
            displayDataList: nerEl.checked ? ['entity_group'] : [],
        })
    )

    const pipeline = new Pipeline(stages)
    const rows = await pipeline.transform(file, {
        onStage: (name, ms) => log(`${name}: ${ms.toFixed(0)}ms`),
    })

    progressEl.textContent = ''
    render(rows[0])
    await pipeline.dispose()
}

function render(row: Row | undefined) {
    if (!row) return log('no pages produced')

    const timing = row.execution_time as { total: number }
    timingsEl.textContent = `total ${timing.total.toFixed(0)}ms`

    const document_ = row.text as Document
    if (document_.exception) return log(`OCR failed: ${document_.exception}`)
    log(`${document_.bboxes.length} boxes, ${document_.text.length} characters`)

    // Recognized text. keepFormatting is on, so the layout is preserved.
    renderInto('#text', showText(document_))
    textMetaEl.textContent = `${document_.text.length} characters, ${document_.text.split('\n').length} lines`
    panels.text.hidden = false

    renderInto('#boxes', showBoxes(document_, 50))
    panels.boxes.hidden = false

    const annotated = (row.annotated ?? row.image) as ScaleDpImage | undefined
    if (annotated) {
        renderInto('#image', showImage(annotated))
        panels.image.hidden = false
    }

    const ner = row.ner as NerOutput | undefined
    if (!ner || ner.entities.length === 0) return

    renderInto('#entities', showNer(ner, { limit: 0 }))
    renderInto('#nerText', visualizeNer(document_, ner))
    panels.entities.hidden = false
}

copyEl.addEventListener('click', async () => {
    await navigator.clipboard.writeText(el('text').textContent ?? '')
    copyEl.textContent = 'Copied'
    setTimeout(() => {
        copyEl.textContent = 'Copy'
    }, 1200)
})

wrapEl.addEventListener('change', () => {
    const pre = el('text').querySelector('pre')
    if (pre) pre.style.whiteSpace = wrapEl.checked ? 'pre-wrap' : 'pre'
})

dropEl.addEventListener('click', () => fileEl.click())
fileEl.addEventListener('change', () => {
    const file = fileEl.files?.[0]
    if (file) void run(file).catch((error) => log(`error: ${error.message}`))
})
dropEl.addEventListener('dragover', (event) => {
    event.preventDefault()
    dropEl.classList.add('over')
})
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'))
dropEl.addEventListener('drop', (event) => {
    event.preventDefault()
    dropEl.classList.remove('over')
    const file = event.dataTransfer?.files?.[0]
    if (file) void run(file).catch((error) => log(`error: ${error.message}`))
})

void setup()
