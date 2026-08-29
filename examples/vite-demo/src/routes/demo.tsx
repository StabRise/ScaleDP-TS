/**
 * The builder.
 *
 * Nothing in `../demo-entry` may be evaluated during the build. SPA mode still
 * renders each route in Node to produce its HTML, and that module graph reaches
 * `OffscreenCanvas`, `ImageBitmap`, `navigator.gpu` and IndexedDB the moment it
 * is imported. Gating on state an effect sets -- rather than only on
 * `<Suspense>` -- is what keeps `lazy()` from ever calling its factory there,
 * because the component is not rendered at all until the browser has it.
 *
 * The same effect does the `setup()` that used to live in `main.tsx`:
 * `configure()` has to land before any stage runs and needs an async WebGPU
 * probe, so the builder waits on it.
 */

import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { Capability } from '../lib/configure'
import { baseOptions } from '../lib/layout.shared'
import { SITE_NAME } from '../lib/site'

const DemoApp = lazy(() => import('../demo-entry'))

export function meta() {
    return [
        { title: `Demo — ${SITE_NAME}` },
        {
            name: 'description',
            content: 'Assemble a document pipeline and run it in this tab. Nothing is uploaded.',
        },
    ]
}

/**
 * The site header, on the builder too.
 *
 * `HomeLayout` is just the navbar plus its children, so it puts the same bar
 * over the builder that every other route shows -- theme switch included. The
 * builder's own palette is defined for both themes in `style.css`; the dark one
 * is the design (a dark surround raises the perceived contrast of the page you
 * are reading), and light is the same instrument on a bench.
 */
function Shell({ children }: { children: React.ReactNode }) {
    return (
        <HomeLayout {...baseOptions()} className="flex-1">
            {children}
        </HomeLayout>
    )
}

function Booting({ note }: { note: string }) {
    return (
        <div className="flex flex-1 items-center justify-center py-32">
            <p className="font-mono text-sm text-fd-muted-foreground">{note}</p>
        </div>
    )
}

export default function DemoRoute() {
    const [caps, setCaps] = useState<Capability[] | null>(null)

    useEffect(() => {
        let live = true
        // Dynamic for the same reason `DemoApp` is lazy: importing this module
        // pulls in the library.
        void import('../lib/configure').then(({ setup }) =>
            setup().then((next) => {
                if (live) setCaps(next)
            })
        )
        return () => {
            live = false
        }
    }, [])

    // `style.css` scopes its bare element rules to this attribute, so the
    // builder's `body` background and form styling do not follow the reader
    // onto the documentation.
    useEffect(() => {
        document.documentElement.dataset.demo = ''
        return () => {
            delete document.documentElement.dataset.demo
        }
    }, [])

    if (!caps)
        return (
            <Shell>
                <Booting note="starting the runtime…" />
            </Shell>
        )

    return (
        <Shell>
            <Suspense fallback={<Booting note="loading the builder…" />}>
                <DemoApp caps={caps} />
            </Suspense>
        </Shell>
    )
}
