# Vendored GLiNER algorithm

Adapted from [`@lmoe/gliner-onnx`](https://github.com/lmo3/gliner-onnx.js)
v0.1.0, MIT License, with fixes carried over from the `@stabrise/pdftools`
prototype.

Vendored rather than depended on because the upstream package is Node-only
(`onnxruntime-node`, `@huggingface/hub`) and the alternative,
[GLiNER.js](https://github.com/Knowledgator/GLiNER.js), pins
`@xenova/transformers@2.17.2` and `onnxruntime-web@1.19.2` -- both several
majors behind and unmaintained since 2025.

This directory holds the pure algorithm: tokenisation, span enumeration and
decoding. Everything ONNX-specific lives one level up.
