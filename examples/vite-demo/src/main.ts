import { DataToImage, Pipeline, configure, type Row } from '@stabrise/scaledp'
import { PdfToImage } from '@stabrise/scaledp/pdf'
import {
    PaddleTextRecognizer,
    isCrossOriginIsolated,
    isPresetCached,
    isWebGpuAvailable,
} from '@stabrise/scaledp/ocr'
import { GlinerNer } from '@stabrise/scaledp/ner'

const OCR_PRESET = 'v6-small'

const progressEl = document.getElementById('progress') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement
const timingsEl = document.getElementById('timings') as HTMLElement
const entitiesEl = document.getElementById('entities') as HTMLElement
const canvas = document.getElementById('canvas') as HTMLCanvasElement
const dropEl = document.getElementById('drop') as HTMLElement
const fileEl = document.getElementById('file') as HTMLInputElement
const nerEl = document.getElementById('ner') as HTMLInputElement

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
        // running log. The terminal 'ready'/'initializing' events carry no
        // filename, so fall back to the repo name.
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
    await reportCache()
}

/**
 * Report whether the OCR models are already cached.
 *
 * Worth surfacing: the cache lives in IndexedDB, which is scoped per *origin*.
 * Serving the demo on a different port is a different origin and therefore an
 * empty cache, which looks exactly like caching being broken.
 */
async function reportCache() {
    const cached = await isPresetCached(OCR_PRESET).catch(() => false)
    log(
        `OCR models (${OCR_PRESET}) at ${location.origin}: ` +
            (cached ? 'cached, no download needed' : 'not cached, first run will download')
    )
}


async function run(file: File) {
    statusEl.textContent = ''
    progressEl.textContent = ''
    timingsEl.textContent = ''
    entitiesEl.textContent = ''
    log(`processing ${file.name} (${(file.size / 1024).toFixed(0)} KB)`)

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const stages = [
        isPdf ? new PdfToImage({ resolution: 200 }) : new DataToImage(),
        new PaddleTextRecognizer({ preset: OCR_PRESET, keepFormatting: true }),
    ]
    if (nerEl.checked) {
        stages.push(
            new GlinerNer({ labels: ['person', 'organization', 'email', 'phone', 'address', 'date'] })
        )
    }

    const pipeline = new Pipeline(stages)
    const rows = await pipeline.transform(file, {
        onStage: (name, ms) => log(`${name}: ${ms.toFixed(0)}ms`),
    })

    progressEl.textContent = ''
    await render(rows[0])
    await pipeline.dispose()
}

async function render(row: Row | undefined) {
    if (!row) return log('no pages produced')

    const timing = row.execution_time as { stages: Record<string, number>; total: number }
    timingsEl.innerHTML = `<p>total ${timing.total.toFixed(0)}ms</p>`

    const document_ = row.text as { text: string; bboxes: { x: number; y: number; width: number; height: number }[]; exception: string }
    if (document_.exception) return log(`OCR failed: ${document_.exception}`)
    log(`${document_.bboxes.length} boxes, ${document_.text.length} characters`)

    const image = row.image as { data: Uint8Array }
    const bitmap = await createImageBitmap(new Blob([image.data as BlobPart]))
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    ctx.strokeStyle = 'rgba(0, 102, 204, 0.7)'
    ctx.lineWidth = 2
    for (const box of document_.bboxes) ctx.strokeRect(box.x, box.y, box.width, box.height)

    const ner = row.ner as { entities: { entity_group: string; word: string; score: number; boxes: typeof document_.bboxes }[] } | undefined
    if (!ner?.entities.length) return

    ctx.strokeStyle = 'rgba(220, 20, 60, 0.9)'
    ctx.lineWidth = 3
    const rows_ = ner.entities.map((e) => {
        for (const box of e.boxes) ctx.strokeRect(box.x, box.y, box.width, box.height)
        return `<tr><td>${e.entity_group}</td><td>${e.word}</td><td>${e.score.toFixed(3)}</td></tr>`
    })
    entitiesEl.innerHTML = `<table><tr><th>Type</th><th>Text</th><th>Score</th></tr>${rows_.join('')}</table>`
}

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
