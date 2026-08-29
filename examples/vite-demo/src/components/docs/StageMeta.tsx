/**
 * The header strip on a stage page: where the class lives, what it needs
 * installed, and what it moves between columns.
 *
 * Read off `STAGE_SPECS` rather than written into each page, because the
 * catalogue is what the builder and the code generator already believe.
 */

import { getStageSpec } from '@stabrise/scaledp/registry'

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
        <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-fd-muted-foreground">{label}</dt>
        <dd className="font-mono text-sm">{children}</dd>
    </div>
)

export function StageMeta({ type }: { type: string }) {
    const spec = getStageSpec(type)
    if (!spec) return null

    return (
        <dl className="not-prose my-6 divide-y divide-fd-border rounded-xl border border-fd-border bg-fd-card px-4 py-2">
            <Row label="Import">
                {/* `subpath` is the full specifier, not a suffix. */}
                <code>{`import { ${spec.type} } from '${spec.subpath}'`}</code>
            </Row>
            <Row label="Group">{spec.group}</Row>
            <Row label="Reads">{spec.consumes.length ? spec.consumes.join(', ') : '—'}</Row>
            <Row label="Writes">
                {[spec.produces, ...(spec.alsoProduces ?? []).map((extra) => extra.kind)].join(', ')}
            </Row>
            <Row label="Needs">
                {spec.peer ? (
                    <code>{spec.peer}</code>
                ) : (
                    <span className="text-fd-muted-foreground">nothing</span>
                )}
            </Row>
            {(spec.expands || spec.terminal) && (
                <Row label="Note">
                    {spec.expands ? 'Expands one row into several.' : 'Terminal — output is for looking at.'}
                </Row>
            )}
        </dl>
    )
}
