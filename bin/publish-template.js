#!/usr/bin/env node

import path from 'path'
import { fileURLToPath } from 'url'
import { publishTemplates } from '@nera-static/plugin-utils'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginName = 'plugin-images'
const sourceDir = path.resolve(__dirname, '../views/')
const force = process.argv.includes('--force')

const templateFiles = ['picture.pug']

const result = publishTemplates({
    pluginName,
    sourceDir,
    templateFiles,
    force,
})

process.exit(result ? 0 : 1)
