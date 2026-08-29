/**
 * The front door.
 *
 * Deliberately in the builder's visual language -- dark housing, cyan for what
 * was found, magenta for what was understood -- so arriving at `/demo` from
 * here is not a change of room. Built with Tailwind rather than `style.css`,
 * which stays scoped to the builder.
 */

import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { ArrowRightIcon, BookOpenIcon, PlayIcon } from 'lucide-react'
import { Link } from 'react-router'
import { baseOptions } from '../lib/layout.shared'
import { PACKAGE_NAME, SITE_NAME, SITE_TAGLINE } from '../lib/site'

export function meta() {
    return [
        { title: `${SITE_NAME} — document pipelines in the browser` },
        {
            name: 'description',
            content:
                'PDF rendering, text detection, OCR and named-entity recognition composed as a pipeline, running entirely in the browser. No server, no upload.',
        },
    ]
}

const CAPABILITIES = [
    {
        title: 'Read',
        accent: 'text-detect',
        body: 'Render PDF pages at any DPI, or lift the existing text layer and skip OCR entirely. Word-level boxes throughout.',
        to: '/docs/stages/read',
    },
    {
        title: 'Detect',
        accent: 'text-detect',
        body: 'PaddleOCR and the DBNet ONNX model ScaleDP uses server-side, plus YOLO for signatures and faces.',
        to: '/docs/stages/detect',
    },
    {
        title: 'Recognise',
        accent: 'text-detect',
        body: 'PaddleOCR across thirteen language presets, or Tesseract over exactly the regions a detector found.',
        to: '/docs/stages/recognise',
    },
    {
        title: 'Understand',
        accent: 'text-entity',
        body: 'GLiNER zero-shot NER: entity types are plain-language labels given at call time, and every entity carries the boxes it came from.',
        to: '/docs/stages/understand',
    },
]

const ENGINES = [
    ['PaddleOCR', 'word', '~6 MB', 'yes', '13 language presets, best all-rounder'],
    ['DBNet ONNX', 'word', '~5 MB', 'yes', 'Detection only; mirrors ScaleDP server-side'],
    ['Tesseract', 'word', '~15 MB / lang', 'no', 'No ONNX; good for clean Latin scans'],
]

const SNIPPET = `import { Pipeline, configure } from '@stabrise/scaledp'
import { PdfToImage } from '@stabrise/scaledp/pdf'
import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'
import { GlinerNer } from '@stabrise/scaledp/ner'

configure({ cache: 'indexeddb', pdf: { workerSrc: '/pdf.worker.min.mjs' } })

const pipeline = new Pipeline([
    new PdfToImage({ resolution: 300 }),
    new PaddleTextRecognizer({ preset: 'v6-small', keepFormatting: true }),
    new GlinerNer({ labels: ['person', 'organization', 'email', 'phone'] }),
])

const rows = await pipeline.transform(file)`

export default function Home() {
    return (
        <HomeLayout {...baseOptions()}>
            <main className="flex flex-1 flex-col">
                {/* Hero */}
                <section className="relative overflow-hidden border-b border-fd-border">
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_-20%,rgba(63,201,245,0.16),transparent_70%)]"
                    />
                    <div className="relative mx-auto w-full max-w-5xl px-6 py-24 sm:py-32">
                        <p className="font-mono text-xs uppercase tracking-[0.2em] text-detect">
                            {PACKAGE_NAME}
                        </p>
                        <h1 className="mt-5 max-w-3xl font-display text-4xl leading-[1.1] font-bold text-balance sm:text-6xl">
                            Process a document{' '}
                            <em className="text-detect not-italic">without sending it anywhere.</em>
                        </h1>
                        <p className="mt-6 max-w-2xl text-lg text-fd-muted-foreground text-pretty">
                            {SITE_TAGLINE}. PDF rendering, text detection, OCR and entity recognition compose
                            into one pipeline and run on WebAssembly or WebGPU — in the tab. The file never
                            leaves the machine, which is the point for anything sensitive.
                        </p>

                        <div className="mt-10 flex flex-wrap gap-3">
                            <Link
                                to="/demo"
                                className="inline-flex items-center gap-2 rounded-lg bg-detect px-5 py-2.5 font-medium text-housing transition-opacity hover:opacity-90"
                            >
                                <PlayIcon className="size-4" aria-hidden="true" />
                                Try it on your own file
                            </Link>
                            <Link
                                to="/docs"
                                className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
                            >
                                <BookOpenIcon className="size-4" aria-hidden="true" />
                                Read the docs
                            </Link>
                        </div>

                        <p className="mt-6 font-mono text-xs text-fd-muted-foreground">
                            npm install @stabrise/scaledp
                        </p>
                    </div>
                </section>

                {/* What it does */}
                <section className="mx-auto w-full max-w-5xl px-6 py-16">
                    <div className="grid gap-4 sm:grid-cols-2">
                        {CAPABILITIES.map((item) => (
                            <Link
                                key={item.title}
                                to={item.to}
                                className="group rounded-xl border border-fd-border bg-fd-card p-6 transition-colors hover:border-detect/50"
                            >
                                <h2
                                    className={`font-mono text-xs uppercase tracking-[0.18em] ${item.accent}`}
                                >
                                    {item.title}
                                </h2>
                                <p className="mt-3 text-sm text-fd-muted-foreground">{item.body}</p>
                                <span className="mt-4 inline-flex items-center gap-1 text-sm text-fd-foreground">
                                    Stages
                                    <ArrowRightIcon
                                        className="size-3.5 transition-transform group-hover:translate-x-0.5"
                                        aria-hidden="true"
                                    />
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>

                {/* The shape of the API */}
                <section className="border-y border-fd-border bg-fd-card/40">
                    <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-16 lg:grid-cols-[1fr_1.2fr]">
                        <div>
                            <h2 className="font-display text-2xl font-bold">
                                The same pipeline, minus the cluster
                            </h2>
                            <p className="mt-4 text-fd-muted-foreground">
                                It mirrors the{' '}
                                <a
                                    className="text-detect underline underline-offset-4"
                                    href="https://github.com/StabRise/ScaleDP"
                                >
                                    ScaleDP
                                </a>{' '}
                                Python library — same stages, same parameter names, same schemas — so a
                                pipeline reads the same in both. What differs is the runtime: no Spark, no
                                server.
                            </p>
                            <Link
                                to="/docs/porting-from-python"
                                className="mt-6 inline-flex items-center gap-1 text-sm text-detect underline underline-offset-4"
                            >
                                Porting from Python ScaleDP
                            </Link>
                        </div>
                        <pre className="overflow-x-auto rounded-xl border border-fd-border bg-fd-background p-5 font-mono text-[13px] leading-relaxed">
                            <code>{SNIPPET}</code>
                        </pre>
                    </div>
                </section>

                {/* Engines */}
                <section className="mx-auto w-full max-w-5xl px-6 py-16">
                    <h2 className="font-display text-2xl font-bold">Choosing an OCR engine</h2>
                    <div className="mt-6 overflow-x-auto">
                        <table className="w-full min-w-[40rem] border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-fd-border text-left">
                                    {['Engine', 'Box level', 'Models fetched', 'WebGPU', 'Notes'].map(
                                        (heading) => (
                                            <th
                                                key={heading}
                                                className="py-2 pr-4 font-mono text-xs font-normal uppercase tracking-wide text-fd-muted-foreground"
                                            >
                                                {heading}
                                            </th>
                                        )
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {ENGINES.map(([name, level, size, gpu, note]) => (
                                    <tr key={name} className="border-b border-fd-border/60">
                                        <td className="py-3 pr-4 font-mono text-detect">{name}</td>
                                        <td className="py-3 pr-4">{level}</td>
                                        <td className="py-3 pr-4 font-mono text-xs">{size}</td>
                                        <td className="py-3 pr-4">{gpu}</td>
                                        <td className="py-3 pr-4 text-fd-muted-foreground">{note}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* Errors */}
                <section className="border-t border-fd-border">
                    <div className="mx-auto w-full max-w-5xl px-6 py-16">
                        <h2 className="font-display text-2xl font-bold">One bad page is one bad page</h2>
                        <p className="mt-4 max-w-2xl text-fd-muted-foreground">
                            Every output schema carries an{' '}
                            <code className="font-mono text-detect">exception</code> field. A stage that fails
                            records the message there and the pipeline continues, so one unreadable scan does
                            not lose the other forty. Pass{' '}
                            <code className="font-mono text-detect">propagateError: true</code> to opt into
                            throwing.
                        </p>
                        <Link
                            to="/docs/concepts/error-contract"
                            className="mt-6 inline-flex items-center gap-1 text-sm text-detect underline underline-offset-4"
                        >
                            The error contract
                        </Link>
                    </div>
                </section>
            </main>
        </HomeLayout>
    )
}
