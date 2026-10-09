import os from 'os'
import path from 'path'
import { getConfig } from '@nera-static/plugin-utils'
import { warn } from './warn.js'

// `config/images.yaml` is optional and every key has a default (ROADMAP
// "Configuration"). `getConfig` returns `{}` for a missing file, so each key
// gets its own JS fallback here. A key with a bad value warns and falls back to
// its default rather than failing the build: a typo in an image config must not
// take the site down.

export const MODERN_FORMATS = ['avif', 'webp']
export const QUALITY_FORMATS = ['avif', 'webp', 'jpeg', 'png']
export const FITS = ['cover', 'contain', 'inside']
export const PLACEHOLDERS = ['none', 'color', 'blur']

export function defaultConcurrency() {
    return Math.max(1, os.availableParallelism() - 1)
}

export function defaults() {
    return {
        formats: ['avif', 'webp'],
        widths: [480, 800, 1200, 1600],
        sizes: '100vw',
        quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
        eager_first: true,
        figure: 'title',
        frontmatter_keys: ['image'],
        og: { width: 1200, height: 630, fit: 'cover' },
        placeholder: 'none',
        output_path: '/_img',
        cache_dir: '.nera-cache/images',
        prune: true,
        concurrency: defaultConcurrency(),
    }
}

const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const isPositiveInt = (value) => Number.isInteger(value) && value > 0

const isQuality = (value) => Number.isInteger(value) && value >= 1 && value <= 100

const show = (value) => JSON.stringify(value)

function bad(key, value, fallback) {
    warn(
        `config/images.yaml: invalid ${key} ${show(value)}, using ${show(fallback)}`
    )
    return fallback
}

function readFormats(value, fallback) {
    if (!Array.isArray(value)) return bad('formats', value, fallback)

    const formats = []
    for (const format of value) {
        if (!MODERN_FORMATS.includes(format)) {
            warn(
                `config/images.yaml: ignoring unknown format ${show(format)} (supported: ${MODERN_FORMATS.join(', ')})`
            )
        } else if (!formats.includes(format)) {
            formats.push(format)
        }
    }
    // An explicit `[]` is valid: plain `<img>` with srcset, no `<source>`.
    return formats
}

function readWidths(value, fallback) {
    if (!Array.isArray(value) || value.length === 0) {
        return bad('widths', value, fallback)
    }
    const widths = value.filter(isPositiveInt)
    if (widths.length === 0) return bad('widths', value, fallback)
    if (widths.length !== value.length) {
        warn(
            `config/images.yaml: ignoring widths that are not positive integers in ${show(value)}`
        )
    }

    return [...new Set(widths)].sort((a, b) => a - b)
}

function readQuality(value, fallback) {
    if (!isPlainObject(value)) return bad('quality', value, fallback)

    const quality = { ...fallback }
    for (const [format, q] of Object.entries(value)) {
        if (!QUALITY_FORMATS.includes(format)) {
            warn(`config/images.yaml: ignoring quality for unknown format ${show(format)}`)
        } else if (!isQuality(q)) {
            quality[format] = bad(`quality.${format}`, q, fallback[format])
        } else {
            quality[format] = q
        }
    }
    return quality
}

function readOg(value, fallback) {
    if (value === false) return false
    if (!isPlainObject(value)) return bad('og', value, fallback)

    const og = { ...fallback }
    for (const key of ['width', 'height']) {
        if (value[key] === undefined) continue
        og[key] = isPositiveInt(value[key])
            ? value[key]
            : bad(`og.${key}`, value[key], fallback[key])
    }
    if (value.fit !== undefined) {
        og.fit = FITS.includes(value.fit)
            ? value.fit
            : bad('og.fit', value.fit, fallback.fit)
    }
    return og
}

// `/_img`, `_img/`, `/a/b/` → `/_img`, `/a/b`. A root-absolute URL path
// without a trailing slash, so `${output_path}/${file}` is always right.
function readOutputPath(value, fallback) {
    if (typeof value !== 'string') return bad('output_path', value, fallback)

    const segments = value.split('/').filter(Boolean)
    if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
        return bad('output_path', value, fallback)
    }
    return `/${segments.join('/')}`
}

function readCacheDir(value, fallback) {
    if (typeof value !== 'string' || value.trim() === '') {
        return bad('cache_dir', value, fallback)
    }
    return value.trim()
}

const readers = {
    formats: readFormats,
    widths: readWidths,
    quality: readQuality,
    og: readOg,
    output_path: readOutputPath,
    cache_dir: readCacheDir,
    sizes: (value, fallback) =>
        typeof value === 'string' && value.trim() !== ''
            ? value.trim()
            : bad('sizes', value, fallback),
    eager_first: (value, fallback) =>
        typeof value === 'boolean' ? value : bad('eager_first', value, fallback),
    prune: (value, fallback) =>
        typeof value === 'boolean' ? value : bad('prune', value, fallback),
    figure: (value, fallback) =>
        value === 'title' || value === false ? value : bad('figure', value, fallback),
    frontmatter_keys: (value, fallback) =>
        Array.isArray(value) && value.every((k) => typeof k === 'string' && k !== '')
            ? [...new Set(value)]
            : bad('frontmatter_keys', value, fallback),
    placeholder: (value, fallback) =>
        PLACEHOLDERS.includes(value) ? value : bad('placeholder', value, fallback),
    concurrency: (value, fallback) =>
        isPositiveInt(value) ? value : bad('concurrency', value, fallback),
}

/**
 * Merge a raw config object over the defaults, key by key, with validation.
 * Pure apart from warnings; `normalizeConfig({})` is the full default config.
 *
 * @param {object} raw parsed `config/images.yaml` (anything `getConfig` returns)
 * @returns {object} complete, validated config
 */
export function normalizeConfig(raw) {
    const config = defaults()
    if (raw === null || raw === undefined) return config
    if (!isPlainObject(raw)) {
        warn('config/images.yaml: expected a mapping at the top level, using defaults')
        return config
    }

    for (const [key, value] of Object.entries(raw)) {
        const read = readers[key]
        if (!read) {
            warn(`config/images.yaml: ignoring unknown key ${show(key)}`)
            continue
        }
        // A key present but empty (`widths:` with nothing after it) reads as
        // null; treat it like an absent key rather than an invalid one.
        if (value === null) continue
        config[key] = read(value, config[key])
    }
    return config
}

/**
 * Read and normalize the site's `config/images.yaml`. Called inside the hook,
 * not at module scope, so each build (and each test) sees the current file.
 *
 * @param {{ cwd?: string, app?: object }} [options] `app.folders.config` is
 *     honoured when set, like the rest of the pipeline
 * @returns {object} complete, validated config
 */
export function loadConfig({ cwd = process.cwd(), app } = {}) {
    const folder = app?.folders?.config || 'config'
    return normalizeConfig(getConfig(path.resolve(cwd, folder, 'images.yaml')))
}
