/** Shared tokenizer adaptation, kept separate so backends need not import the loader. */

import { NerError } from '../core/errors.js'
import { extractTokenIds } from './vendor/math.js'
import type { SpanTokenizer } from './vendor/span-processor.js'

export type PretrainedTokenizerLike = (
    text: string,
    options?: { add_special_tokens?: boolean }
) => { input_ids: { tolist(): (bigint | number)[][] | (bigint | number)[] } }

/**
 * Adapt a transformers.js tokenizer to the span processor's interface.
 *
 * CLS/SEP ids are derived empirically -- encode a throwaway token, read the
 * first and last id -- rather than read from `cls_token_id`. Not every GLiNER
 * repo populates those fields, and a wrong id corrupts every sequence silently
 * instead of failing loudly.
 */
export function toSpanTokenizer(tokenizer: PretrainedTokenizerLike): SpanTokenizer {
    const encode = (text: string): number[] =>
        extractTokenIds(tokenizer(text, { add_special_tokens: true }).input_ids.tolist())

    const probe = encode('x')
    if (probe.length < 2) {
        throw new NerError(
            'Tokenizer produced no special tokens; cannot derive CLS/SEP ids',
            'toSpanTokenizer'
        )
    }
    return { encode, clsTokenId: probe[0] as number, sepTokenId: probe[probe.length - 1] as number }
}
