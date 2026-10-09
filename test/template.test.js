import path from 'path'
import { load } from 'cheerio'
import pug from 'pug'
import { describe, it, expect } from 'vitest'

// The `+picture` mixin (D9), rendered from a fixture `meta.images` entry. The
// pug path is cwd-relative like the fleet's other template tests, so this
// passes only when vitest runs from the package root.

const image = {
    src: '/_img/hero-aaaaaaaa-1200.jpg',
    srcset: '/_img/hero-aaaaaaaa-480.jpg 480w, /_img/hero-aaaaaaaa-1200.jpg 1200w',
    sizes: '100vw',
    width: 1200,
    height: 800,
    type: 'image/jpeg',
    sources: [
        { type: 'image/avif', srcset: '/_img/hero-bbbbbbbb-480.avif 480w, /_img/hero-bbbbbbbb-1200.avif 1200w' },
        { type: 'image/webp', srcset: '/_img/hero-cccccccc-480.webp 480w, /_img/hero-cccccccc-1200.webp 1200w' },
    ],
    og: { src: '/_img/hero-dddddddd-1200.jpg', width: 1200, height: 630 },
}

const render = (call, locals = {}) =>
    pug.render(`doctype html\ninclude ../views/picture.pug\n${call}`, {
        filename: path.resolve('test/template.pug'),
        image,
        ...locals,
    })

describe('+picture mixin', () => {
    it('renders the same <picture> markup as the content pass', () => {
        // eslint-disable-next-line quotes
        expect(render(`+picture(image, { alt: 'A hero' })`)).toBe(
            '<!DOCTYPE html><picture>' +
                '<source type="image/avif" srcset="/_img/hero-bbbbbbbb-480.avif 480w, /_img/hero-bbbbbbbb-1200.avif 1200w" sizes="100vw">' +
                '<source type="image/webp" srcset="/_img/hero-cccccccc-480.webp 480w, /_img/hero-cccccccc-1200.webp 1200w" sizes="100vw">' +
                '<img src="/_img/hero-aaaaaaaa-1200.jpg" srcset="/_img/hero-aaaaaaaa-480.jpg 480w, /_img/hero-aaaaaaaa-1200.jpg 1200w" sizes="100vw" width="1200" height="800" alt="A hero" loading="lazy" decoding="async">' +
                '</picture>'
        )
    })

    it('takes class, sizes, eager loading and extra attributes', () => {
        const $ = load(
            // eslint-disable-next-line quotes
            render(`+picture(image, { alt: '', class: 'hero', sizes: '50vw', loading: 'eager' })(data-zoom)`)
        )
        const img = $('picture img')

        expect(img.attr()).toMatchObject({
            class: 'hero',
            alt: '',
            sizes: '50vw',
            loading: 'eager',
            fetchpriority: 'high',
            'data-zoom': '',
        })
        expect(img.attr('decoding')).toBeUndefined()
        expect($('source').map((_, el) => el.attribs.sizes).get()).toEqual(['50vw', '50vw'])
    })

    it('renders a bare <img> when there is no modern format', () => {
        const $ = load(render('+picture(plain)', { plain: { ...image, sources: [] } }))
        expect($('picture')).toHaveLength(0)
        expect($('img').attr('srcset')).toBe(image.srcset)
        expect($('img').attr('alt')).toBeUndefined()
    })

    it('renders nothing for a missing entry', () => {
        expect(render('+picture(undefined)\n+picture(meta.images && meta.images.image)', { meta: {} })).toBe(
            '<!DOCTYPE html>'
        )
    })

    it('escapes the alt text', () => {
        // eslint-disable-next-line quotes
        expect(render(`+picture(image, { alt: '"A" <b>' })`)).toContain('alt="&quot;A&quot; &lt;b&gt;"')
    })

    it('renders a placeholder as the <img> style, like the content pass', () => {
        const color = load(render('+picture(withColor)', { withColor: { ...image, color: '#a1b2c3' } }))
        expect(color('img').attr('style')).toBe('background-color:#a1b2c3')

        const blur = 'data:image/webp;base64,UklGRiIAAABXRUJQ'
        const blurred = load(render('+picture(withBlur)', { withBlur: { ...image, blur } }))
        expect(blurred('img').attr('style')).toBe(`background-image:url(${blur});background-size:cover`)

        expect(load(render('+picture(image)'))('img').attr('style')).toBeUndefined()
    })
})
