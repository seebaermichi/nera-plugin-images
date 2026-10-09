import { describe, it, expect, vi } from 'vitest'
import { load } from 'cheerio'
import { imgAttributes, rewriteHtml } from '../src/rewrite-html.js'

// A generated image as `generate` returns it, without sharp: avif + webp +
// a jpeg fallback at 480/800/1200, so the markup tests run on fixed names.
function fakeImage(base = 'photo', { formats = ['avif', 'webp', 'jpeg'], ext } = {}) {
    const exts = { avif: 'avif', webp: 'webp', jpeg: 'jpg', png: 'png', ...ext }
    const variants = formats.flatMap((format) =>
        [480, 800, 1200].map((width) => ({
            width,
            height: width * 0.75,
            format,
            file: `${base}-0123abcd-${width}.${exts[format]}`,
        }))
    )
    return { width: 1200, height: 900, variants }
}

const defaults = { outputPath: '/_img', sizes: '100vw', eagerFirst: true }

const rewrite = (html, handle = async () => fakeImage(), options = {}) =>
    rewriteHtml(html, { ...defaults, handle, ...options })

describe('rewriteHtml markup (D6 contract)', () => {
    it('emits the documented <picture> for one Markdown image', async () => {
        const { html, count } = await rewrite(
            '<p><img src="/images/photo.jpg" alt="A photo"></p>',
            async () => fakeImage(),
            { eagerFirst: false }
        )

        expect(count).toBe(1)
        // eslint-disable-next-line quotes -- vitest writes inline snapshots in backticks
        expect(html).toMatchInlineSnapshot(`"<p><picture><source type="image/avif" srcset="/_img/photo-0123abcd-480.avif 480w, /_img/photo-0123abcd-800.avif 800w, /_img/photo-0123abcd-1200.avif 1200w" sizes="100vw"><source type="image/webp" srcset="/_img/photo-0123abcd-480.webp 480w, /_img/photo-0123abcd-800.webp 800w, /_img/photo-0123abcd-1200.webp 1200w" sizes="100vw"><img src="/_img/photo-0123abcd-1200.jpg" srcset="/_img/photo-0123abcd-480.jpg 480w, /_img/photo-0123abcd-800.jpg 800w, /_img/photo-0123abcd-1200.jpg 1200w" sizes="100vw" width="1200" height="900" alt="A photo" loading="lazy" decoding="async"></picture></p>"`)
    })

    it('makes the first rewritten image of the page eager, the rest lazy', async () => {
        const { html } = await rewrite('<img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg">')
        const imgs = load(html, null, false)('img')

        expect(imgs.eq(0).attr()).toMatchObject({ loading: 'eager', fetchpriority: 'high' })
        expect(imgs.eq(0).attr('decoding')).toBeUndefined()
        for (const i of [1, 2]) {
            expect(imgs.eq(i).attr()).toMatchObject({ loading: 'lazy', decoding: 'async' })
            expect(imgs.eq(i).attr('fetchpriority')).toBeUndefined()
        }
    })

    it('does not count an untouched image as the first one', async () => {
        const handle = async (src) => (src.endsWith('.svg') ? null : fakeImage())
        const { html } = await rewrite('<img src="/logo.svg"><img src="/a.jpg">', handle)
        const $ = load(html, null, false)

        expect($('img[src="/logo.svg"]').attr('loading')).toBeUndefined()
        expect($('picture img').attr('loading')).toBe('eager')
    })

    it('makes every image lazy with eagerFirst off', async () => {
        const { html } = await rewrite('<img src="/a.jpg"><img src="/b.jpg">', undefined, {
            eagerFirst: false,
        })
        const loading = load(html, null, false)('img').map((_, el) => el.attribs.loading).get()
        expect(loading).toEqual(['lazy', 'lazy'])
    })

    it('emits a bare <img> with srcset when there is no modern format', async () => {
        const { html } = await rewrite('<img src="/a.jpg" alt="x">', async () =>
            fakeImage('a', { formats: ['jpeg'] })
        )
        const $ = load(html, null, false)

        expect($('picture')).toHaveLength(0)
        expect($('img').attr('srcset')).toBe(
            '/_img/a-0123abcd-480.jpg 480w, /_img/a-0123abcd-800.jpg 800w, /_img/a-0123abcd-1200.jpg 1200w'
        )
    })

    it('uses the last format as the fallback (a WebP source has no webp <source>)', async () => {
        const { html } = await rewrite('<img src="/a.webp">', async () =>
            fakeImage('a', { formats: ['avif', 'webp'] })
        )
        const $ = load(html, null, false)

        expect($('source').map((_, el) => el.attribs.type).get()).toEqual(['image/avif'])
        expect($('img').attr('src')).toBe('/_img/a-0123abcd-1200.webp')
    })

    it('honours outputPath and sizes', async () => {
        const { html } = await rewrite('<img src="/a.jpg">', undefined, {
            outputPath: '/media/x',
            sizes: '50vw',
        })
        const $ = load(html, null, false)

        expect($('img').attr('src')).toBe('/media/x/photo-0123abcd-1200.jpg')
        expect($('source, img').map((_, el) => el.attribs.sizes).get()).toEqual(['50vw', '50vw', '50vw'])
    })

    it('escapes attribute values it carries over', async () => {
        const { html } = await rewrite('<img src="/a.jpg" alt="&quot;Quotes&quot; &amp; <tags>">')
        expect(load(html, null, false)('img').attr('alt')).toBe('"Quotes" & <tags>')
    })
})

describe('imgAttributes', () => {
    const image = { src: '/s.jpg', srcset: 's', sizes: '100vw', width: 10, height: 5 }

    it('keeps author attributes in order after the computed ones', () => {
        const attrs = imgAttributes(
            { src: '/orig.jpg', alt: 'A', class: 'c', id: 'i', title: 'T', 'data-x': '1', width: '99' },
            image,
            false
        )
        expect(Object.keys(attrs)).toEqual([
            'src', 'srcset', 'sizes', 'width', 'height',
            'alt', 'class', 'id', 'title', 'data-x',
            'loading', 'decoding',
        ])
        expect(attrs.width).toBe('10')
        expect(attrs.src).toBe('/s.jpg')
    })

    it('leaves a missing alt missing', () => {
        expect(imgAttributes({ src: '/a.jpg' }, image, false)).not.toHaveProperty('alt')
    })

    it('lets an author loading value decide the mode', () => {
        expect(imgAttributes({ loading: 'lazy' }, image, true)).toMatchObject({
            loading: 'lazy',
            decoding: 'async',
        })
        expect(imgAttributes({ loading: 'lazy' }, image, true)).not.toHaveProperty('fetchpriority')
        expect(imgAttributes({ loading: 'eager' }, image, false)).toMatchObject({
            loading: 'eager',
            fetchpriority: 'high',
        })
    })

    it('keeps every author loading hint as written', () => {
        const attrs = imgAttributes({ decoding: 'sync', fetchpriority: 'low' }, image, true)
        expect(attrs).toMatchObject({ loading: 'eager', decoding: 'sync', fetchpriority: 'low' })
    })
})

describe('rewriteHtml skip rules (D5)', () => {
    it('leaves an <img> inside <picture> alone', async () => {
        const handle = vi.fn(async () => fakeImage())
        const input = '<picture><source srcset="/a.webp"><img src="/a.jpg"></picture>'
        const { html, count } = await rewrite(input, handle)

        expect(handle).not.toHaveBeenCalled()
        expect(count).toBe(0)
        expect(html).toBe(input)
    })

    it('leaves an <img> with its own srcset alone', async () => {
        const handle = vi.fn(async () => fakeImage())
        const input = '<img src="/a.jpg" srcset="/a.jpg 1x, /a@2x.jpg 2x">'
        const { html } = await rewrite(input, handle)

        expect(handle).not.toHaveBeenCalled()
        expect(html).toBe(input)
    })

    it('leaves data-nera-skip images alone and removes the attribute', async () => {
        const handle = vi.fn(async () => fakeImage())
        const { html, count } = await rewrite('<img src="/a.jpg" data-nera-skip alt="x">', handle)

        expect(handle).not.toHaveBeenCalled()
        expect(count).toBe(0)
        expect(html).toBe('<img src="/a.jpg" alt="x">')
    })

    it('keeps an image the handler declines exactly as it was', async () => {
        const input = '<p><img src="https://example.com/a.jpg" alt="x"> &amp; text</p>'
        const { html, count } = await rewrite(input, async () => null)

        expect(count).toBe(0)
        expect(html).toBe(input)
    })

    it('passes the src as rendered, and an empty string for a missing src', async () => {
        const handle = vi.fn(async () => null)
        await rewrite('<img src="../a%20b.jpg?w=1#x"><img alt="no src">', handle)

        expect(handle.mock.calls.map((c) => c[0])).toEqual(['../a%20b.jpg?w=1#x', ''])
    })

    it('returns content without images unchanged, without parsing', async () => {
        const handle = vi.fn()
        expect(await rewrite('<p>Hi</p>', handle)).toEqual({ html: '<p>Hi</p>', count: 0 })
        expect(await rewrite(undefined, handle)).toEqual({ html: undefined, count: 0 })
        expect(handle).not.toHaveBeenCalled()
    })

    it('assembles in document order regardless of which image finishes first', async () => {
        const delays = { '/a.jpg': 30, '/b.jpg': 0 }
        const handle = (src) =>
            new Promise((resolve) =>
                setTimeout(() => resolve(fakeImage(src.slice(1, 2))), delays[src])
            )
        const { html } = await rewrite('<img src="/a.jpg"><img src="/b.jpg">', handle)
        const imgs = load(html, null, false)('img')

        expect(imgs.eq(0).attr('src')).toMatch(/^\/_img\/a-/)
        expect(imgs.eq(0).attr('loading')).toBe('eager')
        expect(imgs.eq(1).attr('src')).toMatch(/^\/_img\/b-/)
    })
})
