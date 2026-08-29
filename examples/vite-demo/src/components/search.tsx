/**
 * The search dialog, loaded when it is opened.
 *
 * Orama plus the dialog is about 300 kB, and most visits never press ⌘K.
 * `RootProvider` mounts this on every page, so the split has to be here rather
 * than in the implementation.
 */

import type { SharedProps } from 'fumadocs-ui/contexts/search'
import { lazy } from 'react'

const Dialog = lazy(() => import('./search-dialog'))

export function SearchDialog(props: SharedProps) {
    return <Dialog {...props} />
}
