/**
 * SPA mode with prerendering.
 *
 * `ssr: false` is not optional here: the whole point of the library is that
 * documents are processed in the tab, and half the demo's module graph reaches
 * for `OffscreenCanvas`, `ImageBitmap` and WebGPU. There is no server.
 *
 * Prerendering still runs, because every docs page has a loader that reads MDX
 * off disk -- in SPA mode those loaders must resolve at build time. The result
 * is one real HTML file per docs URL (so a deep link resolves without the SPA
 * fallback, and crawlers see content) plus the client bundle that takes over.
 */

import { glob } from 'node:fs/promises'
import type { Config } from '@react-router/dev/config'
import { createGetUrl, getSlugs } from 'fumadocs-core/source'

const getUrl = createGetUrl('/docs')

export default {
    appDirectory: 'src',
    ssr: false,
    async prerender({ getStaticPaths }) {
        // `/` and `/demo` come back from getStaticPaths; `/docs/*` is a splat,
        // so its concrete URLs have to be enumerated from the content itself.
        const paths = [...getStaticPaths()]

        for await (const entry of glob('**/*.mdx', { cwd: 'content/docs' })) {
            paths.push(getUrl(getSlugs(entry)))
        }

        return paths
    },
} satisfies Config
