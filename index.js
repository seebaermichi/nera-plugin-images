// @nera-static/plugin-images — build-time responsive images.
//
// `getMetaData` finds every local raster image in the rendered pages,
// generates its variants into the cache and rewrites the `<img>` as
// `<picture>` markup; frontmatter images get the same variants as data in
// `meta.images.<key>`, for the `+picture` mixin, both with an optional
// placeholder. `getAssets` (core >= 4.13.0) then prunes the cache and
// hands its files to core, which copies them to `public/<output_path>`.
// See ROADMAP.md for the decisions (D1–D13) behind each step.
import fs from 'fs'
import path from 'path'
import { openCache } from './src/cache.js'
import { loadConfig } from './src/config.js'
import { frontmatterImages } from './src/frontmatter.js'
import { createGenerator } from './src/generate.js'
import { assertCoreVersion, coreVersion } from './src/guard.js'
import { parseParams, sizesFor, stripParams } from './src/params.js'
import { createQueue } from './src/queue.js'
import { resolveSource, sourceRoots, splitUrl } from './src/resolve-source.js'
import { pictureData, publicUrl, rewriteHtml } from './src/rewrite-html.js'
import { warn } from './src/warn.js'

// What `getMetaData` leaves for `getAssets` in the same build. Core calls the
// two hooks in that order, once per build, so one slot is enough.
let current = null

/**
 * Throws (once per build, then again for every later image) when core is too
 * old to call `getAssets` (D12). Checked on the first image that will be
 * generated, before anything is encoded, so a site without images still
 * builds on an older core (decided 2026-10-09).
 */
function coreCheck(cwd) {
    let result
    return () => {
        if (result === undefined) {
            const version = coreVersion(cwd)
            if (version === null) {
                warn('could not determine the @nera-static/core version; it must be >= 4.13.0')
            }
            try {
                assertCoreVersion(version)
                result = null
            } catch (err) {
                result = err
            }
        }
        if (result) throw result
    }
}

export async function getMetaData({ app, pagesData }) {
    const cwd = process.cwd()
    const config = loadConfig({ cwd, app })
    const roots = sourceRoots({ app, cwd })
    const cache = openCache(path.resolve(cwd, config.cache_dir))
    const generator = createGenerator({
        cache,
        queue: createQueue({ concurrency: config.concurrency }),
    })
    const ensureCore = coreCheck(cwd)
    const options = {
        widths: config.widths,
        formats: config.formats,
        quality: config.quality,
    }
    // D10. The og image (D9) gets none: it is a file for crawlers, not markup.
    const placeholder = { placeholder: config.placeholder }
    current = null

    // What one URL on one page means: `null` (not ours, or left as is with a
    // warning), `{ skip }` (`?skip`, with the recognized parameters stripped)
    // or `{ file, params }`, ready to generate. Shared by both passes so a
    // frontmatter path reads exactly like a Markdown image URL.
    const prepare = (src, href, label) => {
        const resolved = resolveSource(src, {
            pageHref: href,
            basePath: app.basePath || '',
            roots,
        })
        // Not a local URL: neither the file nor the query is ours.
        if (['empty', 'external', 'data'].includes(resolved.skip)) return null

        const params = parseParams(splitUrl(src.trim()).search)
        if (params.skip) return { skip: stripParams(src) }

        if (resolved.skip) {
            if (resolved.skip === 'missing' || resolved.skip === 'outside') {
                warn(`${href}: ${label}not found, left as is: ${src}`)
            }
            return null
        }
        for (const message of params.warnings) {
            warn(`${href}: ${message}: ${src}`)
        }
        ensureCore()
        return { file: resolved.file, params }
    }

    let images = 0
    const result = []
    // Pages one after another, a page's images concurrently: the queue bounds
    // the encoders, and only one page's source bytes are held at a time.
    for (const page of pagesData) {
        const href = page.meta?.href || '/index.html'

        const handle = async (src) => {
            const prepared = prepare(src, href, 'image ')
            if (!prepared || prepared.skip) return prepared && { src: prepared.skip }
            try {
                const image = await generator.generate(prepared.file, {
                    ...options,
                    ...prepared.params.options,
                }, placeholder)
                return {
                    image,
                    sizes: sizesFor(prepared.params, config.sizes),
                    loading: prepared.params.loading,
                }
            } catch (err) {
                warn(`${href}: could not process ${src}, left as is (${err.message})`)
                return null
            }
        }

        // D9: `meta.images.<key>` from the frontmatter keys. The `<img>`
        // attributes a template sets itself (`loading`, `alt`) are the mixin's
        // business, so `?loading` has nothing to act on here.
        const prepareFrontmatter = async (key, src) => {
            const prepared = prepare(src, href, `frontmatter ${key} `)
            if (!prepared || prepared.skip) return null
            const { params } = prepared
            if (params.loading) {
                warn(`${href}: loading has no effect on a frontmatter image, ignored: ${src}`)
            }
            try {
                const image = await generator.generate(prepared.file, {
                    ...options,
                    ...params.options,
                }, placeholder)
                const entry = pictureData(image, {
                    outputPath: config.output_path,
                    sizes: sizesFor(params, config.sizes),
                })
                if (config.og) {
                    entry.og = await ogImage(generator, prepared.file, config, params)
                }
                return entry
            } catch (err) {
                warn(`${href}: could not process frontmatter ${key} ${src} (${err.message})`)
                return null
            }
        }

        const [rewritten, frontmatter] = await Promise.all([
            rewriteHtml(page.content, {
                handle,
                outputPath: config.output_path,
                sizes: config.sizes,
                eagerFirst: config.eager_first,
                figure: config.figure,
            }),
            frontmatterImages(page.meta, {
                keys: config.frontmatter_keys,
                prepare: prepareFrontmatter,
            }),
        ])
        images += rewritten.count + frontmatter.count

        const changed = rewritten.html !== page.content || frontmatter.meta !== page.meta
        result.push(
            changed ? { ...page, content: rewritten.html, meta: frontmatter.meta } : page
        )
    }

    current = { config, cache, generator }
    if (images > 0) {
        const placeholders = config.placeholder === 'none'
            ? ''
            : `, ${generator.placeholders} placeholder(s) computed`
        console.log(
            `🖼️  plugin-images: ${images} image(s), ${generator.encoded} variant(s) encoded${placeholders}`
        )
    }
    return result
}

/**
 * The og preset (D9): one JPEG at `og.width` × `og.height` with `og.fit`,
 * never upscaled. Only the frontmatter path's `focus` and `q` carry over; its
 * own geometry (`w`, `ratio`, …) is for the page, not for the social card.
 */
async function ogImage(generator, file, config, params) {
    const { width, height, fit } = config.og
    const { focus, q } = params.options
    const image = await generator.generate(file, {
        widths: [width],
        formats: [],
        quality: config.quality,
        ratio: width / height,
        fit,
        focus,
        q,
        fallback: 'jpeg',
    })
    const [variant] = image.variants
    return {
        src: publicUrl(config.output_path, variant.file),
        width: variant.width,
        height: variant.height,
    }
}

export async function getAssets() {
    if (!current) return []
    const { config, cache, generator } = current
    current = null

    const used = generator.usedKeys()
    // A site that never had an image gets no cache folder at all.
    if (used.length > 0 || fs.existsSync(cache.dir)) {
        try {
            if (config.prune) cache.prune(used)
            cache.save()
        } catch (err) {
            // The variants on disk are complete (atomic writes); a stale
            // manifest only costs a re-check next build. Not worth failing.
            warn(`could not update the image cache (${err.message})`)
        }
    }

    if (used.length === 0 || !fs.existsSync(cache.filesDir)) return []
    return [{ from: cache.filesDir, to: config.output_path.slice(1) }]
}
