/**
 * Fold a page's image readings back into its text layer: many rows in, one row
 * per page out.
 *
 * `PdfEmbeddedImages` emits a row per embedded image, so a recognizer can treat
 * them as ordinary images. That leaves a page spread across several rows, each
 * holding one image's `Document` in the image's *own* pixels. This stage maps
 * those boxes onto the page through the placement each row carries, merges them
 * with the text layer, and emits the page once.
 *
 * It is the one stage in the library that reduces the row count. The mechanism
 * is `NerConsistency`'s: override `transform` to see every row, stash what the
 * per-row path needs, and let the base class keep doing the column wiring, the
 * error capture and the timing.
 */

import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { EXECUTION_TIME_COL, ROW_TIME_COL, type Row, Stage, type StageContext } from '../core/pipeline.js'
import type { Box } from '../schemas/box.js'
import { createDocument, type Document } from '../schemas/document.js'
import { boxToPage, type ImagePlacement } from './extract-images.js'
import { assembleDocument, MERGE_STRATEGIES, type MergeStrategy } from './merge-text.js'
import { NO_EMBEDDED_IMAGES } from './pdf-embedded-images.js'

export interface PdfMergeImageTextParams extends BaseStageParams {
    /** `[textLayerColumn, imageTextColumn]`. */
    inputCols: string[]
    /** Column holding the `ImagePlacement` each image row was cut from. */
    placementCol: string
    /** Row fields that together identify one page. */
    groupByCols: string[]
    strategy: MergeStrategy
    /** How much of a box the other source must cover before it is dropped. */
    coverageThreshold: number
    /** Rebuild the original layout with spaces and blank lines. */
    keepFormatting: boolean
    /** Line-grouping tolerance in pixels; 0 derives it from character height. */
    lineTolerance: number
    /**
     * Gather what each of a page's rows carried into arrays on the merged one.
     *
     * Reducing the rows otherwise throws away everything but the first one's --
     * the picture each was cut from, the regions found in it, what was read --
     * and that is exactly the evidence you want when an image contributes no
     * text and the question is whether it was extracted wrongly or simply
     * unreadable.
     *
     * Only the columns that actually *differ* across the group are collected,
     * which is the definition of what the reduction would destroy: rows are
     * built by spreading their page row, so anything shared is still the same
     * reference and anything per-image is not. Turning this off frees the
     * pictures a page was cut into as soon as the merge is done.
     */
    collect: boolean
}

export const PDF_MERGE_IMAGE_TEXT_DEFAULTS: PdfMergeImageTextParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'document',
    inputCols: ['document', 'image_text'],
    outputCol: 'document',
    keepInputData: true,
    placementCol: 'placement',
    groupByCols: ['path', 'page'],
    strategy: 'text-layer-wins' as MergeStrategy,
    coverageThreshold: 0.5,
    keepFormatting: false,
    lineTolerance: 0,
    collect: true,
})

/** Transient column marking which group a representative row stands for. */
const GROUP_KEY = '__scaledp_page_group'

export class PdfMergeImageText extends Stage<PdfMergeImageTextParams> {
    readonly name = 'PdfMergeImageText'

    /** The rows of each page, live only for the duration of one transform. */
    private groups: Map<string, Row[]> | null = null

    constructor(options: Partial<PdfMergeImageTextParams> = {}) {
        super(
            resolveParams(PDF_MERGE_IMAGE_TEXT_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) {
                        throw new RangeError('inputCols must be [textLayerColumn, imageTextColumn]')
                    }
                },
                groupByCols: (value) => {
                    if (value.length === 0) throw new RangeError('groupByCols must name at least one column')
                },
                strategy: (value) => {
                    if (!MERGE_STRATEGIES.includes(value)) {
                        throw new RangeError(`strategy must be one of ${MERGE_STRATEGIES.join(', ')}`)
                    }
                },
                coverageThreshold: (value) => {
                    if (!(value >= 0 && value <= 1)) {
                        throw new RangeError(`coverageThreshold must be between 0 and 1, received ${value}`)
                    }
                },
            })
        )
    }

    /**
     * One row per page, built from all of that page's rows.
     *
     * The first row of each group is the representative: every row of a page
     * descends from the same page row, so they agree on everything but the
     * image. Running `super.transform` over the representatives keeps the
     * `keepInputData`, `propagateError` and timing contracts identical to every
     * other stage's.
     */
    override async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        const groups = new Map<string, Row[]>()
        for (const row of rows) {
            const key = this.keyOf(row)
            const group = groups.get(key)
            if (group) group.push(row)
            else groups.set(key, [row])
        }

        this.groups = groups
        try {
            const representatives = [...groups].map(([key, group]) => ({
                ...(group[0] as Row),
                [GROUP_KEY]: key,
            }))
            const out = await super.transform(representatives, ctx)
            for (const row of out) {
                this.gather(row, groups.get(String(row[GROUP_KEY])) ?? [])
                delete row[GROUP_KEY]
            }
            return out
        } finally {
            this.groups = null
        }
    }

    protected async apply(_input: unknown, row: Row): Promise<Document> {
        const { inputCols, placementCol, pathCol, keepFormatting, lineTolerance } = this.params
        const [textLayerCol, imageTextCol] = inputCols as [string, string]

        const group = this.groups?.get(String(row[GROUP_KEY])) ?? [row]
        const textLayer = row[textLayerCol] as Document | undefined
        const path = String(row[pathCol] ?? textLayer?.path ?? 'memory')

        const ocrBoxes: Box[] = []
        const failures: string[] = []

        for (const member of group) {
            const placement = member[placementCol] as ImagePlacement | null | undefined
            const read = member[imageTextCol] as Document | undefined

            if (!read) continue
            if (read.exception) {
                // A page with no images at all is the expected case, not a
                // failure -- PdfEmbeddedImages says so on the image it emits.
                if (!read.exception.includes(NO_EMBEDDED_IMAGES)) failures.push(read.exception)
                continue
            }
            if (!placement) continue
            for (const box of read.bboxes) ocrBoxes.push(boxToPage(box, placement))
        }

        // The text layer's own failure is the page's; one image's is not, unless
        // nothing at all could be read. `hasUsableTextLayer` and every
        // downstream stage treat a non-empty `exception` as "upstream failed",
        // so a partial failure must not set it.
        const textBoxes = textLayer?.exception ? [] : (textLayer?.bboxes ?? [])
        const fatal = Boolean(textLayer?.exception) || (textBoxes.length === 0 && ocrBoxes.length === 0)
        const exception = fatal ? [textLayer?.exception, ...failures].filter(Boolean).join('; ') : ''

        return assembleDocument(textBoxes, ocrBoxes, {
            path,
            strategy: this.params.strategy,
            coverageThreshold: this.params.coverageThreshold,
            keepFormatting,
            lineTolerance,
            exception,
        })
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'pdf',
            exception: message,
        })
    }

    /**
     * Gather the columns that differ across a page's rows onto the merged one.
     *
     * Identity, not equality: every row of a page was built by spreading that
     * page's row, so a shared value is literally the same object and a per-image
     * one never is. The pipeline's own bookkeeping is excluded -- `row_time` is
     * copied per row by design, so it differs on every row and would otherwise
     * be collected as a meaningless array of timings.
     */
    private gather(row: Row, group: readonly Row[]): void {
        if (!this.params.collect || group.length < 2) return
        const first = group[0] as Row

        for (const col of Object.keys(first)) {
            if (col === GROUP_KEY || col === this.params.outputCol) continue
            if (col === ROW_TIME_COL || col === EXECUTION_TIME_COL) continue
            if (group.every((member) => member[col] === first[col])) continue
            row[col] = group.map((member) => member[col]).filter((value) => value != null)
        }
    }

    /** JSON rather than a joined string, so no separator can collide two pages. */
    private keyOf(row: Row): string {
        return JSON.stringify(this.params.groupByCols.map((col) => row[col] ?? null))
    }
}
