/**
 * The finished row, one panel per output column.
 *
 * The display helpers return detached elements rather than markup, so each panel
 * hands its node to a ref -- which is also what keeps the library free of React.
 */

import type { Row } from '@stabrise/scaledp'
import { isSkipped } from '@stabrise/scaledp'
import type { Box, ScaleDpImage } from '@stabrise/scaledp/display'
import { boxOverlay, showBoxes, showImage, showNer, showText, visualizeNer } from '@stabrise/scaledp/display'
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { boxesAt, type PagePoint } from '../lib/hit-test'
import {
    asDetector,
    asDocument,
    asImage,
    asList,
    asNer,
    asOrientations,
    asScript,
    type OutputColumn,
    outputsOf,
} from '../lib/outputs'
import { useRun } from '../store/run'

/**
 * Publish the page's rendered height as `--page-height` on `host`.
 *
 * A page is as tall as its own aspect ratio makes it at whatever width the
 * column happens to get, so only the browser knows the number -- and it changes
 * with the window, the sidebar, and the page itself. An observer is the one way
 * to keep the panel beside it exactly as tall.
 */
function usePageHeight(host: RefObject<HTMLElement | null>): (node: HTMLElement | null) => void {
    // A callback ref, not a RefObject: a ref never re-runs an effect, so the
    // observer would have to be rebuilt on every render -- once per box picked.
    // This attaches exactly when the element it watches changes.
    const [measured, setMeasured] = useState<HTMLElement | null>(null)

    useEffect(() => {
        const target = host.current
        if (!measured || !target) return

        const observer = new ResizeObserver(([entry]) => {
            // The border box, not `contentRect`: the frame's own padding and
            // border are part of what the reader sees as the page's height, and
            // the panel matching it is bordered and padded the same way.
            const height = entry?.borderBoxSize?.[0]?.blockSize ?? 0
            // Zero while an image is still decoding; writing it would collapse
            // the panel to its floor and then snap back a frame later.
            if (height > 0) target.style.setProperty('--page-height', `${Math.round(height)}px`)
        })
        observer.observe(measured)
        return () => observer.disconnect()
    }, [measured, host])

    return setMeasured
}

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

    // The box a reader picked in the panel on the right, outlined on the page on
    // the left. It lives up here because the two are separate columns; the table
    // that sets it also clears it, on its way out as well as on a new list.
    const [picked, setPicked] = useState<Box | null>(null)

    // The other direction: a click on the page, in image pixels, which the boxes
    // table resolves to a row. Only offered while a table that can be picked
    // from is showing, since otherwise a click has nothing to land on.
    const [pagePoint, setPagePoint] = useState<PagePoint | null>(null)
    const [pageClickable, setPageClickable] = useState(false)
    // A point is a place on one page; on the next page it means nothing.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `selected` is the trigger
    useEffect(() => setPagePoint(null), [selected])

    const results = useRef<HTMLElement>(null)
    const pageFrame = usePageHeight(results)

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
        <section className="results" ref={results}>
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
                    <PageImage
                        image={page ? asImage(page) : null}
                        picked={picked}
                        frame={pageFrame}
                        onPoint={pageClickable ? setPagePoint : null}
                    />
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
                            {panel.exception && (
                                <span
                                    className={`tab__bad${isSkipped(panel.exception) ? ' tab__bad--skip' : ''}`}
                                    title={panel.exception}
                                />
                            )}
                        </button>
                    ))}
                </div>
                {current && (
                    <Panel
                        column={current}
                        all={columns}
                        page={page ? asImage(page) : null}
                        onPick={setPicked}
                        pagePoint={pagePoint}
                        onPickable={setPageClickable}
                    />
                )}
            </div>
        </section>
    )
}

/**
 * The page, with the picked box outlined over it.
 *
 * The overlay is a sibling of the `<img>`, not drawn into it: the picture is
 * whatever the pipeline produced and stays untouched, while the outline can
 * change as often as a reader clicks. Both are stretched to the same frame, so
 * an SVG authored in image pixels lands exactly on the pixels it describes.
 */
function PageImage({
    image,
    picked,
    frame,
    onPoint,
}: {
    image: ScaleDpImage | null
    picked: Box | null
    frame: (node: HTMLElement | null) => void
    /** Set when a click on the page can pick a box; null leaves the page inert. */
    onPoint: ((point: PagePoint) => void) | null
}) {
    const seq = useRef(0)
    // Keyed on the bytes, so the object URL is not rebuilt on every pick --
    // showImage revokes it on load, and a second render would race the first.
    const node = useMemo(() => (image ? showImage(image) : null), [image])
    const overlay = useMemo(
        () => (image && picked ? boxOverlay([picked], image, { fill: 'rgba(255,45,85,0.14)' }) : null),
        [image, picked]
    )

    // The picture is scaled to its column, so the click is mapped back through
    // the rendered size to the image's own pixels -- the space boxes live in.
    const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const img = event.currentTarget.querySelector('img')
        if (!onPoint || !image || !img) return
        const rect = img.getBoundingClientRect()
        if (rect.width === 0) return
        const scale = image.width / rect.width
        const x = (event.clientX - rect.left) * scale
        const y = (event.clientY - rect.top) * scale
        if (x < 0 || y < 0 || x > image.width || y > image.height) return
        seq.current += 1
        // Four screen pixels of slack, whatever the zoom: a one-line box is
        // only a few pixels tall at column width.
        onPoint({ x, y, tolerance: 4 * scale, seq: seq.current })
    }

    return (
        // A mouse convenience on top of the table, which stays the keyboard
        // route to the same selection -- so no role or key handler here.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the boxes table is the accessible path
        // biome-ignore lint/a11y/noStaticElementInteractions: see above
        <div
            className={`framed page-frame${onPoint ? ' page-frame--pickable' : ''}`}
            ref={frame}
            onClick={onClick}
            title={onPoint ? 'Click a box to find it in the table' : undefined}
        >
            <Detached node={node} />
            {overlay && <Detached className="page-frame__overlay" node={overlay} />}
        </div>
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

interface PanelProps {
    column: OutputColumn
    all: OutputColumn[]
    /** The image the left-hand column is showing, for deciding what can be picked. */
    page: ScaleDpImage | null
    onPick: (box: Box | null) => void
    /**
     * Whether this panel's boxes are in the page's coordinates.
     *
     * A gathered list's items are not: each belongs to the picture its row was
     * cut from, so outlining one on the page would point confidently at the
     * wrong place.
     */
    pageSpace?: boolean
    /** The last click on the page, for a boxes table to resolve to a row. */
    pagePoint?: PagePoint | null
    /** Told whether a table that can be picked from is showing. */
    onPickable?: (pickable: boolean) => void
}

function Panel({ column, all, page, onPick, pageSpace = true, pagePoint, onPickable }: PanelProps) {
    if (column.exception) {
        return <p className={isSkipped(column.exception) ? 'warn' : 'warn warn--error'}>{column.exception}</p>
    }

    if (column.kind === 'document') {
        return (
            <DocumentPanel
                column={column}
                all={all}
                page={page}
                onPick={onPick}
                pageSpace={pageSpace}
                pagePoint={pagePoint}
                onPickable={onPickable}
            />
        )
    }
    if (column.kind === 'ner') return <NerPanel column={column} all={all} />
    if (column.kind === 'script') return <ScriptPanel column={column} />
    if (column.kind === 'list') return <ListPanel column={column} all={all} page={page} onPick={onPick} />

    if (column.kind === 'detector') {
        const detected = asDetector(column)
        return (
            <>
                <p className="panel__note">
                    {detected.type} — {detected.bboxes.length} boxes
                </p>
                <BoxTable
                    boxes={detected.bboxes}
                    page={page}
                    onPick={onPick}
                    pageSpace={pageSpace}
                    pagePoint={pagePoint}
                    onPickable={onPickable}
                />
            </>
        )
    }
    return <Detached className="framed" node={showImage(asImage(column))} />
}

/**
 * The boxes table, with a click on a row outlining that box on the page.
 *
 * `showBoxes` builds the table and tags each row with its index, so the click is
 * one delegated listener rather than a React row per box -- and the table is
 * built once however often the selection changes.
 *
 * Picking is offered only when the boxes are in the page's own coordinates. A
 * list item's boxes are in the coordinates of the picture it was cut from, and
 * outlining those on the page would point confidently at the wrong place.
 */
function BoxTable({
    boxes,
    page,
    onPick,
    pageSpace = true,
    pagePoint,
    onPickable,
}: {
    boxes: Box[]
    page: ScaleDpImage | null
    onPick: (box: Box | null) => void
    /** False for a gathered list's items, which belong to their own picture. */
    pageSpace?: boolean
    pagePoint?: PagePoint | null
    onPickable?: (pickable: boolean) => void
}) {
    const host = useRef<HTMLDivElement>(null)
    const [picked, setPicked] = useState<number | null>(null)
    // Mirrored in a ref so `pick` can read the current selection without listing
    // it as a dependency -- otherwise every click would rebuild the callback and
    // rewire all two hundred rows.
    const pickedRef = useRef<number | null>(null)
    // Unlimited: showBoxes's own search box is how a long table stays usable,
    // rather than truncating rows out of it before a reader can find them.
    const node = useMemo(() => showBoxes({ path: '', type: '', exception: '', bboxes: boxes }, 0), [boxes])
    // Fitting inside the page is necessary but nowhere near sufficient: boxes
    // from a 1000x300 picture all fit inside a 1700x2200 page while meaning
    // something else entirely. `pageSpace` is what actually settles it.
    const pickable = pageSpace && page !== null && boxesFitIn(boxes, page)

    // A different set of boxes means the old index points at nothing, and so
    // does leaving the panel entirely -- hence the cleanup, without which
    // switching to the image tab would leave the last outline stranded.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `boxes` is the trigger, not a value the body reads
    useEffect(() => {
        pickedRef.current = null
        setPicked(null)
        onPick(null)
        return () => onPick(null)
    }, [boxes, onPick])

    const select = useCallback(
        (next: number | null) => {
            pickedRef.current = next
            setPicked(next)
            // Deliberately outside any state updater: React runs those during
            // render, and telling a parent to update from there is an error.
            onPick(next === null ? null : (boxes[next] ?? null))
        },
        [boxes, onPick]
    )

    // Clicking the picked row again clears it, so the page can be seen
    // unobstructed without hunting for a deselect control.
    const pick = useCallback((index: number) => select(pickedRef.current === index ? null : index), [select])

    useEffect(() => {
        onPickable?.(pickable)
        return () => onPickable?.(false)
    }, [pickable, onPickable])

    // A click on the page, resolved to the innermost box under it. Clicking the
    // same spot again steps outwards through the boxes stacked there -- the word,
    // then its line, then the region -- and a click on bare page clears.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new click (`seq`) is the trigger; the rest is read at that moment
    useEffect(() => {
        if (!pagePoint || !pickable) return
        const hits = boxesAt(boxes, pagePoint)
        if (hits.length === 0) {
            select(null)
            return
        }
        const current = pickedRef.current === null ? -1 : hits.indexOf(pickedRef.current)
        const next = hits[(current + 1) % hits.length] as number
        select(next)
        host.current
            ?.querySelector(`[data-box-index="${next}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }, [pagePoint?.seq])

    // The rows are wired where they are built rather than as React children:
    // `showBoxes` owns the table, and re-rendering it per click would throw away
    // the reader's scroll position in a list that can run to two hundred rows.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `node` says the table was rebuilt, so the rows are new ones to wire
    useEffect(() => {
        const rows = host.current?.querySelectorAll<HTMLElement>('[data-box-index]')
        if (!rows || !pickable) return

        const listeners: (() => void)[] = []
        for (const row of rows) {
            const index = Number(row.dataset.boxIndex)
            row.setAttribute('role', 'button')
            row.tabIndex = 0

            const onClick = () => pick(index)
            const onKeyDown = (event: KeyboardEvent) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                pick(index)
            }
            row.addEventListener('click', onClick)
            row.addEventListener('keydown', onKeyDown)
            listeners.push(() => {
                row.removeEventListener('click', onClick)
                row.removeEventListener('keydown', onKeyDown)
            })
        }
        return () => {
            for (const off of listeners) off()
        }
    }, [node, pickable, pick])

    // Marking the selection imperatively for the same reason: one class toggle
    // beats rebuilding the table.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `node` says the rows were replaced and need marking again
    useEffect(() => {
        for (const row of host.current?.querySelectorAll('[data-box-index]') ?? []) {
            const index = Number((row as HTMLElement).dataset.boxIndex)
            row.classList.toggle('is-picked', index === picked)
            row.setAttribute('aria-pressed', String(index === picked))
        }
    }, [picked, node])

    return (
        <>
            <p className="panel__note">
                {pickable
                    ? 'Click a row to outline that box on the page, or a box on the page to find its row.'
                    : 'These boxes are in the coordinates of the picture they were read from, not the page.'}
            </p>
            <div className={`scroll${pickable ? ' scroll--pickable' : ''}`} ref={host}>
                <Detached node={node} />
            </div>
        </>
    )
}

/** True when every box lies inside the image, so it can be outlined on it. */
function boxesFitIn(boxes: readonly Box[], image: ScaleDpImage): boolean {
    if (image.width === 0 || image.height === 0) return false
    return boxes.every(
        (box) =>
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= image.width + 1 &&
            box.y + box.height <= image.height + 1
    )
}

/**
 * Every item a reduced row was built from, each drawn as its own panel.
 *
 * A stage that folds several rows into one leaves the rest unviewable, and for a
 * hybrid PDF read that is the most interesting evidence there is: which pictures
 * were found, what was detected in each and what came back. Delegating to
 * `Panel` means one list handles all of them -- there is no kind this can show
 * that a column of its own could not.
 */
function ListPanel({ column, all, page, onPick }: PanelProps) {
    const items = asList(column)
    return (
        <>
            <p className="panel__note">
                {items.length} {items.length === 1 ? 'item' : 'items'}
            </p>
            {items.map((item, index) => (
                // Position is the identity: gathered values carry no id of their
                // own, and two copies of one logo are indistinguishable.
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                <section className="strip__item" key={index}>
                    <p className="panel__note">{captionFor(item, index)}</p>
                    <Panel column={item} all={all} page={page} onPick={onPick} pageSpace={false} />
                </section>
            ))}
        </>
    )
}

/** A one-line label saying which item this is and what is in it. */
function captionFor(item: OutputColumn, index: number): string {
    const ordinal = `${index + 1}.`
    if (item.kind === 'image') {
        const image = asImage(item)
        const size = `${image.width}×${image.height}`
        return image.resolution > 0 ? `${ordinal} ${size} · ${image.resolution} dpi` : `${ordinal} ${size}`
    }
    if (item.kind === 'detector') return `${ordinal} ${asDetector(item).bboxes.length} boxes`
    if (item.kind === 'document') {
        const document = asDocument(item)
        return `${ordinal} ${document.bboxes.length} boxes · ${document.text.length} chars`
    }
    return ordinal
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

function DocumentPanel({ column, all, page, onPick, pageSpace, pagePoint, onPickable }: PanelProps) {
    const document_ = asDocument(column)
    const [wrap, setWrap] = useState(false)
    const [view, setView] = useState<'text' | 'boxes'>('text')

    // The text view has no rows to light up, so a click on the page brings the
    // boxes table forward -- which then resolves the very click that opened it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new click (`seq`) is the trigger
    useEffect(() => {
        if (pagePoint) setView('boxes')
    }, [pagePoint?.seq])

    // Clickable in the text view too, since a click there is what opens the
    // table. Whether the boxes are in page space is the table's call, made the
    // same way it makes it for rows.
    const pageSpaceBoxes = pageSpace !== false && page !== null && boxesFitIn(document_.bboxes, page)
    useEffect(() => {
        if (view === 'boxes') return
        onPickable?.(pageSpaceBoxes)
        return () => onPickable?.(false)
    }, [view, pageSpaceBoxes, onPickable])
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
                <div className="scroll">
                    {/*
                     * The panel owns the scrolling, so the helper is told not to:
                     * its own cap is the same 30rem and the two would nest. Wrap
                     * goes through `preserveLayout` for the same reason -- the
                     * helper writes `white-space` inline, which no rule here can
                     * override without `!important`.
                     */}
                    <Detached node={showText(document_, { maxHeight: 'none', preserveLayout: !wrap })} />
                </div>
            ) : (
                <BoxTable
                    boxes={document_.bboxes}
                    page={page}
                    onPick={onPick}
                    pageSpace={pageSpace}
                    pagePoint={pagePoint}
                    onPickable={onPickable}
                />
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
