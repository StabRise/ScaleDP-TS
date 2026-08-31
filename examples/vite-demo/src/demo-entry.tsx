/**
 * The client-only half of `/demo`.
 *
 * Everything that touches `@stabrise/scaledp` lives behind this module so the
 * route file can be imported during the build without dragging the library --
 * and `OffscreenCanvas`, `navigator.gpu`, IndexedDB -- into Node. The route
 * loads it with `lazy()` after an effect has run.
 */

import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { App } from './app'
import './style.css'
import type { RuntimeReport } from './lib/configure'
import { PIPELINE_PARAM, PRESET_PARAM } from './lib/deeplink'
import { decodePipeline } from './lib/deeplink-decode'
import { nodesFrom, usePipeline } from './store/pipeline'

export default function DemoApp({
    report,
    onEngineChange,
}: {
    report: RuntimeReport
    onEngineChange: () => void
}) {
    const [searchParams, setSearchParams] = useSearchParams()
    const replaceStages = usePipeline((state) => state.replaceStages)
    const loadPreset = usePipeline((state) => state.loadPreset)

    // A link from the docs seeds the builder, then gives the URL back. Leaving
    // the parameter in place would re-seed over the reader's own edits on the
    // next reload, which is the opposite of what a permalink should do.
    useEffect(() => {
        const encoded = searchParams.get(PIPELINE_PARAM)
        const preset = searchParams.get(PRESET_PARAM)
        if (!encoded && !preset) return

        if (encoded) {
            const descriptors = decodePipeline(encoded)
            if (descriptors) replaceStages(nodesFrom(descriptors))
        } else if (preset) {
            loadPreset(preset)
        }

        setSearchParams({}, { replace: true })
    }, [searchParams, setSearchParams, replaceStages, loadPreset])

    return <App report={report} onEngineChange={onEngineChange} />
}
