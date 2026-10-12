/** A realm fetching one model, reporting how many GETs it made and what progress it saw. */
import { configure, type ModelProgress } from '../../../src/core/config.js'
import { ensureModelFiles } from '../../../src/core/model-cache.js'

let gets = 0
const realFetch = self.fetch.bind(self)
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') gets++
    return realFetch(input, init)
}

self.onmessage = async (event: MessageEvent<{ url: string; db: string }>) => {
    configure({ cacheDbName: event.data.db, cache: 'indexeddb' })
    const phases: ModelProgress[] = []
    const files = await ensureModelFiles(
        { repo: 'probe', files: [{ path: event.data.url }] },
        { onProgress: (p) => phases.push(p) }
    )
    self.postMessage({ gets, phases, bytes: files[event.data.url]?.byteLength })
}
