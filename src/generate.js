import fs from 'fs'
import { imageKey, sourceDigest, variantFileName, variantHash } from './cache.js'
import { encodeVariant, planVariants, readSourceMeta } from './transform.js'

// One image in, its variants on disk and a manifest entry out. Ties the cache,
// the plan, the queue and the encoder together; the content pass (slice 3)
// and the frontmatter pass (slice 5) both go through here.

/**
 * @param {object} deps
 * @param {ReturnType<import('./cache.js').openCache>} deps.cache
 * @param {ReturnType<import('./queue.js').createQueue>} deps.queue
 * @param {typeof encodeVariant} [deps.encode] injectable for tests
 */
export function createGenerator({ cache, queue, encode = encodeVariant }) {
    const used = new Set()
    let encoded = 0

    /**
     * Make sure every variant of `file` under `options` exists in the cache.
     *
     * The source is re-hashed on every call (D4: cheap next to encoding), and
     * only variants whose file is missing are encoded. Variants shared with
     * another page or image are encoded once (queue keyed by file name).
     *
     * @param {string} file absolute source path
     * @param {object} options planVariants options
     * @returns {Promise<{ key, width, height, files, source, variants }>}
     *     `width`/`height` are the largest variant's (D6); every variant
     *     carries its cache `file` name
     */
    async function generate(file, options) {
        const bytes = await fs.promises.readFile(file)
        const digest = sourceDigest(bytes)
        const key = imageKey(digest, options)
        used.add(key)

        const source = await readSourceMeta(bytes)
        const variants = planVariants(source, options).map((variant) => ({
            ...variant,
            file: variantFileName(file, variantHash(digest, variant), variant),
        }))

        await Promise.all(
            variants
                .filter((variant) => !cache.hasFile(variant.file))
                .map((variant) =>
                    queue.add(async () => {
                        await encode(bytes, variant, cache.filePath(variant.file))
                        encoded++
                    }, variant.file)
                )
        )

        const largest = variants.reduce((a, b) => (b.width > a.width ? b : a))
        const entry = {
            width: largest.width,
            height: largest.height,
            files: [...new Set(variants.map((variant) => variant.file))],
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
    }
}
