/**
 * Registry of NER models that can run locally in the browser.
 *
 * Adding a model is a single entry here; the runtimes dispatch on `arch`.
 *
 * The default is deliberately a *public* model, so `npm i` works with no
 * configuration. StabRise's own PII models are private and stay opt-in: pass
 * their id and supply `configure({ auth })` to provide a token.
 */

import type { ModelFile } from '../core/model-cache.js'

export type NerArchitecture = 'gliner1' | 'gliner2'

export interface NerModel {
    /** Short id callers pass to GlinerNer. */
    id: string
    /** Human-readable name including the download size. */
    name: string
    arch: NerArchitecture
    /** Hugging Face repo id. */
    repo: string
    files: ModelFile[]
    /** Labels this model was tuned for. Using others still works, less well. */
    labels: readonly string[]
    languages: readonly string[]
    /** Private repos need `configure({ auth })` to supply a bearer token. */
    private?: boolean
    /** Execution providers this model requires; overrides the global config. */
    executionProviders?: readonly string[]
}

/** Generic PII labels, matching the pdftools prototype's default set. */
export const DEFAULT_PII_LABELS: readonly string[] = Object.freeze([
    'person',
    'organization',
    'location',
    'email',
    'phone_number',
    'url',
    'id',
    'account_number',
    'zip_code',
    'address',
    'ip_address',
    'date',
    'ssn',
    'driver_license',
    'passport',
    'age',
    'credit_card',
    'medical_condition',
])

/**
 * Label prompts the StabRise GLiNER2 PII model was fine-tuned on.
 *
 * These must match the cloud endpoint's tag list (scaledp-api
 * deidentify/views.py) or scores drop: GLiNER scores a label by its prompt
 * text, so a renamed label is a different label.
 */
export const GLINER2_PII_LABELS: readonly string[] = Object.freeze([
    'date',
    'person_name',
    'person_title',
    'organization',
    'location',
    'email',
    'phone',
    'id',
    'account',
    'zip_code',
    'address',
    'ip',
    'url',
    'ssn',
    'driver_license',
    'passport',
    'age',
    'credit_card',
    'medical_condition',
    'technology',
])

/**
 * The catalogue.
 *
 * Every entry is fp16, and deliberately so. These are all DeBERTa-based GLiNER
 * models, and 8-bit quantization wrecks their score calibration: on the same
 * sentence the fp16 multilingual PII model scores "John Smith" as a person at
 * 1.00, a card number at 0.99 and a date at 1.00, while its int8 build of the
 * same weights gives 0.38, 0.37 and 0.16 -- every one of them under the default
 * 0.5 threshold, so the stage returns nothing at all. The int8 build of
 * `gliner_medium-v2.1` is worse still: fourteen junk spans, none above 0.05.
 * The spans themselves decode correctly in every case; it is only the scores
 * that collapse. fp16 costs roughly 1.7x the download and matches fp32 exactly.
 */
export const NER_MODELS: readonly NerModel[] = Object.freeze([
    {
        id: 'gliner-multi-pii',
        name: 'GLiNER multilingual PII, fp16 (~580 MB)',
        arch: 'gliner1',
        repo: 'onnx-community/gliner_multi_pii-v1',
        files: [
            { path: 'gliner_config.json', approxBytes: 732 },
            { path: 'onnx/model_fp16.onnx', approxBytes: 579_717_643 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['multi'],
    },
    {
        // Token-level rather than span-enumeration: it emits a start, an end and
        // an "inside" score per word per label instead of one score per
        // enumerated span, so it decodes through `decodeTokenSpans`.
        //
        // Served at full precision because it is small enough to afford it --
        // 181 MB, half the fp16 default -- which sidesteps the quantization
        // question entirely. On a 32M-parameter encoder it is the cheapest PII
        // model here by a wide margin, at some cost in recall: it is sharp on
        // card numbers and dates but weaker on names than the multilingual PII
        // model, more so the more labels compete for the same span.
        id: 'gliner-pii-edge',
        name: 'GLiNER PII edge, fp32 (~181 MB)',
        arch: 'gliner1',
        repo: 'knowledgator/gliner-pii-edge-v1.0',
        files: [
            { path: 'gliner_config.json', approxBytes: 2_000 },
            { path: 'onnx/model.onnx', approxBytes: 181_000_000 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['multi'],
    },
    {
        id: 'gliner-small',
        name: 'GLiNER small English, fp16 (~306 MB)',
        arch: 'gliner1',
        repo: 'onnx-community/gliner_small-v2.1',
        files: [
            { path: 'gliner_config.json', approxBytes: 731 },
            { path: 'onnx/model_fp16.onnx', approxBytes: 306_253_040 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['en'],
    },
    {
        id: 'gliner-multi',
        name: 'GLiNER multilingual, fp16 (~580 MB)',
        arch: 'gliner1',
        repo: 'onnx-community/gliner_multi-v2.1',
        files: [
            { path: 'gliner_config.json', approxBytes: 731 },
            { path: 'onnx/model_fp16.onnx', approxBytes: 579_717_643 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['multi'],
    },
    {
        // Same GLiNER1 span-enumeration architecture and ONNX I/O as the models
        // above, on an LFM2.5-350M backbone converted to bidirectional. Its ONNX
        // file sits at the repo root, not under onnx/.
        id: 'stabrise-pii-multi',
        name: 'StabRise PII multilingual, int8 (~404 MB)',
        arch: 'gliner1',
        repo: 'StabRise/pii-detection-en-fr-ge-it-es',
        files: [
            { path: 'config.json', approxBytes: 3_417 },
            { path: 'model_int8.model', approxBytes: 403_923_207 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['en', 'fr', 'de', 'it', 'es'],
        private: true,
    },
    {
        // Opt-in only. The published weights are fp32 and total roughly 1.2 GB,
        // which is not a reasonable browser download; there is no int8 or q4
        // variant on the Hub. Available for desktop-wrapped or kiosk builds.
        //
        // Pinned to WASM: onnxruntime-web's WebGPU backend silently drops
        // entities on this architecture. GLiNER2's dynamic span-gather and
        // count_embed ops fall back to CPU mid-graph, and the resulting
        // CPU/WebGPU partition boundary corrupts results rather than erroring.
        id: 'stabrise-pii-multi-g2',
        name: 'StabRise PII multilingual GLiNER2, fp32 (~1.2 GB)',
        arch: 'gliner2',
        repo: 'StabRise/pii-multi-g2-v1-onnx',
        files: [
            { path: 'config.json', approxBytes: 48 },
            { path: 'gliner2_config.json', approxBytes: 691 },
            { path: 'onnx/encoder.onnx', approxBytes: 1_111_055_946 },
            { path: 'onnx/span_rep.onnx', approxBytes: 66_111_424 },
            { path: 'onnx/count_embed.onnx', approxBytes: 42_506_885 },
        ],
        labels: GLINER2_PII_LABELS,
        languages: ['en', 'de', 'pl', 'es'],
        private: true,
        executionProviders: ['wasm'],
    },
])

/** Public, zero-configuration default. */
export const DEFAULT_NER_MODEL_ID = 'gliner-multi-pii'

export function getNerModel(id: string): NerModel | undefined {
    return NER_MODELS.find((m) => m.id === id)
}

/** Total download size in bytes, for a progress estimate before fetching. */
export function modelSizeBytes(model: NerModel): number {
    return model.files.reduce((sum, f) => sum + (f.approxBytes ?? 0), 0)
}
