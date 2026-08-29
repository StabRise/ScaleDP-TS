/**
 * The reading half of the deep-link format.
 *
 * Separate from `deeplink.ts` because it needs the registry to validate stage
 * names, and only the builder ever decodes -- a docs page just writes links.
 */

import { getStageSpec, type StageDescriptor } from '@stabrise/scaledp/registry'
import { fromBase64Url } from './deeplink'

/**
 * Decode a link, or return null.
 *
 * Applies the same guard `importJson` uses in the store: an unknown stage type
 * is rejected here rather than thrown from `createStage` mid-run. A link that
 * predates a rename is a broken link, not a broken app.
 */
export function decodePipeline(value: string): StageDescriptor[] | null {
    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(value)))
        if (!Array.isArray(parsed) || parsed.length === 0) return null

        const descriptors: StageDescriptor[] = []
        for (const entry of parsed) {
            const type = (entry as StageDescriptor | undefined)?.type
            if (typeof type !== 'string' || !getStageSpec(type)) return null
            const options = (entry as StageDescriptor).options
            descriptors.push({ type, options: options && typeof options === 'object' ? options : {} })
        }
        return descriptors
    } catch {
        return null
    }
}
