import { describe, expect, it } from 'vitest'
import { portableModelUrl } from '../../src/ocr/paddle-service.js'

const BASE = 'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main'

describe('portableModelUrl', () => {
    it('swaps an ORT-format model for its ONNX twin, which WebGPU can load', () => {
        expect(portableModelUrl(`${BASE}/recognition/ort/PP-OCRv6_small_rec.ort`)).toBe(
            `${BASE}/recognition/PP-OCRv6_small_rec.onnx`
        )
        expect(portableModelUrl(`${BASE}/detection/ort/PP-OCRv6_medium_det.ort`)).toBe(
            `${BASE}/detection/PP-OCRv6_medium_det.onnx`
        )
    })

    it('leaves ONNX models and dictionaries alone', () => {
        const onnx = `${BASE}/recognition/multi/eslav/v5/eslav_PP-OCRv5_mobile_rec_infer.onnx`
        expect(portableModelUrl(onnx)).toBe(onnx)
        expect(portableModelUrl(`${BASE}/recognition/ppocrv6_dict.txt`)).toBe(
            `${BASE}/recognition/ppocrv6_dict.txt`
        )
    })

    it('covers every ORT model ppu catalogues', async () => {
        const { MODEL_PRESETS } = await import('ppu-paddle-ocr/web')
        for (const urls of Object.values(MODEL_PRESETS)) {
            for (const url of [urls.detection, urls.recognition]) {
                expect(portableModelUrl(url), url).not.toMatch(/\.ort$/)
            }
        }
    })
})
