import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

// What to produce for one source image (planVariants, pure) and how to produce
// one variant (encodeVariant, sharp). ROADMAP D6 (output), D7 (parameters).

// The `<img>` fallback stays in the source's own family (D6); formats a
// browser cannot show in `<img>` fall back to JPEG. sharp reports AVIF (and
// HEIC) sources as `heif`.
const FALLBACK_FORMAT = {
    jpeg: 'jpeg',
    png: 'png',
    webp: 'webp',
    heif: 'jpeg',
    avif: 'jpeg',
    tiff: 'jpeg',
}

export const EXTENSIONS = { avif: 'avif', webp: 'webp', jpeg: 'jpg', png: 'png' }

export const MIME_TYPES = {
    avif: 'image/avif',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
    png: 'image/png',
}

export const STRATEGIES = ['attention', 'entropy']

export function fallbackFormat(sourceFormat) {
    return FALLBACK_FORMAT[sourceFormat] || 'jpeg'
}

/**
 * Dimensions as a visitor sees them: EXIF orientation 5–8 swaps width and
 * height, and `.rotate()` in encodeVariant applies it.
 *
 * @param {string|Buffer} input file path or bytes
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean }>}
 */
export async function readSourceMeta(input) {
    const meta = await sharp(input).metadata()
    if (!meta.width || !meta.height) {
        throw new Error('could not read image dimensions')
    }
    const { width, height } = meta.autoOrient || meta
    return { width, height, format: meta.format, hasAlpha: Boolean(meta.hasAlpha) }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// The largest region of `aspect` (width / height) inside the source, centred
// on the focal point and pushed back inside the edges.
function coverCrop(source, aspect, focus) {
    const { width: sw, height: sh } = source
    const width = sw / sh > aspect ? Math.round(sh * aspect) : sw
    const height = sw / sh > aspect ? sh : Math.round(sw / aspect)

    if (typeof focus === 'string') {
        return { region: { width, height }, crop: { strategy: focus } }
    }
    const { x = 50, y = 50 } = focus || {}
    const left = clamp(Math.round((x / 100) * sw - width / 2), 0, sw - width)
    const top = clamp(Math.round((y / 100) * sh - height / 2), 0, sh - height)
    return { region: { width, height }, crop: { left, top, width, height } }
}

// The geometry shared by every variant of one image: how the source is cut and
// fitted, independent of the output width.
function geometry(source, { w, h, ratio, fit, focus }) {
    const aspect = w && h ? w / h : ratio || null

    if (!aspect) {
        return { aspect: null, fit: 'fill', crop: null, region: source }
    }
    const mode = fit || 'cover'
    if (mode === 'cover') {
        const { region, crop } = coverCrop(source, aspect, focus)
        return { aspect, fit: 'cover', crop, region }
    }
    return { aspect, fit: mode, crop: null, region: source }
}

// Output size for a candidate width W, and the largest W that does not
// upscale the image content.
function sizer(source, geo) {
    const { aspect, fit, region } = geo
    const { width: sw, height: sh } = source

    if (fit === 'contain' || fit === 'inside') {
        // Box W × W/aspect; the image is scaled to fit inside it. `contain`
        // pads the box, `inside` returns just the scaled image.
        const scale = (W) => Math.min(W / sw, W / aspect / sh)
        return {
            max: Math.round(Math.max(sw, sh * aspect)),
            size: (W) =>
                fit === 'contain'
                    ? { width: W, height: Math.round(W / aspect) }
                    : {
                        width: Math.round(sw * scale(W)),
                        height: Math.round(sh * scale(W)),
                    },
        }
    }
    // `fill` (no crop) and `cover` both scale the region to the full width.
    const ratio = aspect || region.width / region.height
    return {
        max: region.width,
        size: (W) => ({ width: W, height: Math.max(1, Math.round(W / ratio)) }),
    }
}

/**
 * Plan every variant of one image. Pure: no I/O, the main unit-test target.
 *
 * Widths (D6, D7): the config widths, or with `w` those below `w` plus `w` and
 * `2w` (retina). Never upscaled: config widths above the source are dropped
 * and the source width is used when none is left; `w`/`2w` are capped at it.
 *
 * Geometry: `w` + `h` or `ratio` (width / height, a number) set an aspect.
 * With `fit: cover` (the default once an aspect is set) the source is cropped
 * to it around `focus` (`{ x, y }` in percent, default 50/50, or `attention` /
 * `entropy` for sharp's strategies). `contain` pads to the aspect, `inside`
 * scales to fit within it. `w` + `h` take precedence over `ratio`.
 *
 * Formats: one set per modern format, then the fallback (D6). A modern format
 * equal to the fallback is produced once, as the fallback. `fallback` forces
 * the fallback format instead of deriving it from the source (the og preset,
 * D9, is always JPEG).
 *
 * @param {{ width: number, height: number, format: string }} source oriented
 * @param {object} options `{ widths, formats, quality, w?, h?, ratio?, fit?, focus?, q?, fallback? }`
 * @returns {Array<{ width, height, format, quality, fit, crop, aspect }>}
 *     modern formats in `formats` order, fallback last, each ascending by width
 */
export function planVariants(source, options) {
    const { widths, formats = [], quality = {}, w, q } = options
    const geo = geometry(source, options)
    const { max, size } = sizer(source, geo)

    let candidates
    if (w) {
        candidates = [...widths.filter((x) => x < w), w, 2 * w].map((x) =>
            Math.min(x, max)
        )
    } else {
        candidates = widths.filter((x) => x <= max)
        if (candidates.length === 0) candidates = [max]
    }

    // `inside` can map two box widths to the same output width; keep one.
    const sizes = []
    for (const W of [...new Set(candidates)].sort((a, b) => a - b)) {
        const dims = size(W)
        if (!sizes.some((s) => s.width === dims.width)) sizes.push(dims)
    }

    const fallback = options.fallback || fallbackFormat(source.format)
    const order = [...formats.filter((f) => f !== fallback), fallback]

    return order.flatMap((format) =>
        sizes.map(({ width, height }) => ({
            width,
            height,
            format,
            quality: q || quality[format],
            fit: geo.fit,
            crop: geo.crop,
            aspect: geo.aspect,
        }))
    )
}

// The pixels of one variant before encoding: EXIF orientation applied,
// cropped, resized and in sRGB. Shared by the encoder and the placeholders,
// so a placeholder always shows exactly the variant's region.
function shape(input, { width, height, fit, crop }) {
    let image = sharp(input).rotate()

    if (crop && crop.strategy) {
        image = image.resize(width, height, {
            fit: 'cover',
            position: sharp.strategy[crop.strategy],
        })
    } else {
        if (crop) image = image.extract(crop)
        image = image.resize(width, height, {
            fit,
            background: { r: 255, g: 255, b: 255, alpha: 0 },
        })
    }
    return image.toColourspace('srgb')
}

function encoder(image, { format, quality }) {
    switch (format) {
    case 'avif':
        return image.avif({ quality })
    case 'webp':
        return image.webp({ quality })
    case 'png':
        // Lossless; `quality` only matters with palette quantisation, which
        // stays off (see the config reference).
        return image.png()
    case 'jpeg':
        return image.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true })
    default:
        throw new Error(`unsupported output format "${format}"`)
    }
}

/**
 * Encode one planned variant and write it to `outFile`.
 *
 * Applies EXIF orientation, crops, resizes, converts to sRGB and encodes.
 * Metadata is stripped: that is sharp's default, and `.withMetadata()` is never
 * called (D6). The file is written to a temporary name and renamed into place,
 * so an interrupted build never leaves a truncated file the cache would later
 * take for a finished one.
 *
 * @param {string|Buffer} input source file path or bytes
 * @param {object} variant one entry from planVariants
 * @param {string} outFile absolute target path
 */
export async function encodeVariant(input, variant, outFile) {
    const image = encoder(shape(input, variant), variant)

    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    const temp = `${outFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
        await image.toFile(temp)
        fs.renameSync(temp, outFile)
    } catch (err) {
        fs.rmSync(temp, { force: true })
        throw err
    }
}

export const PLACEHOLDER_SAMPLE_WIDTH = 64
export const BLUR_WIDTH = 16
const BLUR_QUALITY = 50

// The same variant at another width, with the height following its aspect.
const scaled = (variant, width) => {
    const w = Math.min(width, variant.width)
    return { ...variant, width: w, height: Math.max(1, Math.round((w * variant.height) / variant.width)) }
}

const hex = (value) => Math.round(value).toString(16).padStart(2, '0')

/**
 * The placeholder of one image (D10), computed from its largest variant's
 * geometry so it shows the same crop the visitor will see.
 *
 * - `color`: the dominant colour as `#rrggbb`;
 * - `blur`: a {@link BLUR_WIDTH} px wide WebP as a base64 data URI.
 *
 * An image that is not fully opaque (alpha, or `fit=contain` padding) gets
 * `{ transparent: true }` instead: a background behind it would stay visible
 * through the transparent parts after loading (decided 2026-10-09).
 *
 * @param {string|Buffer} input source file path or bytes
 * @param {object} variant the largest planned variant
 * @param {'color'|'blur'} mode
 * @returns {Promise<{ color: string }|{ blur: string }|{ transparent: true }>}
 */
export async function placeholderOf(input, variant, mode) {
    const sample = await shape(input, scaled(variant, PLACEHOLDER_SAMPLE_WIDTH)).png().toBuffer()
    const { isOpaque, dominant } = await sharp(sample).stats()
    if (!isOpaque) return { transparent: true }

    if (mode === 'color') {
        return { color: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}` }
    }
    const { width, height } = scaled(variant, BLUR_WIDTH)
    const blur = await sharp(sample)
        .resize(width, height, { fit: 'fill' })
        .webp({ quality: BLUR_QUALITY })
        .toBuffer()
    return { blur: `data:image/webp;base64,${blur.toString('base64')}` }
}
