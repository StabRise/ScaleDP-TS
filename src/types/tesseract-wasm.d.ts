/**
 * Ambient types for tesseract-wasm.
 *
 * The package ships `dist/index.d.ts` but its `exports` map points `.` straight
 * at `dist/lib.js` with no `types` condition, so TypeScript cannot resolve them
 * under `moduleResolution: bundler`. Declared here is only the surface this
 * library actually uses, so a future upstream fix is a clean deletion.
 */
declare module 'tesseract-wasm' {
    export interface BoundingBox {
        text: string
        /** 0-100. */
        confidence: number
        rect: { left: number; top: number; right: number; bottom: number }
    }

    export type TextUnit = 'word' | 'line'

    export interface OCRClientOptions {
        workerURL?: string
        wasmBinary?: ArrayBuffer | Uint8Array
    }

    export class OCRClient {
        constructor(options?: OCRClientOptions)
        loadModel(model: Uint8Array | ArrayBuffer | string): Promise<void>
        loadImage(image: ImageData | ImageBitmap): Promise<void>
        getBoundingBoxes(unit: TextUnit): Promise<BoundingBox[]>
        getText(): Promise<string>
        destroy(): void
    }
}
