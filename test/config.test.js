import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defaults, loadConfig, normalizeConfig } from '../src/config.js'

let warnSpy

beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    warnSpy.mockRestore()
})

const warnings = () => warnSpy.mock.calls.map(([message]) => message)

describe('normalizeConfig', () => {
    it('returns the documented defaults for an empty config', () => {
        const config = normalizeConfig({})

        expect(config).toEqual({
            formats: ['avif', 'webp'],
            widths: [480, 800, 1200, 1600],
            sizes: '100vw',
            quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
            eager_first: true,
            figure: 'title',
            frontmatter_keys: ['image'],
            og: { width: 1200, height: 630, fit: 'cover' },
            placeholder: 'none',
            output_path: '/_img',
            cache_dir: '.nera-cache/images',
            prune: true,
            concurrency: Math.max(1, os.availableParallelism() - 1),
        })
        expect(normalizeConfig(undefined)).toEqual(config)
        expect(normalizeConfig(null)).toEqual(config)
        expect(warnings()).toEqual([])
    })

    it('never shares default objects between calls', () => {
        const a = normalizeConfig({})
        a.widths.push(9999)
        a.quality.avif = 1

        expect(defaults().widths).toEqual([480, 800, 1200, 1600])
        expect(normalizeConfig({}).quality.avif).toBe(50)
    })

    it('takes valid values over the defaults', () => {
        const config = normalizeConfig({
            formats: ['webp'],
            widths: [1000, 400, 400],
            sizes: '50vw',
            eager_first: false,
            figure: false,
            frontmatter_keys: ['image', 'cover'],
            og: false,
            placeholder: 'blur',
            output_path: 'media/img/',
            cache_dir: '.cache/img',
            prune: false,
            concurrency: 2,
        })

        expect(config.formats).toEqual(['webp'])
        expect(config.widths).toEqual([400, 1000])
        expect(config.sizes).toBe('50vw')
        expect(config.eager_first).toBe(false)
        expect(config.figure).toBe(false)
        expect(config.frontmatter_keys).toEqual(['image', 'cover'])
        expect(config.og).toBe(false)
        expect(config.placeholder).toBe('blur')
        expect(config.output_path).toBe('/media/img')
        expect(config.cache_dir).toBe('.cache/img')
        expect(config.prune).toBe(false)
        expect(config.concurrency).toBe(2)
        expect(warnings()).toEqual([])
    })

    it('accepts an empty formats list (no <source> at all)', () => {
        expect(normalizeConfig({ formats: [] }).formats).toEqual([])
    })

    it('merges quality and og per key', () => {
        const config = normalizeConfig({
            quality: { avif: 40 },
            og: { width: 800 },
        })

        expect(config.quality).toEqual({ avif: 40, webp: 75, jpeg: 78, png: 80 })
        expect(config.og).toEqual({ width: 800, height: 630, fit: 'cover' })
    })

    it('treats a key with no value like an absent key', () => {
        expect(normalizeConfig({ widths: null }).widths).toEqual([480, 800, 1200, 1600])
        expect(warnings()).toEqual([])
    })

    it.each([
        ['formats', 'avif', ['avif', 'webp']],
        ['widths', [], [480, 800, 1200, 1600]],
        ['widths', ['big'], [480, 800, 1200, 1600]],
        ['sizes', '', '100vw'],
        ['eager_first', 'yes', true],
        ['figure', 'caption', 'title'],
        ['frontmatter_keys', 'image', ['image']],
        ['placeholder', 'shimmer', 'none'],
        ['output_path', '/', '/_img'],
        ['output_path', '/../outside', '/_img'],
        ['cache_dir', 42, '.nera-cache/images'],
        ['prune', 1, true],
        ['concurrency', 0, Math.max(1, os.availableParallelism() - 1)],
        ['quality', 60, { avif: 50, webp: 75, jpeg: 78, png: 80 }],
        ['og', true, { width: 1200, height: 630, fit: 'cover' }],
    ])('warns and falls back on an invalid %s (%j)', (key, value, expected) => {
        expect(normalizeConfig({ [key]: value })[key]).toEqual(expected)
        expect(warnings()).toHaveLength(1)
        expect(warnings()[0]).toMatch(/^⚠️ plugin-images: config\/images\.yaml: invalid/)
        expect(warnings()[0]).toContain(key)
    })

    it('drops bad entries inside lists and keeps the good ones', () => {
        const config = normalizeConfig({
            formats: ['avif', 'jpeg', 'avif'],
            widths: [800, -1, 1.5, 400],
        })

        expect(config.formats).toEqual(['avif'])
        expect(config.widths).toEqual([400, 800])
        expect(warnings()).toHaveLength(2)
    })

    it('falls back per key for bad quality and og values', () => {
        const config = normalizeConfig({
            quality: { avif: 0, webp: 101, jpeg: 70, gif: 50 },
            og: { width: 'wide', fit: 'stretch' },
        })

        expect(config.quality).toEqual({ avif: 50, webp: 75, jpeg: 70, png: 80 })
        expect(config.og).toEqual({ width: 1200, height: 630, fit: 'cover' })
        expect(warnings()).toHaveLength(5)
    })

    it('warns about unknown keys and ignores them', () => {
        const config = normalizeConfig({ widht: [100] })

        expect(config).not.toHaveProperty('widht')
        expect(warnings()).toEqual([
            '⚠️ plugin-images: config/images.yaml: ignoring unknown key "widht"',
        ])
    })

    it('uses the defaults when the file is not a mapping', () => {
        expect(normalizeConfig(['avif'])).toEqual(normalizeConfig({}))
        expect(warnings()).toHaveLength(1)
    })
})

describe('loadConfig', () => {
    let dir

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-config-'))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('returns the defaults when config/images.yaml is missing', () => {
        expect(loadConfig({ cwd: dir })).toEqual(defaults())
    })

    it('reads config/images.yaml from the site', () => {
        fs.mkdirSync(path.join(dir, 'config'))
        fs.writeFileSync(
            path.join(dir, 'config', 'images.yaml'),
            'widths: [320, 640]\nquality:\n    avif: 45\n'
        )

        const config = loadConfig({ cwd: dir })

        expect(config.widths).toEqual([320, 640])
        expect(config.quality.avif).toBe(45)
        expect(config.formats).toEqual(['avif', 'webp'])
    })

    it('treats a fully commented-out file as empty', () => {
        fs.mkdirSync(path.join(dir, 'config'))
        fs.writeFileSync(path.join(dir, 'config', 'images.yaml'), '# widths: [1]\n')

        expect(loadConfig({ cwd: dir })).toEqual(defaults())
    })

    it('honours app.folders.config', () => {
        fs.mkdirSync(path.join(dir, 'settings'))
        fs.writeFileSync(path.join(dir, 'settings', 'images.yaml'), 'sizes: 80vw\n')

        const config = loadConfig({ cwd: dir, app: { folders: { config: './settings' } } })

        expect(config.sizes).toBe('80vw')
    })
})
