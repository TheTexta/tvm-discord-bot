// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoster } = require('../src/tvm/roster')

test('parses emails while ignoring student numbers and other columns', () => {
    assert.deepEqual(parseRoster('Student ID,Email,Note\n,"A@Example.org","x,y"\n00123,b@example.org,member\n'), [
        { email: 'a@example.org' }, { email: 'b@example.org' }
    ])
    assert.deepEqual(parseRoster('Email\nmember@example.org\n'), [{ email: 'member@example.org' }])
})

test('rejects missing, empty, duplicate, and malformed email rosters', () => {
    assert.throws(() => parseRoster('Student ID,Other\n1,x'), /Email header/)
    assert.throws(() => parseRoster('Email\n'), /cannot be empty/)
    assert.throws(() => parseRoster('Email\na@example.org\nA@example.org'), /Duplicate Email/)
    assert.throws(() => parseRoster('Email\ninvalid'), /Invalid Email/)
    assert.throws(() => parseRoster('Email,Note\na@example.org'), /Invalid roster CSV/)
})
