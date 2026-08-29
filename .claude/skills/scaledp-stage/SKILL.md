---
name: scaledp-stage
description: Add a new pipeline stage to scaledp-ts. Use when creating a stage class (a reader, detector, recognizer, NER or transform step), porting a stage from Python ScaleDP, or wiring a new stage into the subpath exports. Covers the file layout, params/defaults, the non-throwing error contract, registration and tests.
---

# Adding a scaledp-ts stage

## 1. Find the Python original

If a Python equivalent exists, read it first — parameter names, defaults and
output schema must match.

```bash
ls /Users/mykola/PycharmProjects/ScaleDP/scaledp/models/
grep -rn "defaultParams" /Users/mykola/PycharmProjects/ScaleDP/scaledp/<path>.py
```

Copy the `defaultParams` values exactly. Where you deliberately differ, say so
in a comment at the site *and* add a row to `docs/porting.md`.

If there is no Python original, still follow its conventions: camelCase params,
`inputCol`/`outputCol`, `scoreThreshold`, `keepInputData`.

## 2. Pick the location

| Kind | Directory | Subpath |
|---|---|---|
| No engine needed | `src/stages/` | root |
| PDF | `src/pdf/` | `/pdf` |
| Detection or recognition | `src/ocr/` | `/ocr` |
| NER | `src/ner/` | `/ner` |
| Object detection | `src/detect/` | `/detect` |

One stage per file, kebab-case filename.

## 3. Write it

```ts
export interface MyStageParams extends BaseStageParams {
    scoreThreshold: number
}

export const MY_STAGE_DEFAULTS: MyStageParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'boxes',
    keepInputData: true,
    scoreThreshold: 0.5,
})

export class MyStage extends Stage<MyStageParams> {
    readonly name = 'MyStage'

    constructor(options: Partial<MyStageParams> = {}) {
        super(resolveParams(MY_STAGE_DEFAULTS, options, {
            scoreThreshold: (v) => assertInRange('scoreThreshold', v, 0, 1),
        }))
    }

    /** One-time setup: model download, session creation. */
    override async init(): Promise<void> {}

    protected async apply(input: unknown, row: Row): Promise<DetectorOutput> {
        // Throwing here is fine and expected -- the base class captures it.
    }

    /** Well-formed empty output carrying the message. Never undefined. */
    protected onError(message: string, row: Row): DetectorOutput {
        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'my-stage',
            exception: message,
        })
    }

    override async dispose(): Promise<void> {}
}
```

Emitting several rows per input (page explosion, box cropping) means overriding
`expand` instead of `apply`; `apply` then throws an "unreachable" error.

## 4. Honour the invariants

- **Never throw from `apply` for expected failures.** The base class turns them
  into `exception`. Only `propagateError: true` rethrows.
- **Engines load lazily.** `const mod = await import('some-engine')` inside a
  function, wrapped in try/catch with a message naming the package to install.
  Add it to `peerDependencies` (optional) and to `deps.neverBundle`.
- **`OffscreenCanvas` only.** No `document`, no `HTMLImageElement`, no
  `toDataURL`.
- **No app-owned paths.** Read them from `getConfig()`.
- Cache load promises and clear them on failure, so a transient network error is
  retried rather than cached as a permanently rejected promise.

## 5. Register it

Export from the subpath barrel (`src/<area>/index.ts`). For a *new* subpath,
also add the entry to `tsdown.config.ts` and to `package.json` `exports` in the
same change — the entry list is deliberately only what exists.

## 6. Test it

Pure logic goes in `test/unit/`. Anything needing ORT, WASM, WebGPU or a real
canvas goes in `test/browser/`.

Test the error path explicitly — that the exception lands in the output and the
pipeline still completes:

```ts
it('records failures rather than throwing', async () => {
    const rows = await new Pipeline([new MyStage()]).transform([{ image: null }])
    expect(rows[0]?.boxes.exception).toContain('MyStage')
})
```

If the stage was ported from Python, add a parity test: extend a generator in
`test/fixtures/`, regenerate goldens, and diff against them. See `CLAUDE.md`
for the tolerances that are legitimate.

## 7. Document it

Add a row to the parameter table in `docs/stages.md`, and to the stage map in
`docs/porting.md` if a Python original exists.

## 8. Verify

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:pkg
```
