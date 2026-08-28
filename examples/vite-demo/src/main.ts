import {
    DataToImage,
    ImageDrawBoxes,
    Pipeline,
    configure,
    isCached,
    type Row,
} from '@stabrise/scaledp'
import {
    renderInto,
    showBoxes,
    showImage,
    showNer,
    showText,
    visualizeNer,
} from '@stabrise/scaledp/display'
import type {
    DetectorOutput,
    Document,
    NerOutput,
    ScaleDpImage,
} from '@stabrise/scaledp/display'
import {
    DEFAULT_NER_MODEL_ID,
    GlinerNer,
    NER_MODELS,
    getNerModel,
    modelSizeBytes,
} from '@stabrise/scaledp/ner'
import {
    DEFAULT_DETECTOR_ID,
    DEFAULT_OCR_PRESET,
    DETECTOR_MODELS,
    DEFAULT_ORIENTATION_MODEL,
    DbnetOnnxDetector,
    LineOrientationDetector,
    PADDLE_OCR_PRESETS,
    PaddleTextDetector,
    PaddleTextRecognizer,
    isCrossOriginIsolated,
    isKnownPreset,
    getDetectorModel,
    isPresetCached,
    isWebGpuAvailable,
} from '@stabrise/scaledp/ocr'
import { PdfToImage } from '@stabrise/scaledp/pdf'

/** Kept in step with --detect and --entity in style.css. */
const BOX_COLOR = '#3fc9f5'
const ENTITY_COLOR = '#ff5c8a'
/** A separate detector's boxes, so they can be told from the recognizer's. */
const DETECT_COLOR = '#9d8cff'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const capsEl = el('caps')
const platenEl = el<HTMLButtonElement>('drop')
const dropLabel = el('dropLabel')
const dropHint = el('dropHint')
const fileEl = el<HTMLInputElement>('file')
const noteEl = el('note')

const ocrModelEl = el<HTMLSelectElement>('ocrModel')
const nerModelEl = el<HTMLSelectElement>('nerModel')
const detModelEl = el<HTMLSelectElement>('detModel')
const detCacheEl = el('detCache')
const orientEl = el<HTMLInputElement>('orient')
const orientCacheEl = el('orientCache')
const ocrCacheEl = el('ocrCache')
const nerCacheEl = el('nerCache')
const nerEl = el<HTMLInputElement>('ner')
const labelsEl = el<HTMLInputElement>('labels')
const labelsRow = el('labelsRow')
const resetLabelsEl = el<HTMLButtonElement>('resetLabels')

const traceEl = el('trace')
const traceList = el<HTMLOListElement>('traceList')
const traceTotal = el('traceTotal')

const resultsEl = el('results')
const pageMetaEl = el('pageMeta')
const textMetaEl = el('textMeta')
const tabEntities = el('tabEntities')
const tabDetect = el('tabDetect')
const detNoteEl = el('detNote')
const rerunRow = el('rerunRow')
const rerunEl = el<HTMLButtonElement>('rerun')
const rerunNote = el('rerunNote')
const copyEl = el<HTMLButtonElement>('copy')
const wrapEl = el<HTMLInputElement>('wrap')

/** Errors say what happened; the interface never apologises. */
const note = (message: string) => {
    noteEl.textContent = message
}

function capability(label: string, on: boolean) {
    const chip = document.createElement('span')
    chip.className = 'cap'
    chip.dataset.on = String(on)
    chip.textContent = label
    capsEl.append(chip)
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
        onProgress: ({ repo, file, loaded, total, phase }) => {
            if (phase === 'ready') {
                dropHint.textContent = 'PDF or image · click to browse'
                return
            }
            // Some catalogues use absolute URLs as file paths, so show the
            // filename rather than dumping a signed CDN URL into the interface.
            const what = (file || repo).split('/').pop() ?? repo
            dropHint.textContent =
                total > 0
                    ? `${phase} ${what} — ${Math.round((loaded / total) * 100)}%`
                    : `${phase} ${what}…`
        },
    })

    capability(webgpu ? 'webgpu' : 'wasm', true)
    capability('cross-origin isolated', isCrossOriginIsolated())

    populateModelPickers()
    await refreshCacheStatus()
}

/** Remember the chosen models across reloads. */
const remember = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Private windows can refuse storage; the pickers still work.
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
            `${model.name} · ${model.languages.join('/')}${model.private ? ' · private' : ''}`,
            model.id
        )
        // Private repos need configure({ auth }); this demo supplies none, so
        // offering them would only produce a 401 mid-pipeline.
        option.disabled = model.private === true
        option.title = `${model.arch}, ${size} MB, ${model.repo}`
        nerModelEl.add(option)
    }

    for (const detector of DETECTOR_MODELS) {
        const option = new Option(detector.name, detector.id)
        option.title = detector.notes
        detModelEl.add(option)
    }
    const rememberedDet = recall('detModel', DEFAULT_DETECTOR_ID)
    detModelEl.value = getDetectorModel(rememberedDet) ? rememberedDet : DEFAULT_DETECTOR_ID

    // A remembered id can go stale -- removed from the registry, or private
    // since it was chosen. Fall back rather than failing mid-pipeline.
    const remembered = recall('nerModel', DEFAULT_NER_MODEL_ID)
    const usable = getNerModel(remembered)
    nerModelEl.value = usable && !usable.private ? remembered : DEFAULT_NER_MODEL_ID
    applyModelLabels()
}

/**
 * Default the labels to the set the selected model was tuned on. GLiNER scores
 * a label by its prompt text, so other wording asks a different question.
 */
function applyModelLabels() {
    labelsEl.value = (getNerModel(nerModelEl.value)?.labels ?? []).join(', ')
}

const currentLabels = (): string[] =>
    labelsEl.value
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean)

function setState(node: HTMLElement, text: string, ready: boolean) {
    node.textContent = text
    node.dataset.state = ready ? 'ready' : 'pending'
}

/**
 * Report whether each selected model is already cached.
 *
 * The cache is scoped per origin, port included, so a dev server that moved to
 * a different port has an empty cache and looks like caching is broken.
 */
async function refreshCacheStatus() {
    const cached = await isPresetCached(ocrModelEl.value).catch(() => false)
    setState(ocrCacheEl, cached ? 'cached' : 'downloads on first run', cached)

    const detector = getDetectorModel(detModelEl.value)
    if (detector?.repo) {
        const detCached = await isCached({
            repo: detector.repo,
            files: [{ path: 'model.onnx', approxBytes: detector.approxBytes }],
        }).catch(() => false)
        const size = Math.round((detector.approxBytes ?? 0) / 1e6)
        setState(detCacheEl, detCached ? 'cached' : `downloads ${size} MB on first run`, detCached)
    } else {
        // The Paddle detector is part of the preset already accounted for above.
        setState(detCacheEl, 'included in the OCR preset', true)
    }

    const orientCached = await isCached({
        repo: DEFAULT_ORIENTATION_MODEL,
        files: [{ path: 'model.onnx', approxBytes: 9_000_000 }],
    }).catch(() => false)
    setState(orientCacheEl, orientCached ? 'cached' : 'downloads ~9 MB on first run', orientCached)

    const model = getNerModel(nerModelEl.value)
    if (!model) return
    const size = Math.round(modelSizeBytes(model) / 1e6)
    const nerCached = await isCached({ repo: model.repo, files: model.files }).catch(() => false)
    setState(nerCacheEl, nerCached ? 'cached' : `downloads ${size} MB on first run`, nerCached)
}

/**
 * Orientation correction consumes boxes, so it needs a standalone detector.
 * Say so rather than silently doing nothing.
 */
function syncOrientHint() {
    const needsDetector = orientEl.checked && detModelEl.value === DEFAULT_DETECTOR_ID
    orientCacheEl.dataset.state = needsDetector ? 'pending' : orientCacheEl.dataset.state ?? 'ready'
    if (needsDetector) orientCacheEl.textContent = 'pick a detector above to enable'
    else void refreshCacheStatus()
}

function syncNerControls() {
    nerModelEl.disabled = !nerEl.checked
    labelsRow.hidden = !nerEl.checked
}

async function run(file: File) {
    note('')
    traceEl.hidden = true
    traceList.replaceChildren()
    resultsEl.hidden = true

    rerunEl.disabled = true
    platenEl.classList.add('is-reading')
    dropLabel.textContent = file.name
    dropHint.textContent = `${(file.size / 1024).toFixed(0)} KB · reading`

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const detector = getDetectorModel(detModelEl.value)
    const stages = [isPdf ? new PdfToImage({ resolution: 200 }) : new DataToImage()]

    // A standalone detector runs alongside the recognizer rather than feeding it:
    // PaddleTextRecognizer detects internally as one pass. Showing both lets you
    // compare what a detector finds against what the recognizer acted on, which
    // is the reason to pick one in the first place.
    if (detector?.kind === 'dbnet-onnx' && detector.repo) {
        stages.push(new DbnetOnnxDetector({ model: detector.repo, outputCol: 'detected' }))
    } else if (detector?.kind === 'paddle' && detModelEl.value !== DEFAULT_DETECTOR_ID) {
        stages.push(new PaddleTextDetector({ preset: ocrModelEl.value, outputCol: 'detected' }))
    }

    // Correcting orientation needs boxes, so it sits between a detector and the
    // recognizer -- and therefore needs a standalone detector to have run.
    const canOrient = orientEl.checked && stages.some((s) => s.name.includes('Detector'))
    if (canOrient) {
        stages.push(
            new LineOrientationDetector({
                inputCols: ['image', 'detected'],
                // The library defaults to rotated boxes only, as ScaleDP does.
                // Here the point is to exercise the check, and the note below
                // reports how many regions were turned so its accuracy is
                // visible rather than assumed.
                onlyRotated: false,
            })
        )
    }

    stages.push(
        new PaddleTextRecognizer({
            inputCol: canOrient ? 'oriented' : 'image',
            preset: ocrModelEl.value,
            keepFormatting: true,
        })
    )
    if (nerEl.checked) {
        const labels = currentLabels()
        if (labels.length === 0) throw new Error('Add at least one label before running NER.')
        stages.push(new GlinerNer({ model: nerModelEl.value, labels }))
    }
    // Annotating the page is a pipeline stage, as in ScaleDP: the result is just
    // another image column. Two passes rather than one, so the page speaks the
    // same false-colour language as the interface -- cyan for what was detected,
    // magenta for what was understood. A single stage takes one colour for every
    // source, and colouring by box text gives each distinct word its own hue,
    // which on a page of unique words is just noise.
    stages.push(
        new ImageDrawBoxes({
            inputCols: ['image', 'text'],
            outputCol: 'annotated',
            color: BOX_COLOR,
            lineWidth: 2,
        })
    )
    if (detector?.kind === 'dbnet-onnx') {
        stages.push(
            new ImageDrawBoxes({
                inputCols: ['annotated', 'detected'],
                outputCol: 'annotated',
                color: DETECT_COLOR,
                lineWidth: 2,
                padding: 3,
            })
        )
    }
    if (nerEl.checked) {
        stages.push(
            new ImageDrawBoxes({
                inputCols: ['annotated', 'ner'],
                outputCol: 'annotated',
                color: ENTITY_COLOR,
                lineWidth: 3,
                padding: 2,
                displayDataList: ['entity_group'],
            })
        )
    }

    const timings: { name: string; ms: number }[] = []
    const pipeline = new Pipeline(stages)
    try {
        const rows = await pipeline.transform(file, {
            onStage: (name, ms) => timings.push({ name, ms }),
        })
        renderTrace(timings, rows[0])
        render(rows[0])
    } finally {
        platenEl.classList.remove('is-reading')
        dropHint.textContent = 'PDF or image · click to browse'
        rerunEl.disabled = false
        rerunRow.hidden = false
        clearStale()
        await pipeline.dispose()
        await refreshCacheStatus()
    }
}

/** Each bar is the stage's measured share of total time. */
function renderTrace(timings: { name: string; ms: number }[], row: Row | undefined) {
    const total = timings.reduce((sum, t) => sum + t.ms, 0) || 1
    traceList.replaceChildren()

    // A pipeline can run the same stage twice -- two ImageDrawBoxes passes, one
    // per colour -- so number the repeats rather than showing two identical rows.
    const seen = new Map<string, number>()
    const occurrences = new Map<string, number>()
    for (const { name } of timings) occurrences.set(name, (occurrences.get(name) ?? 0) + 1)

    for (const { name, ms } of timings) {
        const nth = (seen.get(name) ?? 0) + 1
        seen.set(name, nth)
        const shown = (occurrences.get(name) ?? 1) > 1 ? `${name} (${nth})` : name

        const li = document.createElement('li')
        const label = document.createElement('span')
        label.className = 'trace__name'
        const bar = document.createElement('span')
        bar.className = 'trace__bar'
        bar.style.width = `${Math.max(2, (ms / total) * 100)}%`
        const text = document.createElement('span')
        text.className = 'trace__text'
        text.textContent = shown
        label.append(bar, text)

        const value = document.createElement('span')
        value.className = 'trace__ms'
        value.textContent = `${ms.toFixed(0)} ms`

        li.append(label, value)
        traceList.append(li)
    }

    const wall = (row?.execution_time as { total: number } | undefined)?.total ?? total
    traceTotal.textContent = `${wall.toFixed(0)} ms total`
    traceEl.hidden = false
}

function render(row: Row | undefined) {
    if (!row) return note('No pages were produced. Try another file.')

    const document_ = row.text as Document
    if (document_.exception) return note(document_.exception)

    resultsEl.hidden = false

    renderInto('#text', showText(document_))
    textMetaEl.textContent = `${document_.text.length} chars · ${document_.text.split('\n').length} lines`

    renderInto('#boxes', showBoxes(document_, 200))

    const annotated = (row.annotated ?? row.image) as ScaleDpImage | undefined
    if (annotated) {
        renderInto('#image', showImage(annotated))
        pageMetaEl.textContent = `${annotated.width}×${annotated.height} · ${document_.bboxes.length} boxes`
    }

    const orientations = row.orientations as string[] | undefined
    if (orientations) {
        const flipped = orientations.filter((o) => o === '180_degree').length
        note(
            flipped > 0
                ? `Line orientation: ${flipped} of ${orientations.length} regions turned 180°.`
                : `Line orientation: all ${orientations.length} regions upright.`
        )
    }

    const detected = row.detected as DetectorOutput | undefined
    tabDetect.hidden = !detected
    if (detected) {
        if (detected.exception) {
            detNoteEl.textContent = detected.exception
            renderInto('#detBoxes', document.createTextNode(''))
        } else {
            const name = getDetectorModel(detModelEl.value)?.name ?? detModelEl.value
            detNoteEl.textContent =
                `${name} — ${detected.bboxes.length} boxes, ` +
                `against ${document_.bboxes.length} from the recognizer`
            renderInto('#detBoxes', showBoxes(detected, 200))
        }
    }

    const ner = row.ner as NerOutput | undefined
    const hasEntities = Boolean(ner && ner.entities.length > 0)
    tabEntities.hidden = !hasEntities
    if (ner && hasEntities) {
        renderInto('#entities', showNer(ner, { limit: 0 }))
        renderInto('#nerText', visualizeNer(document_, ner))
    }
    showPanel(hasEntities ? 'entities' : 'text')
}

function showPanel(name: string) {
    for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
        tab.classList.toggle('is-on', tab.dataset.panel === name)
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
        panel.classList.toggle('is-on', panel.dataset.panel === name)
    }
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

/**
 * The file most recently read, kept so a model change can be applied to it
 * without asking for the file again. Held in memory only -- it is never written
 * anywhere, which is the whole point of the library.
 */
let lastFile: File | null = null

const accept = (file: File | undefined) => {
    if (!file) return
    lastFile = file
    void run(file).catch((error: Error) => note(error.message))
}

/**
 * Mark the result on screen as out of date.
 *
 * Changing a model does not re-run on its own: re-reading is seconds of work
 * and, for a model not yet cached, hundreds of megabytes. Surfacing the choice
 * is better than making it silently.
 */
function markStale(what: string) {
    if (!lastFile) return
    rerunRow.classList.add('is-stale')
    rerunNote.textContent = `${what} changed — run again to apply`
}

function clearStale() {
    rerunRow.classList.remove('is-stale')
    rerunNote.textContent = lastFile ? `last read ${lastFile.name}` : ''
}

rerunEl.addEventListener('click', () => {
    if (!lastFile) return
    void run(lastFile).catch((error: Error) => note(error.message))
})

platenEl.addEventListener('click', () => fileEl.click())
fileEl.addEventListener('change', () => {
    const file = fileEl.files?.[0]
    // Clear the input, or picking the same file again fires no change event and
    // nothing happens -- which reads as the app ignoring the click.
    fileEl.value = ''
    accept(file)
})

for (const event of ['dragenter', 'dragover'] as const) {
    platenEl.addEventListener(event, (e) => {
        e.preventDefault()
        platenEl.classList.add('is-over')
    })
}
for (const event of ['dragleave', 'dragend'] as const) {
    platenEl.addEventListener(event, () => platenEl.classList.remove('is-over'))
}
platenEl.addEventListener('drop', (e) => {
    e.preventDefault()
    platenEl.classList.remove('is-over')
    accept(e.dataTransfer?.files?.[0])
})

for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel as string))
}

ocrModelEl.addEventListener('change', () => {
    remember('ocrModel', ocrModelEl.value)
    markStale('OCR model')
    void refreshCacheStatus()
})
detModelEl.addEventListener('change', () => {
    remember('detModel', detModelEl.value)
    markStale('Detector')
    syncOrientHint()
    void refreshCacheStatus()
})
nerModelEl.addEventListener('change', () => {
    remember('nerModel', nerModelEl.value)
    applyModelLabels()
    markStale('NER model')
    void refreshCacheStatus()
})
nerEl.addEventListener('change', () => {
    syncNerControls()
    markStale('NER')
})
orientEl.addEventListener('change', () => {
    syncOrientHint()
    markStale('Orientation')
})
labelsEl.addEventListener('input', () => markStale('Labels'))
resetLabelsEl.addEventListener('click', () => {
    applyModelLabels()
    markStale('Labels')
})

copyEl.addEventListener('click', async () => {
    await navigator.clipboard.writeText(el('text').textContent ?? '')
    copyEl.textContent = 'Copied'
    setTimeout(() => {
        copyEl.textContent = 'Copy text'
    }, 1200)
})

wrapEl.addEventListener('change', () => {
    const pre = el('text').querySelector('pre')
    if (pre) pre.style.whiteSpace = wrapEl.checked ? 'pre-wrap' : 'pre'
})

syncNerControls()
void setup().then(syncOrientHint)
