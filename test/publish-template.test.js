import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// `npm run publish-template` / the `nera-images` bin copy the mixin into the
// site's views/vendor/plugin-images/, via publishTemplates from plugin-utils.

const SCRIPT = path.resolve('bin/publish-template.js')
let root

const publish = (...args) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8' })

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nera-images-publish-'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'my-site' }))
    fs.mkdirSync(path.join(root, 'config'))
    fs.writeFileSync(path.join(root, 'config', 'app.yaml'), 'lang: en\n')
    fs.mkdirSync(path.join(root, 'pages'))
})

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
})

describe('publish-template', () => {
    it('copies picture.pug to views/vendor/plugin-images/', () => {
        const out = publish()
        const target = path.join(root, 'views', 'vendor', 'plugin-images', 'picture.pug')

        expect(out).toContain('views/vendor/plugin-images')
        expect(fs.readFileSync(target, 'utf-8')).toBe(fs.readFileSync(path.resolve('views/picture.pug'), 'utf-8'))
    })

    it('keeps an already published copy unless --force is given', () => {
        const target = path.join(root, 'views', 'vendor', 'plugin-images', 'picture.pug')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, '//- edited\n')

        expect(publish()).toContain('Skipping')
        expect(fs.readFileSync(target, 'utf-8')).toBe('//- edited\n')

        publish('--force')
        expect(fs.readFileSync(target, 'utf-8')).toContain('mixin picture(')
    })
})
