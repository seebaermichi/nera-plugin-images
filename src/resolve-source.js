import fs from 'fs'
import path from 'path'
import { resolveTheme } from '@nera-static/core/theme'

// URL in the rendered HTML → absolute source file (ROADMAP D5).
//
// Lookup order is the site's assets folder, then the theme's: the same order
// in which the site's files override the theme's in `public/`, so the plugin
// processes exactly the file a visitor would otherwise have downloaded.

export const RASTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']

// `http:`, `https:`, `mailto:`, `data:`, … and protocol-relative `//host/…`.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * The folders a source image may live in, most specific first.
 *
 * During the plugin stage `app.theme` is no longer the spec string from
 * app.yaml but core's `{ name, package, config }` object (core attaches it
 * before running plugins), so the spec is read back from `.name`.
 *
 * @param {{ app?: object, cwd?: string }} options
 * @returns {string[]} absolute directories (site assets, then theme assets)
 */
export function sourceRoots({ app = {}, cwd = process.cwd() } = {}) {
    const roots = [path.resolve(cwd, app.folders?.assets || './assets')]

    const spec = typeof app.theme === 'object' && app.theme !== null
        ? app.theme.name
        : app.theme
    const theme = resolveTheme({ app: { ...app, theme: spec }, cwd })
    if (theme && !roots.includes(theme.assetsRoot)) {
        roots.push(theme.assetsRoot)
    }
    return roots
}

/**
 * True when `file` is `root` itself or below it.
 */
export function isInside(root, file) {
    const relative = path.relative(root, file)
    return (
        relative === '' ||
        (relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    )
}

/**
 * Split `src` into path, query and hash without touching their encoding.
 */
export function splitUrl(src) {
    const hashAt = src.indexOf('#')
    const hash = hashAt === -1 ? '' : src.slice(hashAt)
    const rest = hashAt === -1 ? src : src.slice(0, hashAt)
    const queryAt = rest.indexOf('?')
    return {
        pathname: queryAt === -1 ? rest : rest.slice(0, queryAt),
        search: queryAt === -1 ? '' : rest.slice(queryAt),
        hash,
    }
}

/**
 * Resolve an image URL from a page to a source file.
 *
 * Returns `{ file, root, pathname, search, hash }` on success, where
 * `pathname` is the site-logical URL path (base_path stripped, page-relative
 * resolved, decoded). Otherwise `{ skip: reason }`:
 *
 * - `empty`       blank `src`
 * - `external`    any scheme (`http:`, `https:`, …) or protocol-relative `//`
 * - `data`        a `data:` URI
 * - `unsupported` not a raster format the plugin processes (`.svg`, `.gif`, …)
 * - `missing`     looks local but no such file under any root (caller warns)
 * - `outside`     resolves outside every root (caller warns)
 *
 * @param {string} src the `src` attribute as rendered
 * @param {{ pageHref?: string, basePath?: string, roots: string[] }} options
 */
export function resolveSource(src, { pageHref = '/index.html', basePath = '', roots }) {
    const url = typeof src === 'string' ? src.trim() : ''
    if (url === '') return { skip: 'empty' }
    if (/^data:/i.test(url)) return { skip: 'data' }
    if (url.startsWith('//') || SCHEME.test(url)) return { skip: 'external' }

    const { pathname: raw, search, hash } = splitUrl(url)
    if (raw === '') return { skip: 'empty' }

    let decoded
    try {
        decoded = decodeURIComponent(raw)
    } catch {
        return { skip: 'missing' }
    }

    let logical
    if (decoded.startsWith('/')) {
        // Root-absolute: a base_path prefix is a deploy detail, not part of the
        // asset's location under assets/.
        logical = basePath && (decoded === basePath || decoded.startsWith(`${basePath}/`))
            ? decoded.slice(basePath.length) || '/'
            : decoded
    } else {
        // Page-relative: against the page's own folder, in the logical
        // (un-prefixed) namespace `meta.href` lives in.
        logical = path.posix.join(path.posix.dirname(pageHref), decoded)
    }
    // Normalizing an absolute posix path clamps `..` at `/`, like a browser.
    const pathname = path.posix.normalize(logical)

    if (!RASTER_EXTENSIONS.includes(path.posix.extname(pathname).toLowerCase())) {
        return { skip: 'unsupported' }
    }

    let outside = 0
    for (const root of roots) {
        const file = path.join(root, ...pathname.split('/').filter(Boolean))
        if (!isInside(root, file)) {
            outside++
            continue
        }
        try {
            if (fs.statSync(file).isFile()) {
                return { file, root, pathname, search, hash }
            }
        } catch {
            // Not under this root; try the next.
        }
    }
    return { skip: outside === roots.length && roots.length > 0 ? 'outside' : 'missing' }
}
