# Models and caching

## How models load

Every ONNX model is fetched once, cached in IndexedDB, and handed to
onnxruntime-web as an `ArrayBuffer`. A repeat visit starts instantly and works
offline.

```ts
configure({
  modelHost: 'https://huggingface.co',  // or '/models' to self-host
  cache: 'indexeddb',                   // or 'none'
  cacheDbName: 'scaledp-models',
  onProgress: ({ repo, file, loaded, total, phase }) => { /* ... */ },
})
```

Sizes come from a `HEAD` request so progress is a real percentage rather than a
byte count climbing toward an unknown ceiling.

## Sizes

These are large downloads. Show progress, and consider checking `isCached()`
before starting one on a metered connection.

### NER

| id | Arch | Repo | Size | Access |
|---|---|---|---|---|
| `gliner-multi-pii` *(default)* | GLiNER1 | `onnx-community/gliner_multi_pii-v1` | ~333 MB | public |
| `gliner-small` | GLiNER1 | `onnx-community/gliner_small-v2.1` | ~183 MB | public |
| `stabrise-pii-multi` | GLiNER1 | `StabRise/pii-detection-en-fr-ge-it-es` | ~404 MB | private |
| `stabrise-pii-multi-g2` | GLiNER2 | `StabRise/pii-multi-g2-v1-onnx` | ~1.2 GB | private |

The default is public so `npm install` works with no configuration.

**GLiNER2 is registered but not recommended for the open web.** Its published
weights are fp32 and total about 1.2 GB, with no int8 or q4 variant on the Hub.
It is there for desktop-wrapped and kiosk builds where a one-time download of
that size is acceptable. It is also pinned to the WASM execution provider:
onnxruntime-web's WebGPU backend silently *drops entities* on that architecture,
because its dynamic span-gather and `count_embed` ops fall back to CPU
mid-graph and the partition boundary corrupts data rather than erroring.

### OCR

PaddleOCR presets are 5–15 MB total (detection + recognition + dictionary).
Tesseract language data is roughly 15 MB per language.

## Private repositories

StabRise's PII models are private. Supply a token:

```ts
configure({
  auth: async (repo) => {
    const response = await fetch('/api/hf-token')
    if (!response.ok) throw new Error('Sign in to use this model')
    return (await response.json()).token
  },
})
```

Mint the token server-side and scope it to the repos you need. A Hugging Face
token shipped in client-side code is a published token.

Tokenizer files are fetched by `@huggingface/transformers`, which has its own
host settings; proxy them through your origin for gated repos:

```ts
configure({
  hf: {
    remoteHost: `${location.origin}/`,
    remotePathTemplate: 'api/hf-model/{model}/resolve/{revision}/',
  },
})
```

## Self-hosting

Point `modelHost` at your own origin and mirror the repo-relative layout:

```
/models/onnx-community/gliner_multi_pii-v1/gliner_config.json
/models/onnx-community/gliner_multi_pii-v1/onnx/model_int8.onnx
```

```ts
configure({ modelHost: '/models' })
```

Absolute URLs bypass `modelHost` entirely, which is how ppu-paddle-ocr's own
catalogue keeps working.

## When it looks like the cache is not working

Two things routinely read as "the models download every time" and are neither a
bug nor a model download.

**The cache is scoped per origin.** IndexedDB is partitioned by scheme, host and
**port**, so `http://localhost:5173` and `http://localhost:5174` have entirely
separate caches. Vite silently moves to the next free port when one is busy, so
restarting a dev server while an old one is still running lands you on a new
origin with an empty cache. Pin the port (`server: { port: 5173, strictPort:
true }`) so this fails loudly instead. The same applies in production to a
scheme or host change.

**The onnxruntime-web runtime is not a model.** ORT fetches a multi-megabyte
`.wasm` at load time -- around 5 MB over the wire for the default build. It is
served from a version-matched CDN and cached by the *browser's* HTTP cache, not
by IndexedDB, so it appears in the network panel on every load even when it is
a cache hit. DevTools' "Disable cache" checkbox turns those hits back into real
downloads, which is worth ruling out first.

To check what is actually happening rather than inferring it from the network
panel:

```ts
import { isCached } from '@stabrise/scaledp'
import { getNerModel } from '@stabrise/scaledp/ner'
import { isPresetCached } from '@stabrise/scaledp/ocr'

console.log(location.origin, await isPresetCached('v6-small'))

const model = getNerModel('gliner-multi-pii')
if (model) console.log(await isCached({ repo: model.repo, files: model.files }))
```

Self-hosting ORT's runtime (`configure({ ortWasmPaths: '/ort/' })`) removes the
CDN round-trip in production. It cannot be served out of a Vite `public/`
directory in dev, though: Vite refuses to `import` files from there, and ORT
loads its `.mjs` glue by dynamic import.

## Managing the cache

```ts
import { isCached, evict } from '@stabrise/scaledp'
import { getNerModel } from '@stabrise/scaledp/ner'
import { isPresetCached, loadPreset, removePreset } from '@stabrise/scaledp/ocr'

const model = getNerModel('gliner-multi-pii')
if (model && !(await isCached({ repo: model.repo, files: model.files }))) {
  // Warn before a 333 MB download.
}

await loadPreset('v6-small')     // pre-warm so first OCR is instant
await removePreset('v6-medium')  // free the space
```

## Execution providers

```ts
configure({ executionProviders: ['webgpu', 'wasm'] })
```

Order is priority. WebGPU is typically 2–5× faster and needs no cross-origin
isolation, so it is the better default where available:

```ts
import { isWebGpuAvailable } from '@stabrise/scaledp/ocr'

configure({
  executionProviders: (await isWebGpuAvailable()) ? ['webgpu', 'wasm'] : ['wasm'],
})
```

Two caveats. GLiNER2 overrides this and always uses WASM, for the reason above.
And onnxruntime-web deprecated the WebGL and JSEP providers in 1.29 — the
native WebGPU provider is the supported path.
