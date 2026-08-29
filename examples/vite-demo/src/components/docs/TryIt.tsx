/**
 * "Open in builder" -- the link that turns a code block into something running.
 *
 * Takes the same `StageDescriptor[]` the snippet above it constructs, so the
 * two cannot describe different pipelines without someone noticing.
 *
 * `label` rather than children, because MDX cannot parse a multi-line array of
 * object literals inside an attribute on an element that *has* children -- a
 * line beginning with `{` ends the expression. Self-closing parses fine, so the
 * pipelines stay readable in the source.
 */

import type { StageDescriptor } from '@stabrise/scaledp/registry'
import { PlayIcon } from 'lucide-react'
import { Link } from 'react-router'
import { builderHref } from '../../lib/deeplink'

export function TryIt({ stages, label = 'Open in builder' }: { stages: StageDescriptor[]; label?: string }) {
    return (
        <Link
            to={builderHref(stages)}
            className="not-prose my-6 inline-flex items-center gap-2 rounded-lg border border-detect/40 bg-detect/10 px-4 py-2 font-mono text-sm text-detect no-underline transition-colors hover:bg-detect/20"
        >
            <PlayIcon className="size-4" aria-hidden="true" />
            {label}
        </Link>
    )
}
