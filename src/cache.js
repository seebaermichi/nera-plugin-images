import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { slugify } from '@nera-static/plugin-utils'
import { EXTENSIONS } from './transform.js'
import { warn } from './warn.js'

// The variant cache (ROADMAP D3, D4): `<dir>/files/` holds every generated
// file, `<dir>/manifest.json` one entry per image. A variant is encoded only
// when its file is missing, and pruning removes what a build did not use.

// Bump when the encoder's output changes for the same inputs (new sharp
// settings, a fixed crop bug). It feeds every hash, so all names change and
// the next build re-encodes; pruning then removes the old files.
export const CACHE_VERSION = 1

const MANIFEST = 'manifest.json'

const sha256 = (...parts) => {
    const hash = crypto.createHash('sha256')
    for (const part of parts) hash.update(part)
    return hash.digest('hex')
}

// JSON with sorted keys and `undefined` dropped, so two option objects that
// mean the same thing hash the same regardless of key order.
export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    if (value !== null && typeof value === 'object') {
        const entries = Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        return `{${entries.join(',')}}`
    }
    return JSON.stringify(value)
}

/** sha256 hex of the source bytes. */
export function sourceDigest(bytes) {
    return sha256(bytes)
}

/**
 * Manifest key of one image: the source plus every option that shapes its
 * set of files (widths, formats, quality, geometry).
 */
export function imageKey(digest, options) {
    return sha256(digest, '\0', stableStringify(options), '\0', String(CACHE_VERSION))
}

/**
 * D3 `hash8` of one variant: source bytes + transform parameters + cache
 * version. Width is left out on purpose, it is part of the file name, so all
 * widths of one format share a hash and the files sort together.
 */
export function variantHash(digest, { format, quality, fit, crop, aspect }) {
    const params = stableStringify({ format, quality, fit, crop, aspect })
    return sha256(digest, '\0', params, '\0', String(CACHE_VERSION)).slice(0, 8)
}

/**
 * `<basename>-<hash8>-<width>.<ext>` (D3). The basename is slugified so a
 * photo named `Straße am Meer.JPG` yields a URL that needs no escaping;
 * a name with nothing usable left becomes `image`.
 */
export function variantFileName(source, hash8, { width, format }) {
    const base = slugify(path.parse(source).name) || 'image'
    return `${base}-${hash8}-${width}.${EXTENSIONS[format]}`
}

function readManifest(file) {
    let raw
    try {
        raw = fs.readFileSync(file, 'utf-8')
    } catch {
        return {}
    }
    try {
        const parsed = JSON.parse(raw)
        if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
            return parsed.entries
        }
    } catch {
        warn(`ignoring unreadable cache manifest ${file}`)
    }
    // Another cache version or a broken file: start empty. Nothing references
    // the old files any more, so the next prune removes them.
    return {}
}

function writeAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, content)
    fs.renameSync(temp, file)
}

/**
 * Open (or start) the cache at `dir`.
 *
 * @param {string} dir absolute cache directory (config `cache_dir`, resolved)
 */
export function openCache(dir) {
    const filesDir = path.join(dir, 'files')
    const manifestFile = path.join(dir, MANIFEST)
    const entries = readManifest(manifestFile)

    return {
        dir,
        filesDir,

        filePath: (name) => path.join(filesDir, name),
        hasFile: (name) => fs.existsSync(path.join(filesDir, name)),

        has: (key) => Object.hasOwn(entries, key),
        get: (key) => entries[key],
        put(key, entry) {
            entries[key] = entry
        },
        keys: () => Object.keys(entries),

        /** Write the manifest (temp file + rename, so it is never half-written). */
        save() {
            const sorted = Object.fromEntries(
                Object.keys(entries).sort().map((key) => [key, entries[key]])
            )
            writeAtomic(
                manifestFile,
                `${JSON.stringify({ version: CACHE_VERSION, entries: sorted }, null, 2)}\n`
            )
        },

        /**
         * Drop every manifest entry not in `usedKeys`, then every file in
         * `files/` that no remaining entry lists (D4). Builds are always full,
         * so "unused this build" means "unused". Returns what was removed.
         *
         * @param {Iterable<string>} usedKeys
         * @returns {{ entries: string[], files: string[] }}
         */
        prune(usedKeys) {
            const used = new Set(usedKeys)
            const removedEntries = Object.keys(entries).filter((key) => !used.has(key))
            for (const key of removedEntries) delete entries[key]

            const keep = new Set(Object.values(entries).flatMap((entry) => entry.files || []))
            let present = []
            try {
                present = fs.readdirSync(filesDir)
            } catch {
                // No files yet.
            }
            const removedFiles = present.filter((name) => !keep.has(name)).sort()
            for (const name of removedFiles) {
                fs.rmSync(path.join(filesDir, name), { recursive: true, force: true })
            }
            return { entries: removedEntries.sort(), files: removedFiles }
        },
    }
}
