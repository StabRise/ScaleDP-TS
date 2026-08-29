import { useEffect, useState } from 'react'
import { Builder } from './components/Builder'
import { Platen } from './components/Platen'
import { Rail } from './components/Rail'
import { Results } from './components/Results'
import { Trace } from './components/Trace'
import { setProgressSink } from './lib/configure'

export function App({ caps }: { caps: { label: string; on: boolean }[] }) {
    const [progress, setProgress] = useState('')

    // configure() takes one onProgress callback and is called before React
    // mounts, so the callback writes into a module-level sink that this
    // subscribes to rather than being re-registered on every render.
    useEffect(() => setProgressSink(setProgress), [])

    return (
        <>
            <div className="grain" aria-hidden="true" />
            <Rail caps={caps} />
            <div className="sheet">
                <section className="stage">
                    <h1 className="lede">
                        Read a document <em>without sending it anywhere.</em>
                    </h1>
                    <p className="sub">
                        Assemble a pipeline from the stages below and run it here, on WebAssembly or WebGPU.
                        Rendering, detection, OCR and entity recognition all happen in this tab — the file
                        never leaves your machine.
                    </p>
                    <Platen progress={progress} />
                </section>

                <Builder />
                <Trace />
                <Results />
            </div>
        </>
    )
}
