import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { load } from 'cheerio'
import sharp from 'sharp'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import run from '@nera-static/core'
import { makeImages } from './fixtures/make-images.js'

// End to end through core's real pipeline (ROADMAP slice 3): a throwaway site
// in a temp dir loads this repo's index.js as a local plugin, and `run()`
// builds it, including the `getAssets` copy into public/.

const pluginEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js')

const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

function makeSite(root, { appYaml = '' } = {}) {
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', private: true, type: 'module' }))
    write(path.join(root, 'config', 'app.yaml'), `name: Demo\nlang: en\n${appYaml}`)
    write(
        path.join(root, 'views', 'layout.pug'),
        'doctype html\nhtml\n  body\n    main!= content'
    )
    write(
        path.join(root, 'plugins', 'images', 'index.js'),
        `export * from '${pathToFileURL(pluginEntry).href}'\n`
    )
}

const page = (body) => `---\ntitle: Page\nlayout: layout.pug\n---\n${body}\n`

const folders = (root) => ({
    config: path.join(root, 'config'),
    pages: path.join(root, 'pages'),
    views: path.join(root, 'views'),
    assets: path.join(root, 'assets'),
    dist: path.join(root, 'public'),
    plugins: path.join(root, 'plugins'),
})

let prevCwd
let log
let warn

async function build(root) {
    log.mockClear()
    warn.mockClear()
    process.chdir(root)
    try {
        await run({ folders: folders(root) })
    } finally {
        process.chdir(prevCwd)
    }
}

const html = (root, rel) => load(fs.readFileSync(path.join(root, 'public', rel), 'utf-8'))
const logged = (spy) => spy.mock.calls.map((c) => c.join(' ')).join('\n')
const urlsOf = (srcset) => srcset.split(',').map((s) => s.trim().split(' ')[0])

function mtimes(dir) {
    return Object.fromEntries(
        fs.readdirSync(dir).sort().map((name) => [name, fs.statSync(path.join(dir, name)).mtimeMs])
    )
}

beforeAll(() => {
    prevCwd = process.cwd()
})

beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    log.mockRestore()
    warn.mockRestore()
})

// The cold build is the expensive part (AVIF encodes), so one site is built
// once and the tests below run against it in order.
describe('a site with images', () => {
    let root
    let coldWarnings

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-int-'))
        makeSite(root)
        await makeImages(path.join(root, 'assets', 'images'))
        write(
            path.join(root, 'pages', 'index.md'),
            page(
                [
                    '![Logo](/images/logo.svg)',
                    '',
                    '![A photo](/images/photo.jpg)',
                    '',
                    'Inline ![Alpha](images/alpha.png) image.',
                    '',
                    '![Remote](https://example.com/x.jpg)',
                    '',
                    '![Gone](/images/missing.jpg)',
                ].join('\n')
            )
        )
        write(path.join(root, 'pages', 'blog', 'post.md'), page('![Same photo](../images/photo.jpg)'))
        write(path.join(root, 'pages', 'plain.md'), page('No images here.'))

        log = vi.spyOn(console, 'log').mockImplementation(() => {})
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await build(root)
        coldWarnings = logged(warn)
    }, 120_000)

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('copies the variants to public/_img', () => {
        const files = fs.readdirSync(path.join(root, 'public', '_img')).sort()

        // photo: 480/800/1200 × avif/webp/jpg; alpha (300 px wide): 300 × avif/webp/png.
        expect(files).toHaveLength(12)
        expect(files.filter((f) => f.startsWith('photo-'))).toHaveLength(9)
        expect(files.filter((f) => f.startsWith('alpha-'))).toHaveLength(3)
        expect(files.filter((f) => f.endsWith('.png'))).toEqual([expect.stringMatching(/^alpha-[0-9a-f]{8}-300\.png$/)])
    })

    it('rewrites local raster images to <picture> with intrinsic width/height', () => {
        const $ = html(root, 'index.html')
        const photo = $('img[alt="A photo"]')
        const alpha = $('img[alt="Alpha"]')

        expect($('picture')).toHaveLength(2)
        expect(photo.parent().is('picture')).toBe(true)
        // EXIF orientation 6: the 2000×1500 original is upright 1500×2000;
        // 1600 is above the source and dropped, so 1200 is the largest.
        expect([photo.attr('width'), photo.attr('height')]).toEqual(['1200', '1600'])
        expect(photo.attr('src')).toMatch(/^\/_img\/photo-[0-9a-f]{8}-1200\.jpg$/)
        expect([alpha.attr('width'), alpha.attr('height')]).toEqual(['300', '200'])
        expect(alpha.attr('src')).toMatch(/\.png$/)
        expect(photo.prev().attr('type')).toBe('image/webp')
        expect(photo.prev().prev().attr('type')).toBe('image/avif')
    })

    it('makes the first rewritten image eager, the rest lazy, per page', () => {
        const $ = html(root, 'index.html')
        expect($('img[alt="A photo"]').attr('loading')).toBe('eager')
        expect($('img[alt="A photo"]').attr('fetchpriority')).toBe('high')
        expect($('img[alt="Alpha"]').attr('loading')).toBe('lazy')
        // The same photo on another page is that page's first image.
        expect(html(root, 'blog/post.html')('img').attr('loading')).toBe('eager')
    })

    it('leaves SVG, external and missing images untouched and warns for the missing one', () => {
        const $ = html(root, 'index.html')
        expect($('img[src="/images/logo.svg"]').parent().is('p')).toBe(true)
        expect($('img[src="https://example.com/x.jpg"]')).toHaveLength(1)
        expect($('img[src="/images/missing.jpg"]')).toHaveLength(1)
        expect(coldWarnings).toMatch(/plugin-images: \/index\.html: image not found.*\/images\/missing\.jpg/)
        expect(coldWarnings).not.toMatch(/logo\.svg|example\.com/)
    })

    it('points every srcset and src at a file that exists in public/', () => {
        for (const rel of ['index.html', 'blog/post.html']) {
            const $ = html(root, rel)
            const urls = [
                ...$('picture source, picture img').map((_, el) => urlsOf(el.attribs.srcset)).get(),
                ...$('picture img').map((_, el) => el.attribs.src).get(),
            ]
            expect(urls.length).toBeGreaterThan(0)
            for (const url of urls) {
                expect(fs.existsSync(path.join(root, 'public', url))).toBe(true)
            }
        }
    })

    it('ships no EXIF/GPS in the emitted files', async () => {
        const dir = path.join(root, 'public', '_img')
        for (const name of fs.readdirSync(dir)) {
            expect((await sharp(path.join(dir, name)).metadata()).exif).toBeUndefined()
        }
    })

    it('keeps the cache at the site root and leaves image-less pages byte-identical', () => {
        expect(fs.existsSync(path.join(root, '.nera-cache', 'images', 'manifest.json'))).toBe(true)
        expect(html(root, 'plain.html')('main').html().trim()).toBe('<p>No images here.</p>')
    })

    it('encodes nothing on a second build', async () => {
        const filesDir = path.join(root, '.nera-cache', 'images', 'files')
        const before = mtimes(filesDir)
        const pageBefore = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8')

        await build(root)

        expect(mtimes(filesDir)).toEqual(before)
        expect(logged(log)).toMatch(/plugin-images: 3 image\(s\), 0 variant\(s\) encoded/)
        expect(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8')).toBe(pageBefore)
    }, 60_000)

    it('prefixes srcset and src with base_path', async () => {
        write(path.join(root, 'config', 'app.yaml'), 'name: Demo\nlang: en\nbase_path: /sub\n')
        try {
            await build(root)
            const $ = html(root, 'index.html')
            const urls = [
                ...$('picture source, picture img').map((_, el) => urlsOf(el.attribs.srcset)).get(),
                ...$('picture img').map((_, el) => el.attribs.src).get(),
            ]
            expect(urls.length).toBeGreaterThan(0)
            for (const url of urls) expect(url).toMatch(/^\/sub\/_img\//)
            expect(logged(log)).toMatch(/0 variant\(s\) encoded/)
        } finally {
            write(path.join(root, 'config', 'app.yaml'), 'name: Demo\nlang: en\n')
        }
    }, 60_000)

    it('prunes the variants of an image no page uses any more', async () => {
        write(path.join(root, 'pages', 'index.md'), page('![A photo](/images/photo.jpg)'))
        await build(root)

        const cached = fs.readdirSync(path.join(root, '.nera-cache', 'images', 'files'))
        const published = fs.readdirSync(path.join(root, 'public', '_img'))
        expect(cached.some((f) => f.startsWith('alpha-'))).toBe(false)
        expect(published.sort()).toEqual(cached.sort())
        expect(published).toHaveLength(9)
    }, 60_000)
})

describe('query parameters and captions from Markdown', () => {
    it('reads the parameters and the title through markdown-it', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-params-'))
        try {
            makeSite(root)
            await makeImages(path.join(root, 'assets', 'images'))
            write(
                path.join(root, 'pages', 'index.md'),
                page(
                    [
                        '![Wide](/images/photo.jpg?w=400&ratio=16:9&focus=50,0&formats=webp "A caption")',
                        '',
                        'Inline ![Alpha](/images/alpha.png?skip "Kept title") image.',
                    ].join('\n')
                )
            )
            await build(root)

            const $ = html(root, 'index.html')
            const figure = $('main > figure.nera-image')
            const img = figure.find('picture img')

            expect(figure.find('figcaption.nera-image__caption').text()).toBe('A caption')
            expect(img.attr('title')).toBeUndefined()
            // Upright 1500×2000, cropped to 16:9 → 1500×844; w=400 and 2w=800.
            expect([img.attr('width'), img.attr('height')]).toEqual(['800', '450'])
            expect(urlsOf(img.attr('srcset')).map((u) => u.match(/-(\d+)\.jpg$/)[1])).toEqual(['400', '800'])
            expect(figure.find('source').map((_, el) => el.attribs.type).get()).toEqual(['image/webp'])
            expect(img.attr('sizes')).toBe('(min-width: 400px) 400px, 100vw')
            expect($('main p img').attr()).toMatchObject({ src: '/images/alpha.png', title: 'Kept title' })
            expect(logged(warn)).not.toMatch(/plugin-images/)
            expect(fs.readdirSync(path.join(root, 'public', '_img'))).toHaveLength(4)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    }, 60_000)
})

describe('a frontmatter image through the +picture mixin', () => {
    it('renders meta.images.image in a layout, with base_path, and keeps meta.image as written', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-frontmatter-'))
        try {
            makeSite(root, { appYaml: 'base_path: /sub\n' })
            await makeImages(path.join(root, 'assets', 'images'))
            // What `npm run publish-template` puts there.
            write(
                path.join(root, 'views', 'vendor', 'plugin-images', 'picture.pug'),
                fs.readFileSync(path.resolve(path.dirname(pluginEntry), 'views', 'picture.pug'), 'utf-8')
            )
            write(
                path.join(root, 'views', 'hero.pug'),
                [
                    'include /vendor/plugin-images/picture',
                    'doctype html',
                    'html',
                    '  head',
                    '    meta(property="og:image" content=meta.image)',
                    '    if meta.images && meta.images.image',
                    '      meta(name="og-file" content=meta.images.image.og.src)',
                    '  body',
                    '    header',
                    '      +picture(meta.images && meta.images.image, { alt: meta.title, loading: \'eager\' })',
                    '    main!= content',
                ].join('\n')
            )
            write(
                path.join(root, 'pages', 'index.md'),
                '---\ntitle: Hero\nlayout: hero.pug\nimage: /images/photo.jpg\n---\nText.\n'
            )
            write(path.join(root, 'pages', 'none.md'), '---\ntitle: None\nlayout: hero.pug\n---\nText.\n')
            await build(root)

            const $ = html(root, 'index.html')
            const img = $('header picture img')
            const urls = [
                ...$('header source, header img').map((_, el) => urlsOf(el.attribs.srcset)).get(),
                img.attr('src'),
            ]

            expect(img.attr()).toMatchObject({ alt: 'Hero', width: '1200', height: '1600', loading: 'eager' })
            expect($('header source').map((_, el) => el.attribs.type).get()).toEqual(['image/avif', 'image/webp'])
            for (const url of urls) {
                expect(url).toMatch(/^\/sub\/_img\//)
                expect(fs.existsSync(path.join(root, 'public', url.slice('/sub'.length)))).toBe(true)
            }
            // The original string is untouched; the og file is published too.
            expect($('meta[property="og:image"]').attr('content')).toBe('/images/photo.jpg')
            const og = $('meta[name="og-file"]').attr('content')
            expect(await sharp(path.join(root, 'public', og)).metadata()).toMatchObject({ width: 1200, height: 630, format: 'jpeg' })

            expect(html(root, 'none.html')('header').html().trim()).toBe('')
            expect(logged(warn)).not.toMatch(/plugin-images/)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    }, 60_000)
})

describe('placeholders end to end (D10)', () => {
    it('inlines the blur from a cold build and reads it from the manifest on a warm one', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-ph-'))
        try {
            makeSite(root)
            await makeImages(path.join(root, 'assets', 'images'))
            write(path.join(root, 'config', 'images.yaml'), 'placeholder: blur\nformats: [webp]\n')
            write(path.join(root, 'pages', 'index.md'), page('![A photo](/images/photo.jpg)\n\n![Alpha](/images/alpha.png)'))

            await build(root)
            const style = html(root, 'index.html')('img[alt="A photo"]').attr('style')
            const manifest = JSON.parse(
                fs.readFileSync(path.join(root, '.nera-cache', 'images', 'manifest.json'), 'utf-8')
            )
            const entries = Object.values(manifest.entries)

            expect(logged(log)).toMatch(/2 image\(s\), \d+ variant\(s\) encoded, 2 placeholder\(s\) computed/)
            expect(style).toMatch(/^background-image:url\(data:image\/webp;base64,[A-Za-z0-9+/]+=*\);background-size:cover$/)
            expect(html(root, 'index.html')('img[alt="Alpha"]').attr('style')).toBeUndefined()
            expect(entries.map((e) => e.blur).filter(Boolean)).toEqual([style.slice(21, style.indexOf(');'))])
            expect(entries.filter((e) => e.transparent)).toHaveLength(1)

            const before = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8')
            await build(root)
            expect(logged(log)).toMatch(/0 variant\(s\) encoded, 0 placeholder\(s\) computed/)
            expect(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8')).toBe(before)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    }, 60_000)
})

describe('a site without images', () => {
    it('creates no cache and no _img folder', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-none-'))
        try {
            makeSite(root)
            write(path.join(root, 'pages', 'index.md'), page('# Hi'))
            await build(root)

            expect(fs.existsSync(path.join(root, 'public', 'index.html'))).toBe(true)
            expect(fs.existsSync(path.join(root, '.nera-cache'))).toBe(false)
            expect(fs.existsSync(path.join(root, 'public', '_img'))).toBe(false)
            expect(logged(warn)).not.toMatch(/plugin|asset/i)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })
})
