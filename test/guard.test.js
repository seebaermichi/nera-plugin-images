import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, it, expect } from 'vitest'
import { assertCoreVersion, coreVersion, satisfies } from '../src/guard.js'

describe('satisfies', () => {
    it('compares major.minor.patch against 4.13.0', () => {
        expect(satisfies('4.13.0')).toBe(true)
        expect(satisfies('4.13.1')).toBe(true)
        expect(satisfies('4.20.0')).toBe(true)
        expect(satisfies('5.0.0')).toBe(true)
        expect(satisfies('4.12.9')).toBe(false)
        expect(satisfies('3.99.99')).toBe(false)
    })

    it('ignores a prerelease suffix and rejects garbage', () => {
        expect(satisfies('4.13.0-beta.1')).toBe(true)
        expect(satisfies('not a version')).toBe(false)
        expect(satisfies(undefined)).toBe(false)
    })
})

describe('assertCoreVersion', () => {
    it('throws on an older core, naming both versions', () => {
        expect(() => assertCoreVersion('4.12.0')).toThrow(/4\.12\.0 is too old.*>= 4\.13\.0/)
    })

    it('passes a new enough core and an unknown one', () => {
        expect(() => assertCoreVersion('4.13.0')).not.toThrow()
        expect(() => assertCoreVersion(null)).not.toThrow()
    })
})

describe('coreVersion', () => {
    const dirs = []
    const site = (core) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'images-guard-'))
        dirs.push(dir)
        fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }')
        if (core) {
            const pkg = path.join(dir, 'node_modules/@nera-static/core')
            fs.mkdirSync(pkg, { recursive: true })
            fs.writeFileSync(
                path.join(pkg, 'package.json'),
                JSON.stringify({ name: '@nera-static/core', version: core })
            )
        }
        return dir
    }

    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    it('finds the installed core (the devDependency here)', () => {
        expect(satisfies(coreVersion())).toBe(true)
    })

    it('prefers the site\'s core over the plugin\'s own copy', () => {
        // A symlinked plugin resolves from its real path, where its own
        // devDependency core (>= 4.13.0) would hide the site's older one.
        expect(coreVersion(site('4.12.0'))).toBe('4.12.0')
        expect(() => assertCoreVersion(coreVersion(site('4.12.0')))).toThrow(/too old/)
    })

    it('falls back to the plugin\'s location when the site has no core', () => {
        expect(satisfies(coreVersion(site(null)))).toBe(true)
    })
})
