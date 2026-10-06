/**
 * ScaleDP stages never throw by default: a failure is captured into the output
 * schema's `exception` field so a pipeline always completes and partial results
 * survive. `propagateError: true` opts a stage into throwing instead.
 */

export class ScaleDpError extends Error {
    constructor(
        message: string,
        readonly stage: string,
        override readonly cause?: unknown
    ) {
        super(message)
        this.name = 'ScaleDpError'
    }
}

export class ImageError extends ScaleDpError {
    override readonly name = 'ImageError'
}
export class OcrError extends ScaleDpError {
    override readonly name = 'OcrError'
}
export class DetectionError extends ScaleDpError {
    override readonly name = 'DetectionError'
}
export class NerError extends ScaleDpError {
    override readonly name = 'NerError'
}
export class ConfigError extends ScaleDpError {
    override readonly name = 'ConfigError'
}

/**
 * Reasons a stage had nothing to process, as opposed to failing at it.
 *
 * A page with no embedded pictures is the common case: the hybrid PDF pipeline
 * still reads it through its text layer, so every stage that would have worked
 * on the pictures has simply nothing to do. Such a reason is still written to
 * `exception`, which is what lets downstream stages and `PdfMergeImageText`
 * recognise it, but it is passed along verbatim rather than wrapped as an
 * upstream failure -- as Python ScaleDP passes an upstream `exception` -- and
 * `isSkipped` lets a caller show it as a warning rather than an error.
 */
export const NO_EMBEDDED_IMAGES = 'This page has no embedded images to read.'

const SKIP_REASONS: ReadonlySet<string> = new Set([NO_EMBEDDED_IMAGES])

/** Whether an `exception` records a stage with nothing to do rather than a failure. */
export function isSkipped(exception: string | undefined | null): boolean {
    return exception != null && SKIP_REASONS.has(exception)
}

/** Thrown to record a skip: `formatException` writes its message verbatim. */
export class SkipError extends ScaleDpError {
    override readonly name = 'SkipError'
}

/**
 * The error a stage throws when its input carries an `exception` from upstream.
 *
 * A skip passes through unchanged, so the whole chain reports the one reason
 * the page had nothing to read. Anything else is a real failure and is wrapped,
 * naming the stage that noticed it.
 */
export function upstreamError(exception: string, stage: string, make: (message: string) => Error): Error {
    return isSkipped(exception)
        ? new SkipError(exception, stage)
        : make(`Upstream stage failed: ${exception}`)
}

/** Render a caught value the way Python writes a traceback into `exception`. */
export function formatException(stage: string, error: unknown): string {
    if (error instanceof SkipError) return error.message
    if (error instanceof Error) {
        return `${stage}: ${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
    }
    return `${stage}: ${String(error)}`
}
