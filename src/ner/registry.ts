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

export const NER_MODELS: readonly NerModel[] = Object.freeze([
    {
        id: 'gliner-multi-pii',
        name: 'GLiNER multilingual PII, int8 (~333 MB)',
        arch: 'gliner1',
        repo: 'onnx-community/gliner_multi_pii-v1',
        files: [
            { path: 'gliner_config.json', approxBytes: 800 },
            { path: 'onnx/model_int8.onnx', approxBytes: 349_000_000 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['multi'],
    },
    {
        id: 'gliner-small',
        name: 'GLiNER small English, int8 (~183 MB)',
        arch: 'gliner1',
        repo: 'onnx-community/gliner_small-v2.1',
        files: [
            { path: 'gliner_config.json', approxBytes: 731 },
            { path: 'onnx/model_quantized.onnx', approxBytes: 183_403_734 },
        ],
        labels: DEFAULT_PII_LABELS,
        languages: ['en'],
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
