import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { isInside, resolveSource, sourceRoots } from '../src/resolve-source.js'

let dir
let siteAssets
let themeAssets
let roots

function touch(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
}

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-resolve-'))
    siteAssets = path.join(dir, 'assets')
    themeAssets = path.join(dir, 'my-theme', 'assets')
    fs.mkdirSync(path.join(dir, 'my-theme', 'views'), { recursive: true })

    touch(path.join(siteAssets, 'images', 'photo.jpg'))
    touch(path.join(siteAssets, 'images', 'both.png'))
    touch(path.join(siteAssets, 'images', 'Straße am Meer.JPG'))
    touch(path.join(siteAssets, 'blog', 'local.webp'))
    touch(path.join(siteAssets, 'images', 'logo.svg'))
    touch(path.join(themeAssets, 'images', 'both.png'))
    touch(path.join(themeAssets, 'images', 'theme-only.avif'))
    fs.mkdirSync(path.join(siteAssets, 'images', 'folder.jpg'))

    roots = [siteAssets, themeAssets]
})

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

const resolve = (src, options = {}) => resolveSource(src, { roots, ...options })

describe('resolveSource', () => {
    it('resolves a root-absolute URL under the site assets', () => {
        expect(resolve('/images/photo.jpg')).toEqual({
            file: path.join(siteAssets, 'images', 'photo.jpg'),
            root: siteAssets,
            pathname: '/images/photo.jpg',
            search: '',
            hash: '',
        })
    })

    it('prefers the site over the theme and falls back to the theme', () => {
        expect(resolve('/images/both.png').file).toBe(
            path.join(siteAssets, 'images', 'both.png')
        )
        expect(resolve('/images/theme-only.avif')).toMatchObject({
            file: path.join(themeAssets, 'images', 'theme-only.avif'),
            root: themeAssets,
        })
    })

    it('resolves page-relative URLs against meta.href', () => {
        expect(resolve('local.webp', { pageHref: '/blog/post.html' }).file).toBe(
            path.join(siteAssets, 'blog', 'local.webp')
        )
        expect(resolve('./local.webp', { pageHref: '/blog/post.html' }).file).toBe(
            path.join(siteAssets, 'blog', 'local.webp')
        )
        expect(resolve('../images/photo.jpg', { pageHref: '/blog/post.html' }).file).toBe(
            path.join(siteAssets, 'images', 'photo.jpg')
        )
    })

    it('strips base_path from root-absolute URLs only', () => {
        expect(resolve('/sub/images/photo.jpg', { basePath: '/sub' }).pathname).toBe(
            '/images/photo.jpg'
        )
        // Not under the prefix: resolved as-is.
        expect(resolve('/images/photo.jpg', { basePath: '/sub' }).pathname).toBe(
            '/images/photo.jpg'
        )
        // `/subway` is not under `/sub`.
        expect(resolve('/subway/x.jpg', { basePath: '/sub' })).toEqual({ skip: 'missing' })
    })

    it('splits off query and hash and keeps them', () => {
        expect(resolve('/images/photo.jpg?w=800&ratio=16:9#top')).toMatchObject({
            file: path.join(siteAssets, 'images', 'photo.jpg'),
            pathname: '/images/photo.jpg',
            search: '?w=800&ratio=16:9',
            hash: '#top',
        })
    })

    it('decodes percent-encoding and matches extensions case-insensitively', () => {
        expect(resolve('/images/Stra%C3%9Fe%20am%20Meer.JPG').file).toBe(
            path.join(siteAssets, 'images', 'Straße am Meer.JPG')
        )
    })

    it('clamps .. at the URL root, so it never leaves the roots', () => {
        expect(resolve('/../../images/photo.jpg').file).toBe(
            path.join(siteAssets, 'images', 'photo.jpg')
        )
        expect(resolve('../../../../etc/passwd.jpg', { pageHref: '/a/b.html' })).toEqual({
            skip: 'missing',
        })
        expect(resolve('/%2e%2e/%2e%2e/etc/hosts.png')).toEqual({ skip: 'missing' })
    })

    it.each([
        ['', 'empty'],
        ['   ', 'empty'],
        ['?w=10', 'empty'],
        ['https://example.com/a.jpg', 'external'],
        ['http://example.com/a.jpg', 'external'],
        ['//cdn.example.com/a.jpg', 'external'],
        ['data:image/png;base64,iVBORw0KGgo=', 'data'],
        ['/images/logo.svg', 'unsupported'],
        ['/images/anim.gif', 'unsupported'],
        ['/images/readme', 'unsupported'],
        ['/images/nope.jpg', 'missing'],
        ['/images/folder.jpg', 'missing'],
        ['/images/%E0%A4%A.jpg', 'missing'],
    ])('skips %j as %s', (src, reason) => {
        expect(resolve(src)).toEqual({ skip: reason })
    })

    it('accepts every raster extension from D5', () => {
        for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff']) {
            touch(path.join(siteAssets, 'ext', `x.${ext}`))
            expect(resolve(`/ext/x.${ext}`).file).toBe(path.join(siteAssets, 'ext', `x.${ext}`))
        }
    })
})

describe('isInside', () => {
    it('accepts the root and paths below it', () => {
        expect(isInside('/site/assets', '/site/assets')).toBe(true)
        expect(isInside('/site/assets', '/site/assets/a/b.jpg')).toBe(true)
        expect(isInside('/site/assets', '/site/assets/..hidden.jpg')).toBe(true)
    })

    it('rejects paths outside the root', () => {
        expect(isInside('/site/assets', '/site/other/b.jpg')).toBe(false)
        expect(isInside('/site/assets', '/site/assets-2/b.jpg')).toBe(false)
        expect(isInside('/site/assets', '/etc/passwd')).toBe(false)
    })
})

describe('sourceRoots', () => {
    it('uses app.folders.assets resolved against cwd', () => {
        expect(sourceRoots({ app: { folders: { assets: './theme/assets' } }, cwd: dir })).toEqual([
            path.join(dir, 'theme', 'assets'),
        ])
    })

    it('defaults to ./assets', () => {
        expect(sourceRoots({ app: {}, cwd: dir })).toEqual([siteAssets])
    })

    it('adds the theme assetsRoot from core\'s app.theme object', () => {
        const app = {
            folders: { assets: './assets' },
            theme: { name: './my-theme', package: null, config: {} },
        }

        expect(sourceRoots({ app, cwd: dir })).toEqual([siteAssets, themeAssets])
    })

    it('also accepts the raw app.yaml spec string', () => {
        expect(sourceRoots({ app: { theme: './my-theme' }, cwd: dir })).toEqual([
            siteAssets,
            themeAssets,
        ])
    })
})
