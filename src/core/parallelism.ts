/**
 * How much to run at once: workers, threads per worker, pages in flight.
 *
 * Three knobs, one per level at which work can overlap:
 *
 * - `pagesInFlight` -- pages walking one pipeline at once. Overlaps stages that
 *   wait on different things (pdf.js parses in its own thread, a cloud NER call
 *   waits on the network, WebGPU on the GPU). Two CPU-bound WASM inferences in
 *   one worker do not overlap: they share its thread pool.
 * - `threadsPerWorker` -- onnxruntime-web's `numThreads`. Only engages on a
 *   cross-origin-isolated page, and is fixed per worker when its first session
 *   is created.
 * - `workers` -- separate realms, each with its own sessions. The only CPU
 *   parallelism on a page that is not isolated, paid for in memory: every
 *   worker loads its own copy of every model.
 *
 * `resolveParallelism('auto', await probeEnvironment())` picks all three from
 * the machine. Pass a partial object to pin any of them.
 */

export interface EnvironmentProbe {
    /** `navigator.hardwareConcurrency`. */
    cores: number
    /** `crossOriginIsolated`: whether WASM threads can engage at all. */
    isolated: boolean
    /** Whether a WebGPU adapter was found. */
    webgpu: boolean
    /** `navigator.deviceMemory`, in GB, where the browser reports it (Chromium, capped at 8). */
    deviceMemoryGb?: number
}

export interface Parallelism {
    workers: number
    threadsPerWorker: number
    /** Per worker. */
    pagesInFlight: number
    /** For stages that create ONNX sessions, in priority order. */
    executionProviders: string[]
}

export type ParallelismPreset = 'auto' | 'conservative' | Partial<Parallelism>

/** Probe what this realm can do. Never throws; an unknown is reported as the conservative answer. */
export async function probeEnvironment(): Promise<EnvironmentProbe> {
    const nav =
        typeof navigator === 'undefined'
            ? undefined
            : (navigator as Navigator & {
                  gpu?: { requestAdapter(): Promise<unknown> }
                  deviceMemory?: number
              })
    let webgpu = false
    try {
        webgpu = Boolean(await nav?.gpu?.requestAdapter())
    } catch {
        webgpu = false
    }
    return {
        cores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 1,
        isolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
        webgpu,
        ...(typeof nav?.deviceMemory === 'number' ? { deviceMemoryGb: nav.deviceMemory } : {}),
    }
}

/**
 * Concrete settings for a preset on a machine.
 *
 * `conservative` is the library's behaviour before any of this existed: one
 * worker, one page at a time. `auto` follows the measurements in
 * `bench/results/` (render, DBNet, PaddleRecognizer, FaceDetector; 18 cores):
 *
 * - **Workers first.** At equal total threads, more workers beat more threads
 *   per worker: 4x1 = 1.56 pages/s, 2x2 = 1.52, 1x4 = 1.25. Each worker owns
 *   its sessions, so nothing is shared to contend on. Capped by memory, since
 *   each worker also loads its own copy of every model.
 * - **Then threads, where the page is isolated.** 4 workers x 4 threads was the
 *   fastest setting measured (3.30 pages/s, 6.4x one worker x one thread).
 *   Without isolation threads cannot engage, and 4 workers alone gave 3.2x.
 * - **One page in flight per worker.** With every stage a CPU-bound WASM
 *   model, a second page only competes for the same threads: throughput fell
 *   (4x4: 3.30 -> 1.82 pages/s at 2 pages) and latency doubled. Raise it for
 *   pipelines with a stage that waits on something else -- a cloud NER call, a
 *   WebGPU queue.
 * - **WebGPU** (not yet measured): one device per realm and the GPU is the
 *   shared resource, so one worker, with pages in flight to keep it fed while
 *   rendering and OCR's WASM fallbacks run beside it.
 */
export function resolveParallelism(preset: ParallelismPreset, env: EnvironmentProbe): Parallelism {
    const spare = Math.max(1, env.cores - 1)
    const threadsFor = (workers: number) =>
        env.isolated ? Math.max(1, Math.min(4, Math.floor(spare / workers))) : 1

    if (preset === 'conservative') {
        return {
            workers: 1,
            threadsPerWorker: threadsFor(1),
            pagesInFlight: 1,
            executionProviders: ['wasm'],
        }
    }

    const auto = autoParallelism(env, spare, threadsFor)
    if (preset === 'auto') return auto
    const workers = clampInt(preset.workers ?? auto.workers, 1, 64)
    return {
        workers,
        threadsPerWorker: clampInt(preset.threadsPerWorker ?? threadsFor(workers), 1, 64),
        pagesInFlight: clampInt(preset.pagesInFlight ?? auto.pagesInFlight, 1, 64),
        executionProviders: [...(preset.executionProviders ?? auto.executionProviders)],
    }
}

function autoParallelism(
    env: EnvironmentProbe,
    spare: number,
    threadsFor: (workers: number) => number
): Parallelism {
    // Each worker holds its own models; a full PDF pipeline is a few hundred MB.
    const byMemory = env.deviceMemoryGb === undefined ? 4 : Math.max(1, Math.floor(env.deviceMemoryGb / 1.5))

    if (env.webgpu) {
        return {
            workers: 1,
            threadsPerWorker: threadsFor(1),
            pagesInFlight: 3,
            executionProviders: ['webgpu', 'wasm'],
        }
    }
    const workers = Math.max(1, Math.min(4, spare, byMemory))
    return { workers, threadsPerWorker: threadsFor(workers), pagesInFlight: 1, executionProviders: ['wasm'] }
}

function clampInt(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.floor(value)))
}
