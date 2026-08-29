import { RootProvider } from 'fumadocs-ui/provider/react-router'
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import './app.css'
import type { Route } from './+types/root'
import { SearchDialog } from './components/search'
import NotFound from './routes/not-found'

export const links: Route.LinksFunction = () => [
    // crossorigin is required: the site sets COEP require-corp for threaded
    // WASM, which blocks cross-origin subresources unless they are CORS-fetched.
    { rel: 'preconnect', href: 'https://fonts.googleapis.com', crossOrigin: 'anonymous' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
    {
        rel: 'stylesheet',
        crossOrigin: 'anonymous',
        href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap',
    },
]

export function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <Meta />
                <Links />
            </head>
            <body className="flex min-h-screen flex-col font-display">
                <RootProvider search={{ SearchDialog }}>{children}</RootProvider>
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    )
}

export default function App() {
    return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
    if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />

    const details = isRouteErrorResponse(error)
        ? error.statusText
        : error instanceof Error
          ? error.message
          : 'An unexpected error occurred.'

    return (
        <main className="mx-auto w-full max-w-3xl p-8">
            <h1 className="font-display text-2xl">Something broke</h1>
            <p className="mt-2 text-fd-muted-foreground">{details}</p>
            {import.meta.env.DEV && error instanceof Error && error.stack && (
                <pre className="mt-6 overflow-x-auto rounded-lg border border-fd-border p-4 text-xs">
                    <code>{error.stack}</code>
                </pre>
            )}
        </main>
    )
}
