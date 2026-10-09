import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { openCache } from '../src/cache.js'
import { createGenerator } from '../src/generate.js'
import { createQueue } from '../src/queue.js'
import { encodeVariant, placeholderOf } from '../src/transform.js'
import { makeImages } from './fixtures/make-images.js'

const options = {
    widths: [480, 800, 1200, 1600],
    formats: ['avif', 'webp'],
    quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
}

let dir
let paths

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-generate-'))
    paths = await makeImages(path.join(dir, 'src'))
})

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

// One "build": open the cache, generate, prune, save — what slice 3's hooks do.
async function build(cacheDir, images) {
    const cache = openCache(cacheDir)
    const encode = vi.fn(encodeVariant)
    const generator = createGenerator({ cache, queue: createQueue({ concurrency: 2 }), encode })

    const results = []
    for (const [file, opts] of images) {
        results.push(await generator.generate(file, opts))
    }
    const pruned = cache.prune(generator.usedKeys())
    cache.save()

    return { cache, encode, generator, results, pruned }
}

describe('createGenerator', () => {
    it('encodes every planned variant on a cold cache', async () => {
        const cacheDir = path.join(dir, 'cold')
        const { encode, generator, results, cache } = await build(cacheDir, [[paths.photo, options]])
        const [result] = results

        // Upright 1500×2000 photo: 480/800/1200 in avif, webp and jpeg.
        expect(result.variants).toHaveLength(9)
        expect(encode).toHaveBeenCalledTimes(9)
        expect(generator.encoded).toBe(9)
        expect([result.width, result.height]).toEqual([1200, 1600])
        expect(result.source).toEqual({ width: 1500, height: 2000, format: 'jpeg', hasAlpha: false })
        expect(result.files).toHaveLength(9)
        for (const name of result.files) {
            expect(name).toMatch(/^photo-[0-9a-f]{8}-(480|800|1200)\.(avif|webp|jpg)$/)
            expect(cache.hasFile(name)).toBe(true)
        }
        expect(cache.get(result.key)).toEqual({ width: 1200, height: 1600, files: result.files })
    })

    it('encodes nothing on a second run with the same inputs', async () => {
        const cacheDir = path.join(dir, 'warm')
        const first = await build(cacheDir, [[paths.photo, options], [paths.alpha, options]])
        expect(first.encode).toHaveBeenCalled()

        const second = await build(cacheDir, [[paths.photo, options], [paths.alpha, options]])

        expect(second.encode).not.toHaveBeenCalled()
        expect(second.generator.encoded).toBe(0)
        expect(second.pruned).toEqual({ entries: [], files: [] })
        expect(second.results.map((r) => r.files)).toEqual(first.results.map((r) => r.files))
    })

    it('encodes a variant shared by two pages once', async () => {
        const { encode, results } = await build(path.join(dir, 'shared'), [
            [paths.alpha, options],
            [paths.alpha, options],
        ])

        expect(results[0].key).toBe(results[1].key)
        expect(encode).toHaveBeenCalledTimes(results[0].variants.length)
    })

    it('encodes only what changed when the options change', async () => {
        const cacheDir = path.join(dir, 'changed')
        await build(cacheDir, [[paths.photo, options]])

        const { encode, pruned } = await build(cacheDir, [
            [paths.photo, { ...options, quality: { ...options.quality, avif: 40 } }],
        ])

        // Only the three avif widths are new; webp and jpeg come from cache.
        expect(encode).toHaveBeenCalledTimes(3)
        expect(encode.mock.calls.every(([, variant]) => variant.format === 'avif')).toBe(true)
        expect(pruned.entries).toHaveLength(1)
        expect(pruned.files).toHaveLength(3)
        expect(pruned.files.every((name) => name.endsWith('.avif'))).toBe(true)
    })

    it('prunes the files of an image no longer used', async () => {
        const cacheDir = path.join(dir, 'prune')
        const first = await build(cacheDir, [[paths.photo, options], [paths.alpha, options]])
        const [photo, alpha] = first.results

        const second = await build(cacheDir, [[paths.alpha, options]])

        expect(second.encode).not.toHaveBeenCalled()
        expect(second.pruned).toEqual({ entries: [photo.key], files: [...photo.files].sort() })
        expect(fs.readdirSync(second.cache.filesDir).sort()).toEqual([...alpha.files].sort())
        expect(openCache(cacheDir).keys()).toEqual([alpha.key])
    })

    it('re-encodes a variant whose file disappeared', async () => {
        const cacheDir = path.join(dir, 'missing')
        const first = await build(cacheDir, [[paths.alpha, options]])
        const [gone] = first.results[0].files
        fs.rmSync(first.cache.filePath(gone))

        const second = await build(cacheDir, [[paths.alpha, options]])

        expect(second.encode).toHaveBeenCalledTimes(1)
        expect(second.cache.hasFile(gone)).toBe(true)
    })

    it('rejects when the source is not an image', async () => {
        const bogus = path.join(dir, 'bogus.png')
        fs.writeFileSync(bogus, 'not an image')
        const generator = createGenerator({
            cache: openCache(path.join(dir, 'bogus')),
            queue: createQueue(),
        })

        await expect(generator.generate(bogus, options)).rejects.toThrow()
    })
})

describe('placeholders in the manifest (D10)', () => {
    async function run(cacheDir, images, mode) {
        const cache = openCache(cacheDir)
        const placeholder = vi.fn(placeholderOf)
        const encode = vi.fn(encodeVariant)
        const generator = createGenerator({ cache, queue: createQueue({ concurrency: 2 }), encode, placeholder })
        const results = []
        for (const file of images) {
            results.push(await generator.generate(file, options, { placeholder: mode }))
        }
        cache.prune(generator.usedKeys())
        cache.save()
        return { cache, placeholder, encode, generator, results }
    }

    it('computes nothing with placeholder none and keeps the entry as before', async () => {
        const { placeholder, results, cache } = await run(path.join(dir, 'ph-none'), [paths.photo], 'none')

        expect(placeholder).not.toHaveBeenCalled()
        expect(Object.keys(cache.get(results[0].key))).toEqual(['width', 'height', 'files'])
    })

    it('stores the placeholder with the entry and reads it back on a warm build', async () => {
        const cacheDir = path.join(dir, 'ph-warm')
        const first = await run(cacheDir, [paths.photo, paths.photo], 'color')

        // Same image twice in one build: computed once.
        expect(first.placeholder).toHaveBeenCalledTimes(1)
        expect(first.generator.placeholders).toBe(1)
        expect(first.results[0].color).toMatch(/^#[0-9a-f]{6}$/)
        expect(openCache(cacheDir).get(first.results[0].key).color).toBe(first.results[0].color)

        const second = await run(cacheDir, [paths.photo], 'color')
        expect(second.placeholder).not.toHaveBeenCalled()
        expect(second.encode).not.toHaveBeenCalled()
        expect(second.results[0].color).toBe(first.results[0].color)
    })

    it('keeps the manifest key and every file when the mode changes', async () => {
        const cacheDir = path.join(dir, 'ph-switch')
        const none = await run(cacheDir, [paths.photo], 'none')
        const blur = await run(cacheDir, [paths.photo], 'blur')

        expect(blur.results[0].key).toBe(none.results[0].key)
        expect(blur.encode).not.toHaveBeenCalled()
        expect(blur.placeholder).toHaveBeenCalledTimes(1)
        expect(blur.results[0].blur).toMatch(/^data:image\/webp;base64,/)

        // Only the current mode's data is kept.
        const color = await run(cacheDir, [paths.photo], 'color')
        expect(color.placeholder).toHaveBeenCalledTimes(1)
        const entry = openCache(cacheDir).get(color.results[0].key)
        expect(entry.color).toBeDefined()
        expect(entry.blur).toBeUndefined()

        await run(cacheDir, [paths.photo], 'none')
        expect(Object.keys(openCache(cacheDir).get(color.results[0].key))).toEqual(['width', 'height', 'files'])
    })

    it('remembers a transparent image, whatever the mode', async () => {
        const cacheDir = path.join(dir, 'ph-alpha')
        const first = await run(cacheDir, [paths.alpha], 'blur')
        expect(first.results[0]).toMatchObject({ transparent: true })
        expect(first.results[0].blur).toBeUndefined()

        const second = await run(cacheDir, [paths.alpha], 'color')
        expect(second.placeholder).not.toHaveBeenCalled()
        expect(second.results[0].color).toBeUndefined()
    })
})
