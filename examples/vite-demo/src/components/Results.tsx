/**
 * The finished row, one panel per output column.
 *
 * The display helpers return detached elements rather than markup, so each panel
 * hands its node to a ref -- which is also what keeps the library free of React.
 */

import type { Row } from '@stabrise/scaledp'
import { showBoxes, showImage, showNer, showText, visualizeNer } from '@stabrise/scaledp/display'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
    asDetector,
    asDocument,
    asImage,
    asNer,
    asOrientations,
    asScript,
    type OutputColumn,
    outputsOf,
} from '../lib/outputs'
import { useRun } from '../store/run'

/** Render a detached element into a div, replacing whatever was there. */
function Detached({ node, className }: { node: Node | null; className?: string }) {
    const host = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const element = host.current
        if (!element) return
        element.replaceChildren(node ?? document.createTextNode(''))
    }, [node])
    return <div className={className} ref={host} />
}

export function Results() {
    const rows = useRun((state) => state.rows)
    const selected = useRun((state) => state.selected)
    const select = useRun((state) => state.select)
    const row = rows[selected] ?? null
    const columns = useMemo(() => outputsOf(row), [row])
    const [active, setActive] = useState<string | null>(null)

    // The page and the reading are the two things worth seeing side by side, so
    // the last image goes on the left and everything else becomes a tab -- the
    // annotated one, when a draw stage ran.
    //
    // If that stage failed, fall back to the last image that did not, and report
    // the failure beneath it. A blank page area says less than the page plus the
    // reason its overlay is missing.
    const images = columns.filter((column) => column.kind === 'image')
    const failed = images.at(-1)?.exception ? images.at(-1) : null
    const page = [...images].reverse().find((image) => !image.exception) ?? images.at(-1) ?? null
    const panels = columns.filter(
        (column) => column !== page && column !== failed && column.kind !== 'orientations'
    )
    const orientations = columns.find((column) => column.kind === 'orientations')

    // Open on what the run was for. The old demo hardcoded "entities if any,
    // else text"; the same order still holds when the columns are derived.
    const preferred =
        panels.find((panel) => panel.kind === 'ner' && !panel.exception) ??
        panels.find((panel) => panel.kind === 'document' && !panel.exception) ??
        panels[0] ??
        null
    const current = panels.find((panel) => panel.name === active) ?? preferred

    if (!row || columns.length === 0) return null

    return (
        <section className="results">
            <div className="col col--page">
                {rows.length > 1 && <Pager rows={rows} selected={selected} onSelect={select} />}
                <h2 className="col__head">
                    Page
                    <span>
                        {page && !page.exception
                            ? `${asImage(page).width}×${asImage(page).height} · ${page.name}`
                            : ''}
                    </span>
                </h2>
                {page?.exception ? (
                    <p className="warn warn--error">{page.exception}</p>
                ) : (
                    <Detached className="framed" node={page ? showImage(asImage(page)) : null} />
                )}
                {failed && (
                    <p className="warn warn--error">
                        {failed.name}: {failed.exception}
                    </p>
                )}
                {orientations && <OrientationNote labels={asOrientations(orientations)} />}
            </div>

            <div className="col col--read">
                <div className="tabs" role="tablist">
                    {panels.map((panel) => (
                        <button
                            className={`tab${panel === current ? ' is-on' : ''}`}
                            type="button"
                            role="tab"
                            key={panel.name}
                            onClick={() => setActive(panel.name)}
                        >
                            {panel.name}
                            {panel.exception && <span className="tab__bad" title={panel.exception} />}
                        </button>
                    ))}
                </div>
                {current && <Panel column={current} all={columns} />}
            </div>
        </section>
    )
}

/**
 * Move between the rows a run produced.
 *
 * Usually pages of a PDF, so they are labelled by the `page` column where one
 * exists -- but `ImageCropBoxes` also emits a row per crop, and those have no
 * page of their own, so the position in the run is the fallback.
 */
function Pager({
    rows,
    selected,
    onSelect,
}: {
    rows: Row[]
    selected: number
    onSelect: (index: number) => void
}) {
    const labelFor = (row: Row, index: number): string => {
        const page = row.page
        return typeof page === 'number' ? `Page ${page + 1}` : `Result ${index + 1}`
    }

    return (
        <div className="pager">
            <button
                className="ghost"
                type="button"
                disabled={selected === 0}
                title="Previous"
                onClick={() => onSelect(selected - 1)}
            >
                ‹
            </button>
            <select
                aria-label="Page"
                value={selected}
                onChange={(event) => onSelect(Number(event.target.value))}
            >
                {rows.map((row, index) => (
                    // The position in the run is the identity: rows carry no id,
                    // and two pages can legitimately look identical.
                    // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                    <option key={index} value={index}>
                        {labelFor(row, index)}
                    </option>
                ))}
            </select>
            <button
                className="ghost"
                type="button"
                disabled={selected === rows.length - 1}
                title="Next"
                onClick={() => onSelect(selected + 1)}
            >
                ›
            </button>
            <span className="pager__count">of {rows.length}</span>
        </div>
    )
}

function OrientationNote({ labels }: { labels: string[] }) {
    const flipped = labels.filter((label) => label === '180_degree').length
    return (
        <p className="panel__note">
            {flipped > 0
                ? `Line orientation: ${flipped} of ${labels.length} regions turned 180°.`
                : `Line orientation: all ${labels.length} regions upright.`}
        </p>
    )
}

function Panel({ column, all }: { column: OutputColumn; all: OutputColumn[] }) {
    if (column.exception) return <p className="warn warn--error">{column.exception}</p>

    if (column.kind === 'document') return <DocumentPanel column={column} all={all} />
    if (column.kind === 'ner') return <NerPanel column={column} all={all} />
    if (column.kind === 'script') return <ScriptPanel column={column} />
    if (column.kind === 'detector') {
        const detected = asDetector(column)
        return (
            <>
                <p className="panel__note">
                    {detected.type} — {detected.bboxes.length} boxes
                </p>
                <Detached className="scroll" node={showBoxes(detected, 200)} />
            </>
        )
    }
    return <Detached className="framed" node={showImage(asImage(column))} />
}

/**
 * What OSD found. The presets are the reason the stage exists -- the script name
 * on its own does not tell you which recognizer can read the page.
 */
function ScriptPanel({ column }: { column: OutputColumn }) {
    const osd = asScript(column)
    if (!osd.script) {
        return (
            <p className="panel__note">
                No script identified. OSD needs a reasonable amount of text on the page.
            </p>
        )
    }
    return (
        <>
            <p className="panel__note">
                {osd.script} — score {osd.script_confidence.toFixed(2)} · page rotated{' '}
                {osd.orientation_degrees}°
            </p>
            {osd.presets.length > 0 ? (
                <p className="panel__note">
                    Presets that can read it:{' '}
                    {osd.presets.map((preset, index) => (
                        <span key={preset}>
                            {index > 0 && ', '}
                            <code>{preset}</code>
                        </span>
                    ))}
                </p>
            ) : (
                <p className="panel__note">No PaddleOCR preset here reads {osd.script}.</p>
            )}
        </>
    )
}

function DocumentPanel({ column, all }: { column: OutputColumn; all: OutputColumn[] }) {
    const document_ = asDocument(column)
    const [wrap, setWrap] = useState(false)
    const [view, setView] = useState<'text' | 'boxes'>('text')
    const [copied, setCopied] = useState(false)

    const ner = all.find((other) => other.kind === 'ner' && !other.exception)

    return (
        <>
            <div className="panel__bar">
                <span>
                    {document_.text.length} chars · {document_.text.split('\n').length} lines ·{' '}
                    {document_.bboxes.length} boxes
                </span>
                <span className="spacer" />
                <button
                    className={`ghost${view === 'text' ? ' is-on' : ''}`}
                    type="button"
                    onClick={() => setView('text')}
                >
                    Text
                </button>
                <button
                    className={`ghost${view === 'boxes' ? ' is-on' : ''}`}
                    type="button"
                    onClick={() => setView('boxes')}
                >
                    Boxes
                </button>
                <label className="chk">
                    <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
                </label>
                <button
                    className="ghost"
                    type="button"
                    onClick={async () => {
                        await navigator.clipboard.writeText(document_.text)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1200)
                    }}
                >
                    {copied ? 'Copied' : 'Copy text'}
                </button>
            </div>

            {view === 'text' ? (
                <div className="scroll" data-wrap={wrap || undefined}>
                    <Detached node={showText(document_)} />
                </div>
            ) : (
                <Detached className="scroll" node={showBoxes(document_, 200)} />
            )}

            {view === 'text' && ner && (
                <>
                    <h3 className="sub-head">Entities in context</h3>
                    <Detached className="scroll" node={visualizeNer(document_, asNer(ner))} />
                </>
            )}
        </>
    )
}

function NerPanel({ column, all }: { column: OutputColumn; all: OutputColumn[] }) {
    const ner = asNer(column)
    const document_ = all.find((other) => other.kind === 'document' && !other.exception)

    if (ner.entities.length === 0) {
        return <p className="panel__note">No entities scored above the threshold.</p>
    }
    return (
        <>
            <p className="panel__note">{ner.entities.length} entities</p>
            <Detached className="scroll" node={showNer(ner, { limit: 0 })} />
            {document_ && (
                <>
                    <h3 className="sub-head">In context</h3>
                    <Detached className="scroll" node={visualizeNer(asDocument(document_), ner)} />
                </>
            )}
        </>
    )
}
