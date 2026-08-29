import { describe, expect, it } from 'vitest'
import { type Detection, decodeYoloOutput, iou, nonMaximumSuppression } from '../../src/detect/yolo-onnx.js'

describe('iou', () => {
    it('is 1 for identical boxes and 0 when disjoint', () => {
        expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1, 9)
        expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0)
    })

    it('is 0 for boxes that merely touch', () => {
        expect(iou([0, 0, 10, 10], [10, 0, 20, 10])).toBe(0)
    })

    it('computes partial overlap', () => {
        expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150, 9)
    })
})

describe('nonMaximumSuppression', () => {
    const det = (bbox: [number, number, number, number], score: number, classId = 0): Detection => ({
        bbox,
        score,
        classId,
        label: `class_${classId}`,
    })

    it('keeps the highest-scoring of two overlapping boxes', () => {
        const kept = nonMaximumSuppression([det([0, 0, 10, 10], 0.6), det([1, 1, 11, 11], 0.9)], 0.5)
        expect(kept).toHaveLength(1)
        expect(kept[0]?.score).toBeCloseTo(0.9, 9)
    })

    it('never lets one class suppress another', () => {
        const kept = nonMaximumSuppression([det([0, 0, 10, 10], 0.9, 0), det([0, 0, 10, 10], 0.8, 1)], 0.5)
        expect(kept).toHaveLength(2)
    })

    it('keeps boxes that overlap below the threshold', () => {
        expect(nonMaximumSuppression([det([0, 0, 10, 10], 0.9), det([8, 0, 18, 10], 0.8)], 0.5)).toHaveLength(
            2
        )
    })
})

describe('decodeYoloOutput', () => {
    it('decodes the transposed [1, 4 + classes, anchors] layout', () => {
        // 2 anchors, 2 classes. Channel-major: cx, cy, w, h, score0, score1.
        const anchors = 2
        const data = new Float32Array([
            50,
            200, // cx
            60,
            210, // cy
            20,
            40, // w
            10,
            20, // h
            0.9,
            0.1, // class 0 scores
            0.05,
            0.8, // class 1 scores
        ])
        const out = decodeYoloOutput(data, [1, 6, anchors], 0.5)
        expect(out).toHaveLength(2)
        expect(out[0]).toMatchObject({ classId: 0, bbox: [40, 55, 60, 65] })
        expect(out[1]).toMatchObject({ classId: 1 })
        expect(out[1]?.score).toBeCloseTo(0.8, 6)
    })

    it('decodes the end-to-end NMS [1, n, 6] layout', () => {
        const data = new Float32Array([10, 20, 30, 40, 0.85, 3])
        const out = decodeYoloOutput(data, [1, 1, 6], 0.5)
        expect(out[0]).toMatchObject({ bbox: [10, 20, 30, 40], classId: 3 })
        expect(out[0]?.score).toBeCloseTo(0.85, 6)
    })

    it('drops detections below the threshold', () => {
        const data = new Float32Array([10, 20, 30, 40, 0.2, 0])
        expect(decodeYoloOutput(data, [1, 1, 6], 0.5)).toHaveLength(0)
    })

    it('rejects an unrecognised output rank rather than reading garbage', () => {
        expect(() => decodeYoloOutput(new Float32Array(4), [1, 4], 0.5)).toThrow(
            /Unsupported YOLO output shape/
        )
    })
})
