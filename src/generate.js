import fs from 'fs'
import { imageKey, sourceDigest, variantFileName, variantHash } from './cache.js'
import { encodeVariant, placeholderOf, planVariants, readSourceMeta } from './transform.js'

// One image in, its variants on disk and a manifest entry out. Ties the cache,
// the plan, the queue and the encoder together; the content pass (slice 3)
// and the frontmatter pass (slice 5) both go through here.

/**
 * @param {object} deps
 * @param {ReturnType<import('./cache.js').openCache>} deps.cache
 * @param {ReturnType<import('./queue.js').createQueue>} deps.queue
 * @param {typeof encodeVariant} [deps.encode] injectable for tests
 * @param {typeof placeholderOf} [deps.placeholder] injectable for tests
 */
export function createGenerator({ cache, queue, encode = encodeVariant, placeholder = placeholderOf }) {
    const used = new Set()
    let encoded = 0
    let placeholders = 0

    // A placeholder (D10) from the manifest when the entry already has one for
    // this mode (or knows the image is transparent), otherwise computed once
    // per build and image (queue key) and stored with the entry.
    const placeholderFor = (key, bytes, largest, mode) => {
        const previous = cache.get(key)
        if (previous?.transparent) return { transparent: true }
        if (previous?.[mode] !== undefined) return { [mode]: previous[mode] }
        return queue.add(async () => {
            const result = await placeholder(bytes, largest, mode)
            placeholders++
            return result
        }, `placeholder:${mode}:${key}`)
    }

    /**
     * Make sure every variant of `file` under `options` exists in the cache.
     *
     * The source is re-hashed on every call (D4: cheap next to encoding), and
     * only variants whose file is missing are encoded. Variants shared with
     * another page or image are encoded once (queue keyed by file name).
     *
     * The placeholder mode is not part of the manifest key: it adds data to
     * the entry but changes none of its files, so switching it on keeps every
     * cached variant.
     *
     * @param {string} file absolute source path
     * @param {object} options planVariants options
     * @param {{ placeholder?: 'none'|'color'|'blur' }} [extra]
     * @returns {Promise<{ key, width, height, files, source, variants, color?, blur?, transparent? }>}
     *     `width`/`height` are the largest variant's (D6); every variant
     *     carries its cache `file` name
     */
    async function generate(file, options, { placeholder: mode = 'none' } = {}) {
        const bytes = await fs.promises.readFile(file)
        const digest = sourceDigest(bytes)
        const key = imageKey(digest, options)
        used.add(key)

        const source = await readSourceMeta(bytes)
        const variants = planVariants(source, options).map((variant) => ({
            ...variant,
            file: variantFileName(file, variantHash(digest, variant), variant),
        }))

        const largest = variants.reduce((a, b) => (b.width > a.width ? b : a))

        const [extra] = await Promise.all([
            mode === 'none' ? {} : placeholderFor(key, bytes, largest, mode),
            ...variants
                .filter((variant) => !cache.hasFile(variant.file))
                .map((variant) =>
                    queue.add(async () => {
                        await encode(bytes, variant, cache.filePath(variant.file))
                        encoded++
                    }, variant.file)
                ),
        ])

        // Only the placeholder of the current mode is kept, so the manifest
        // never carries data the build does not use.
        const entry = {
            width: largest.width,
            height: largest.height,
            files: [...new Set(variants.map((variant) => variant.file))],
            ...extra,
        }
        cache.put(key, entry)

        return { key, ...entry, source, variants }
    }

    return {
        generate,
        /** Manifest keys touched by this build, for `cache.prune`. */
        usedKeys: () => [...used],
        /** Variants actually encoded by this generator (not served from cache). */
        get encoded() {
            return encoded
        },
        /** Placeholders actually computed by this generator (not from the manifest). */
        get placeholders() {
            return placeholders
        },
    }
}
