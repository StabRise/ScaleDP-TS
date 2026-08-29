/**
 * Runtime metadata describing every stage's parameters.
 *
 * Params in this library are a TypeScript interface plus a frozen defaults
 * object (see `src/core/params.ts`). Types, enums and ranges live in the `.d.ts`
 * and in validator closures -- neither readable at runtime, which is what a
 * parameter form needs. This file declares the shape of that missing metadata;
 * `catalog.ts` fills it in.
 *
 * The defaults themselves are never restated here. Every spec points at the
 * stage's own `*_DEFAULTS` constant, so a changed default cannot drift out of
 * the catalogue -- and `test/unit/registry.test.ts` fails when a *new* param is
 * added to a stage without a matching entry.
 */

/** What a column holds, well enough to check that a stage can read it. */
export type ColumnKind = 'bytes' | 'image' | 'boxes' | 'document' | 'ner' | 'orientations' | 'box'

/** Which widget a parameter wants. */
export type StageParamKind =
    | 'string'
    | 'number'
    | 'boolean'
    | 'enum'
    /** An array of strings edited as a list: labels, lang, displayDataList. */
    | 'stringList'
    /** A single row field name: inputCol, outputCol, orientationCol, boxCol. */
    | 'column'
    /** A fixed-length list of row field names: inputCols. */
    | 'columns'
    /** A CSS colour, or null for "choose one per group". */
    | 'color'

export interface StageParamOption {
    value: string
    label: string
    /** Longer description, for a tooltip. */
    title?: string
    /** Selectable but not usable as configured -- private repos, say. */
    disabled?: boolean
}

export interface StageParamSpec {
    /** Key in the stage's params object. */
    key: string
    kind: StageParamKind
    label: string
    /** One line explaining what the parameter does. */
    help?: string
    min?: number
    max?: number
    step?: number
    /** `columns` only: how many entries the list must have, when it is fixed. */
    arity?: number
    /**
     * `columns` only: the fewest entries a variable-length list may have.
     *
     * `ImageDrawBoxes` takes an image and at least one box column, so its list
     * grows but never shrinks below two. Without this the constraint lives only
     * inside the stage's constructor validator, where a form cannot see it.
     */
    minArity?: number
    /** `columns`/`column` only: what each position must hold. */
    accepts?: ColumnKind[]
    /**
     * Values worth offering.
     *
     * On an `enum` these are the only values. On a `stringList` they are the
     * ones a UI should let you pick from -- the list stays open, but the field
     * names that actually render are not guessable, so leaving it entirely free
     * text hides them.
     */
    options?: readonly StageParamOption[]
    /** `enum` only: also accept a value outside `options`. */
    allowCustom?: boolean
    /** Wiring and plumbing rather than behaviour; collapse it by default. */
    advanced?: boolean
    /** Reject the value in the UI before the constructor throws. */
    required?: boolean
}

/** Where a stage's weights come from, so a UI can report cache state. */
export type StageCacheSpec =
    /** The param names a PaddleOCR preset id. */
    | { kind: 'paddle-preset'; param: string }
    /** The param names a Hugging Face repo id or URL. */
    | { kind: 'hf-repo'; param: string; approxBytes?: number }
    /** The param names an id in `NER_MODELS`. */
    | { kind: 'ner-id'; param: string }

export interface StageSpec {
    /** Exported class name. Also the `StageDescriptor.type` and the stage's `name`. */
    type: string
    label: string
    group: 'Read' | 'Detect' | 'Recognise' | 'Understand' | 'Transform'
    /** Import specifier the class lives behind, shown on the stage card. */
    subpath: string
    summary: string
    /** Column kinds this stage reads, in `inputCols` order where it has one. */
    consumes: readonly ColumnKind[]
    /** Column kind written to `outputCol`. */
    produces: ColumnKind
    /** Extra columns written by stages that emit more than one. */
    alsoProduces?: readonly { param: string; kind: ColumnKind }[]
    /** Optional peer dependency the stage needs at run time. */
    peer?: string
    cache?: StageCacheSpec
    /** One row per input row, or several? PDF page explosion and box cropping. */
    expands?: boolean
    /**
     * The output is for looking at, not for feeding onward.
     *
     * An annotated page is still an image, so a UI choosing "the most recent
     * image column" would hand it to the next detector -- which would then read
     * text through the boxes drawn over it. Chaining annotation passes is a real
     * idiom, so this marks the column rather than forbidding it.
     */
    terminal?: boolean
    /** The stage's own frozen `*_DEFAULTS` object. */
    defaults: Readonly<Record<string, unknown>>
    params: readonly StageParamSpec[]
}
