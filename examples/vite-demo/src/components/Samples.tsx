/**
 * Documents to try, beside the drop target rather than instead of it.
 *
 * A sample is fetched and handed to the same `run(file)` a dropped file goes
 * through, so there is one path into the pipeline and no second code path to
 * keep in step. The fetch is same-origin: COEP `require-corp` blocks anything
 * else, which is why the files are served from `public/`.
 */

import { useState } from 'react'
import { SAMPLES, type Sample, sampleUrl } from '../catalog/samples'
import { run } from '../lib/run'
import { useRun } from '../store/run'

export function Samples() {
    const status = useRun((state) => state.status)
    const setNote = useRun((state) => state.setNote)
    const [loading, setLoading] = useState('')

    const busy = status === 'running' || loading !== ''

    const pick = async (sample: Sample) => {
        if (busy) return
        setLoading(sample.file)
        try {
            const response = await fetch(sampleUrl(sample))
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
            const blob = await response.blob()
            await run(new File([blob], sample.file, { type: 'application/pdf' }))
        } catch (error) {
            // A missing sample is a deployment problem, not a pipeline one, so
            // it is reported here rather than through the run's error state.
            setNote(`Could not load ${sample.file}: ${(error as Error).message}`)
        } finally {
            setLoading('')
        }
    }

    return (
        <div className="samples">
            <span className="samples__key">or try</span>
            {SAMPLES.map((sample) => (
                <button
                    className="pill"
                    type="button"
                    key={sample.file}
                    title={sample.wants}
                    disabled={busy}
                    onClick={() => void pick(sample)}
                >
                    {loading === sample.file ? 'loading…' : sample.label}
                </button>
            ))}
        </div>
    )
}
