/**
 * What the library is asked to run on: execution provider, and threads.
 *
 * Persisted, because it is a property of this machine rather than of the
 * pipeline. `setup()` reads it before `configure()` and the rail writes it.
 *
 * Neither choice is a promise about what the tab actually gets. WebGPU falls
 * back to WASM when a model has no kernel for it, and threads engage only on a
 * cross-origin-isolated page; the rail reports the resolved state separately.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 'auto' prefers WebGPU where the browser has an adapter. */
export type Engine = 'auto' | 'webgpu' | 'wasm'

interface RuntimeStore {
    engine: Engine
    /** Ask onnxruntime-web for several WASM threads rather than one. */
    threads: boolean
    /**
     * How many, when threads are on. `0` means "let the library choose", which
     * leaves one core for the interface and caps at 4 -- past that ORT's own
     * synchronisation costs more than the parallelism wins on these model sizes.
     */
    threadCount: number
    setEngine: (engine: Engine) => void
    setThreads: (threads: boolean) => void
    setThreadCount: (threadCount: number) => void
}

export const useRuntime = create<RuntimeStore>()(
    persist(
        (set) => ({
            engine: 'auto',
            threads: true,
            threadCount: 0,
            setEngine: (engine) => set({ engine }),
            setThreads: (threads) => set({ threads }),
            setThreadCount: (threadCount) => set({ threadCount }),
        }),
        { name: 'scaledp-demo-runtime' }
    )
)
