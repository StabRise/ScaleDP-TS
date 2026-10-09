/**
 * Per-row conditions for a stage: `when` on a descriptor.
 *
 * A condition is plain JSON so it survives the worker boundary and a round
 * trip through storage, exactly like the rest of a `StageDescriptor`. That
 * rules out functions, and is also why the grammar is kept small -- a path into
 * the row, a test, and the three boolean combinators. Anything richer belongs
 * in a stage that writes a column a condition can test.
 *
 *   { path: 'document.bboxes.length', gte: 1 }
 *   { not: { path: 'document.exception', eq: '' } }
 *   { any: [{ var: 'forceOcr', truthy: true }, { path: 'needsOcr', truthy: true }] }
 *
 * `path` reads the row; `var` reads `RunOptions.vars`, so one pipeline can be
 * steered per run (a "force OCR" switch) without rebuilding it.
 */

import type { Row } from './pipeline.js'

export type Json = string | number | boolean | null

export type Operand = { path: string; var?: never } | { var: string; path?: never }

export interface Tests {
    exists?: boolean
    truthy?: boolean
    eq?: Json
    ne?: Json
    in?: readonly Json[]
    gt?: number
    gte?: number
    lt?: number
    lte?: number
}

export type Test = Operand & Tests

export type Condition =
    | { all: readonly Condition[] }
    | { any: readonly Condition[] }
    | { not: Condition }
    | Test

const TEST_KEYS = ['exists', 'truthy', 'eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'] as const

/** Marks "the path led nowhere", which is distinct from a stored `undefined`. */
const MISSING = Symbol('missing')

/** Follow a dotted path. Numeric segments index arrays; `length` works on arrays and strings. */
export function readPath(source: unknown, path: string): unknown {
    let value: unknown = source
    for (const segment of path.split('.')) {
        if (value === null || value === undefined) return MISSING
        if (segment === 'length' && (Array.isArray(value) || typeof value === 'string')) {
            value = value.length
            continue
        }
        if (typeof value !== 'object') return MISSING
        if (!(segment in (value as object))) return MISSING
        value = (value as Record<string, unknown>)[segment]
    }
    return value
}

export function evaluate(condition: Condition, row: Row, vars: Readonly<Record<string, Json>> = {}): boolean {
    if ('all' in condition) return condition.all.every((c) => evaluate(c, row, vars))
    if ('any' in condition) return condition.any.some((c) => evaluate(c, row, vars))
    if ('not' in condition) return !evaluate(condition.not, row, vars)

    const value =
        condition.var !== undefined
            ? condition.var in vars
                ? vars[condition.var]
                : MISSING
            : readPath(row, condition.path as string)
    return runTests(condition, value)
}

function runTests(test: Tests, value: unknown): boolean {
    const present = value !== MISSING && value !== undefined
    // Every test listed must hold. A missing value fails all of them except
    // `exists: false`, so `{ path: 'x', ne: 1 }` does not match a row without
    // `x` -- the absent case is asked for explicitly, never assumed.
    if (test.exists !== undefined && test.exists !== present) return false
    if (!present) return test.exists === false && countTests(test) === 1

    if (test.truthy !== undefined && Boolean(value) !== test.truthy) return false
    if (test.eq !== undefined && value !== test.eq) return false
    if (test.ne !== undefined && value === test.ne) return false
    if (test.in !== undefined && !test.in.includes(value as Json)) return false
    if (test.gt !== undefined && !(typeof value === 'number' && value > test.gt)) return false
    if (test.gte !== undefined && !(typeof value === 'number' && value >= test.gte)) return false
    if (test.lt !== undefined && !(typeof value === 'number' && value < test.lt)) return false
    if (test.lte !== undefined && !(typeof value === 'number' && value <= test.lte)) return false
    return true
}

function countTests(test: Tests): number {
    return TEST_KEYS.filter((key) => test[key] !== undefined).length
}

/**
 * Check a condition's shape, so a typo fails when the pipeline is built rather
 * than silently matching nothing on every row.
 */
export function validateCondition(condition: unknown, where = 'when'): Condition {
    if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
        throw new TypeError(`${where}: a condition must be an object, received ${JSON.stringify(condition)}`)
    }
    const c = condition as Record<string, unknown>

    for (const combinator of ['all', 'any'] as const) {
        if (combinator in c) {
            const parts = c[combinator]
            if (!Array.isArray(parts) || parts.length === 0) {
                throw new TypeError(`${where}.${combinator} must be a non-empty array of conditions`)
            }
            onlyKeys(c, [combinator], where)
            for (const [i, part] of parts.entries()) validateCondition(part, `${where}.${combinator}[${i}]`)
            return condition as Condition
        }
    }
    if ('not' in c) {
        onlyKeys(c, ['not'], where)
        validateCondition(c.not, `${where}.not`)
        return condition as Condition
    }

    const hasPath = typeof c.path === 'string' && c.path.length > 0
    const hasVar = typeof c.var === 'string' && c.var.length > 0
    if (hasPath === hasVar) {
        throw new TypeError(`${where}: a test needs exactly one of "path" or "var"`)
    }
    onlyKeys(c, [hasPath ? 'path' : 'var', ...TEST_KEYS], where)
    if (countTests(c as Tests) === 0) {
        throw new TypeError(`${where}: a test needs at least one of ${TEST_KEYS.join(', ')}`)
    }
    for (const key of ['gt', 'gte', 'lt', 'lte'] as const) {
        if (c[key] !== undefined && typeof c[key] !== 'number') {
            throw new TypeError(`${where}.${key} must be a number`)
        }
    }
    for (const key of ['exists', 'truthy'] as const) {
        if (c[key] !== undefined && typeof c[key] !== 'boolean') {
            throw new TypeError(`${where}.${key} must be a boolean`)
        }
    }
    if (c.in !== undefined && !Array.isArray(c.in)) throw new TypeError(`${where}.in must be an array`)
    return condition as Condition
}

function onlyKeys(c: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(c)) {
        if (!allowed.includes(key)) throw new TypeError(`${where}: unexpected key "${key}"`)
    }
}
