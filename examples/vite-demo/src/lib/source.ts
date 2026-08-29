/**
 * The docs content collection.
 *
 * `async: true` keeps every page's compiled MDX out of the initial bundle: the
 * route loader hands back a path, and the component `use()`s the page's own
 * lazy chunk. With forty-odd pages that is the difference between a docs site
 * and a download.
 */

import { loader } from 'fumadocs-core/source'
import { defineDocs } from 'fumadocs-mdx/macro'

export const docs = defineDocs({
    dir: 'content/docs',
    docs: { async: true },
})

export const source = loader({
    source: docs.toFumadocsSource(),
    baseUrl: '/docs',
})
