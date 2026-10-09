import { describe, it, expect } from 'vitest'
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
    it('finds the installed core (the devDependency here)', () => {
        expect(satisfies(coreVersion())).toBe(true)
    })
})
