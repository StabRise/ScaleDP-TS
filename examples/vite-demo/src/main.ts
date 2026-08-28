import { DataToImage, ImageDrawBoxes, Pipeline, configure, isCached, type Row } from '@stabrise/scaledp'
import {
    renderInto,
    showBoxes,
    showImage,
    showNer,
    showText,
    visualizeNer,
} from '@stabrise/scaledp/display'
import {
    DEFAULT_NER_MODEL_ID,
    GlinerNer,
    NER_MODELS,
    getNerModel,
    modelSizeBytes,
} from '@stabrise/scaledp/ner'
import {
    DEFAULT_OCR_PRESET,
    PADDLE_OCR_PRESETS,
    PaddleTextRecognizer,
    isKnownPreset,
    isCrossOriginIsolated,
    isPresetCached,
    isWebGpuAvailable,
} from '@stabrise/scaledp/ocr'
import { PdfToImage } from '@stabrise/scaledp/pdf'

import type { Document, NerOutput, ScaleDpImage } from '@stabrise/scaledp/display'


const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const progressEl = el('progress')
const statusEl = el('status')
const timingsEl = el('timings')
const dropEl = el('drop')
const fileEl = el<HTMLInputElement>('file')
const nerEl = el<HTMLInputElement>('ner')
const ocrModelEl = el<HTMLSelectElement>('ocrModel')
const nerModelEl = el<HTMLSelectElement>('nerModel')
const ocrCacheEl = el('ocrCache')
const nerCacheEl = el('nerCache')
const labelsEl = el<HTMLInputElement>('labels')
const labelsRow = el('labelsRow')
const labelsHint = el('labelsHint')
const resetLabelsEl = el<HTMLButtonElement>('resetLabels')
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
    populateModelPickers()
    await refreshCacheStatus()
}

/** Remember the chosen models across reloads. */
const remember = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Private windows can refuse storage; the picker still works.
    }
}
const recall = (key: string, fallback: string): string => {
    try {
        return localStorage.getItem(key) ?? fallback
    } catch {
        return fallback
    }
}

function populateModelPickers() {
    for (const preset of PADDLE_OCR_PRESETS) {
        const option = new Option(preset.label, preset.value)
        option.title = preset.scripts.join(', ')
        ocrModelEl.add(option)
    }
    const rememberedPreset = recall('ocrModel', DEFAULT_OCR_PRESET)
    ocrModelEl.value = isKnownPreset(rememberedPreset) ? rememberedPreset : DEFAULT_OCR_PRESET

    for (const model of NER_MODELS) {
        const size = Math.round(modelSizeBytes(model) / 1e6)
        const option = new Option(
            `${model.name} - ${model.languages.join('/')}${model.private ? ' [private]' : ''}`,
            model.id
        )
        // Private repos need configure({ auth }); this demo supplies none, so
        // offering them would only produce a confusing 401 mid-pipeline.
        option.disabled = model.private === true
        option.title = `${model.arch}, ${size} MB, ${model.repo}`
        nerModelEl.add(option)
    }
    // A remembered id can go stale -- the model may have been removed from the
    // registry, or become private since it was chosen. Fall back rather than
    // failing mid-pipeline.
    const remembered = recall('nerModel', DEFAULT_NER_MODEL_ID)
    const usable = getNerModel(remembered)
    nerModelEl.value = usable && !usable.private ? remembered : DEFAULT_NER_MODEL_ID
    applyModelLabels()
}

/**
 * Default the labels to the set the selected model was tuned on. GLiNER scores
 * a label by its prompt text, so the GLiNER2 model in particular drops accuracy
 * against any other wording.
 */
function applyModelLabels() {
    const model = getNerModel(nerModelEl.value)
    labelsEl.value = (model?.labels ?? []).join(', ')
}

const currentLabels = (): string[] =>
    labelsEl.value
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean)

/**
 * Report whether each selected model is already cached.
 *
 * The cache is scoped per origin, port included, so a dev server that moved to
 * a different port has an empty cache and looks like caching is broken.
 */
async function refreshCacheStatus() {
    const preset = ocrModelEl.value
    const ocrCached = await isPresetCached(preset).catch(() => false)
    ocrCacheEl.textContent = ocrCached ? 'cached' : 'will download on first run'
    ocrCacheEl.className = `hint ${ocrCached ? 'ok' : 'warn'}`

    const model = getNerModel(nerModelEl.value)
    if (!model) {
        nerCacheEl.textContent = ''
        return
    }
    const size = Math.round(modelSizeBytes(model) / 1e6)
    const nerCached = await isCached({ repo: model.repo, files: model.files }).catch(() => false)
    nerCacheEl.textContent = nerCached ? 'cached' : `will download ~${size} MB on first run`
    nerCacheEl.className = `hint ${nerCached ? 'ok' : 'warn'}`
}

function syncNerControls() {
    nerModelEl.disabled = !nerEl.checked
    labelsRow.hidden = !nerEl.checked
    labelsHint.hidden = !nerEl.checked
}

ocrModelEl.addEventListener('change', () => {
    remember('ocrModel', ocrModelEl.value)
    void refreshCacheStatus()
})
nerModelEl.addEventListener('change', () => {
    remember('nerModel', nerModelEl.value)
    applyModelLabels()
    void refreshCacheStatus()
})
nerEl.addEventListener('change', syncNerControls)
resetLabelsEl.addEventListener('click', applyModelLabels)

async function run(file: File) {
    statusEl.textContent = ''
    progressEl.textContent = ''
    for (const panel of Object.values(panels)) panel.hidden = true

    log(`processing ${file.name} (${(file.size / 1024).toFixed(0)} KB)`)
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

    const stages = [
        isPdf ? new PdfToImage({ resolution: 200 }) : new DataToImage(),
        new PaddleTextRecognizer({ preset: ocrModelEl.value, keepFormatting: true }),
    ]
    if (nerEl.checked) {
        const labels = currentLabels()
        if (labels.length === 0) throw new Error('NER needs at least one label')
        stages.push(new GlinerNer({ model: nerModelEl.value, labels }))
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
    await refreshCacheStatus()
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

syncNerControls()
void setup()
