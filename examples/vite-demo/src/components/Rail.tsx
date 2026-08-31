/**
 * The builder's status strip, and the two runtime controls.
 *
 * It used to carry the mark and the navigation too; both now live in the site
 * header above it. What is left is the part no header can say -- what this tab
 * can actually run on, and what it is being asked to run on.
 *
 * The two controls behave differently on purpose. Switching provider takes
 * effect on the next run, because a provider is chosen per session and the
 * engines cached from the previous choice are dropped. Threads are fixed when
 * onnxruntime-web starts its WASM runtime and cannot be restarted inside a
 * page, so that one offers a reload rather than pretending.
 */

import { useState } from 'react'
import type { RuntimeReport } from '../lib/configure'
import { type Engine, useRuntime } from '../store/runtime'

const ENGINES: { value: Engine; label: string }[] = [
    { value: 'auto', label: 'auto' },
    { value: 'webgpu', label: 'webgpu' },
    { value: 'wasm', label: 'wasm' },
]

export function Rail({ report, onEngineChange }: { report: RuntimeReport; onEngineChange: () => void }) {
    const engine = useRuntime((state) => state.engine)
    const threads = useRuntime((state) => state.threads)
    const threadCount = useRuntime((state) => state.threadCount)
    const setEngine = useRuntime((state) => state.setEngine)
    const setThreads = useRuntime((state) => state.setThreads)
    const setThreadCount = useRuntime((state) => state.setThreadCount)
    const [pendingReload, setPendingReload] = useState(false)

    const chooseEngine = (next: Engine) => {
        if (next === engine) return
        setEngine(next)
        onEngineChange()
    }

    const toggleThreads = (next: boolean) => {
        setThreads(next)
        setPendingReload(true)
    }

    const chooseCount = (next: number) => {
        setThreadCount(next)
        setPendingReload(true)
    }

    // 1 is "off", so it is the checkbox's job rather than a count to pick.
    const counts = Array.from({ length: Math.max(0, report.cores - 1) }, (_, i) => i + 2)

    // Naming what actually happened is the point of the strip: "auto" is not an
    // answer, and asking for WebGPU on a machine without an adapter is not one
    // either.
    const resolved = report.engine === 'webgpu' ? 'running on webgpu' : 'running on wasm'
    const threadNote = !report.isolated
        ? 'unavailable: this page is not cross-origin isolated'
        : threads
          ? `${report.threads} of ${report.cores} cores`
          : 'single-threaded'

    return (
        <header className="rail">
            <span className="rail__label">runtime</span>

            <div className="rail__group">
                <span className="rail__key">engine</span>
                <fieldset className="seg">
                    <legend className="sr-only">Execution provider</legend>
                    {ENGINES.map((option) => {
                        const missing = option.value === 'webgpu' && !report.webgpu
                        return (
                            <button
                                type="button"
                                key={option.value}
                                className="seg__item"
                                aria-pressed={engine === option.value}
                                disabled={missing}
                                title={
                                    missing
                                        ? 'This browser reports no WebGPU adapter.'
                                        : option.value === 'auto'
                                          ? 'Prefer WebGPU where the browser has an adapter.'
                                          : `Create sessions with ${option.label}.`
                                }
                                onClick={() => chooseEngine(option.value)}
                            >
                                {option.label}
                            </button>
                        )
                    })}
                </fieldset>
                <span className="cap" data-on="true">
                    {resolved}
                </span>
            </div>

            <div className="rail__group">
                <span className="rail__key">threads</span>
                <label className="rail__check" title={THREAD_HELP}>
                    <input
                        type="checkbox"
                        checked={threads && report.isolated}
                        disabled={!report.isolated}
                        onChange={(event) => toggleThreads(event.target.checked)}
                    />
                    multithreading
                </label>
                {report.isolated && threads && (
                    <select
                        className="rail__select"
                        aria-label="Thread count"
                        value={String(threadCount)}
                        title={`How many WASM threads to ask for. This machine reports ${report.cores} cores.`}
                        onChange={(event) => chooseCount(Number(event.target.value))}
                    >
                        <option value="0">auto ({report.autoThreads})</option>
                        {counts.map((count) => (
                            <option value={String(count)} key={count}>
                                {count}
                            </option>
                        ))}
                    </select>
                )}
                <span className="cap" data-on={String(report.isolated && threads)}>
                    {threadNote}
                </span>
                {pendingReload && report.isolated && (
                    <button type="button" className="rail__reload" onClick={() => location.reload()}>
                        reload to apply
                    </button>
                )}
            </div>
        </header>
    )
}

const THREAD_HELP =
    'WASM threads need SharedArrayBuffer, which needs COOP/COEP response headers. ' +
    'The dev server sets them; GitHub Pages cannot, so the deployed site is always single-threaded. ' +
    'WebGPU is unaffected either way.'
