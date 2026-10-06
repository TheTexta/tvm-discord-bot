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

test('editable text validates missing keys, placeholders and component limits with named errors', () => {
    const { validateUiText } = require('../src/tvm/uiText')
    const text = require('../ui-text.json')
    assert.equal(validateUiText(text), text)
    for (const [key, value, pattern] of [
        ['commands.verify', undefined, /commands.verify/],
        ['email.codeBody', 'Your code is {wrong}', /email.codeBody/],
        ['email.codeBody', 'Your code is ready', /email.codeBody/],
        ['buttons.verify', 'x'.repeat(81), /buttons.verify/],
        ['shoot.nameLabel', 'x'.repeat(46), /shoot.nameLabel/],
        ['shoot.setup', 'x'.repeat(101), /shoot.setup/],
        ['shoot.joinDescription', 'x'.repeat(101), /shoot.joinDescription/]
    ]) {
        const candidate = structuredClone(text)
        const [section, name] = key.split('.')
        candidate[section][name] = value
        assert.throws(() => validateUiText(candidate), pattern)
    }
})

test('recovery identifiers retain the deployed format and do not depend on editable copy', () => {
    const { shootMarker, shootTopic } = require('../src/tvm/shoot/identifiers')
    const { renderShoot } = require('../src/tvm/shoot/render')
    assert.equal(shootTopic('abc'), 'TVM shoot abc')
    assert.equal(shootMarker('abc', 'brief'), 'TVM shoot abc · brief')
    const shoot = {
        id: 'abc',
        name: 'A shoot',
        location: 'Studio',
        organizer_id: '1',
        channel_id: '2',
        join_period: 'never'
    }
    assert.equal(renderShoot(shoot, 'brief', false).embeds[0].toJSON().footer.text, 'TVM shoot abc · brief')
    assert.equal(Object.hasOwn(require('../ui-text.json').shoot, 'marker'), false)
})
