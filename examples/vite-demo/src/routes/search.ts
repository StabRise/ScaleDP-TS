import { createFromSource } from 'fumadocs-core/search/server'
import { source } from '../lib/source'

const server = createFromSource(source, { language: 'english' })

/** Prerendered at build time; the client fetches this index once and queries it. */
export async function loader() {
    return server.staticGET()
}
