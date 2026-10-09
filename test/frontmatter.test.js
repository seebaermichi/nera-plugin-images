import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { frontmatterImages } from '../src/frontmatter.js'

// The pure part of the frontmatter pass (D9): which keys are prepared and how
// the entries land in `meta.images`, with a fake `prepare`.

let warn

beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

const prepare = vi.fn(async (key, src) => (src.includes('missing') ? null : { src: `/_img/${key}` }))

describe('frontmatterImages', () => {
    it('writes meta.images.<key> and never touches the original string', async () => {
        const meta = { href: '/a.html', image: '/images/a.jpg', cover: '/images/b.jpg' }
        const result = await frontmatterImages(meta, { keys: ['image', 'cover'], prepare })

        expect(result.count).toBe(2)
        expect(result.meta).toEqual({
            ...meta,
            images: { image: { src: '/_img/image' }, cover: { src: '/_img/cover' } },
        })
        expect(result.meta.image).toBe('/images/a.jpg')
        expect(meta.images).toBeUndefined()
    })

    it('returns the same meta object when there is nothing to prepare', async () => {
        for (const meta of [{}, { image: '' }, { image: 42 }, { image: ['/a.jpg'] }, { title: 'x' }]) {
            const result = await frontmatterImages(meta, { keys: ['image'], prepare })
            expect(result.meta).toBe(meta)
            expect(result.count).toBe(0)
        }
        expect(warn).not.toHaveBeenCalled()
    })

    it('leaves out a key whose image was not prepared', async () => {
        const meta = { image: '/images/missing.jpg', cover: '/images/b.jpg' }
        const result = await frontmatterImages(meta, { keys: ['image', 'cover'], prepare })
        expect(result.meta.images).toEqual({ cover: { src: '/_img/cover' } })

        const none = await frontmatterImages({ image: '/images/missing.jpg' }, { keys: ['image'], prepare })
        expect(none.meta.images).toBeUndefined()
    })

    it('merges into an existing meta.images mapping and keeps the keys in config order', async () => {
        const meta = { cover: '/c.jpg', image: '/i.jpg', images: { other: 1 } }
        const result = await frontmatterImages(meta, { keys: ['image', 'cover'], prepare })
        expect(Object.keys(result.meta.images)).toEqual(['other', 'image', 'cover'])
    })

    it('does not touch an author-set meta.images that is not a mapping, and warns', async () => {
        const meta = { href: '/g.html', image: '/i.jpg', images: ['/a.jpg', '/b.jpg'] }
        const result = await frontmatterImages(meta, { keys: ['image'], prepare })

        expect(result.meta).toBe(meta)
        expect(warn.mock.calls.join('\n')).toMatch(/\/g\.html: meta\.images is already set by the page and is not a mapping/)
    })
})
