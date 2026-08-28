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

/** Render a caught value the way Python writes a traceback into `exception`. */
export function formatException(stage: string, error: unknown): string {
    if (error instanceof Error) {
        return `${stage}: ${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
    }
    return `${stage}: ${String(error)}`
}
