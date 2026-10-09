import { load } from 'cheerio'
import { MIME_TYPES } from './transform.js'

// The content pass (ROADMAP D5, D6): every `<img>` in a page's rendered HTML
// that the plugin may process is handed to a callback, and the image it
// describes replaces the `<img>` as `<picture>` markup. Which file a URL means
// and how its variants are produced is the callback's business; this module
// only decides which elements to touch and what the output looks like.

// Attributes the plugin computes itself. An author's own value for these is
// replaced (width/height always reflect the emitted variant, D6).
const OWNED = new Set(['src', 'srcset', 'sizes', 'width', 'height'])

// Loading hints. An author's explicit value wins (decided 2026-10-09); the
// plugin fills in only what is missing, consistent with the mode in effect.
const LOADING_HINTS = new Set(['loading', 'decoding', 'fetchpriority'])

const SKIP_ATTR = 'data-nera-skip'

const EAGER = { loading: 'eager', fetchpriority: 'high' }
const LAZY = { loading: 'lazy', decoding: 'async' }

/**
 * Join a cache file name onto the public output path (`/_img` + name).
 */
export function publicUrl(outputPath, file) {
    return `${outputPath}/${file}`
}

function srcsetOf(variants, outputPath) {
    return variants
        .map((variant) => `${publicUrl(outputPath, variant.file)} ${variant.width}w`)
        .join(', ')
}

/**
 * Group planned variants by format, keeping `planVariants`' order: modern
 * formats first in `formats` order, the `<img>` fallback last, each ascending
 * by width (D13). A WebP source with `formats: [avif, webp]` therefore yields
 * one modern group, not two: its WebP set *is* the fallback.
 */
function groupByFormat(variants) {
    const groups = new Map()
    for (const variant of variants) {
        if (!groups.has(variant.format)) groups.set(variant.format, [])
        groups.get(variant.format).push(variant)
    }
    return [...groups].map(([format, list]) => ({
        format,
        variants: [...list].sort((a, b) => a.width - b.width),
    }))
}

/**
 * The attributes of the new `<img>`, in a fixed order (D13): the computed
 * ones first, then the author's own in their original order, then the
 * loading hints.
 *
 * @param {object} original the original `<img>`'s attributes
 * @param {object} image `{ src, srcset, sizes, width, height }`
 * @param {boolean} eager whether this is the page's eager image
 */
export function imgAttributes(original, image, eager) {
    const attrs = {
        src: image.src,
        srcset: image.srcset,
        sizes: image.sizes,
        width: String(image.width),
        height: String(image.height),
    }
    for (const [name, value] of Object.entries(original)) {
        if (OWNED.has(name) || LOADING_HINTS.has(name) || name === SKIP_ATTR) continue
        attrs[name] = value
    }

    // An author's `loading` decides the mode; otherwise the plugin's choice.
    const authorLoading = original.loading?.toLowerCase()
    const mode = authorLoading === 'eager' || authorLoading === 'lazy'
        ? (authorLoading === 'eager' ? EAGER : LAZY)
        : (eager ? EAGER : LAZY)
    for (const name of ['loading', 'decoding', 'fetchpriority']) {
        if (original[name] !== undefined) attrs[name] = original[name]
        else if (mode[name] !== undefined) attrs[name] = mode[name]
    }
    return attrs
}

/**
 * Build the replacement for one `<img>` (D6).
 *
 * With at least one modern format, a `<picture>` with one `<source>` per
 * modern format and the fallback `<img>`; with none (`formats: []`), the
 * `<img>` alone, still with `srcset`.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {object} original the original `<img>`'s attributes
 * @param {{ variants: object[], width: number, height: number }} image
 *     what `generate` returned (variants carry their cache `file`)
 * @param {{ outputPath: string, sizes: string, eager: boolean }} options
 */
export function buildPicture($, original, image, { outputPath, sizes, eager }) {
    const groups = groupByFormat(image.variants)
    const fallback = groups[groups.length - 1]
    const largest = fallback.variants[fallback.variants.length - 1]

    const img = $('<img>').attr(
        imgAttributes(
            original,
            {
                src: publicUrl(outputPath, largest.file),
                srcset: srcsetOf(fallback.variants, outputPath),
                sizes,
                width: image.width,
                height: image.height,
            },
            eager
        )
    )

    const modern = groups.slice(0, -1)
    if (modern.length === 0) return img

    const picture = $('<picture>')
    for (const group of modern) {
        picture.append(
            $('<source>').attr({
                type: MIME_TYPES[group.format],
                srcset: srcsetOf(group.variants, outputPath),
                sizes,
            })
        )
    }
    return picture.append(img)
}

/**
 * Rewrite every processable `<img>` in `html`.
 *
 * Left untouched (D5): an `<img>` inside `<picture>`, one with a `srcset`
 * already set, and one carrying `data-nera-skip` (the attribute itself is
 * removed). Everything else is offered to `handle(src)`, which returns the
 * generated image or `null` to leave the `<img>` as it is (external, SVG,
 * missing file, encode error: the callback decides and warns).
 *
 * The first image actually rewritten on the page is the eager one when
 * `eagerFirst` is set (D6, decided 2026-10-09: an untouched SVG or external
 * image before it does not count).
 *
 * Images are generated concurrently; the markup is assembled afterwards in
 * document order, so the result does not depend on encode timing.
 *
 * @param {string} html a page's rendered content
 * @param {object} options
 * @param {(src: string) => Promise<object|null>} options.handle
 * @param {string} options.outputPath public URL path, e.g. `/_img`
 * @param {string} options.sizes default `sizes`
 * @param {boolean} options.eagerFirst
 * @returns {Promise<{ html: string, count: number }>} `html` is the input
 *     unchanged (same string) when nothing was touched
 */
export async function rewriteHtml(html, { handle, outputPath, sizes, eagerFirst }) {
    if (typeof html !== 'string' || !/<img\b/i.test(html)) {
        return { html, count: 0 }
    }

    const $ = load(html, null, false)
    let changed = false
    const candidates = []

    $('img').each((_, el) => {
        const node = $(el)
        if (node.attr(SKIP_ATTR) !== undefined) {
            node.removeAttr(SKIP_ATTR)
            changed = true
            return
        }
        if (node.closest('picture').length > 0) return
        if (node.attr('srcset') !== undefined) return
        candidates.push(node)
    })

    const images = await Promise.all(candidates.map((node) => handle(node.attr('src') ?? '')))

    let count = 0
    candidates.forEach((node, i) => {
        const image = images[i]
        if (!image) return

        const eager = eagerFirst && count === 0
        node.replaceWith(buildPicture($, { ...node.attr() }, image, { outputPath, sizes, eager }))
        count++
        changed = true
    })

    // Re-serializing can normalize unrelated markup (entities, quoting), so a
    // page without a rewritten image keeps its exact original string.
    return { html: changed ? $.html() : html, count }
}
