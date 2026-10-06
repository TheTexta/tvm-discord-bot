// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { uiText, createTextRenderer } = require('../src/tvm/uiText')

test('renders codes and account mentions while treating inserted text literally', () => {
    // Exercise the formatter with fixed templates, independent of admin-edited copy.
    const fixture = {
        email: { codeBody: 'Code: {code}. Repeat: {code}.' },
        admin: { transferred: 'Transferred to <@{userId}>.', operationFailed: 'Failed: {error}' }
    }
    const render = createTextRenderer(fixture)
    assert.equal(render('email.codeBody', { code: '123456' }), 'Code: 123456. Repeat: 123456.')
    assert.equal(render('admin.transferred', { userId: '123456789012345678' }), 'Transferred to <@123456789012345678>.')
    const error = 'Unexpected $& {code}'
    assert.equal(render('admin.operationFailed', { error }), `Failed: ${error}`)
    assert.throws(() => render('email.codeBody'), { message: 'Missing UI text value: email.codeBody.code' })
    assert.throws(() => render('missing.key'), { message: 'Missing UI text: missing.key' })
})

test('runtime text references exist in the config', () => {
    const directory = path.join(__dirname, '../src/tvm')
    for (const filename of fs.readdirSync(directory, { recursive: true }).filter((name) => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8')
        for (const [, key] of source.matchAll(/uiText\('([^']+)'/g)) {
            const template = key.split('.').reduce((value, part) => value?.[part], require('../ui-text.json'))
            assert.equal(typeof template, 'string', `${filename}: ${key}`)
            const values = Object.fromEntries(
                [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map(([, name]) => [name, 'example'])
            )
            assert.equal(typeof uiText(key, values), 'string')
        }
    }
})
