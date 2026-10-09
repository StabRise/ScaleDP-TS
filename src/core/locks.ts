/**
 * Priority semaphores for the scheduler.
 *
 * An ONNX session runs one inference at a time -- a second `run()` on the same
 * session fails with "Session already started" -- so a stage holding one may
 * not be entered twice at once, and stages that *share* a session (every
 * PaddleOCR stage on one preset does) may not be entered at once either. The
 * scheduler expresses both as named resources and acquires them here.
 *
 * Waiters are served by priority, lowest first, where the priority is the
 * page's key. That is what turns "several pages in flight" into a pipeline
 * rather than a scramble: the oldest page always gets the free stage, so page
 * 1 reaches NER while page 2 is still in OCR, and the first result arrives as
 * early as it would with one page in flight.
 */

export type Priority = readonly number[]

/** Lexicographic, with a prefix ordering first -- the order of rows in the result. */
export function comparePriority(a: Priority, b: Priority): number {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
        const d = (a[i] as number) - (b[i] as number)
        if (d !== 0) return d
    }
    return a.length - b.length
}

interface Waiter {
    priority: Priority
    seq: number
    resolve: () => void
    reject: (reason: unknown) => void
}

let sequence = 0

export class Semaphore {
    private available: number
    private readonly waiters: Waiter[] = []

    constructor(readonly capacity: number) {
        this.available = capacity
    }

    get pending(): number {
        return this.waiters.length
    }

    acquire(priority: Priority = [], signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted()
        if (this.available > 0 && this.waiters.length === 0) {
            this.available -= 1
            return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { priority, seq: sequence++, resolve, reject }
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter)
                if (index >= 0) this.waiters.splice(index, 1)
                reject(signal?.reason)
            }
            waiter.resolve = () => {
                signal?.removeEventListener('abort', onAbort)
                resolve()
            }
            signal?.addEventListener('abort', onAbort, { once: true })

            // Insert in priority order; equal priorities keep arrival order.
            let at = this.waiters.length
            while (at > 0) {
                const before = this.waiters[at - 1] as Waiter
                const cmp = comparePriority(before.priority, priority)
                if (cmp < 0 || (cmp === 0 && before.seq < waiter.seq)) break
                at -= 1
            }
            this.waiters.splice(at, 0, waiter)
        })
    }

    release(): void {
        const next = this.waiters.shift()
        if (next) next.resolve()
        else this.available = Math.min(this.capacity, this.available + 1)
    }
}

/** A resource a stage call holds: a name, and how many holders it admits. */
export type ResourceClaim = string | { key: string; capacity: number }

const shared = new Map<string, Semaphore>()

/**
 * Process-wide semaphore for a named resource.
 *
 * Shared across every pipeline in the realm on purpose: two runs over one
 * module-cached Paddle session collide just as two pages of one run would.
 * The first claim fixes the capacity.
 */
export function sharedSemaphore(claim: ResourceClaim): Semaphore {
    const key = typeof claim === 'string' ? claim : claim.key
    let semaphore = shared.get(key)
    if (!semaphore) {
        semaphore = new Semaphore(typeof claim === 'string' ? 1 : Math.max(1, claim.capacity))
        shared.set(key, semaphore)
    }
    return semaphore
}

export function claimKey(claim: ResourceClaim): string {
    return typeof claim === 'string' ? claim : claim.key
}

/**
 * Acquire several semaphores, always in the same global order, so two callers
 * holding overlapping sets can never each wait on the other. Released in
 * reverse by the returned function; a failure part-way releases what was held.
 */
export async function acquireAll(
    semaphores: readonly { key: string; semaphore: Semaphore }[],
    priority: Priority,
    signal?: AbortSignal
): Promise<() => void> {
    const ordered = [...semaphores].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const held: Semaphore[] = []
    try {
        for (const { semaphore } of ordered) {
            await semaphore.acquire(priority, signal)
            held.push(semaphore)
        }
    } catch (error) {
        for (const semaphore of held.reverse()) semaphore.release()
        throw error
    }
    return () => {
        for (const semaphore of held.reverse()) semaphore.release()
    }
}
