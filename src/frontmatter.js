import { warn } from './warn.js'

// Frontmatter images (ROADMAP D9): for each configured key holding an image
// path, the plugin prepares variants and writes the data a template needs to
// `meta.images.<key>`. The original `meta.<key>` string is never modified:
// canonical-links, social plugins and existing templates keep reading it.

const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Prepare every configured frontmatter image of one page.
 *
 * `prepare(key, src)` resolves and generates one image and answers with its
 * `meta.images` entry, or `null` (external, SVG, missing file, `?skip`: the
 * callback decides and warns). Non-string values are not image paths and are
 * passed over silently. Keys are prepared concurrently; the entries are
 * assembled in `keys` order, so the result does not depend on encode timing.
 *
 * @param {object} meta the page's meta
 * @param {object} options
 * @param {string[]} options.keys config `frontmatter_keys`
 * @param {(key: string, src: string) => Promise<object|null>} options.prepare
 * @returns {Promise<{ meta: object, count: number }>} `meta` is the input
 *     itself (same object) when no image was prepared
 */
export async function frontmatterImages(meta, { keys, prepare }) {
    const wanted = keys.filter((key) => typeof meta?.[key] === 'string' && meta[key].trim() !== '')
    if (wanted.length === 0) return { meta, count: 0 }

    const existing = meta.images
    if (existing !== undefined && !isPlainObject(existing)) {
        // An author's own `images:` (a gallery list, say) is theirs; merging
        // into it or replacing it would break the page's templates.
        warn(
            `${meta.href || '/index.html'}: meta.images is already set by the page and is not a mapping, frontmatter images not prepared`
        )
        return { meta, count: 0 }
    }

    const entries = await Promise.all(wanted.map((key) => prepare(key, meta[key])))
    const images = {}
    wanted.forEach((key, i) => {
        if (entries[i]) images[key] = entries[i]
    })

    const count = Object.keys(images).length
    if (count === 0) return { meta, count }
    return { meta: { ...meta, images: { ...existing, ...images } }, count }
}
