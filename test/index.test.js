import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeImages } from './fixtures/make-images.js'

// The hooks called directly (no core run), for the paths the end-to-end test
// cannot reach: the D12 guard against an old core, and per-image failures.

const version = vi.hoisted(() => ({ value: '4.13.0' }))
vi.mock('../src/guard.js', async (importOriginal) => ({
    ...(await importOriginal()),
    coreVersion: () => version.value,
}))

const { getAssets, getMetaData } = await import('../index.js')

let root
let prevCwd
let warn

const app = () => ({ basePath: '', folders: { assets: './assets', config: './config' } })
const pageWith = (content, href = '/index.html') => ({ content, meta: { href } })

beforeEach(async () => {
    prevCwd = process.cwd()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-hooks-'))
    await makeImages(path.join(root, 'assets', 'images'))
    process.chdir(root)
    version.value = '4.13.0'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(prevCwd)
    fs.rmSync(root, { recursive: true, force: true })
})

describe('D12 core version guard', () => {
    it('fails before encoding anything when core is older than 4.13.0', async () => {
        version.value = '4.12.0'
        const pages = [pageWith('<img src="/images/alpha.png">')]

        await expect(getMetaData({ app: app(), pagesData: pages })).rejects.toThrow(
            /@nera-static\/core 4\.12\.0 is too old.*>= 4\.13\.0/
        )
        expect(fs.existsSync(path.join(root, '.nera-cache'))).toBe(false)
    })

    it('lets a site without processable images build on an older core', async () => {
        version.value = '4.12.0'
        const pages = [pageWith('<img src="/images/logo.svg"><p>text</p>')]

        const result = await getMetaData({ app: app(), pagesData: pages })
        expect(result[0]).toBe(pages[0])
        expect(await getAssets()).toEqual([])
    })

    it('warns but builds when the core version cannot be determined', async () => {
        version.value = null
        const result = await getMetaData({ app: app(), pagesData: [pageWith('<img src="/images/alpha.png">')] })

        expect(result[0].content).toContain('<picture>')
        expect(warn.mock.calls.join('\n')).toMatch(/could not determine the @nera-static\/core version/)
        await getAssets()
    })
})

describe('getMetaData / getAssets', () => {
    it('leaves an image it cannot decode as it was and warns', async () => {
        fs.writeFileSync(path.join(root, 'assets', 'images', 'broken.jpg'), 'not a jpeg')
        const content = '<p><img src="/images/broken.jpg" alt="b"></p>'

        const [page] = await getMetaData({ app: app(), pagesData: [pageWith(content, '/x.html')] })

        expect(page.content).toBe(content)
        expect(warn.mock.calls.join('\n')).toMatch(/\/x\.html: could not process \/images\/broken\.jpg/)
        expect(await getAssets()).toEqual([])
    })

    it('returns the cache files folder under output_path from config', async () => {
        fs.mkdirSync(path.join(root, 'config'))
        fs.writeFileSync(path.join(root, 'config', 'images.yaml'), 'output_path: /media/img/\n')

        const [page] = await getMetaData({ app: app(), pagesData: [pageWith('<img src="/images/alpha.png">')] })
        const assets = await getAssets()

        expect(page.content).toMatch(/src="\/media\/img\/alpha-[0-9a-f]{8}-300\.png"/)
        expect(assets).toEqual([
            { from: path.join(fs.realpathSync(root), '.nera-cache', 'images', 'files'), to: 'media/img' },
        ])
        // getAssets consumes the build: a second call has nothing to hand over.
        expect(await getAssets()).toEqual([])
    })

    it('returns a new page object only for pages it changed', async () => {
        const untouched = pageWith('<p>no images</p>')
        const changed = pageWith('<img src="/images/alpha.png">', '/b.html')

        const result = await getMetaData({ app: app(), pagesData: [untouched, changed] })

        expect(result[0]).toBe(untouched)
        expect(result[1]).not.toBe(changed)
        expect(result[1].meta).toBe(changed.meta)
        await getAssets()
    })
})
