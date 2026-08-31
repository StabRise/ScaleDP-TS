/**
 * The cache is an optimisation, and must never be the reason a model fails.
 *
 * IndexedDB is refused for all sorts of reasons outside the library's control:
 * the quota is full, the user is in a private window, a page open in another
 * tab holds the database at a version this build does not know. None of that
 * should stop a model that has already been downloaded from being used.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { configure, resetConfig } from '../../src/core/config.js'
import { cacheKey, ensureModelFiles, isCached, requestPersistentStorage } from '../../src/core/model-cache.js'

/** A real, tiny file, so the test exercises the download path honestly. */
const SPEC = {
    repo: 'onnx-community/gliner_small-v2.1',
    files: [{ path: 'gliner_config.json', approxBytes: 731 }],
}

const DB = 'scaledp-cache-test'

/** Occupy the database name at a version our opener will refuse. */
function holdAtFutureVersion(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 99)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

describe('ensureModelFiles', () => {
    beforeEach(() => resetConfig())

    it('still returns the files when the cache cannot be written', async () => {
        const held = await holdAtFutureVersion(DB)
        try {
            configure({ cache: 'indexeddb', cacheDbName: DB })

            const files = await ensureModelFiles(SPEC)

            expect(Object.keys(files)).toEqual(['gliner_config.json'])
            expect((files['gliner_config.json'] as ArrayBuffer).byteLength).toBeGreaterThan(0)
            // And it reports honestly that nothing was cached.
            expect(await isCached(SPEC)).toBe(false)
        } finally {
            held.close()
            indexedDB.deleteDatabase(DB)
        }
    }, 120_000)

    it('asks for persistent storage, and says so when it cannot', async () => {
        // Whatever the browser answers, it must be a boolean and must not throw
        // -- Safari and private windows have no navigator.storage.persist at all.
        await expect(requestPersistentStorage()).resolves.toBeTypeOf('boolean')
    })

    /** Read whatever is actually sitting in the store, without interpreting it. */
    function rawEntry(db: string, key: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const open = indexedDB.open(db, 1)
            open.onsuccess = () => {
                const value = open.result.transaction('files', 'readonly').objectStore('files').get(key)
                value.onsuccess = () => {
                    resolve(value.result)
                    open.result.close()
                }
                value.onerror = () => reject(value.error)
            }
            open.onerror = () => reject(open.error)
        })
    }

    it('stores a Blob, not an ArrayBuffer', async () => {
        const db = 'scaledp-blob-test'
        configure({ cache: 'indexeddb', cacheDbName: db })
        try {
            await ensureModelFiles(SPEC)
            const stored = await rawEntry(db, cacheKey(SPEC, 'gliner_config.json'))

            // Chrome structured-clones an ArrayBuffer into the value payload --
            // a second full copy of the weights at commit time, which is what
            // kills the tab on a several-hundred-megabyte model. A Blob is
            // written to disk-backed storage and referenced instead.
            expect(stored).toBeInstanceOf(Blob)
        } finally {
            indexedDB.deleteDatabase(db)
        }
    }, 120_000)

    it('still reads an ArrayBuffer left by an older build', async () => {
        const db = 'scaledp-legacy-test'
        const key = cacheKey(SPEC, 'gliner_config.json')
        const bytes = new Uint8Array([1, 2, 3, 4]).buffer

        await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open(db, 1)
            open.onupgradeneeded = () => open.result.createObjectStore('files')
            open.onsuccess = () => {
                const tx = open.result.transaction('files', 'readwrite')
                tx.objectStore('files').put(bytes, key)
                tx.oncomplete = () => {
                    open.result.close()
                    resolve()
                }
                tx.onerror = () => reject(tx.error)
            }
            open.onerror = () => reject(open.error)
        })

        configure({ cache: 'indexeddb', cacheDbName: db })
        try {
            const files = await ensureModelFiles(SPEC)
            expect(new Uint8Array(files['gliner_config.json'] as ArrayBuffer)).toEqual(
                new Uint8Array([1, 2, 3, 4])
            )
        } finally {
            indexedDB.deleteDatabase(db)
        }
    }, 120_000)
})
