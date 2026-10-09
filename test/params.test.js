import { describe, it, expect } from 'vitest'
import { PARAMS, parseParams, sizesFor, stripParams } from '../src/params.js'

describe('parseParams (D7)', () => {
    it('returns nothing to do for an empty query', () => {
        expect(parseParams('')).toEqual({ skip: false, options: {}, warnings: [] })
        expect(parseParams('?')).toEqual({ skip: false, options: {}, warnings: [] })
        expect(parseParams()).toEqual({ skip: false, options: {}, warnings: [] })
    })

    it('reads every parameter of the table', () => {
        const params = parseParams(
            '?w=800&h=450&fit=cover&focus=30,60&q=60&formats=webp&sizes=50vw&loading=eager'
        )
        expect(params.options).toEqual({
            w: 800,
            h: 450,
            fit: 'cover',
            focus: { x: 30, y: 60 },
            q: 60,
            formats: ['webp'],
        })
        expect(params.sizes).toBe('50vw')
        expect(params.loading).toBe('eager')
        expect(params.skip).toBe(false)
        expect(params.warnings).toEqual([])
    })

    it('accepts the query with or without the leading ?', () => {
        expect(parseParams('w=800').options).toEqual({ w: 800 })
    })

    it('turns ratio W:H into width / height', () => {
        expect(parseParams('?ratio=16:9').options.ratio).toBeCloseTo(16 / 9)
        expect(parseParams('?ratio=2.35:1').options.ratio).toBeCloseTo(2.35)
    })

    it.each(['attention', 'entropy'])('passes focus=%s through as a strategy', (strategy) => {
        expect(parseParams(`?ratio=1:1&focus=${strategy}`).options.focus).toBe(strategy)
    })

    it('accepts decimal focus percentages', () => {
        expect(parseParams('?ratio=1:1&focus=12.5,100').options.focus).toEqual({ x: 12.5, y: 100 })
    })

    it('reads formats as a list in the given order, none as no modern format', () => {
        expect(parseParams('?formats=webp,avif').options.formats).toEqual(['webp', 'avif'])
        expect(parseParams('?formats=none').options.formats).toEqual([])
    })

    it('drops unknown formats with a warning and keeps the rest', () => {
        const params = parseParams('?formats=jpeg,webp')
        expect(params.options.formats).toEqual(['webp'])
        expect(params.warnings).toEqual(['unknown format "jpeg" in formats ignored'])
    })

    it('falls back to the config formats when none is usable', () => {
        const params = parseParams('?formats=gif')
        expect(params.options).not.toHaveProperty('formats')
        expect(params.warnings).toEqual([
            'unknown format "gif" in formats ignored',
            'invalid formats "gif", using the default',
        ])
    })

    it('decodes sizes like a browser (+ is a space, %xx escapes)', () => {
        expect(parseParams('?sizes=(min-width:+600px)+50vw').sizes).toBe('(min-width: 600px) 50vw')
        expect(parseParams('?sizes=(min-width%3A%20600px)%2050vw').sizes).toBe('(min-width: 600px) 50vw')
    })

    it.each([
        ['w=abc', 'w', '"abc"'],
        ['w=0', 'w', '"0"'],
        ['w=-5', 'w', '"-5"'],
        ['w=1.5', 'w', '"1.5"'],
        ['w=', 'w', '""'],
        ['h=x&w=800', 'h', '"x"'],
        ['q=0', 'q', '"0"'],
        ['q=101', 'q', '"101"'],
        ['ratio=16x9', 'ratio', '"16x9"'],
        ['ratio=0:9', 'ratio', '"0:9"'],
        ['fit=fill', 'fit', '"fill"'],
        ['ratio=1:1&focus=center', 'focus', '"center"'],
        ['ratio=1:1&focus=120,50', 'focus', '"120,50"'],
        ['sizes=', 'sizes', '""'],
        ['loading=auto', 'loading', '"auto"'],
    ])('warns about %s and uses the default', (query, key, shown) => {
        const params = parseParams(`?${query}`)
        expect(params.options).not.toHaveProperty(key)
        expect(params).not.toHaveProperty(key)
        expect(params.warnings).toContain(`invalid ${key} ${shown}, using the default`)
    })

    it('warns about unknown parameters and ignores them', () => {
        const params = parseParams('?width=800&v=2&w=400')
        expect(params.options).toEqual({ w: 400 })
        expect(params.warnings).toEqual([
            'unknown parameter "width" ignored',
            'unknown parameter "v" ignored',
        ])
    })

    it('uses the last value of a repeated parameter', () => {
        expect(parseParams('?w=400&w=800').options).toEqual({ w: 800 })
    })

    it('treats skip as a flag, whatever its value', () => {
        expect(parseParams('?skip').skip).toBe(true)
        expect(parseParams('?skip=1&w=800').skip).toBe(true)
        expect(parseParams('?w=800').skip).toBe(false)
    })

    it('warns about valid parameters that have no effect on their own', () => {
        expect(parseParams('?h=450').warnings).toEqual(['h has no effect without w, ignored'])
        expect(parseParams('?fit=contain').warnings).toEqual([
            'fit has no effect without ratio or w and h, ignored',
        ])
        expect(parseParams('?w=800&focus=30,60').warnings).toEqual([
            'focus only applies to a cover crop (ratio or w and h), ignored',
        ])
        expect(parseParams('?ratio=1:1&fit=inside&focus=attention').warnings).toEqual([
            'focus only applies to a cover crop (ratio or w and h), ignored',
        ])
    })

    it('raises no such warning when the combination is meaningful', () => {
        for (const query of ['?w=800&h=450', '?ratio=1:1&fit=contain', '?w=8&h=4&focus=0,0', '?ratio=1:1&fit=cover&focus=entropy']) {
            expect(parseParams(query).warnings).toEqual([])
        }
    })
})

describe('sizesFor', () => {
    it('prefers ?sizes, then derives from ?w, then the config default', () => {
        expect(sizesFor(parseParams('?w=800&sizes=50vw'), '100vw')).toBe('50vw')
        expect(sizesFor(parseParams('?w=800'), '100vw')).toBe('(min-width: 800px) 800px, 100vw')
        expect(sizesFor(parseParams(''), '100vw')).toBe('100vw')
    })
})

describe('stripParams', () => {
    it('removes every recognized parameter and the emptied ?', () => {
        expect(stripParams('/a.jpg?skip')).toBe('/a.jpg')
        expect(stripParams('/a.jpg?w=800&skip&ratio=16:9')).toBe('/a.jpg')
    })

    it('keeps unknown parameters and the hash exactly as written', () => {
        expect(stripParams('/a%20b.jpg?v=2&skip&x=%41#top')).toBe('/a%20b.jpg?v=2&x=%41#top')
        expect(stripParams('/a.jpg?skip#top')).toBe('/a.jpg#top')
    })

    it('returns a URL without a query unchanged', () => {
        expect(stripParams('/a.jpg')).toBe('/a.jpg')
        expect(stripParams('/a.jpg#x?skip')).toBe('/a.jpg#x?skip')
    })

    it('knows every parameter of the table', () => {
        const query = PARAMS.map((p) => `${p}=1`).join('&')
        expect(stripParams(`/a.jpg?${query}`)).toBe('/a.jpg')
    })
})
