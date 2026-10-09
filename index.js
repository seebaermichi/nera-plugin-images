// @nera-static/plugin-images — build-time responsive images.
//
// `getMetaData` finds every local raster image in the rendered pages,
// generates its variants into the cache and rewrites the `<img>` as
// `<picture>` markup. `getAssets` (core >= 4.13.0) then prunes the cache and
// hands its files to core, which copies them to `public/<output_path>`.
// See ROADMAP.md for the decisions (D1–D13) behind each step.
import fs from 'fs'
import path from 'path'
import { openCache } from './src/cache.js'
import { loadConfig } from './src/config.js'
import { createGenerator } from './src/generate.js'
import { assertCoreVersion, coreVersion } from './src/guard.js'
import { parseParams, sizesFor, stripParams } from './src/params.js'
import { createQueue } from './src/queue.js'
import { resolveSource, sourceRoots, splitUrl } from './src/resolve-source.js'
import { rewriteHtml } from './src/rewrite-html.js'
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
    current = null

    let images = 0
    const result = []
    // Pages one after another, a page's images concurrently: the queue bounds
    // the encoders, and only one page's source bytes are held at a time.
    for (const page of pagesData) {
        const href = page.meta?.href || '/index.html'

        const handle = async (src) => {
            const resolved = resolveSource(src, {
                pageHref: href,
                basePath: app.basePath || '',
                roots,
            })
            // Not a local URL: neither the file nor the query is ours.
            if (['empty', 'external', 'data'].includes(resolved.skip)) return null

            const params = parseParams(splitUrl(src.trim()).search)
            if (params.skip) return { src: stripParams(src) }

            if (resolved.skip) {
                if (resolved.skip === 'missing' || resolved.skip === 'outside') {
                    warn(`${href}: image not found, left as is: ${src}`)
                }
                return null
            }
            for (const message of params.warnings) {
                warn(`${href}: ${message}: ${src}`)
            }
            ensureCore()
            try {
                const image = await generator.generate(resolved.file, {
                    ...options,
                    ...params.options,
                })
                return {
                    image,
                    sizes: sizesFor(params, config.sizes),
                    loading: params.loading,
                }
            } catch (err) {
                warn(`${href}: could not process ${src}, left as is (${err.message})`)
                return null
            }
        }

        const { html, count } = await rewriteHtml(page.content, {
            handle,
            outputPath: config.output_path,
            sizes: config.sizes,
            eagerFirst: config.eager_first,
            figure: config.figure,
        })
        images += count
        result.push(html === page.content ? page : { ...page, content: html })
    }

    current = { config, cache, generator }
    if (images > 0) {
        console.log(
            `🖼️  plugin-images: ${images} image(s), ${generator.encoded} variant(s) encoded`
        )
    }
    return result
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
