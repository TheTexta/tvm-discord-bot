// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoster } = require('../src/tvm/roster')

test('parses headers, quoted fields, and leading zeroes', () => {
    assert.deepEqual(parseRoster('Student ID,Email,Note\n"00123","A@Example.org","x,y"\n'), [
        { studentId: '00123', email: 'a@example.org' }
    ])
})

test('rejects missing, empty, duplicate, and malformed roster data', () => {
    assert.throws(() => parseRoster('Student ID,Other\n1,x'), /Email headers/)
    assert.throws(() => parseRoster('Student ID,Email\n'), /cannot be empty/)
    assert.throws(() => parseRoster('Student ID,Email\n1,a@example.org\n1,b@example.org'), /Duplicate Student ID/)
    assert.throws(() => parseRoster('Student ID,Email\n1,a@example.org\n2,A@example.org'), /Duplicate Email/)
    assert.throws(() => parseRoster('Student ID,Email\n1,invalid'), /Invalid Email/)
    assert.throws(() => parseRoster('Student ID,Email\n1,a@example.org\n2'), /Invalid roster CSV/)
})
