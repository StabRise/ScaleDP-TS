import { pipelineCode } from '@stabrise/scaledp/registry'
import { useState } from 'react'
import { highlightTs } from '../lib/highlight'
import { toDescriptors, usePipeline } from '../store/pipeline'
import { useRun } from '../store/run'

/**
 * The pipeline as source, in its own card.
 *
 * This is a playground, and the thing to walk away from a playground with is
 * the code — so the card sits open on the TypeScript view rather than behind a
 * disclosure. It shares no state with the preset controls above it, which is
 * why it is a card of its own rather than a panel inside that one.
 */
export function Transfer() {
    const stages = usePipeline((state) => state.stages)
    const exportJson = usePipeline((state) => state.exportJson)
    const importJson = usePipeline((state) => state.importJson)
    const markStale = useRun((state) => state.markStale)

    const [view, setView] = useState<'code' | 'json'>('code')
    /**
     * What the user has typed into the JSON box, tagged with the pipeline it was
     * typed against.
     *
     * Both views are derived, so a card that stands open cannot show a stale
     * pipeline. The JSON box is editable, so an edit in progress has to win --
     * but only over the pipeline it was made against. Tagging it means a
     * pipeline change simply stops the draft applying, with no effect to fire
     * and no render in between showing the wrong thing.
     */
    const [draft, setDraft] = useState<{ of: unknown; text: string } | null>(null)
    const [problem, setProblem] = useState('')
    const [copied, setCopied] = useState(false)

    const code = pipelineCode(toDescriptors(stages))
    const json = draft?.of === stages ? draft.text : exportJson()

    const copy = async () => {
        await navigator.clipboard.writeText(view === 'code' ? code : json)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
    }

    return (
        <section className="transfer" aria-label="Pipeline source">
            <div className="transfer__head">
                <div className="tabs" role="tablist" aria-label="Format">
                    <button
                        className={`tab${view === 'code' ? ' is-on' : ''}`}
                        type="button"
                        role="tab"
                        aria-selected={view === 'code'}
                        onClick={() => setView('code')}
                    >
                        TypeScript
                    </button>
                    <button
                        className={`tab${view === 'json' ? ' is-on' : ''}`}
                        type="button"
                        role="tab"
                        aria-selected={view === 'json'}
                        onClick={() => setView('json')}
                    >
                        JSON
                    </button>
                </div>
                <span className="spacer" />
                <button className="ghost" type="button" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>

            {view === 'code' ? (
                <>
                    {/* Read-only: the pipeline is edited in the cards above, and
                        a round trip from source back into stages would be a
                        parser this demo has no business carrying. */}
                    <pre className="code">
                        <code>{highlightTs(code)}</code>
                    </pre>
                    <p className="transfer__note">
                        Add a <code>configure({'{ … }'})</code> call for asset paths and caching before
                        running it.
                    </p>
                </>
            ) : (
                <>
                    <textarea
                        className="transfer__json"
                        value={json}
                        spellCheck={false}
                        aria-label="Pipeline as JSON"
                        onChange={(event) => setDraft({ of: stages, text: event.target.value })}
                    />
                    <div className="transfer__actions">
                        <button
                            className="ghost"
                            type="button"
                            onClick={() => {
                                try {
                                    importJson(json)
                                    setProblem('')
                                    markStale('Pipeline')
                                } catch (error) {
                                    setProblem((error as Error).message)
                                }
                            }}
                        >
                            Import this
                        </button>
                        <span className="transfer__note">
                            Paste a pipeline here to load it, or copy this one somewhere else.
                        </span>
                        {problem && <span className="warn">{problem}</span>}
                    </div>
                </>
            )}
        </section>
    )
}
