/**
 * The pipeline being assembled, and the ones saved in this browser.
 *
 * A pipeline is `StageDescriptor[]` -- the same plain JSON the worker protocol
 * sends across the boundary and `@stabrise/scaledp/registry` turns back into
 * live stages. That is why it can be persisted at all: nothing here is a class
 * instance, so it survives a round trip through localStorage untouched.
 *
 * Each node also carries a `id`, which the descriptor does not: two
 * ImageDrawBoxes passes in one pipeline need stable React keys and independent
 * params, and their type is the same.
 */

import { getStageSpec, type StageDescriptor, type StageSpec } from '@stabrise/scaledp/registry'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID } from '../catalog/presets'
import { latestOfKind } from '../lib/columns'

export interface StageNode extends StageDescriptor {
    id: string
    options: Record<string, unknown>
}

export interface SavedPipeline {
    id: string
    name: string
    stages: StageNode[]
    savedAt: number
}

/** The persisted document, versioned so a later shape can migrate this one. */
export interface PipelineFile {
    version: 1
    presets: SavedPipeline[]
    stages: StageNode[]
}

// crypto.randomUUID needs a secure context, which a plain-http dev server on a
// LAN address is not. The fallback only has to be unique within one page.
let counter = 0
const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${counter++}`

const node = (descriptor: StageDescriptor): StageNode => ({
    id: newId(),
    type: descriptor.type,
    options: { ...descriptor.options },
})

export const nodesFrom = (descriptors: readonly StageDescriptor[]): StageNode[] => descriptors.map(node)

const DEFAULT_STAGES = (): StageNode[] =>
    nodesFrom(BUILTIN_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)?.stages ?? [])

/**
 * Point a newly added stage at the columns already on the row.
 *
 * Every stage's defaults name the columns of the pipeline it was designed for
 * (`image`, `boxes`, `text`), and those are usually right. They stop being right
 * as soon as an earlier stage was renamed -- a detector writing `detected`, say.
 * Choosing the most recent upstream column of the kind the stage wants means
 * adding LineOrientationDetector after a detector lands on the detector's real
 * output rather than on a column nothing writes.
 */
function prewire(spec: StageSpec, stages: readonly StageNode[], index: number): Record<string, unknown> {
    const options: Record<string, unknown> = {}

    const multi = spec.params.find((param) => param.kind === 'columns')
    if (multi) {
        const wanted = (spec.defaults[multi.key] as string[]) ?? []
        const wired = wanted.map((fallback, position) => {
            const kind = multi.accepts?.[Math.min(position, (multi.accepts?.length ?? 1) - 1)]
            return (kind && latestOfKind(stages, index, kind, spec.terminal)) ?? fallback
        })
        if (wired.some((name, i) => name !== wanted[i])) options[multi.key] = wired
    } else if (spec.consumes[0]) {
        const wired = latestOfKind(stages, index, spec.consumes[0], spec.terminal)
        if (wired && wired !== spec.defaults.inputCol) options.inputCol = wired
    }
    return options
}

interface PipelineStore extends PipelineFile {
    /** Which saved or built-in pipeline the working copy came from. */
    activePresetId: string | null

    addStage: (type: string, atIndex?: number) => string | null
    removeStage: (id: string) => void
    moveStage: (id: string, delta: number) => void
    setParam: (id: string, key: string, value: unknown) => void
    swapStageType: (id: string, type: string) => void
    resetParam: (id: string, key: string) => void
    resetStage: (id: string) => void
    replaceStages: (stages: StageNode[], presetId?: string | null) => void
    resetPipeline: () => void

    loadPreset: (id: string) => void
    savePreset: (name: string) => void
    renamePreset: (id: string, name: string) => void
    deletePreset: (id: string) => void

    exportJson: () => string
    importJson: (text: string) => void
}

/** Rewrite one node, leaving the rest identical so React can skip them. */
const patch = (stages: StageNode[], id: string, change: (node: StageNode) => StageNode): StageNode[] =>
    stages.map((stage) => (stage.id === id ? change(stage) : stage))

export const usePipeline = create<PipelineStore>()(
    persist(
        (set, get) => ({
            version: 1,
            stages: DEFAULT_STAGES(),
            presets: [],
            activePresetId: DEFAULT_PRESET_ID,

            addStage: (type, atIndex) => {
                const spec = getStageSpec(type)
                if (!spec) return null
                const id = newId()
                set((state) => {
                    const index = atIndex ?? state.stages.length
                    const added: StageNode = {
                        id,
                        type,
                        options: prewire(spec, state.stages, index),
                    }
                    const stages = [...state.stages]
                    stages.splice(index, 0, added)
                    return { stages, activePresetId: null }
                })
                return id
            },

            removeStage: (id) =>
                set((state) => ({
                    stages: state.stages.filter((stage) => stage.id !== id),
                    activePresetId: null,
                })),

            moveStage: (id, delta) =>
                set((state) => {
                    const from = state.stages.findIndex((stage) => stage.id === id)
                    const to = from + delta
                    if (from < 0 || to < 0 || to >= state.stages.length) return state
                    const stages = [...state.stages]
                    const [moved] = stages.splice(from, 1)
                    if (moved) stages.splice(to, 0, moved)
                    return { stages, activePresetId: null }
                }),

            setParam: (id, key, value) =>
                set((state) => ({
                    stages: patch(state.stages, id, (stage) => {
                        const spec = getStageSpec(stage.type)
                        const options = { ...stage.options }
                        // Store only what differs from the stage's own default,
                        // so a saved pipeline reads as the choices someone made
                        // rather than a dump of every parameter.
                        if (spec && same(spec.defaults[key], value)) delete options[key]
                        else options[key] = value
                        return { ...stage, options }
                    }),
                    activePresetId: null,
                })),

            // Swapping a reader for its sibling keeps every option the new
            // stage also understands -- PdfToImage and DataToImage share
            // resolution, imageType and their columns -- and drops the rest.
            swapStageType: (id, type) =>
                set((state) => {
                    const spec = getStageSpec(type)
                    if (!spec) return state
                    return {
                        stages: patch(state.stages, id, (stage) => ({
                            ...stage,
                            type,
                            options: Object.fromEntries(
                                Object.entries(stage.options).filter(([key]) => key in spec.defaults)
                            ),
                        })),
                    }
                }),

            resetParam: (id, key) =>
                set((state) => ({
                    stages: patch(state.stages, id, (stage) => {
                        const options = { ...stage.options }
                        delete options[key]
                        return { ...stage, options }
                    }),
                    activePresetId: null,
                })),

            resetStage: (id) =>
                set((state) => ({
                    stages: patch(state.stages, id, (stage) => ({ ...stage, options: {} })),
                    activePresetId: null,
                })),

            replaceStages: (stages, presetId = null) => set({ stages, activePresetId: presetId }),

            resetPipeline: () => set({ stages: DEFAULT_STAGES(), activePresetId: DEFAULT_PRESET_ID }),

            loadPreset: (id) => {
                const builtin = BUILTIN_PRESETS.find((preset) => preset.id === id)
                if (builtin) return set({ stages: nodesFrom(builtin.stages), activePresetId: id })
                const saved = get().presets.find((preset) => preset.id === id)
                if (saved) set({ stages: nodesFrom(saved.stages), activePresetId: id })
            },

            savePreset: (name) =>
                set((state) => {
                    const trimmed = name.trim()
                    if (!trimmed) return state
                    // Saving under a name already in the list replaces it, which
                    // is what "save" means everywhere else.
                    const existing = state.presets.find((preset) => preset.name === trimmed)
                    const preset: SavedPipeline = {
                        id: existing?.id ?? newId(),
                        name: trimmed,
                        stages: nodesFrom(state.stages),
                        savedAt: Date.now(),
                    }
                    return {
                        presets: existing
                            ? state.presets.map((p) => (p.id === existing.id ? preset : p))
                            : [...state.presets, preset],
                        activePresetId: preset.id,
                    }
                }),

            renamePreset: (id, name) =>
                set((state) => ({
                    presets: state.presets.map((preset) =>
                        preset.id === id ? { ...preset, name: name.trim() || preset.name } : preset
                    ),
                })),

            deletePreset: (id) =>
                set((state) => ({
                    presets: state.presets.filter((preset) => preset.id !== id),
                    activePresetId: state.activePresetId === id ? null : state.activePresetId,
                })),

            exportJson: () => {
                const { version, presets, stages } = get()
                const file: PipelineFile = { version, presets, stages }
                return JSON.stringify(file, null, 2)
            },

            importJson: (text) => {
                const parsed = JSON.parse(text) as Partial<PipelineFile>
                if (!Array.isArray(parsed.stages)) {
                    throw new Error('Expected a "stages" array. Export a pipeline to see the shape.')
                }
                for (const stage of parsed.stages) {
                    if (!getStageSpec(stage?.type)) {
                        throw new Error(`Unknown stage "${stage?.type}".`)
                    }
                }
                set({
                    stages: nodesFrom(parsed.stages),
                    presets: Array.isArray(parsed.presets)
                        ? parsed.presets.map((preset) => ({ ...preset, id: preset.id || newId() }))
                        : get().presets,
                    activePresetId: null,
                })
            },
        }),
        {
            name: 'scaledp-demo-pipelines',
            version: 1,
            partialize: ({ version, stages, presets, activePresetId }) => ({
                version,
                stages,
                presets,
                activePresetId,
            }),
        }
    )
)

/** Structural equality, deep enough for param values: scalars and string lists. */
export function same(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => value === b[index])
    }
    return a === b
}

/** The value in effect for a param: the chosen one, or the stage's default. */
export function effective(stage: StageNode, key: string): unknown {
    if (key in stage.options) return stage.options[key]
    return getStageSpec(stage.type)?.defaults[key]
}

/** The working pipeline as the descriptors the registry builds from. */
export const toDescriptors = (stages: readonly StageNode[]): StageDescriptor[] =>
    stages.map(({ type, options }) => ({ type, options }))
