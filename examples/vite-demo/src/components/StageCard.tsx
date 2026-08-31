import { getStageSpec } from '@stabrise/scaledp/registry'
import { useEffect, useState } from 'react'
import { type CacheState, cacheTarget, probeCache, probeCachedValues } from '../lib/cache'
import { type Column, writes } from '../lib/columns'
import { type StageNode, usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'
import { useUi } from '../store/ui'
import { ParamField } from './ParamField'

/** Stable identity, so the initial state does not re-trigger the effect. */
const EMPTY: ReadonlySet<string> = new Set()

interface Props {
    stage: StageNode
    index: number
    total: number
    columns: Column[]
    dangling: string[]
    /** Set when this stage re-expands rows an earlier stage already expanded. */
    multiplies: string | null
    /** Set when this stage's output column recorded a failure on the last run. */
    exception: string
}

export function StageCard({ stage, index, total, columns, dangling, multiplies, exception }: Props) {
    const spec = getStageSpec(stage.type)
    const setParam = usePipeline((state) => state.setParam)
    const resetParam = usePipeline((state) => state.resetParam)
    const resetStage = usePipeline((state) => state.resetStage)
    const removeStage = usePipeline((state) => state.removeStage)
    const moveStage = usePipeline((state) => state.moveStage)
    const markStale = useRun((state) => state.markStale)
    const open = useUi((state) => state.expanded.has(stage.id))
    const toggle = useUi((state) => state.toggle)
    const [cache, setCache] = useState<CacheState | null>(null)

    // Re-probed when the model changes and once a run ends: one that was
    // downloading a moment ago is cached now. Depending on the target string
    // rather than on the stage means editing an unrelated parameter does not
    // re-probe, and skipping the probe mid-run keeps it out of the way of the
    // download it would be asking about.
    const runStatus = useRun((state) => state.status)
    const target = cacheTarget(stage)
    useEffect(() => {
        if (runStatus === 'running') return
        let live = true
        void probeCache(stage.type, target).then((state) => {
            if (live) setCache(state)
        })
        return () => {
            live = false
        }
    }, [stage.type, target, runStatus])

    // The same question asked of every option, so the dropdown can mark the
    // ones already downloaded. Keyed on the stage type rather than the chosen
    // value: the option list does not change when the choice does, and the set
    // is refreshed after a run, when one more of them has become cached.
    const [cachedValues, setCachedValues] = useState<ReadonlySet<string>>(EMPTY)
    const cacheParam = spec?.cache?.param
    const cacheOptions = spec?.params.find((param) => param.key === cacheParam)?.options
    useEffect(() => {
        if (runStatus === 'running' || !cacheOptions) return
        let live = true
        void probeCachedValues(
            stage.type,
            cacheOptions.map((option) => option.value)
        ).then((values) => {
            if (live) setCachedValues(values)
        })
        return () => {
            live = false
        }
    }, [stage.type, cacheOptions, runStatus])

    if (!spec) {
        return (
            <li className="card card--unknown">
                <p className="card__head">Unknown stage “{stage.type}”</p>
                <button className="ghost" type="button" onClick={() => removeStage(stage.id)}>
                    Remove
                </button>
            </li>
        )
    }

    const change = (key: string, value: unknown) => {
        setParam(stage.id, key, value)
        markStale(spec.label)
    }
    const reset = (key: string) => {
        resetParam(stage.id, key)
        markStale(spec.label)
    }

    const plain = spec.params.filter((param) => !param.advanced)
    const advanced = spec.params.filter((param) => param.advanced)
    const produced = writes(stage, index)
    // Closed, the one thing a card cannot show is which parameters were touched.
    // Counting them keeps "this stage is not at its defaults" visible.
    const changedCount = Object.keys(stage.options).length

    return (
        <li className={`card${exception ? ' card--failed' : ''}`} data-open={open || undefined}>
            <div className="card__head">
                <span className="card__n">{index + 1}</span>
                {/* The title is the disclosure, so the whole name is the hit
                    target rather than a chevron a few pixels wide. */}
                <button
                    className="card__title"
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(stage.id)}
                >
                    <span className="card__chevron" aria-hidden="true" />
                    <strong>{spec.label}</strong>
                    <code>{stage.type}</code>
                </button>
                <span className="card__group">{spec.group}</span>
                {cache && (
                    <span className="ctrl__state" data-state={cache.ready ? 'ready' : 'pending'}>
                        {cache.label}
                    </span>
                )}
                <span className="spacer" />
                <button
                    className="ghost"
                    type="button"
                    disabled={index === 0}
                    title="Move up"
                    onClick={() => moveStage(stage.id, -1)}
                >
                    ↑
                </button>
                <button
                    className="ghost"
                    type="button"
                    disabled={index === total - 1}
                    title="Move down"
                    onClick={() => moveStage(stage.id, 1)}
                >
                    ↓
                </button>
                <button className="ghost" type="button" onClick={() => resetStage(stage.id)}>
                    Defaults
                </button>
                <button className="ghost" type="button" onClick={() => removeStage(stage.id)}>
                    Remove
                </button>
            </div>

            {open && (
                <p className="card__summary">
                    {spec.summary} <span className="card__path">{spec.subpath}</span>
                </p>
            )}

            <p className="card__flow">
                {produced.map((column) => (
                    <span className="chip" key={column.name}>
                        writes <code>{column.name}</code> · {column.kind}
                    </span>
                ))}
                {spec.expands && <span className="chip">one row per page or region</span>}
                {!open && changedCount > 0 && (
                    <span className="chip chip--changed">
                        {changedCount} parameter{changedCount === 1 ? '' : 's'} changed
                    </span>
                )}
            </p>

            {dangling.length > 0 && (
                <p className="warn">
                    Nothing upstream writes{' '}
                    {dangling.map((name) => (
                        <code key={name}>{name}</code>
                    ))}{' '}
                    by the time this stage runs — either no stage produces it, or one above dropped it with
                    “Keep input column” off. The run still completes; this stage records the failure instead.
                </p>
            )}
            {multiplies && (
                <p className="warn">
                    This expands every row “{multiplies}” already produced, expanding each of them again — a
                    five-page file becomes twenty-five rows. Point it at a column that stage wrote, or drop
                    one of the two.
                </p>
            )}
            {exception && <p className="warn warn--error">{exception}</p>}

            {open && (
                <>
                    <div className="card__params">
                        {plain.map((param) => (
                            <ParamField
                                key={param.key}
                                stage={stage}
                                param={param}
                                columns={columns}
                                defaults={spec.defaults}
                                onChange={change}
                                onReset={reset}
                                cached={param.key === cacheParam ? cachedValues : undefined}
                            />
                        ))}
                    </div>

                    <details className="card__advanced">
                        <summary>Wiring and error handling</summary>
                        <div className="card__params">
                            {advanced.map((param) => (
                                <ParamField
                                    key={param.key}
                                    stage={stage}
                                    param={param}
                                    columns={columns}
                                    defaults={spec.defaults}
                                    onChange={change}
                                    onReset={reset}
                                    cached={param.key === cacheParam ? cachedValues : undefined}
                                />
                            ))}
                        </div>
                    </details>
                </>
            )}
        </li>
    )
}
