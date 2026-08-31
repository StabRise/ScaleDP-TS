import { useState } from 'react'
import { BUILTIN_PRESETS } from '../catalog/presets'
import { usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'

export function Presets() {
    const presets = usePipeline((state) => state.presets)
    const activePresetId = usePipeline((state) => state.activePresetId)
    const loadPreset = usePipeline((state) => state.loadPreset)
    const savePreset = usePipeline((state) => state.savePreset)
    const deletePreset = usePipeline((state) => state.deletePreset)
    const renamePreset = usePipeline((state) => state.renamePreset)
    const markStale = useRun((state) => state.markStale)

    const [name, setName] = useState('')

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
            </div>
        </div>
    )
}
