/**
 * Ambient types for tesseract-wasm.
 *
 * The package ships `dist/index.d.ts` but its `exports` map points `.` straight
 * at `dist/lib.js` with no `types` condition, so TypeScript cannot resolve them
 * under `moduleResolution: bundler`. Declared here is only the surface this
 * library uses, so a future upstream fix is a clean deletion.
 *
 * Mirrors the real definitions in `dist/ocr-engine.d.ts`. Two details it is
 * easy to guess wrong, and which produce silently empty output rather than an
 * error: `BoxItem` carries geometry only, and `confidence` is 0-1, not 0-100.
 */
declare module 'tesseract-wasm' {
    export interface IntRect {
        left: number
        top: number
        right: number
        bottom: number
    }

    /** Layout analysis only: geometry, with no text and no confidence. */
    export interface BoxItem {
        rect: IntRect
    }

    /** Full recognition: geometry plus the text and its confidence, 0-1. */
    export interface TextItem {
        rect: IntRect
        confidence: number
        text: string
    }

    export type TextUnit = 'word' | 'line'

    export interface OCRClientInit {
        workerURL?: string
        wasmBinary?: ArrayBuffer | Uint8Array
    }

    export class OCRClient {
        constructor(options?: OCRClientInit)
        loadModel(model: Uint8Array | ArrayBuffer | string): Promise<void>
        loadImage(image: ImageData | ImageBitmap): Promise<void>
        clearImage(): Promise<void>
        getBoundingBoxes(unit: TextUnit): Promise<BoxItem[]>
        getTextBoxes(unit: TextUnit): Promise<TextItem[]>
        getText(): Promise<string>
        destroy(): Promise<void>
    }
}
