/**
 * Documents worth trying the pipeline on.
 *
 * The files live at `examples/pdfs` and `copy-assets.mjs` copies them into
 * `public/samples/`, so the repository keeps one copy and the browser fetches
 * them same-origin -- COEP `require-corp` would block them otherwise.
 *
 * Each one exists to exercise something specific, and `wants` says what: a
 * signature page is a poor showing under a text pipeline, and vice versa.
 * Picking a sample loads the file and nothing else -- the stages stay the
 * reader's, the same reason the reader stage is swapped out loud rather than
 * silently.
 */

export interface Sample {
    /** Filename under `public/samples/`. */
    file: string
    label: string
    /** What it exercises, and therefore which stages are worth having. */
    wants: string
}

export const SAMPLES: readonly Sample[] = [
    {
        file: 'SampleWithRotatedText.pdf',
        label: 'Rotated text',
        wants: 'Skewed and upside-down lines — what DBNet plus TesseractRecognizer is for',
    },
    {
        file: 'SampleWithSignatures.pdf',
        label: 'Signatures',
        wants: 'Handwritten signatures — add SignatureDetector',
    },
    {
        file: 'SampleWithFace.pdf',
        label: 'Face',
        wants: 'A portrait on a digital page — add FaceDetector',
    },
    {
        file: 'SampleWithFaceImage.pdf',
        label: 'Face, scanned',
        wants: 'The same, as a scan — no text layer, so everything comes from OCR',
    },
    {
        file: 'SampleWithFaceRussianImage.pdf',
        label: 'Face, Cyrillic',
        wants: 'Russian text — PaddleOCR with a v5-cyrillic preset reads it',
    },
]

/** Where the browser fetches a sample from. */
export const sampleUrl = (sample: Sample): string => `/samples/${sample.file}`
