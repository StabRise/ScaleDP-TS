import { describe, expect, it } from 'vitest'
import { DBNET_DETECTOR_DEFAULTS, packSheets } from '../../src/ocr/dbnet-onnx.js'

describe('packSheets', () => {
    it('puts a lone picture where the unpacked path would, at its unpacked scale', () => {
        const [sheet] = packSheets([{ width: 1524, height: 2014 }], 1280, 2, 64)
        expect(sheet).toEqual([
            {
                item: 0,
                x: 0,
                y: 0,
                scale: 1280 / 2014,
                width: Math.trunc(1524 * (1280 / 2014)),
                height: 1280,
            },
        ])
    })

    it('shares one sheet between small pictures, never overlapping, gutter between them', () => {
        const sheets = packSheets(
            [
                { width: 1000, height: 300 },
                { width: 966, height: 470 },
                { width: 345, height: 84 },
            ],
            1280,
            1,
            64
        )
        expect(sheets).toHaveLength(1)
        const places = sheets[0] ?? []
        for (const a of places) {
            expect(a.x + a.width).toBeLessThanOrEqual(1280)
            expect(a.y + a.height).toBeLessThanOrEqual(1280)
            for (const b of places) {
                if (a === b) continue
                const apartX = a.x + a.width + 64 <= b.x || b.x + b.width + 64 <= a.x
                const apartY = a.y + a.height + 64 <= b.y || b.y + b.height + 64 <= a.y
                expect(apartX || apartY).toBe(true)
            }
        }
    })

    it('caps the upscale and starts a new sheet when one is full', () => {
        const sheets = packSheets(
            Array.from({ length: 6 }, () => ({ width: 600, height: 500 })),
            1280,
            2,
            64
        )
        expect(sheets.flat().every((place) => place.scale === 1280 / 600 || place.scale <= 2)).toBe(true)
        expect(sheets.length).toBeGreaterThan(1)
        expect(
            sheets
                .flat()
                .map((p) => p.item)
                .sort()
        ).toEqual([0, 1, 2, 3, 4, 5])
    })
})

describe('DBNet defaults', () => {
    it('runs the picture’s own shape, and packs only on request', () => {
        expect(DBNET_DETECTOR_DEFAULTS.squareInput).toBe(false)
        expect(DBNET_DETECTOR_DEFAULTS.pack).toBe(false)
    })
})
