/**
 * Pipelines in a URL.
 *
 * A stage page can hand the builder a working pipeline rather than a list of
 * instructions -- `/demo?p=<encoded>` opens with those stages already wired.
 * The payload is the same `StageDescriptor[]` the worker protocol sends and
 * `Export as JSON` writes, so a link is interchangeable with a saved file.
 *
 * base64url rather than a JSON query param: the descriptors contain quotes,
 * braces and `#` colour values, and percent-encoding all of that produces a
 * link that no one can read anyway and that mail clients like to break.
 *
 * Encoding is deliberately registry-free -- it is imported by every docs page
 * that carries an "Open in builder" link, and pulling in fifteen stage classes
 * to call `JSON.stringify` would be 77 kB on each of them. Validation lives in
 * `deeplink-decode.ts`, which only the builder loads.
 */

import type { StageDescriptor } from '@stabrise/scaledp/registry'

/** The query parameter a stage page or recipe sets. */
export const PIPELINE_PARAM = 'p'
/** The query parameter for a built-in preset id. */
export const PRESET_PARAM = 'preset'

export const toBase64Url = (bytes: Uint8Array): string => {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const fromBase64Url = (value: string): Uint8Array => {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function encodePipeline(descriptors: readonly StageDescriptor[]): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(descriptors)))
}

/** The href a docs page links to. */
export function builderHref(descriptors: readonly StageDescriptor[]): string {
    return `/demo?${PIPELINE_PARAM}=${encodePipeline(descriptors)}`
}
