// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoster } = require('../src/tvm/roster')

test('parses member tiers while ignoring student numbers and other columns', () => {
    assert.deepEqual(parseRoster('Student ID,Email,Role,Note\n,"A@Example.org",Exec - Editor,"x,y"\n00123,b@example.org,Admin,member\n'), [
        { email: 'a@example.org', role: 'exec' }, { email: 'b@example.org', role: 'admin' }
    ])
    assert.deepEqual(parseRoster('Email,Role\nmember@example.org,GM\n'), [{ email: 'member@example.org', role: 'gm' }])
    assert.deepEqual(parseRoster('Email,Role\nmember@example.org,Exec: Producer\n'), [{ email: 'member@example.org', role: 'exec' }])
})

test('rejects missing, empty, duplicate, and malformed email rosters', () => {
    assert.throws(() => parseRoster('Student ID,Other\n1,x'), /Email and Role headers/)
    assert.throws(() => parseRoster('Email,Role\n'), /cannot be empty/)
    assert.throws(() => parseRoster('Email,Role\na@example.org,GM\nA@example.org,GM'), /Duplicate Email/)
    assert.throws(() => parseRoster('Email,Role\ninvalid,GM'), /Invalid Email/)
    assert.throws(() => parseRoster('Email,Role\na@example.org,unknown'), /Invalid Role/)
    assert.throws(() => parseRoster('Email,Role,Note\na@example.org,GM'), /Invalid roster CSV/)
})
