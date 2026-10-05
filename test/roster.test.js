// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoster } = require('../src/tvm/roster')
const { uiText } = require('../src/tvm/uiText')

test('parses member tiers while ignoring student numbers and other columns', () => {
    assert.deepEqual(parseRoster('Student ID,Email,Role,Note\n,"A@Example.org",Exec - Editor,"x,y"\n00123,b@example.org,Admin,member\n'), [
        { email: 'a@example.org', role: 'exec' }, { email: 'b@example.org', role: 'admin' }
    ])
    assert.deepEqual(parseRoster('Email,Role\nmember@example.org,GM\n'), [{ email: 'member@example.org', role: 'gm' }])
    assert.deepEqual(parseRoster('Email,Role\nmember@example.org,Exec: Producer\n'), [{ email: 'member@example.org', role: 'exec' }])
})

test('rejects missing, empty, duplicate, and malformed email rosters', () => {
    assert.throws(() => parseRoster('Student ID,Other\n1,x'), {
        message: uiText('errors.invalidCsv', { error: uiText('errors.missingHeaders') })
    })
    assert.throws(() => parseRoster('Email,Role\n'), { message: uiText('errors.emptyRoster') })
    assert.throws(() => parseRoster('Email,Role\na@example.org,GM\nA@example.org,GM'), {
        message: uiText('errors.duplicateEmailRow', { row: 3 })
    })
    assert.throws(() => parseRoster('Email,Role\ninvalid,GM'), {
        message: uiText('errors.invalidEmailRow', { row: 2 })
    })
    assert.throws(() => parseRoster('Email,Role\na@example.org,unknown'), {
        message: uiText('errors.invalidRoleRow', { row: 2 })
    })
    assert.throws(() => parseRoster('Email,Role,Note\na@example.org,GM'), Error)
})
