import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FIXTURES, makeImages } from './fixtures/make-images.js'

// Later slices prove the plugin strips EXIF/GPS, rotates phone photos and
// keeps alpha. Those proofs are only worth something if the fixtures really
// carry what they claim, so that is checked here first.

let dir
let paths

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-fixtures-'))
    paths = await makeImages(dir)
})

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

// TIFF tag 0x8825 is the pointer to the GPS IFD, in either byte order.
function hasGpsIfd(exif) {
    return (
        exif.includes(Buffer.from([0x88, 0x25])) ||
        exif.includes(Buffer.from([0x25, 0x88]))
    )
}

describe('makeImages', () => {
    it('writes every fixture into the given directory', () => {
        for (const key of Object.keys(FIXTURES)) {
            expect(fs.existsSync(paths[key])).toBe(true)
            expect(path.dirname(paths[key])).toBe(dir)
        }
    })

    it('makes a landscape JPEG with EXIF orientation 6 and GPS', async () => {
        const meta = await sharp(paths.photo).metadata()

        expect(meta.format).toBe('jpeg')
        expect(meta.width).toBe(FIXTURES.photo.width)
        expect(meta.height).toBe(FIXTURES.photo.height)
        expect(meta.orientation).toBe(6)
        expect(meta.exif).toBeInstanceOf(Buffer)
        expect(hasGpsIfd(meta.exif)).toBe(true)
    })

    it('makes a PNG with an alpha channel and real transparency', async () => {
        const meta = await sharp(paths.alpha).metadata()
        const { isOpaque } = await sharp(paths.alpha).stats()

        expect(meta.format).toBe('png')
        expect(meta.width).toBe(FIXTURES.alpha.width)
        expect(meta.height).toBe(FIXTURES.alpha.height)
        expect(meta.hasAlpha).toBe(true)
        expect(isOpaque).toBe(false)
    })

    it('makes an SVG', async () => {
        const meta = await sharp(paths.svg).metadata()

        expect(meta.format).toBe('svg')
        expect(meta.width).toBe(FIXTURES.svg.width)
        expect(meta.height).toBe(FIXTURES.svg.height)
    })

    it('makes an animated GIF', async () => {
        const meta = await sharp(paths.gif).metadata()

        expect(meta.format).toBe('gif')
        expect(meta.width).toBe(FIXTURES.gif.width)
        expect(meta.pages).toBe(FIXTURES.gif.pages)
    })
})
