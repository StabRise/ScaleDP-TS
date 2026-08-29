/**
 * One widget per parameter kind.
 *
 * Everything the form knows comes from the stage's `StageParamSpec`: the widget,
 * the range, the enum options, whether it may be left empty. Nothing about any
 * particular stage is written here.
 */

import type { StageParamSpec } from '@stabrise/scaledp/registry'
import { useState } from 'react'
import type { Column } from '../lib/columns'
import { effective, type StageNode, same } from '../store/pipeline'

interface Props {
    stage: StageNode
    param: StageParamSpec
    /** Columns written upstream, offered as suggestions for column params. */
    columns: Column[]
    defaults: Readonly<Record<string, unknown>>
    onChange: (key: string, value: unknown) => void
    onReset: (key: string) => void
}

const asList = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : '')

/** What a position in a `columns` list is for, from the spec's `accepts`. */
function slotTitle(param: StageParamSpec, position: number): string {
    const kinds = param.accepts
    if (!kinds || kinds.length === 0) return ''
    const kind = kinds[Math.min(position, kinds.length - 1)]
    return position === 0 ? `the ${kind}` : `${kind} #${position}`
}

const parseList = (text: string): string[] =>
    text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

/**
 * A comma-separated list, typed rather than parsed out from under you.
 *
 * The value in the store is a `string[]`, so rendering `value.join(', ')` back
 * into the input means the comma you just pressed parses to nothing and
 * disappears on the next render -- `eng,` becomes `eng`, and a second language
 * can never be typed. The raw text is kept here instead, and used only while it
 * still describes the value in the store: a revert, a preset load or one of the
 * toggles below changes the array underneath, and the field follows.
 */
function ListInput({
    id,
    value,
    empty,
    onChange,
}: {
    id: string
    value: unknown
    empty: boolean | undefined
    onChange: (next: string[]) => void
}) {
    const [draft, setDraft] = useState<string | null>(null)
    const text = draft !== null && same(parseList(draft), value) ? draft : asList(value)

    return (
        <input
            id={id}
            type="text"
            value={text}
            data-empty={empty || undefined}
            placeholder="comma separated"
            onChange={(event) => {
                setDraft(event.target.value)
                onChange(parseList(event.target.value))
            }}
            onBlur={() => setDraft(null)}
        />
    )
}

export function ParamField({ stage, param, columns, defaults, onChange, onReset }: Props) {
    const value = effective(stage, param.key)
    const changed = !same(value, defaults[param.key])
    const id = `${stage.id}-${param.key}`
    const listId = `${id}-columns`

    const empty =
        param.required &&
        (value === '' || value === undefined || (Array.isArray(value) && value.length === 0))

    return (
        <div className={`field${changed ? ' field--changed' : ''}`}>
            <label className="field__key" htmlFor={id}>
                {param.label}
                {changed && (
                    <button
                        className="field__revert"
                        type="button"
                        title={`Back to ${JSON.stringify(defaults[param.key])}`}
                        onClick={(event) => {
                            event.preventDefault()
                            onReset(param.key)
                        }}
                    >
                        revert
                    </button>
                )}
            </label>

            {param.kind === 'boolean' && (
                // The checkbox is visually hidden -- kept in the accessibility
                // tree rather than collapsed to 0x0 -- so the track is only
                // clickable if a label ties the two together. Without this the
                // switch reads as a control and does nothing when pressed.
                <label className="switch" htmlFor={id}>
                    <input
                        id={id}
                        type="checkbox"
                        checked={Boolean(value)}
                        onChange={(event) => onChange(param.key, event.target.checked)}
                    />
                    <span className="switch__track">
                        <span className="switch__knob" />
                    </span>
                </label>
            )}

            {param.kind === 'number' && (
                <input
                    id={id}
                    type="number"
                    value={Number(value ?? 0)}
                    min={param.min}
                    max={param.max}
                    step={param.step ?? 'any'}
                    onChange={(event) => onChange(param.key, event.target.valueAsNumber)}
                />
            )}

            {param.kind === 'string' && (
                <input
                    id={id}
                    type="text"
                    value={String(value ?? '')}
                    data-empty={empty || undefined}
                    onChange={(event) => onChange(param.key, event.target.value)}
                />
            )}

            {param.kind === 'stringList' && (
                <>
                    <ListInput
                        id={id}
                        value={value}
                        empty={empty}
                        onChange={(next) => onChange(param.key, next)}
                    />
                    {/* The list stays open -- any string is valid -- but the
                        values that actually do something are not guessable, so
                        the known ones are offered as toggles. */}
                    {param.options && (
                        <span className="field__picks">
                            {param.options.map((option) => {
                                const current = Array.isArray(value) ? (value as string[]) : []
                                const on = current.includes(option.value)
                                return (
                                    <button
                                        className="pick"
                                        type="button"
                                        key={option.value}
                                        title={option.title}
                                        aria-pressed={on}
                                        onClick={() =>
                                            onChange(
                                                param.key,
                                                on
                                                    ? current.filter((v) => v !== option.value)
                                                    : [...current, option.value]
                                            )
                                        }
                                    >
                                        {option.label}
                                    </button>
                                )
                            })}
                        </span>
                    )}
                </>
            )}

            {param.kind === 'enum' && (
                <ColumnOrEnum
                    id={id}
                    value={String(value ?? '')}
                    options={param.options ?? []}
                    allowCustom={param.allowCustom === true}
                    onChange={(next) => onChange(param.key, next)}
                />
            )}

            {param.kind === 'column' && (
                <>
                    <input
                        id={id}
                        type="text"
                        list={listId}
                        value={String(value ?? '')}
                        onChange={(event) => onChange(param.key, event.target.value)}
                    />
                    <ColumnList id={listId} columns={columns} />
                </>
            )}

            {param.kind === 'columns' && (
                <span className="field__columns">
                    {(value as string[]).map((name, position) => {
                        const list = value as string[]
                        // Entry 0 is the image every one of these stages reads;
                        // the rest are the box sources. Removing the image
                        // would silently promote a box column into its place,
                        // so only the optional tail can go.
                        const removable =
                            param.arity === undefined && position > 0 && list.length > (param.minArity ?? 2)
                        return (
                            // Positions are the identity here: entry 0 is the
                            // image, entry 1 the boxes. Reordering is not a
                            // thing a fixed-arity list does.
                            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                            <span className="slot" key={position}>
                                <input
                                    id={position === 0 ? id : undefined}
                                    type="text"
                                    list={listId}
                                    value={name}
                                    title={slotTitle(param, position)}
                                    onChange={(event) => {
                                        const next = [...list]
                                        next[position] = event.target.value
                                        onChange(param.key, next)
                                    }}
                                />
                                {removable && (
                                    <button
                                        className="slot__drop"
                                        type="button"
                                        title={`Remove ${name || 'this column'}`}
                                        onClick={() =>
                                            onChange(
                                                param.key,
                                                list.filter((_, index) => index !== position)
                                            )
                                        }
                                    >
                                        ×
                                    </button>
                                )}
                            </span>
                        )
                    })}
                    {param.arity === undefined && (
                        <button
                            className="ghost"
                            type="button"
                            title="Add a box column"
                            onClick={() => onChange(param.key, [...(value as string[]), ''])}
                        >
                            +
                        </button>
                    )}
                    <ColumnList id={listId} columns={columns} />
                </span>
            )}

            {param.kind === 'color' && (
                <span className="field__color">
                    <input
                        id={id}
                        type="color"
                        value={typeof value === 'string' ? value : '#3fc9f5'}
                        onChange={(event) => onChange(param.key, event.target.value)}
                    />
                    <button
                        className="ghost"
                        type="button"
                        aria-pressed={value === null}
                        onClick={() => onChange(param.key, value === null ? '#3fc9f5' : null)}
                    >
                        {value === null ? 'by group' : 'fixed'}
                    </button>
                </span>
            )}

            {param.help && <span className="field__help">{param.help}</span>}
            {empty && <span className="field__warn">This stage needs a value here.</span>}
        </div>
    )
}

function ColumnList({ id, columns }: { id: string; columns: Column[] }) {
    return (
        <datalist id={id}>
            {columns.map((column) => (
                <option key={column.name} value={column.name}>
                    {column.kind}
                </option>
            ))}
        </datalist>
    )
}

/**
 * A select, with a text input alongside when the spec allows a value outside
 * the list -- a self-hosted model URL is not in any registry.
 */
function ColumnOrEnum({
    id,
    value,
    options,
    allowCustom,
    onChange,
}: {
    id: string
    value: string
    options: readonly { value: string; label: string; title?: string; disabled?: boolean }[]
    allowCustom: boolean
    onChange: (value: string) => void
}) {
    const known = options.some((option) => option.value === value)

    return (
        <span className="field__enum">
            <select
                id={id}
                value={known ? value : '__custom'}
                onChange={(event) => {
                    if (event.target.value !== '__custom') onChange(event.target.value)
                }}
            >
                {options.map((option) => (
                    <option
                        key={option.value}
                        value={option.value}
                        title={option.title}
                        disabled={option.disabled}
                    >
                        {option.label}
                    </option>
                ))}
                {allowCustom && <option value="__custom">Custom…</option>}
            </select>
            {allowCustom && !known && (
                <input type="text" value={value} onChange={(event) => onChange(event.target.value)} />
            )}
        </span>
    )
}
