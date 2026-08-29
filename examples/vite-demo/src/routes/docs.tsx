/**
 * Every documentation page.
 *
 * The loader runs at build time (SPA mode prerenders it), so `source.getPage`
 * reads the MDX off disk once per URL and the browser never ships the page
 * tree logic. The compiled body is a separate lazy chunk -- `docs` is an async
 * collection -- which is what keeps forty pages from becoming one bundle.
 */

import { useFumadocsLoader } from 'fumadocs-core/source/client'
import { DocsLayout } from 'fumadocs-ui/layouts/notebook'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/notebook/page'
import { use } from 'react'
import { useMDXComponents } from '../components/mdx'
import { baseOptions } from '../lib/layout.shared'
import { SITE_NAME } from '../lib/site'
import { docs, source } from '../lib/source'
import type { Route } from './+types/docs'

export async function loader({ params }: Route.LoaderArgs) {
    const slugs = params['*'].split('/').filter((segment) => segment.length > 0)
    const page = source.getPage(slugs)
    if (!page) throw new Response('Not found', { status: 404 })

    // Warm the page's own chunk before the component renders. Without this the
    // body suspends -- which at build time means the prerendered HTML carries
    // the shell, the sidebar and the title but not a word of the page, and in
    // the browser means a flash of empty article on every navigation.
    await docs.getPage(page.path)?.preload()

    return {
        path: page.path,
        pageTree: await source.serializePageTree(source.getPageTree()),
    }
}

function Content({ path }: { path: string }) {
    const page = docs.getPage(path)
    if (!page) throw new Error(`unknown page: ${path}`)

    const { toc } = use(page.load())
    const Mdx = page.body

    return (
        <DocsPage toc={toc}>
            <title>{`${page.title} — ${SITE_NAME}`}</title>
            <meta name="description" content={page.description} />
            <DocsTitle>{page.title}</DocsTitle>
            <DocsDescription>{page.description}</DocsDescription>
            <DocsBody>
                <Mdx components={useMDXComponents()} />
            </DocsBody>
        </DocsPage>
    )
}

export default function Page({ loaderData }: Route.ComponentProps) {
    const { pageTree, path } = useFumadocsLoader(loaderData)

    // `nav.mode: 'top'` is what makes the header span the page instead of
    // sitting inside the sidebar: the same bar, in the same place, on every
    // route. The default ('auto') hides it on wide screens.
    const options = baseOptions()

    return (
        <DocsLayout {...options} nav={{ ...options.nav, mode: 'top' }} tree={pageTree}>
            <Content path={path} />
        </DocsLayout>
    )
}
