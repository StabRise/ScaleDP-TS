import { useRef, useState } from 'react'
import { run } from '../lib/run'
import { usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'

interface Props {
    /** Model download progress, reported by configure()'s onProgress. */
    progress: string
}

export function Platen({ progress }: Props) {
    const status = useRun((state) => state.status)
    const file = useRun((state) => state.file)
    const note = useRun((state) => state.note)
    const stale = useRun((state) => state.stale)
    const cancel = useRun((state) => state.cancel)
    const stages = usePipeline((state) => state.stages)
    const input = useRef<HTMLInputElement>(null)
    const [over, setOver] = useState(false)

    const busy = status === 'running'
    const accept = (picked: File | undefined) => {
        if (!picked || busy) return
        void run(picked)
    }

    const hint = busy
        ? progress || 'reading'
        : file
          ? `${(file.size / 1024).toFixed(0)} KB · ${status === 'error' ? 'failed' : 'read'}`
          : 'PDF or image · click to browse'

    return (
        <>
            <button
                className={`platen${busy ? ' is-reading' : ''}${over ? ' is-over' : ''}`}
                type="button"
                onClick={() => input.current?.click()}
                onDragEnter={(event) => {
                    event.preventDefault()
                    setOver(true)
                }}
                onDragOver={(event) => {
                    event.preventDefault()
                    setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(event) => {
                    event.preventDefault()
                    setOver(false)
                    accept(event.dataTransfer?.files?.[0])
                }}
            >
                <span className="platen__reg platen__reg--tl" aria-hidden="true" />
                <span className="platen__reg platen__reg--tr" aria-hidden="true" />
                <span className="platen__reg platen__reg--bl" aria-hidden="true" />
                <span className="platen__reg platen__reg--br" aria-hidden="true" />
                <span className="platen__beam" aria-hidden="true" />
                <span className="platen__label">{file ? file.name : 'Drop a page'}</span>
                <span className="platen__hint">{hint}</span>
            </button>

            <input
                ref={input}
                type="file"
                accept="application/pdf,image/*"
                hidden
                onChange={(event) => {
                    const picked = event.target.files?.[0]
                    // Clear the input, or picking the same file again fires no
                    // change event and nothing happens -- which reads as the app
                    // ignoring the click.
                    event.target.value = ''
                    accept(picked)
                }}
            />

            <div className={`rerun${stale ? ' is-stale' : ''}`}>
                {busy ? (
                    <button className="rerun__btn" type="button" onClick={cancel}>
                        Cancel
                    </button>
                ) : (
                    <button
                        className="rerun__btn"
                        type="button"
                        disabled={!file || stages.length === 0}
                        onClick={() => file && void run(file)}
                    >
                        Run again
                    </button>
                )}
                <span className="rerun__note">
                    {stale
                        ? `${stale} changed — run again to apply`
                        : file
                          ? `last read ${file.name}`
                          : 'Drop a file to run the pipeline'}
                </span>
            </div>

            {note && (
                <p className="note" role="status" data-error={status === 'error' || undefined}>
                    {note}
                </p>
            )}
        </>
    )
}
