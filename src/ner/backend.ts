/**
 * The interface both GLiNER runtimes implement.
 *
 * Keeping this narrow is what makes the GLiNER1/GLiNER2 choice a registry entry
 * rather than a rewrite, and it is where a future architecture plugs in.
 */

import type { ModelFiles } from '../core/model-cache.js'
import type { DecodedSpan } from './vendor/span-decoder.js'

export interface NerBackendLoadOptions {
    /** A `@huggingface/transformers` tokenizer instance. */
    tokenizer: unknown
    executionProviders?: readonly string[]
}

export interface NerBackend {
    readonly arch: 'gliner1' | 'gliner2'
    load(files: ModelFiles, options: NerBackendLoadOptions): Promise<void>
    /** Entities with character offsets into `text`. */
    extract(text: string, labels: readonly string[], threshold: number): Promise<DecodedSpan[]>
    dispose(): Promise<void>
}

export type { DecodedSpan }
