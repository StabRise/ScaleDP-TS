/**
 * A push-to-pull bridge: callbacks in, `for await` out.
 *
 * Buffers without bound, which is right for pipeline events -- there are a
 * handful per page and dropping one would leave a UI showing a stage as
 * running forever.
 */
export class EventStream<T> implements AsyncIterable<T> {
    private readonly buffer: T[] = []
    private waiting: ((result: IteratorResult<T>) => void) | null = null
    private failWaiting: ((error: unknown) => void) | null = null
    private done = false
    private error: unknown = undefined
    private failed = false

    push(value: T): void {
        if (this.done) return
        if (this.waiting) {
            const resolve = this.waiting
            this.waiting = null
            this.failWaiting = null
            resolve({ value, done: false })
        } else {
            this.buffer.push(value)
        }
    }

    close(error?: unknown): void {
        if (this.done) return
        this.done = true
        if (error !== undefined) {
            this.failed = true
            this.error = error
        }
        if (this.waiting) {
            const resolve = this.waiting
            const reject = this.failWaiting
            this.waiting = null
            this.failWaiting = null
            if (this.failed) reject?.(this.error)
            else resolve({ value: undefined, done: true })
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                const value = this.buffer.shift()
                if (value !== undefined) return Promise.resolve({ value, done: false })
                if (this.done) {
                    return this.failed
                        ? Promise.reject(this.error)
                        : Promise.resolve({ value: undefined, done: true })
                }
                return new Promise<IteratorResult<T>>((resolve, reject) => {
                    this.waiting = resolve
                    this.failWaiting = reject
                })
            },
            return: () => {
                this.done = true
                this.buffer.length = 0
                return Promise.resolve({ value: undefined, done: true })
            },
        }
    }
}
