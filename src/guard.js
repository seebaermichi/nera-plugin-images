import { createRequire } from 'module'
import path from 'path'

// D12 runtime safety net. The plugin rewrites pages to reference files it only
// hands to core through `getAssets`, which core calls from 4.13.0 on. On an
// older core the hook is never called, every rewritten page points at missing
// files, and the build would still exit 0. So the plugin checks core's version
// and fails loudly instead. `peerDependencies` reports the same at install
// time; this catches an install that ignored it.

export const REQUIRED_CORE = '4.13.0'

const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim())
    return match ? match.slice(1, 4).map(Number) : null
}

/**
 * True when `version` is at least `required` (major.minor.patch; a
 * prerelease suffix is ignored). False for anything unparseable.
 */
export function satisfies(version, required = REQUIRED_CORE) {
    const have = parse(version)
    const need = parse(required)
    if (!have || !need) return false
    for (let i = 0; i < 3; i++) {
        if (have[i] !== need[i]) return have[i] > need[i]
    }
    return true
}

/**
 * The version of `@nera-static/core` this build most likely runs on, or
 * `null` when it cannot be found.
 *
 * Resolved from the site root first: that is the core `nera` loads. Only
 * when the site has none is it resolved from the plugin's own location. The
 * plugin's location alone is not enough: Node resolves a symlinked plugin
 * (`npm install ../nera-plugin-images`, `npm link`) from its real path, where
 * its own devDependency core would answer for the site's (found in the
 * slice 7 field test, decided 2026-10-09).
 *
 * @param {string} [cwd]
 */
export function coreVersion(cwd = process.cwd()) {
    const bases = [path.join(cwd, 'package.json'), import.meta.url]
    for (const base of bases) {
        try {
            return createRequire(base)('@nera-static/core/package.json').version
        } catch {
            // Try the next base.
        }
    }
    return null
}

/**
 * Throw when core is known to be older than `REQUIRED_CORE`. An unknown
 * version (core not resolvable from here) passes: the plugin is running inside
 * a build, so some core is calling it, and refusing on a guess would block a
 * working setup.
 *
 * @param {string|null} version
 */
export function assertCoreVersion(version) {
    if (version === null || satisfies(version)) return
    throw new Error(
        `plugin-images: @nera-static/core ${version} is too old; this plugin needs ` +
            `>= ${REQUIRED_CORE} (the getAssets hook). Without it, pages would link ` +
            'to image files that are never copied to public/. Update with ' +
            '`npm update @nera-static/nera` (or `@nera-static/core`).'
    )
}
