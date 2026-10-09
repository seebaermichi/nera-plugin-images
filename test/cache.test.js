import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
    CACHE_VERSION,
    imageKey,
    openCache,
    sourceDigest,
    stableStringify,
    variantFileName,
    variantHash,
} from '../src/cache.js'

const variant = {
    width: 800,
    height: 600,
    format: 'avif',
    quality: 50,
    fit: 'fill',
    crop: null,
    aspect: null,
}

describe('keys and names', () => {
    const digest = sourceDigest(Buffer.from('source bytes'))

    it('hashes the source bytes with sha256', () => {
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
        expect(sourceDigest(Buffer.from('source bytes'))).toBe(digest)
        expect(sourceDigest(Buffer.from('other bytes'))).not.toBe(digest)
    })

    it('stringifies independent of key order and drops undefined', () => {
        expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(
            stableStringify({ a: [{ d: 2 }], b: 1 })
        )
        expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }))
    })

    it('keys an image by source and options, regardless of key order', () => {
        const key = imageKey(digest, { widths: [480], formats: ['avif'] })

        expect(key).toMatch(/^[0-9a-f]{64}$/)
        expect(imageKey(digest, { formats: ['avif'], widths: [480] })).toBe(key)
        expect(imageKey(digest, { widths: [480, 800], formats: ['avif'] })).not.toBe(key)
        expect(imageKey(sourceDigest(Buffer.from('x')), { widths: [480], formats: ['avif'] })).not.toBe(key)
    })

    it('gives all widths of one format the same hash8', () => {
        const hash = variantHash(digest, variant)

        expect(hash).toMatch(/^[0-9a-f]{8}$/)
        expect(variantHash(digest, { ...variant, width: 1600, height: 1200 })).toBe(hash)
    })

    it('changes hash8 with every transform parameter', () => {
        const hash = variantHash(digest, variant)

        for (const change of [
            { format: 'webp' },
            { quality: 51 },
            { fit: 'cover' },
            { crop: { left: 0, top: 1, width: 10, height: 10 } },
            { aspect: 2 },
        ]) {
            expect(variantHash(digest, { ...variant, ...change })).not.toBe(hash)
        }
        expect(variantHash(sourceDigest(Buffer.from('x')), variant)).not.toBe(hash)
    })

    it('names files <basename>-<hash8>-<width>.<ext>', () => {
        expect(variantFileName('/a/zerpensafari-iphone.jpg', '3f9a1c2e', variant)).toBe(
            'zerpensafari-iphone-3f9a1c2e-800.avif'
        )
        expect(variantFileName('/a/x.png', '00000000', { width: 10, format: 'jpeg' })).toBe(
            'x-00000000-10.jpg'
        )
        expect(variantFileName('/a/Straße am Meer.JPG', 'abcdef12', { width: 480, format: 'webp' })).toBe(
            'strasse-am-meer-abcdef12-480.webp'
        )
        expect(variantFileName('/a/日本.png', 'abcdef12', { width: 480, format: 'png' })).toBe(
            'image-abcdef12-480.png'
        )
    })
})

describe('openCache', () => {
    let dir

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-cache-'))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const addFile = (cache, name) => {
        fs.mkdirSync(cache.filesDir, { recursive: true })
        fs.writeFileSync(cache.filePath(name), name)
    }

    it('starts empty when nothing exists yet', () => {
        const cache = openCache(path.join(dir, 'images'))

        expect(cache.keys()).toEqual([])
        expect(cache.has('k')).toBe(false)
        expect(cache.get('k')).toBeUndefined()
        expect(cache.hasFile('a.jpg')).toBe(false)
        expect(cache.filePath('a.jpg')).toBe(path.join(dir, 'images', 'files', 'a.jpg'))
    })

    it('round-trips entries through manifest.json', () => {
        const cache = openCache(dir)
        cache.put('b', { width: 2, height: 2, files: ['b.jpg'] })
        cache.put('a', { width: 1, height: 1, files: ['a.jpg'] })
        cache.save()

        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
        expect(manifest.version).toBe(CACHE_VERSION)
        expect(Object.keys(manifest.entries)).toEqual(['a', 'b'])

        const reopened = openCache(dir)
        expect(reopened.has('a')).toBe(true)
        expect(reopened.get('b')).toEqual({ width: 2, height: 2, files: ['b.jpg'] })
    })

    it('writes the manifest atomically, leaving no temp file', () => {
        const cache = openCache(dir)
        cache.put('a', { files: [] })
        const rename = vi.spyOn(fs, 'renameSync')

        cache.save()

        expect(rename).toHaveBeenCalledTimes(1)
        expect(rename.mock.calls[0][1]).toBe(path.join(dir, 'manifest.json'))
        expect(fs.readdirSync(dir)).toEqual(['manifest.json'])
        rename.mockRestore()
    })

    it('starts empty on a broken manifest, with a warning', () => {
        fs.writeFileSync(path.join(dir, 'manifest.json'), '{ nope')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        expect(openCache(dir).keys()).toEqual([])
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^⚠️ plugin-images: ignoring unreadable cache manifest/))
        warn.mockRestore()
    })

    it('starts empty on a manifest from another cache version', () => {
        fs.writeFileSync(
            path.join(dir, 'manifest.json'),
            JSON.stringify({ version: CACHE_VERSION + 1, entries: { a: { files: [] } } })
        )

        expect(openCache(dir).keys()).toEqual([])
    })

    it('prunes exactly the entries and files not used by this build', () => {
        const cache = openCache(dir)
        cache.put('used', { files: ['used-1.avif', 'shared.jpg'] })
        cache.put('stale', { files: ['stale-1.avif', 'shared.jpg'] })
        for (const name of ['used-1.avif', 'shared.jpg', 'stale-1.avif', 'orphan.webp']) {
            addFile(cache, name)
        }

        const removed = cache.prune(['used'])

        expect(removed).toEqual({ entries: ['stale'], files: ['orphan.webp', 'stale-1.avif'] })
        expect(cache.keys()).toEqual(['used'])
        expect(fs.readdirSync(cache.filesDir).sort()).toEqual(['shared.jpg', 'used-1.avif'])
    })

    it('prunes everything when nothing was used, and tolerates no files dir', () => {
        const cache = openCache(dir)
        expect(cache.prune([])).toEqual({ entries: [], files: [] })

        cache.put('a', { files: ['a.jpg'] })
        addFile(cache, 'a.jpg')
        expect(cache.prune(new Set())).toEqual({ entries: ['a'], files: ['a.jpg'] })
        expect(fs.readdirSync(cache.filesDir)).toEqual([])
    })
})
