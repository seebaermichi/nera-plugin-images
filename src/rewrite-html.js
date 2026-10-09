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
 * The data behind one image's markup: the fallback `<img>` (`src`, `srcset`,
 * `sizes`, `width`, `height`, `type`) and one `{ type, srcset }` per modern
 * format, in `formats` order. The content pass builds its `<picture>` from it,
 * and the frontmatter pass hands it to templates as `meta.images.<key>` (D9),
 * so both always describe the same files the same way.
 *
 * @param {{ variants: object[], width: number, height: number }} image
 *     what `generate` returned (variants carry their cache `file`)
 * @param {{ outputPath: string, sizes: string }} options
 */
export function pictureData(image, { outputPath, sizes }) {
    const groups = groupByFormat(image.variants)
    const fallback = groups[groups.length - 1]
    const largest = fallback.variants[fallback.variants.length - 1]

    return {
        src: publicUrl(outputPath, largest.file),
        srcset: srcsetOf(fallback.variants, outputPath),
        sizes,
        width: image.width,
        height: image.height,
        type: MIME_TYPES[fallback.format],
        sources: groups.slice(0, -1).map((group) => ({
            type: MIME_TYPES[group.format],
            srcset: srcsetOf(group.variants, outputPath),
        })),
    }
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
    const data = pictureData(image, { outputPath, sizes })
    const img = $('<img>').attr(imgAttributes(original, data, eager))
    if (data.sources.length === 0) return img

    const picture = $('<picture>')
    for (const source of data.sources) {
        picture.append($('<source>').attr({ type: source.type, srcset: source.srcset, sizes }))
    }
    return picture.append(img)
}

const CAPTION_ATTR = 'title'

/**
 * The `<p>` an image may turn into a `<figure>` (D8): its parent paragraph,
 * when the image is that paragraph's only content (whitespace aside) and the
 * paragraph carries no attributes of its own. markdown-it wraps a lone
 * image in a bare `<p>`, and `<figure>` inside `<p>` is invalid HTML, so the
 * figure replaces the paragraph. Anywhere else (inline with text, inside a
 * link, in raw HTML) the context may not allow a `<figure>`, so there is none.
 *
 * @returns {import('cheerio').Cheerio|null}
 */
function figureSlot(node) {
    const parent = node.parent()
    if (!parent.is('p') || Object.keys(parent.attr() || {}).length > 0) return null
    const alone = parent.contents().toArray().every((child) =>
        child === node[0] || (child.type === 'text' && child.data.trim() === '')
    )
    return alone ? parent : null
}

/**
 * Rewrite every processable `<img>` in `html`.
 *
 * Left untouched (D5): an `<img>` inside `<picture>`, one with a `srcset`
 * already set, and one carrying `data-nera-skip` (the attribute itself is
 * removed). Everything else is offered to `handle(src)`, which answers with
 *
 * - `null`: leave the `<img>` as it is (external, SVG, missing file, encode
 *   error: the callback decides and warns);
 * - `{ src }`: leave it in place, but with this `src` (`?skip`, D7, whose
 *   parameters are stripped);
 * - `{ image, sizes?, loading? }`: the generated image, with this image's
 *   `sizes` (default: `options.sizes`) and an explicit `loading` (`?loading`,
 *   which overrides the author's attribute and the eager-first choice).
 *
 * The first image actually rewritten on the page is the eager one when
 * `eagerFirst` is set (D6, decided 2026-10-09: an untouched SVG or external
 * image before it does not count).
 *
 * With `figure: 'title'`, a rewritten image with a non-empty `title` that is
 * alone in its paragraph becomes `figure.nera-image` with the title as
 * `figcaption.nera-image__caption`, and the `title` attribute is dropped
 * (D8). Otherwise the title stays on the `<img>`.
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
 * @param {'title'|false} [options.figure]
 * @returns {Promise<{ html: string, count: number }>} `html` is the input
 *     unchanged (same string) when nothing was touched
 */
export async function rewriteHtml(html, { handle, outputPath, sizes, eagerFirst, figure = false }) {
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

    const results = await Promise.all(candidates.map((node) => handle(node.attr('src') ?? '')))

    let count = 0
    candidates.forEach((node, i) => {
        const result = results[i]
        if (!result) return

        if (!result.image) {
            if (result.src !== node.attr('src')) {
                node.attr('src', result.src)
                changed = true
            }
            return
        }

        const original = { ...node.attr() }
        if (result.loading) original.loading = result.loading

        const title = original[CAPTION_ATTR]
        const slot = figure === 'title' && title && title.trim() !== '' ? figureSlot(node) : null
        if (slot) delete original[CAPTION_ATTR]

        const eager = eagerFirst && count === 0
        const picture = buildPicture($, original, result.image, {
            outputPath,
            sizes: result.sizes || sizes,
            eager,
        })

        if (slot) {
            slot.replaceWith(
                $('<figure>')
                    .addClass('nera-image')
                    .append(picture)
                    .append($('<figcaption>').addClass('nera-image__caption').text(title))
            )
        } else {
            node.replaceWith(picture)
        }
        count++
        changed = true
    })

    // Re-serializing can normalize unrelated markup (entities, quoting), so a
    // page without a rewritten image keeps its exact original string.
    return { html: changed ? $.html() : html, count }
}
