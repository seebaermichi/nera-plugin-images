import { FITS, MODERN_FORMATS } from './config.js'
import { STRATEGIES } from './transform.js'

// Per-image options as Glide-style query parameters on the image URL
// (ROADMAP D7): `![alt](/images/a.jpg?w=800&ratio=16:9)`. Query strings
// survive Markdown rendering untouched, so the plugin reads them from the
// rendered `src`. Parsing is pure: problems come back as `warnings` for the
// caller to print with the page and the URL, and a bad value falls back to the
// default rather than failing the build.

export const PARAMS = ['w', 'h', 'ratio', 'fit', 'focus', 'q', 'formats', 'sizes', 'loading', 'skip']

const POSITIVE_INT = /^[1-9]\d*$/
const NUMBER = '(\\d+(?:\\.\\d+)?)'
const RATIO = new RegExp(`^${NUMBER}:${NUMBER}$`)
const FOCUS = new RegExp(`^${NUMBER},${NUMBER}$`)

const show = (value) => JSON.stringify(value)

// The query string as `[key, value]` pairs, decoded like a browser would
// (`+` is a space, so `?sizes=50vw` and `?sizes=(min-width:+600px)+50vw` work).
function pairs(search) {
    const query = search.startsWith('?') ? search.slice(1) : search
    return query === '' ? [] : [...new URLSearchParams(query)]
}

const readers = {
    w: (value) => (POSITIVE_INT.test(value) ? Number(value) : undefined),
    h: (value) => (POSITIVE_INT.test(value) ? Number(value) : undefined),
    q: (value) => {
        const q = POSITIVE_INT.test(value) ? Number(value) : 0
        return q >= 1 && q <= 100 ? q : undefined
    },
    ratio: (value) => {
        const match = RATIO.exec(value)
        if (!match) return undefined
        const [width, height] = [Number(match[1]), Number(match[2])]
        return width > 0 && height > 0 ? width / height : undefined
    },
    fit: (value) => (FITS.includes(value) ? value : undefined),
    focus: (value) => {
        if (STRATEGIES.includes(value)) return value
        const match = FOCUS.exec(value)
        if (!match) return undefined
        const [x, y] = [Number(match[1]), Number(match[2])]
        return x <= 100 && y <= 100 ? { x, y } : undefined
    },
    sizes: (value) => (value.trim() === '' ? undefined : value.trim()),
    loading: (value) => (value === 'eager' || value === 'lazy' ? value : undefined),
}

// `formats=none` → no modern format; `formats=webp,avif` → in that order.
// Unknown entries are dropped with a warning; nothing usable left falls back
// to the config's formats.
function readFormats(value, warnings) {
    if (value === 'none') return []
    const formats = []
    for (const format of value.split(',').map((f) => f.trim())) {
        if (MODERN_FORMATS.includes(format)) {
            if (!formats.includes(format)) formats.push(format)
        } else {
            warnings.push(`unknown format ${show(format)} in formats ignored`)
        }
    }
    if (formats.length === 0) {
        warnings.push(`invalid formats ${show(value)}, using the default`)
        return undefined
    }
    return formats
}

/**
 * Parse an image URL's query string (D7).
 *
 * @param {string} search the query, with or without the leading `?`
 * @returns {{
 *     skip: boolean,
 *     options: { w?, h?, ratio?, fit?, focus?, q?, formats? },
 *     sizes?: string,
 *     loading?: 'eager'|'lazy',
 *     warnings: string[],
 * }} `options` holds only the parameters that were given and valid, ready to
 *     spread over the config's `planVariants` options
 */
export function parseParams(search = '') {
    const result = { skip: false, options: {}, warnings: [] }
    const values = {}

    for (const [key, value] of pairs(search)) {
        if (!PARAMS.includes(key)) {
            result.warnings.push(`unknown parameter ${show(key)} ignored`)
            continue
        }
        // A repeated parameter: the last one wins, as with URLSearchParams.get.
        values[key] = value
    }

    if ('skip' in values) result.skip = true

    for (const [key, value] of Object.entries(values)) {
        if (key === 'skip') continue
        const parsed = key === 'formats'
            ? readFormats(value, result.warnings)
            : readers[key](value)
        if (parsed === undefined) {
            if (key !== 'formats') {
                result.warnings.push(`invalid ${key} ${show(value)}, using the default`)
            }
            continue
        }
        if (key === 'sizes' || key === 'loading') result[key] = parsed
        else result.options[key] = parsed
    }

    // Parameters that are valid but cannot do anything on their own. The plan
    // ignores them; say so rather than leave the author guessing.
    const { w, h, ratio, fit, focus } = result.options
    const aspect = Boolean((w && h) || ratio)
    if (h && !w) {
        result.warnings.push('h has no effect without w, ignored')
    }
    if (fit && !aspect) {
        result.warnings.push('fit has no effect without ratio or w and h, ignored')
    }
    if (focus && (!aspect || (fit && fit !== 'cover'))) {
        result.warnings.push('focus only applies to a cover crop (ratio or w and h), ignored')
    }
    return result
}

/**
 * The `sizes` attribute for one image: an explicit `?sizes`, else one derived
 * from `?w` (D7), else the config default.
 *
 * @param {ReturnType<typeof parseParams>} params
 * @param {string} fallback the config's `sizes`
 */
export function sizesFor(params, fallback) {
    if (params.sizes) return params.sizes
    const { w } = params.options
    return w ? `(min-width: ${w}px) ${w}px, 100vw` : fallback
}

/**
 * `src` without the recognized parameters (D7), for an image the plugin
 * leaves in place (`?skip`). Unknown parameters (a cache buster, say) and the
 * hash stay exactly as written; an emptied query loses its `?`.
 *
 * @param {string} src
 */
export function stripParams(src) {
    const hashAt = src.indexOf('#')
    const hash = hashAt === -1 ? '' : src.slice(hashAt)
    const rest = hashAt === -1 ? src : src.slice(0, hashAt)
    const queryAt = rest.indexOf('?')
    if (queryAt === -1) return src

    const kept = rest
        .slice(queryAt + 1)
        .split('&')
        .filter((part) => {
            if (part === '') return false
            const key = part.split('=')[0]
            let name
            try {
                name = decodeURIComponent(key.replace(/\+/g, ' '))
            } catch {
                return true
            }
            return !PARAMS.includes(name)
        })
    return `${rest.slice(0, queryAt)}${kept.length ? `?${kept.join('&')}` : ''}${hash}`
}
