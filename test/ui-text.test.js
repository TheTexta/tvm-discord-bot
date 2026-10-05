// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { uiText } = require('../src/tvm/uiText')

test('renders codes and account mentions while treating inserted text literally', () => {
    assert.match(uiText('email.codeBody', { code: '123456' }), /code is 123456/)
    assert.equal(uiText('admin.transferred', { userId: '123456789012345678' }),
        'Account transfer complete for <@123456789012345678>.')
    const error = 'Unexpected $& {code}'
    assert.equal(uiText('admin.operationFailed', { error }), `Operation failed: ${error}`)
    assert.throws(() => uiText('email.codeBody'), /Missing UI text value: email.codeBody.code/)
    assert.throws(() => uiText('missing.key'), /Missing UI text: missing.key/)
})

test('runtime text references exist in the config', () => {
    const directory = path.join(__dirname, '../src/tvm')
    for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8')
        for (const [, key] of source.matchAll(/uiText\('([^']+)'/g)) {
            const template = key.split('.').reduce((value, part) => value?.[part], require('../ui-text.json'))
            assert.equal(typeof template, 'string', `${filename}: ${key}`)
            const values = Object.fromEntries([...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
                .map(([, name]) => [name, 'example']))
            assert.equal(typeof uiText(key, values), 'string')
        }
    }
})
