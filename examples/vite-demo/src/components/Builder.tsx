import { STAGE_SPECS } from '@stabrise/scaledp/registry'
import { useMemo, useState } from 'react'
import { columnsBefore, danglingInputs, multipliesRows } from '../lib/columns'
import { outputsOf } from '../lib/outputs'
import { usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'
import { useUi } from '../store/ui'
import { Presets } from './Presets'
import { StageCard } from './StageCard'

const GROUPS = ['Read', 'Detect', 'Transform', 'Recognise', 'Understand'] as const

export function Builder() {
    const stages = usePipeline((state) => state.stages)
    const addStage = usePipeline((state) => state.addStage)
    const markStale = useRun((state) => state.markStale)
    const rows = useRun((state) => state.rows)
    const expanded = useUi((state) => state.expanded)
    const expandAll = useUi((state) => state.expandAll)
    const collapseAll = useUi((state) => state.collapseAll)
    const expand = useUi((state) => state.expand)
    const [adding, setAdding] = useState(false)

    const openCount = stages.filter((stage) => expanded.has(stage.id)).length

    // Which stage each failure belongs to: the stage that writes the column the
    // exception landed in. A run keeps going after one stage fails, so several
    // cards can carry a message at once -- and with a multi-page document a
    // stage can fail on one page and not the others, so every row is searched
    // and the first message found is the one shown.
    const failures = useMemo(() => {
        const byColumn = new Map<string, string>()
        for (const row of rows) {
            for (const column of outputsOf(row)) {
                if (column.exception && !byColumn.has(column.name)) {
                    byColumn.set(column.name, column.exception)
                }
            }
        }
        return stages.map((stage) => byColumn.get(String(stage.options.outputCol ?? '')) ?? '')
    }, [rows, stages])

    return (
        <section className="builder" aria-label="Pipeline">
            <Presets />

            {stages.length > 0 && (
                <div className="builder__bar">
                    <span className="builder__count">
                        {stages.length} stage{stages.length === 1 ? '' : 's'}
                    </span>
                    <span className="spacer" />
                    <button
                        className="ghost"
                        type="button"
                        onClick={() =>
                            openCount === stages.length
                                ? collapseAll()
                                : expandAll(stages.map((stage) => stage.id))
                        }
                    >
                        {openCount === stages.length ? 'Collapse all' : 'Expand all'}
                    </button>
                </div>
            )}

            <ol className="builder__list">
                {stages.map((stage, index) => (
                    <StageCard
                        key={stage.id}
                        stage={stage}
                        index={index}
                        total={stages.length}
                        columns={columnsBefore(stages, index)}
                        dangling={danglingInputs(stages, index)}
                        multiplies={multipliesRows(stages, index)}
                        exception={failures[index] ?? ''}
                    />
                ))}
                {stages.length === 0 && (
                    <li className="builder__empty">
                        No stages yet. Add one below, or load a pipeline above.
                    </li>
                )}
            </ol>

            <div className="builder__add">
                <button className="add" type="button" onClick={() => setAdding((open) => !open)}>
                    {adding ? 'Close' : 'Add a stage'}
                </button>

                {adding && (
                    <div className="menu">
                        {GROUPS.map((group) => (
                            <div className="menu__group" key={group}>
                                <h3>{group}</h3>
                                {STAGE_SPECS.filter((spec) => spec.group === group).map((spec) => (
                                    <button
                                        className="menu__item"
                                        type="button"
                                        key={spec.type}
                                        onClick={() => {
                                            // Open what was just added: you add
                                            // a stage in order to configure it.
                                            const id = addStage(spec.type)
                                            if (id) expand(id)
                                            markStale(spec.label)
                                            setAdding(false)
                                        }}
                                    >
                                        <strong>{spec.label}</strong>
                                        <span>{spec.summary}</span>
                                        {spec.peer && <em>needs {spec.peer}</em>}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    )
}
