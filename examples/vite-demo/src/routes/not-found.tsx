import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { Link } from 'react-router'
import { baseOptions } from '../lib/layout.shared'

export default function NotFound() {
    return (
        <HomeLayout {...baseOptions()}>
            <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center p-8">
                <p className="font-mono text-sm text-detect">404</p>
                <h1 className="mt-2 font-display text-3xl">No page here</h1>
                <p className="mt-3 text-fd-muted-foreground">
                    The link may be from an older version of the docs.
                </p>
                <div className="mt-6 flex gap-3">
                    <Link className="text-detect underline underline-offset-4" to="/docs">
                        Documentation
                    </Link>
                    <Link className="text-detect underline underline-offset-4" to="/demo">
                        Live demo
                    </Link>
                </div>
            </main>
        </HomeLayout>
    )
}
