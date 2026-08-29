/**
 * Search runs in the reader's browser.
 *
 * There is no server on this site, so `/api/search` is not a query endpoint --
 * it is a prerendered Orama index, served whole. `staticClient` downloads it
 * once and searches it locally; the stock dialog's default client would GET
 * `/api/search?query=...`, get the entire index back where it expected a result
 * array, and throw. Same reason the documents are processed in the tab: nothing
 * here needs a backend.
 *
 * Built from the dialog primitives rather than `DefaultSearchDialog`, because
 * choosing the client is what its deprecated `type` prop used to do.
 */

import { useDocsSearch } from 'fumadocs-core/search/client'
import { staticClient } from 'fumadocs-core/search/client/orama-static'
import {
    SearchDialog as Dialog,
    SearchDialogClose,
    SearchDialogContent,
    SearchDialogHeader,
    SearchDialogIcon,
    SearchDialogInput,
    SearchDialogList,
    SearchDialogOverlay,
    type SharedProps,
} from 'fumadocs-ui/components/dialog/search'
import { useMemo } from 'react'

/** Somewhere to go before anything has been typed. */
const LINKS: [string, string][] = [
    ['Quickstart', '/docs/quickstart'],
    ['Stage reference', '/docs/stages'],
    ['Recipes', '/docs/recipes/ocr-a-scanned-pdf'],
    ['Try it in the builder', '/demo'],
]

export default function SearchDialog(props: SharedProps) {
    const client = useMemo(() => staticClient({ from: '/api/search' }), [])
    const { search, setSearch, query } = useDocsSearch({ client })

    const defaults = useMemo(
        () => LINKS.map(([content, url]) => ({ type: 'page' as const, id: content, content, url })),
        []
    )

    return (
        <Dialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
            <SearchDialogOverlay />
            <SearchDialogContent>
                <SearchDialogHeader>
                    <SearchDialogIcon />
                    <SearchDialogInput />
                    <SearchDialogClose />
                </SearchDialogHeader>
                <SearchDialogList items={query.data !== 'empty' ? query.data : defaults} />
            </SearchDialogContent>
        </Dialog>
    )
}
