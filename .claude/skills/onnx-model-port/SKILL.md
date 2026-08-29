---
name: onnx-model-port
description: Port an ONNX model from Python ScaleDP to onnxruntime-web, or debug one whose browser output does not match Python. Use when adding an ONNX-backed stage, when boxes/scores/entities differ between the two runtimes, or when a session fails to create. Covers the preprocessing parity checklist, tensor construction, execution providers, external data and parity testing.
---

# Porting an ONNX model to onnxruntime-web

Wrong output from an ONNX model is almost always preprocessing, not the model.
Work through the checklist before suspecting anything else.

## 1. Read the Python preprocessing end to end

```bash
ls /Users/mykola/PycharmProjects/ScaleDP/scaledp/models/detectors/paddle_onnx/
```

Follow the actual call chain — the op list in `predict_*.py`, the ops in
`operators.py`, and any conversion in the *stage* file. That last one matters:
ScaleDP's `DBNetOnnxDetector.call_detector` does `cv2.cvtColor(..., RGB2BGR)`
before the op chain ever runs.

## 2. Preprocessing parity checklist

Each line is a real bug that has shipped.

- [ ] **Channel order.** Does the Python path convert RGB→BGR? ScaleDP's DBNet
      and line-orientation paths do, and never convert back — so the model is
      fed **BGR channels against RGB ImageNet statistics**. Reproduce the quirk;
      "fixing" it shifts every box. `toNchwFloat32(..., { bgr: true })`.
- [ ] **Resize mode.** Letterbox or plain resize? A plain `cv2.resize` distorts
      the aspect ratio, and some models expect exactly that.
- [ ] **Padding side.** Bottom-right only (`padding: 'end'`, PaddleOCR) or
      centred (`padding: 'center'`, YOLO)? This decides whether coordinates
      restore by dividing by the scale, or by subtracting the pad offsets first.
- [ ] **Padding colour.** White (255) or black? ScaleDP uses white.
- [ ] **Input size.** Fixed (DBNet: 1280×1280) or read from the graph (YOLO)?
- [ ] **Normalisation.** `/255` only, or ImageNet mean/std as well? YOLO uses
      `/255` alone; DBNet applies both.
- [ ] **Layout.** NCHW or NHWC.
- [ ] **dtype.** float32 for images; int64 (`BigInt64Array`) for token ids.

## 3. Build the session

```ts
import { createSession } from '../ocr/ort.js'

const session = await createSession(bytes, {
    executionProviders: getConfig().executionProviders,
})
```

Use `createSession`, not `ort.InferenceSession.create` directly — it configures
`wasmPaths` and `numThreads` first.

**Never hardcode a wasm CDN URL.** The `.mjs` loader and the `.wasm` binary must
match build variant *and* version; a mismatch fails opaquely at session
creation. `src/ocr/ort.ts` derives the URL from the resolved package version.

**External data.** Models over ~2 GB, or any with a companion `.onnx_data`:

```ts
await createSession(graphBytes, {
    externalData: [{ path: 'model.onnx_data', data: weightBytes }],
})
```

External data can bypass the WASM heap; weights embedded in the graph cannot,
and are copied twice during load. A ~1 GB embedded model therefore peaks near
2 GB inside a 4 GiB heap and can abort with a bare `Aborted()`.

## 4. Execution providers

```ts
configure({ executionProviders: ['webgpu', 'wasm'] })
```

Two traps:

- **WebGPU can silently produce wrong output, not an error.** GLiNER2 loses
  entities under WebGPU because its dynamic span-gather and `count_embed` ops
  fall back to CPU mid-graph and the partition boundary corrupts data. If
  browser results differ from Python, **test `['wasm']` before anything else.**
  Pin a model to WASM via `executionProviders` on its registry entry.
- **WebGL and JSEP are deprecated** as of onnxruntime-web 1.29. Native WebGPU
  is the supported accelerated path.

## 5. Run it

```ts
const { Tensor } = await import('onnxruntime-web')
const inputName = session.inputNames[0]
const outputs = await session.run({
    [inputName]: new Tensor('float32', data, [1, 3, height, width]),
})
```

Read names from `session.inputNames` / `outputNames` rather than hardcoding
them; exports of the same model disagree. When a graph declares a *subset* of
your feeds (token-mode GLiNER drops `span_idx`/`span_mask`), filter by
`session.inputNames` instead of passing everything.

## 6. Post-processing

Port the math exactly, including the parts that look wrong:

- **Coordinate restore.** Divide by the scale for bottom-right padding;
  subtract the pad offsets first for centred padding.
- **Clip ranges.** ScaleDP clips to `[0, dest]`, inclusive of the far edge — not
  `[0, dest - 1]`.
- **`cv2.fillPoly`** treats vertices as pixel *centres* and fills both ends of
  a span inclusively. Sampling at pixel centres instead drops the boundary row
  and column, moving scores by ~1% and changing which candidates clear a
  threshold.
- **`cv2.minAreaRect`** reports its angle in `(0, 90]`, and for axis-aligned
  input returns `-0.0` or `90` depending on which hull edge its scan hits. Both
  describe the same rectangle.

## 7. Prove it matches Python

Do not eyeball it — generate goldens from the real Python code.

```python
# test/fixtures/generate-<name>-goldens.py
import sys; sys.path.insert(0, "/Users/mykola/PycharmProjects/ScaleDP")
from scaledp.models.detectors.paddle_onnx.db_postprocess import DBPostProcess
# ... call the real functions, print JSON
```

```bash
~/Library/Caches/pypoetry/virtualenvs/scaledp-DbEJkcaR-py3.12/bin/python \
  test/fixtures/generate-<name>-goldens.py > test/fixtures/<name>-goldens.json
```

Then diff in `test/unit/<name>.test.ts`. Legitimate tolerances, already used
elsewhere: 1px on integers (cv2 is float32, JS is float64) and angle compared
modulo the shape's symmetry group.

Synthetic inputs — a probability map with known rectangles — isolate
post-processing from the model, which is where the bugs actually are.

## 8. Debugging a mismatch

In order:

1. Switch to `['wasm']`. WebGPU corruption is silent.
2. Dump the input tensor's first 20 values and compare against numpy at the same
   point in Python. If these differ, it is preprocessing — go back to step 2.
3. Dump the raw output tensor and compare. If inputs match and outputs do not,
   suspect the execution provider or a version skew.
4. Only then look at post-processing.
