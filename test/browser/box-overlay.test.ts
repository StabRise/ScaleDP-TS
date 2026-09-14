/** boxOverlay builds SVG, so it needs a real document. */
import { describe, expect, it } from 'vitest'
import { boxOverlay } from '../../src/display/index.js'
import { createBox } from '../../src/schemas/box.js'

const size = { width: 1000, height: 800 }

describe('boxOverlay', () => {
    it('authors in image pixels and lets the viewBox do the scaling', () => {
        // No measurement, no resize listener: the overlay stays aligned through
        // any layout change because the browser rescales the viewBox for us.
        const svg = boxOverlay([createBox({ x: 10, y: 20, width: 30, height: 40 })], size)

        expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800')
        expect(svg.getAttribute('preserveAspectRatio')).toBe('none')

        const rect = svg.querySelector('rect')
        expect(rect?.getAttribute('x')).toBe('10')
        expect(rect?.getAttribute('width')).toBe('30')
        expect(rect?.getAttribute('fill')).toBe('none')
    })

    it('turns a rotated box about its centre, not its corner', () => {
        const svg = boxOverlay([createBox({ x: 100, y: 200, width: 40, height: 20, angle: 30 })], size)
        expect(svg.querySelector('rect')?.getAttribute('transform')).toBe('rotate(30 120 210)')
    })

    it('leaves an upright box untransformed', () => {
        const svg = boxOverlay([createBox({ x: 1, y: 2, width: 3, height: 4 })], size)
        expect(svg.querySelector('rect')?.hasAttribute('transform')).toBe(false)
    })

    it('never collapses a zero-sized box to nothing', () => {
        const svg = boxOverlay([createBox({ x: 5, y: 5 })], size)
        expect(svg.querySelector('rect')?.getAttribute('width')).toBe('1')
    })

    it('scales its stroke to the image, so a big page is not hairlined', () => {
        const thin = boxOverlay([createBox({ width: 10, height: 10 })], { width: 400, height: 400 })
        const thick = boxOverlay([createBox({ width: 10, height: 10 })], { width: 4000, height: 4000 })

        const width = (svg: SVGSVGElement) => Number(svg.querySelector('rect')?.getAttribute('stroke-width'))
        expect(width(thick)).toBeGreaterThan(width(thin))
    })
})
