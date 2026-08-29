import { pipelineCode } from '@stabrise/scaledp/registry'
import { useState } from 'react'
import { BUILTIN_PRESETS } from '../catalog/presets'
import { toDescriptors, usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'

export function Presets() {
    const presets = usePipeline((state) => state.presets)
    const activePresetId = usePipeline((state) => state.activePresetId)
    const loadPreset = usePipeline((state) => state.loadPreset)
    const savePreset = usePipeline((state) => state.savePreset)
    const deletePreset = usePipeline((state) => state.deletePreset)
    const renamePreset = usePipeline((state) => state.renamePreset)
    const stages = usePipeline((state) => state.stages)
    const exportJson = usePipeline((state) => state.exportJson)
    const importJson = usePipeline((state) => state.importJson)
    const markStale = useRun((state) => state.markStale)

    const [name, setName] = useState('')
    const [transfer, setTransfer] = useState<string | null>(null)
    const [problem, setProblem] = useState('')
    const [view, setView] = useState<'json' | 'code'>('json')
    const [copied, setCopied] = useState(false)

    // What this pipeline looks like written by hand, for pasting into a project.
    const code = pipelineCode(toDescriptors(stages))

    const load = (id: string) => {
        loadPreset(id)
        markStale('Pipeline')
    }

    return (
        <div className="presets">
            <div className="presets__row">
                <span className="presets__key">Start from</span>
                {BUILTIN_PRESETS.map((preset) => (
                    <button
                        className="pill"
                        type="button"
                        key={preset.id}
                        title={preset.summary}
                        aria-pressed={activePresetId === preset.id}
                        onClick={() => load(preset.id)}
                    >
                        {preset.name}
                    </button>
                ))}
            </div>

            {presets.length > 0 && (
                <div className="presets__row">
                    <span className="presets__key">Saved</span>
                    {presets.map((preset) => (
                        <span className="pill pill--saved" key={preset.id}>
                            <button
                                type="button"
                                aria-pressed={activePresetId === preset.id}
                                onClick={() => load(preset.id)}
                            >
                                {preset.name}
                            </button>
                            <button
                                type="button"
                                title="Rename"
                                onClick={() => {
                                    const next = prompt('Rename pipeline', preset.name)
                                    if (next) renamePreset(preset.id, next)
                                }}
                            >
                                ✎
                            </button>
                            <button type="button" title="Delete" onClick={() => deletePreset(preset.id)}>
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <div className="presets__row">
                <input
                    className="presets__name"
                    type="text"
                    value={name}
                    placeholder="Name this pipeline"
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' || !name.trim()) return
                        savePreset(name)
                        setName('')
                    }}
                />
                <button
                    className="ghost"
                    type="button"
                    disabled={!name.trim()}
                    onClick={() => {
                        savePreset(name)
                        setName('')
                    }}
                >
                    Save
                </button>
                <span className="spacer" />
                <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                        setProblem('')
                        setTransfer(transfer === null ? exportJson() : null)
                    }}
                >
                    {transfer === null ? 'Export / import' : 'Close'}
                </button>
            </div>

            {transfer !== null && (
                <div className="presets__transfer">
                    <div className="tabs" role="tablist">
                        <button
                            className={`tab${view === 'json' ? ' is-on' : ''}`}
                            type="button"
                            role="tab"
                            onClick={() => setView('json')}
                        >
                            JSON
                        </button>
                        <button
                            className={`tab${view === 'code' ? ' is-on' : ''}`}
                            type="button"
                            role="tab"
                            onClick={() => setView('code')}
                        >
                            TypeScript
                        </button>
                    </div>

                    {view === 'json' ? (
                        <>
                            <textarea
                                value={transfer}
                                spellCheck={false}
                                onChange={(event) => setTransfer(event.target.value)}
                            />
                            <div className="presets__row">
                                <button
                                    className="ghost"
                                    type="button"
                                    onClick={() => {
                                        try {
                                            importJson(transfer)
                                            setTransfer(null)
                                            setProblem('')
                                            markStale('Pipeline')
                                        } catch (error) {
                                            setProblem((error as Error).message)
                                        }
                                    }}
                                >
                                    Import this
                                </button>
                                <button
                                    className="ghost"
                                    type="button"
                                    onClick={() => void navigator.clipboard.writeText(transfer)}
                                >
                                    Copy
                                </button>
                                {problem && <span className="warn">{problem}</span>}
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Read-only: the pipeline is edited above, and a
                                round trip from source back into stages would be
                                a parser this demo has no business carrying. */}
                            <pre className="code">{code}</pre>
                            <div className="presets__row">
                                <button
                                    className="ghost"
                                    type="button"
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(code)
                                        setCopied(true)
                                        setTimeout(() => setCopied(false), 1200)
                                    }}
                                >
                                    {copied ? 'Copied' : 'Copy code'}
                                </button>
                                <span className="presets__note">
                                    Add a `configure({'{ … }'})` call for asset paths and caching before
                                    running it.
                                </span>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
