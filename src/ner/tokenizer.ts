/**
 * Tokenizer loading and adaptation for the GLiNER runtimes.
 *
 * `@huggingface/transformers` provides the tokenizer only; no model runs
 * through it. Its remote host is configurable so gated repos can be proxied
 * through the consuming application's own origin.
 */

import { getConfig } from '../core/config.js'
import { extractTokenIds } from './vendor/math.js'

type Transformers = typeof import('@huggingface/transformers')
type PretrainedTokenizer = Awaited<ReturnType<Transformers['AutoTokenizer']['from_pretrained']>>

let modulePromise: Promise<Transformers> | null = null

async function loadTransformers(): Promise<Transformers> {
    if (modulePromise) return modulePromise

    modulePromise = (async () => {
        let mod: Transformers
        try {
            mod = await import('@huggingface/transformers')
        } catch (cause) {
            throw new Error(
                '@huggingface/transformers is required for NER tokenization. Install it: npm i @huggingface/transformers',
                { cause }
            )
        }

        const { hf } = getConfig()
        // Tokenizers come over HTTP; nothing is resolved from the filesystem.
        mod.env.allowLocalModels = false
        if (hf.remoteHost) mod.env.remoteHost = hf.remoteHost
        if (hf.remotePathTemplate) mod.env.remotePathTemplate = hf.remotePathTemplate
        return mod
    })()

    return modulePromise
}

/** Reset the cached module. Tests only. */
export function resetTransformers(): void {
    modulePromise = null
}

const tokenizers = new Map<string, Promise<PretrainedTokenizer>>()

export async function loadTokenizer(repo: string): Promise<PretrainedTokenizer> {
    const existing = tokenizers.get(repo)
    if (existing) return existing

    const promise = (async () => {
        const { AutoTokenizer } = await loadTransformers()
        return AutoTokenizer.from_pretrained(repo)
    })()

    promise.catch(() => tokenizers.delete(repo))
    tokenizers.set(repo, promise)
    return promise
}

/** Adapt to the callable form the GLiNER2 runtime expects. */
export function toCallableTokenizer(tokenizer: PretrainedTokenizer): (text: string) => number[] {
    return (text: string) => {
        const encoded = tokenizer(text, { add_special_tokens: false }) as {
            input_ids: { tolist(): (bigint | number)[][] | (bigint | number)[] }
        }
        return extractTokenIds(encoded.input_ids.tolist())
    }
}
