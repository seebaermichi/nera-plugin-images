import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
    encodeVariant,
    fallbackFormat,
    placeholderOf,
    planVariants,
    readSourceMeta,
} from '../src/transform.js'
import { FIXTURES, hasGpsIfd, makeImages } from './fixtures/make-images.js'

const config = {
    widths: [480, 800, 1200, 1600],
    formats: ['avif', 'webp'],
    quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
}

const jpeg = (width, height) => ({ width, height, format: 'jpeg' })
const widthsOf = (variants, format) =>
    variants.filter((v) => v.format === format).map((v) => v.width)

describe('planVariants: widths', () => {
    it('uses every config width below the source width, per format', () => {
        const variants = planVariants(jpeg(2000, 1500), config)

        expect(variants.map((v) => v.format)).toEqual([
            ...Array(4).fill('avif'),
            ...Array(4).fill('webp'),
            ...Array(4).fill('jpeg'),
        ])
        for (const format of ['avif', 'webp', 'jpeg']) {
            expect(widthsOf(variants, format)).toEqual([480, 800, 1200, 1600])
        }
        expect(variants.map((v) => v.height).slice(0, 4)).toEqual([360, 600, 900, 1200])
    })

    it('never upscales: drops widths above the source', () => {
        const variants = planVariants(jpeg(1000, 500), config)

        expect(widthsOf(variants, 'jpeg')).toEqual([480, 800])
    })

    it('keeps a config width equal to the source width', () => {
        expect(widthsOf(planVariants(jpeg(1200, 800), config), 'jpeg')).toEqual([480, 800, 1200])
    })

    it('uses the source width when every config width exceeds it', () => {
        const variants = planVariants({ width: 300, height: 200, format: 'png' }, config)

        expect(widthsOf(variants, 'png')).toEqual([300])
        expect(variants.find((v) => v.format === 'png').height).toBe(200)
    })

    it('with w: widths below w, plus w and 2w', () => {
        const variants = planVariants(jpeg(4000, 3000), { ...config, w: 800 })

        expect(widthsOf(variants, 'jpeg')).toEqual([480, 800, 1600])
    })

    it('with w: caps w and 2w at the source width', () => {
        expect(widthsOf(planVariants(jpeg(1000, 750), { ...config, w: 800 }), 'jpeg')).toEqual([
            480, 800, 1000,
        ])
        expect(widthsOf(planVariants(jpeg(600, 450), { ...config, w: 800 }), 'jpeg')).toEqual([
            480, 600,
        ])
    })

    it('sorts and de-duplicates the candidates', () => {
        const variants = planVariants(jpeg(2000, 1000), { ...config, widths: [800, 480], w: 480 })

        expect(widthsOf(variants, 'jpeg')).toEqual([480, 960])
    })
})

describe('planVariants: formats and quality', () => {
    it.each([
        ['jpeg', 'jpeg'],
        ['png', 'png'],
        ['webp', 'webp'],
        ['heif', 'jpeg'],
        ['tiff', 'jpeg'],
    ])('falls back from %s to %s', (source, fallback) => {
        expect(fallbackFormat(source)).toBe(fallback)
        const variants = planVariants({ width: 100, height: 100, format: source }, config)
        expect(variants.at(-1).format).toBe(fallback)
    })

    it('produces a modern format equal to the fallback only once', () => {
        const variants = planVariants({ width: 600, height: 400, format: 'webp' }, config)

        expect([...new Set(variants.map((v) => v.format))]).toEqual(['avif', 'webp'])
        expect(widthsOf(variants, 'webp')).toEqual([480])
    })

    it('keeps the configured format order and allows no modern formats', () => {
        const order = planVariants(jpeg(500, 500), { ...config, formats: ['webp', 'avif'] })
        expect([...new Set(order.map((v) => v.format))]).toEqual(['webp', 'avif', 'jpeg'])

        const none = planVariants(jpeg(500, 500), { ...config, formats: [] })
        expect([...new Set(none.map((v) => v.format))]).toEqual(['jpeg'])
    })

    it('forces the fallback format when asked (the og preset is always JPEG)', () => {
        const variants = planVariants(
            { width: 300, height: 200, format: 'png' },
            { ...config, formats: [], fallback: 'jpeg' }
        )
        expect(variants.map((v) => [v.format, v.quality])).toEqual([['jpeg', 78]])
    })

    it('takes quality per format, and q overrides all of them', () => {
        const variants = planVariants(jpeg(500, 500), config)
        expect(Object.fromEntries(variants.map((v) => [v.format, v.quality]))).toEqual({
            avif: 50,
            webp: 75,
            jpeg: 78,
        })

        const overridden = planVariants(jpeg(500, 500), { ...config, q: 60 })
        expect(new Set(overridden.map((v) => v.quality))).toEqual(new Set([60]))
    })
})

describe('planVariants: geometry', () => {
    it('without an aspect, keeps the source ratio and crops nothing', () => {
        const [variant] = planVariants(jpeg(2000, 1500), config)

        expect(variant).toMatchObject({ fit: 'fill', crop: null, aspect: null })
    })

    it('ratio + cover crops the largest centred region', () => {
        const variants = planVariants(jpeg(2000, 1500), { ...config, ratio: 16 / 9 })

        expect(variants[0].crop).toEqual({ left: 0, top: 188, width: 2000, height: 1125 })
        expect(variants[0].fit).toBe('cover')
        expect(widthsOf(variants, 'jpeg')).toEqual([480, 800, 1200, 1600])
        expect(variants.map((v) => v.height).slice(0, 4)).toEqual([270, 450, 675, 900])
    })

    it('crops a wide source on the sides', () => {
        const [variant] = planVariants(jpeg(2000, 1000), { ...config, ratio: 1 })

        expect(variant.crop).toEqual({ left: 500, top: 0, width: 1000, height: 1000 })
    })

    it('moves the crop to the focal point and keeps it inside the image', () => {
        const at = (focus) =>
            planVariants(jpeg(2000, 1000), { ...config, ratio: 1, focus })[0].crop.left

        expect(at({ x: 30, y: 50 })).toBe(100)
        expect(at({ x: 0, y: 50 })).toBe(0)
        expect(at({ x: 100, y: 50 })).toBe(1000)
        expect(at({ x: 90, y: 50 })).toBe(1000)

        const vertical = planVariants(jpeg(1000, 2000), { ...config, ratio: 1, focus: { x: 50, y: 20 } })
        expect(vertical[0].crop).toEqual({ left: 0, top: 0, width: 1000, height: 1000 })
    })

    it('passes attention/entropy through as a sharp strategy', () => {
        const [variant] = planVariants(jpeg(2000, 1000), { ...config, ratio: 1, focus: 'attention' })

        expect(variant.crop).toEqual({ strategy: 'attention' })
        expect(variant.width).toBe(480)
        expect(variant.height).toBe(480)
    })

    it('caps widths at the cropped region, not the source', () => {
        const variants = planVariants(jpeg(1500, 2000), { ...config, ratio: 16 / 9 })

        expect(variants[0].crop).toEqual({ left: 0, top: 578, width: 1500, height: 844 })
        expect(widthsOf(variants, 'jpeg')).toEqual([480, 800, 1200])
    })

    it('w + h set the aspect and take precedence over ratio', () => {
        const variants = planVariants(jpeg(4000, 3000), { ...config, w: 800, h: 450, ratio: 1 })

        expect(variants.filter((v) => v.format === 'jpeg').map((v) => [v.width, v.height])).toEqual([
            [480, 270],
            [800, 450],
            [1600, 900],
        ])
        expect(variants[0].aspect).toBeCloseTo(16 / 9)
    })

    it('contain pads to the aspect without cropping', () => {
        const variants = planVariants(jpeg(1000, 1000), { ...config, ratio: 2, fit: 'contain' })

        expect(variants[0]).toMatchObject({ fit: 'contain', crop: null, aspect: 2 })
        // The content may reach 1000 px tall, so the box may reach 2000 px wide.
        expect(widthsOf(variants, 'jpeg')).toEqual([480, 800, 1200, 1600])
        expect(variants.find((v) => v.width === 1600).height).toBe(800)
    })

    it('inside scales into the aspect box and reports the real size', () => {
        const variants = planVariants(jpeg(1000, 1000), { ...config, ratio: 2, fit: 'inside' })
        const jpegs = variants.filter((v) => v.format === 'jpeg')

        expect(jpegs.map((v) => [v.width, v.height])).toEqual([
            [240, 240],
            [400, 400],
            [600, 600],
            [800, 800],
        ])
        expect(jpegs[0]).toMatchObject({ fit: 'inside', crop: null })
    })
})

describe('readSourceMeta + encodeVariant', () => {
    let dir
    let paths

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-transform-'))
        paths = await makeImages(path.join(dir, 'src'))
    })

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const out = (name) => path.join(dir, 'out', name)

    it('reads the oriented size of a phone photo', async () => {
        expect(await readSourceMeta(paths.photo)).toEqual({
            width: FIXTURES.photo.height,
            height: FIXTURES.photo.width,
            format: 'jpeg',
            hasAlpha: false,
        })
        expect(await readSourceMeta(fs.readFileSync(paths.alpha))).toMatchObject({
            format: 'png',
            hasAlpha: true,
        })
    })

    it('rejects a file that is not an image', async () => {
        const bogus = path.join(dir, 'bogus.jpg')
        fs.writeFileSync(bogus, 'not an image')

        await expect(readSourceMeta(bogus)).rejects.toThrow()
    })

    it('comes out upright, at the planned size, with no EXIF or GPS', async () => {
        const source = await readSourceMeta(paths.photo)
        const variants = planVariants(source, config).filter((v) => v.width === 480)

        for (const variant of variants) {
            const file = out(`photo-480.${variant.format}`)
            await encodeVariant(paths.photo, variant, file)
            const meta = await sharp(file).metadata()

            expect(meta.format).toBe(variant.format === 'avif' ? 'heif' : variant.format)
            expect([meta.width, meta.height]).toEqual([480, 640])
            expect(meta.exif).toBeUndefined()
            expect(meta.orientation).toBeUndefined()
            expect(meta.icc).toBeUndefined()
        }

        // The fixture is red left / blue right before rotation; orientation 6
        // is a 90° clockwise turn, so red ends up on top.
        const { data, info } = await sharp(out('photo-480.jpeg'))
            .raw()
            .toBuffer({ resolveWithObject: true })
        const pixel = (x, y) => {
            const i = (y * info.width + x) * info.channels
            return [data[i], data[i + 1], data[i + 2]]
        }
        expect(pixel(240, 40)[0]).toBeGreaterThan(200)
        expect(pixel(240, 40)[2]).toBeLessThan(60)
        expect(pixel(240, 600)[2]).toBeGreaterThan(200)
        expect(pixel(240, 600)[0]).toBeLessThan(60)
    })

    it('strips GPS from the source bytes it was given', async () => {
        const source = await readSourceMeta(paths.photo)
        const [variant] = planVariants(source, { ...config, formats: [] })
        const file = out('gps.jpg')
        await encodeVariant(fs.readFileSync(paths.photo), variant, file)

        const exif = (await sharp(file).metadata()).exif
        expect(exif === undefined || !hasGpsIfd(exif)).toBe(true)
        expect(fs.readFileSync(file).includes(Buffer.from('Nera Test Camera'))).toBe(false)
    })

    it('crops in oriented coordinates', async () => {
        // Upright the photo is 1500×2000 with red on top: the top square is red.
        const source = await readSourceMeta(paths.photo)
        const [variant] = planVariants(source, {
            ...config,
            formats: [],
            ratio: 1,
            focus: { x: 50, y: 0 },
        })
        expect(variant.crop).toEqual({ left: 0, top: 0, width: 1500, height: 1500 })

        const file = out('square.jpg')
        await encodeVariant(paths.photo, variant, file)
        const { dominant } = await sharp(file).stats()
        const meta = await sharp(file).metadata()

        expect([meta.width, meta.height]).toEqual([480, 480])
        expect(dominant.r).toBeGreaterThan(200)
        expect(dominant.b).toBeLessThan(60)
    })

    it('crops with a sharp strategy at the planned size', async () => {
        const source = await readSourceMeta(paths.photo)
        const [variant] = planVariants(source, {
            ...config,
            formats: [],
            ratio: 16 / 9,
            focus: 'attention',
        })
        expect(variant.crop).toEqual({ strategy: 'attention' })

        const file = out('attention.jpg')
        await encodeVariant(paths.photo, variant, file)
        const meta = await sharp(file).metadata()
        expect([meta.width, meta.height]).toEqual([variant.width, variant.height])
        expect(variant.width / variant.height).toBeCloseTo(16 / 9, 1)
    })

    it('keeps PNG alpha in webp, avif and png', async () => {
        const source = await readSourceMeta(paths.alpha)
        const variants = planVariants(source, config)
        expect(variants.map((v) => v.format)).toEqual(['avif', 'webp', 'png'])

        for (const variant of variants) {
            const file = out(`alpha.${variant.format}`)
            await encodeVariant(paths.alpha, variant, file)

            expect((await sharp(file).metadata()).hasAlpha).toBe(true)
            expect((await sharp(file).stats()).isOpaque).toBe(false)
        }
    })

    it('flattens alpha onto white for a JPEG fallback', async () => {
        const [variant] = planVariants({ width: 300, height: 200, format: 'heif' }, {
            ...config,
            formats: [],
        })
        expect(variant.format).toBe('jpeg')

        const file = out('flat.jpg')
        await encodeVariant(paths.alpha, variant, file)
        const data = await sharp(file).extract({ left: 290, top: 100, width: 1, height: 1 }).raw().toBuffer()

        expect([...data].every((c) => c > 240)).toBe(true)
    })

    it('leaves no file behind when encoding fails', async () => {
        const file = out('broken.jpg')
        const variant = { width: 10, height: 10, format: 'jpeg', quality: 80, fit: 'fill', crop: null }

        await expect(encodeVariant(Buffer.from('nope'), variant, file)).rejects.toThrow()
        expect(fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('broken'))).toEqual([])
    })

    describe('placeholderOf (D10)', () => {
        const plan = async (extra = {}) => {
            const variants = planVariants(await readSourceMeta(paths.photo), { ...config, formats: [], ...extra })
            return variants[variants.length - 1]
        }
        const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

        it('gives the dominant colour of the region the variant shows, as #rrggbb', async () => {
            // Upright, the photo is red on top and blue below (orientation 6).
            const top = await placeholderOf(paths.photo, await plan({ ratio: 2, focus: { x: 50, y: 0 } }), 'color')
            const bottom = await placeholderOf(paths.photo, await plan({ ratio: 2, focus: { x: 50, y: 100 } }), 'color')

            expect(top.color).toMatch(/^#[0-9a-f]{6}$/)
            const [r, , b] = rgb(top.color)
            expect(r).toBeGreaterThan(200)
            expect(b).toBeLessThan(60)
            const [r2, , b2] = rgb(bottom.color)
            expect(b2).toBeGreaterThan(200)
            expect(r2).toBeLessThan(60)
            expect(Object.keys(top)).toEqual(['color'])
        })

        it('gives a tiny WebP data URI of the variant\'s aspect for blur', async () => {
            const variant = await plan()
            const { blur } = await placeholderOf(fs.readFileSync(paths.photo), variant, 'blur')

            expect(blur).toMatch(/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/)
            expect(blur.length).toBeLessThan(1024)
            const meta = await sharp(Buffer.from(blur.split(',')[1], 'base64')).metadata()
            expect(meta.format).toBe('webp')
            expect(meta.width).toBe(16)
            expect(meta.height).toBe(Math.round((16 * variant.height) / variant.width))
            expect(meta.exif).toBeUndefined()
        })

        it('marks an image that is not fully opaque as transparent instead', async () => {
            const [variant] = planVariants(await readSourceMeta(paths.alpha), { ...config, formats: [] })

            expect(await placeholderOf(paths.alpha, variant, 'color')).toEqual({ transparent: true })
            expect(await placeholderOf(paths.alpha, variant, 'blur')).toEqual({ transparent: true })
        })

        it('treats contain padding as transparency', async () => {
            const variant = await plan({ ratio: 3, fit: 'contain' })
            expect(variant.format).toBe('jpeg')
            // The JPEG fallback is flattened, but the modern formats keep the
            // transparent padding, so the image as a whole is not opaque.
            expect(await placeholderOf(paths.photo, variant, 'color')).toEqual({ transparent: true })
        })
    })
})
