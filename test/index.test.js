import fs from 'fs'
import os from 'os'
import path from 'path'
import { load } from 'cheerio'
import sharp from 'sharp'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeImages } from './fixtures/make-images.js'

// The hooks called directly (no core run), for the paths the end-to-end test
// cannot reach: the D12 guard against an old core, and per-image failures.

const version = vi.hoisted(() => ({ value: '4.13.0' }))
vi.mock('../src/guard.js', async (importOriginal) => ({
    ...(await importOriginal()),
    coreVersion: () => version.value,
}))

const { getAssets, getMetaData } = await import('../index.js')

let root
let prevCwd
let warn

const app = () => ({ basePath: '', folders: { assets: './assets', config: './config' } })
const pageWith = (content, href = '/index.html') => ({ content, meta: { href } })

beforeEach(async () => {
    prevCwd = process.cwd()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-hooks-'))
    await makeImages(path.join(root, 'assets', 'images'))
    process.chdir(root)
    version.value = '4.13.0'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(prevCwd)
    fs.rmSync(root, { recursive: true, force: true })
})

describe('D12 core version guard', () => {
    it('fails before encoding anything when core is older than 4.13.0', async () => {
        version.value = '4.12.0'
        const pages = [pageWith('<img src="/images/alpha.png">')]

        await expect(getMetaData({ app: app(), pagesData: pages })).rejects.toThrow(
            /@nera-static\/core 4\.12\.0 is too old.*>= 4\.13\.0/
        )
        expect(fs.existsSync(path.join(root, '.nera-cache'))).toBe(false)
    })

    it('lets a site without processable images build on an older core', async () => {
        version.value = '4.12.0'
        const pages = [pageWith('<img src="/images/logo.svg"><p>text</p>')]

        const result = await getMetaData({ app: app(), pagesData: pages })
        expect(result[0]).toBe(pages[0])
        expect(await getAssets()).toEqual([])
    })

    it('warns but builds when the core version cannot be determined', async () => {
        version.value = null
        const result = await getMetaData({ app: app(), pagesData: [pageWith('<img src="/images/alpha.png">')] })

        expect(result[0].content).toContain('<picture>')
        expect(warn.mock.calls.join('\n')).toMatch(/could not determine the @nera-static\/core version/)
        await getAssets()
    })
})

describe('getMetaData / getAssets', () => {
    it('leaves an image it cannot decode as it was and warns', async () => {
        fs.writeFileSync(path.join(root, 'assets', 'images', 'broken.jpg'), 'not a jpeg')
        const content = '<p><img src="/images/broken.jpg" alt="b"></p>'

        const [page] = await getMetaData({ app: app(), pagesData: [pageWith(content, '/x.html')] })

        expect(page.content).toBe(content)
        expect(warn.mock.calls.join('\n')).toMatch(/\/x\.html: could not process \/images\/broken\.jpg/)
        expect(await getAssets()).toEqual([])
    })

    it('returns the cache files folder under output_path from config', async () => {
        fs.mkdirSync(path.join(root, 'config'))
        fs.writeFileSync(path.join(root, 'config', 'images.yaml'), 'output_path: /media/img/\n')

        const [page] = await getMetaData({ app: app(), pagesData: [pageWith('<img src="/images/alpha.png">')] })
        const assets = await getAssets()

        expect(page.content).toMatch(/src="\/media\/img\/alpha-[0-9a-f]{8}-300\.png"/)
        expect(assets).toEqual([
            { from: path.join(fs.realpathSync(root), '.nera-cache', 'images', 'files'), to: 'media/img' },
        ])
        // getAssets consumes the build: a second call has nothing to hand over.
        expect(await getAssets()).toEqual([])
    })

    it('returns a new page object only for pages it changed', async () => {
        const untouched = pageWith('<p>no images</p>')
        const changed = pageWith('<img src="/images/alpha.png">', '/b.html')

        const result = await getMetaData({ app: app(), pagesData: [untouched, changed] })

        expect(result[0]).toBe(untouched)
        expect(result[1]).not.toBe(changed)
        expect(result[1].meta).toBe(changed.meta)
        await getAssets()
    })
})

describe('query parameters and figure (D7, D8)', () => {
    const run = async (content, href = '/index.html') => {
        const [page] = await getMetaData({ app: app(), pagesData: [pageWith(content, href)] })
        await getAssets()
        return load(page.content, null, false)
    }
    const warnings = () => warn.mock.calls.map((c) => c.join(' ')).join('\n')

    it('feeds the parameters into the plan, derives sizes from w and drops them from the URLs', async () => {
        const $ = await run('<img src="/images/alpha.png?w=200&amp;ratio=1:1&amp;q=60">')
        const img = $('picture img')

        // 300×200 cropped square → 200×200; w and 2w are both capped at 200.
        expect([img.attr('width'), img.attr('height')]).toEqual(['200', '200'])
        expect(img.attr('srcset')).toMatch(/^\/_img\/alpha-[0-9a-f]{8}-200\.png 200w$/)
        expect(img.attr('sizes')).toBe('(min-width: 200px) 200px, 100vw')
        expect($.html()).not.toContain('?')
        expect(warnings()).toBe('')
    })

    it('gives a different quality its own files', async () => {
        const plain = (await run('<img src="/images/alpha.png">'))('source').first().attr('srcset')
        const q = (await run('<img src="/images/alpha.png?q=20">'))('source').first().attr('srcset')
        expect(q).not.toBe(plain)
    })

    it('honours formats, sizes and loading', async () => {
        const $ = await run(
            '<img src="/images/alpha.png?formats=webp"><img src="/images/alpha.png?formats=none&amp;sizes=50vw&amp;loading=eager">'
        )
        const [first, second] = [$('img').eq(0), $('img').eq(1)]

        expect($('picture source').map((_, el) => el.attribs.type).get()).toEqual(['image/webp'])
        expect(second.parent().is('picture')).toBe(false)
        expect(second.attr()).toMatchObject({ sizes: '50vw', loading: 'eager', fetchpriority: 'high' })
        expect(first.attr('loading')).toBe('eager')
    })

    it('leaves ?skip images in place without the parameter, even when the file is missing', async () => {
        const $ = await run('<img src="/images/missing.jpg?skip"><img src="/images/alpha.png?skip&amp;v=2" alt="a">')

        expect($('img').map((_, el) => el.attribs.src).get()).toEqual([
            '/images/missing.jpg',
            '/images/alpha.png?v=2',
        ])
        expect($('picture')).toHaveLength(0)
        expect(warnings()).toBe('')
        expect(fs.existsSync(path.join(root, '.nera-cache'))).toBe(false)
    })

    it('warns about unknown and invalid parameters with the page and the URL, and still processes', async () => {
        const $ = await run('<img src="/images/alpha.png?foo=1&amp;w=abc">', '/blog/x.html')

        expect($('picture')).toHaveLength(1)
        expect($('img').attr('sizes')).toBe('100vw')
        expect(warnings()).toContain(
            'plugin-images: /blog/x.html: unknown parameter "foo" ignored: /images/alpha.png?foo=1&w=abc'
        )
        expect(warnings()).toContain('/blog/x.html: invalid w "abc", using the default: /images/alpha.png?foo=1&w=abc')
    })

    it('does not read the query of a URL that is not local', async () => {
        const input = '<img src="https://example.com/a.jpg?skip&amp;foo=1">'
        const $ = await run(input)
        expect($('img').attr('src')).toBe('https://example.com/a.jpg?skip&foo=1')
        expect(warnings()).toBe('')
    })

    it('turns a captioned lone image into a figure by default, and not with figure: false', async () => {
        const content = '<p><img src="/images/alpha.png" alt="a" title="Cap"></p>'
        expect((await run(content))('figure.nera-image figcaption').text()).toBe('Cap')

        fs.mkdirSync(path.join(root, 'config'))
        fs.writeFileSync(path.join(root, 'config', 'images.yaml'), 'figure: false\n')
        const $ = await run(content)
        expect($('figure')).toHaveLength(0)
        expect($('img').attr('title')).toBe('Cap')
    })
})

describe('frontmatter images (D9)', () => {
    const pageMeta = (meta, content = '<p>text</p>') => ({ content, meta: { href: '/index.html', ...meta } })
    const run = async (meta, content) => {
        const page = pageMeta(meta, content)
        const [result] = await getMetaData({ app: app(), pagesData: [page] })
        const assets = await getAssets()
        return { page, result, assets }
    }
    const warnings = () => warn.mock.calls.map((c) => c.join(' ')).join('\n')
    const cached = (url) => path.join(root, '.nera-cache', 'images', 'files', path.basename(url))

    it('prepares meta.images.image with the fallback, the modern sources and the og JPEG', async () => {
        const { page, result, assets } = await run({ image: '/images/alpha.png' })
        const entry = result.meta.images.image

        expect(result.meta.image).toBe('/images/alpha.png')
        expect(page.meta.images).toBeUndefined()
        expect(result.content).toBe(page.content)
        expect(entry).toEqual({
            src: expect.stringMatching(/^\/_img\/alpha-[0-9a-f]{8}-300\.png$/),
            srcset: expect.stringMatching(/^\/_img\/alpha-[0-9a-f]{8}-300\.png 300w$/),
            sizes: '100vw',
            width: 300,
            height: 200,
            type: 'image/png',
            sources: [
                { type: 'image/avif', srcset: expect.stringMatching(/\.avif 300w$/) },
                { type: 'image/webp', srcset: expect.stringMatching(/\.webp 300w$/) },
            ],
            og: {
                src: expect.stringMatching(/^\/_img\/alpha-[0-9a-f]{8}-300\.jpg$/),
                width: 300,
                height: 158,
            },
        })
        // Every URL is a real file the cache hands to core.
        expect(assets).toHaveLength(1)
        for (const url of [entry.src, entry.og.src]) expect(fs.existsSync(cached(url))).toBe(true)
        expect(warnings()).toBe('')
    })

    it('crops the og JPEG to the preset size, never upscaled, from the frontmatter focus', async () => {
        const { result } = await run({ image: '/images/photo.jpg?focus=0,0' })
        const { og } = result.meta.images.image

        expect([og.width, og.height]).toEqual([1200, 630])
        const meta = await sharp(cached(og.src)).metadata()
        expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(['jpeg', 1200, 630, undefined])
    })

    it('reads query parameters on the frontmatter path like on a Markdown image', async () => {
        const { result } = await run({ image: 'images/photo.jpg?w=400&ratio=1:1&formats=webp' })
        const entry = result.meta.images.image

        expect([entry.width, entry.height]).toEqual([800, 800])
        expect(entry.sizes).toBe('(min-width: 400px) 400px, 100vw')
        expect(entry.sources.map((s) => s.type)).toEqual(['image/webp'])
        // The og preset keeps its own geometry.
        expect([entry.og.width, entry.og.height]).toEqual([1200, 630])
        expect(warnings()).toBe('')
    })

    it('honours frontmatter_keys and og: false', async () => {
        fs.mkdirSync(path.join(root, 'config'))
        fs.writeFileSync(path.join(root, 'config', 'images.yaml'), 'frontmatter_keys: [cover]\nog: false\n')

        const { result } = await run({ image: '/images/alpha.png', cover: '/images/alpha.png' })
        expect(Object.keys(result.meta.images)).toEqual(['cover'])
        expect(result.meta.images.cover.og).toBeUndefined()
    })

    it('warns only for a missing local file; external, SVG and ?skip get no entry silently', async () => {
        for (const image of ['https://example.com/a.jpg', '/images/logo.svg', '/images/alpha.png?skip']) {
            const { page, result } = await run({ image })
            expect(result).toBe(page)
        }
        expect(warnings()).toBe('')

        const { result } = await run({ image: '/images/nope.jpg' }, '<p>text</p>')
        expect(result.meta.images).toBeUndefined()
        expect(warnings()).toContain('plugin-images: /index.html: frontmatter image not found, left as is: /images/nope.jpg')
        expect(fs.existsSync(path.join(root, '.nera-cache'))).toBe(false)
    })

    it('warns that ?loading does nothing on a frontmatter image', async () => {
        const { result } = await run({ image: '/images/alpha.png?loading=eager' })
        expect(result.meta.images.image).toBeDefined()
        expect(warnings()).toContain('/index.html: loading has no effect on a frontmatter image, ignored: /images/alpha.png?loading=eager')
    })

    it('counts frontmatter images in the build line and leaves the content pass alone', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const { result } = await run({ image: '/images/alpha.png' }, '<img src="/images/alpha.png" alt="a">')

        expect(result.content).toContain('loading="eager"')
        expect(log.mock.calls.join('\n')).toMatch(/plugin-images: 2 image\(s\)/)
    })

    it('runs the D12 guard for frontmatter images too', async () => {
        version.value = '4.12.0'
        await expect(run({ image: '/images/alpha.png' })).rejects.toThrow(/too old/)
    })
})
