/**
 * The TS analogue of `scaledp/params.py`.
 *
 * Python builds params from a frozen `defaultParams` map plus a coercion pass
 * (`HasDefaultEnum._set`) that unwraps enums, normalises `lang`, and runs any
 * `validate<Param>` hook. TypeScript needs neither a metaclass nor Param
 * objects -- an options object merged over a frozen default, with optional
 * per-key validators, covers the same ground with real types.
 */

export type Validator<T> = { [K in keyof T]?: (value: T[K], all: T) => void }

/** Params every stage accepts, mirroring the Python mixins. */
export interface BaseStageParams {
    /** Row field this stage reads. */
    inputCol: string
    /** Row field this stage writes. */
    outputCol: string
    /** Row field holding the source path; used to populate output `path`. */
    pathCol: string
    /** Row field holding the page index for multi-page inputs. */
    pageCol: string
    /** Keep `inputCol` in the output rows instead of dropping it. */
    keepInputData: boolean
    /** Throw on failure instead of recording it in the output's `exception`. */
    propagateError: boolean
}

export const BASE_STAGE_DEFAULTS: BaseStageParams = Object.freeze({
    inputCol: 'content',
    outputCol: 'output',
    pathCol: 'path',
    pageCol: 'page',
    keepInputData: false,
    propagateError: false,
})

/**
 * Merge user options over defaults and run validators.
 *
 * `undefined` values are ignored so `{ scoreThreshold: undefined }` falls back
 * to the default rather than erasing it -- callers spreading optional config
 * would otherwise silently lose defaults.
 */
export function resolveParams<T extends object>(
    defaults: Readonly<T>,
    options: Partial<T> = {},
    validators: Validator<T> = {}
): T {
    const resolved = { ...defaults } as T
    for (const key of Object.keys(options) as (keyof T)[]) {
        const value = options[key]
        if (value !== undefined) resolved[key] = value as T[keyof T]
    }
    for (const key of Object.keys(validators) as (keyof T)[]) {
        validators[key]?.(resolved[key], resolved)
    }
    return resolved
}

/** Throw unless `value` lies within [min, max]. */
export function assertInRange(name: string, value: number, min: number, max: number): void {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new RangeError(`${name} must be between ${min} and ${max}, received ${value}`)
    }
}

/** Throw unless `value` is a positive integer. */
export function assertPositiveInt(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer, received ${value}`)
    }
}
