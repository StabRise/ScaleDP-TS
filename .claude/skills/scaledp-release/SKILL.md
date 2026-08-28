---
name: scaledp-release
description: Cut and publish a @stabrise/scaledp release to npm. Use when bumping the version, writing the changelog, validating the package for publish, or setting up/debugging the GitHub Actions OIDC trusted-publishing workflow.
---

# Releasing @stabrise/scaledp

Published to the `@stabrise` npm scope from GitHub Actions via OIDC trusted
publishing. No `NPM_TOKEN` is involved.

## 1. Pre-flight

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:pkg
```

`check:pkg` runs `publint` plus `attw --profile esm-only`. The profile matters:
this is an ESM-only browser library, so node10 resolution and CJS `require()`
failures are expected and out of scope.

Also confirm:

- Every subpath in `package.json` `exports` has a matching entry in
  `tsdown.config.ts`, and the built file exists in `dist/`.
- No engine is bundled: `grep -c "onnxruntime" dist/index.js` should be 0.
- The tarball carries no models or fixtures.

```bash
npm pack --dry-run 2>&1 | grep -E "test/|\.onnx|fixtures" || echo "clean"
```

## 2. Version and changelog

Follow semver against the *public* surface:

- **patch** — bug fixes, comment and doc changes
- **minor** — new stages, new options with defaults, new model registry entries
- **major** — renamed or removed exports, changed defaults, a new required peer

Changed defaults deserve care: they alter output for every existing caller
without a type error to warn them.

```bash
npm version minor --no-git-tag-version
```

Write the changelog entry grouped by subpath, and state behaviour changes
plainly — a shifted default threshold is more disruptive than a new stage.

## 3. Peer dependency ranges

Widen them only after checking. Two specific hazards:

- **onnxruntime-web must resolve to exactly one copy.** ppu-paddle-ocr peer-deps
  its own range; two copies mean ~500 KB of duplicate JS plus tens of MB of
  duplicate WASM, and mismatched glue. Document the `overrides` recipe in the
  release notes when the range moves.
- **pdfjs-dist 5 changed `render()`** from `canvasContext` to `canvas`. The
  floor stays `>=5.0.0`.

## 4. Publish

Tagging triggers the workflow:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/publish.yml` runs the full check suite, builds, and publishes.

### One-time trusted-publisher setup

1. npmjs.com → the package → Settings → Publish access → Trusted Publishers.
2. Add a GitHub Actions publisher: owner `StabRise`, repo `scaledp-ts`,
   workflow `publish.yml`.
3. Configs created after 2026-05-20 must explicitly allow at least one action —
   select `npm publish`.

Requirements in the workflow: npm CLI ≥ 11.5.1 and
`permissions: { id-token: write }`. Provenance attestations are generated
automatically; the `--provenance` flag is no longer needed.

`publishConfig.access` is `public` in `package.json` — scoped packages
otherwise default to private and the publish fails.

## 5. Verify

```bash
npm view @stabrise/scaledp version
npm view @stabrise/scaledp dist-tags
```

Install the published tarball into a scratch Vite app and import each subpath.
`attw` checks type *resolution*; only a real import proves the runtime entry
points work.

## 6. If the publish fails

| Symptom | Cause |
|---|---|
| `402 Payment Required` | Missing `publishConfig.access: "public"` |
| `404 Not Found` on the scope | Trusted publisher not configured, or repo/workflow mismatch |
| `ENEEDAUTH` | npm CLI below 11.5.1, or `id-token: write` missing |
| Version already published | npm forbids republishing; bump and retag |

A published version cannot be replaced. Unpublishing is restricted and
disruptive — ship a patch instead.
