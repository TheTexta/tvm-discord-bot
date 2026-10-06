// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoster } = require('../src/tvm/roster')
const { uiText } = require('../src/tvm/uiText')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('parses member tiers while ignoring student numbers and other columns', () => {
    assert.deepEqual(
        parseRoster(
            'Student ID,Email,Role,Note\n,"A@Example.org",Exec - Editor,"x,y"\n00123,b@example.org,Admin,member\n'
        ),
        [
            { email: 'a@example.org', role: 'exec' },
            { email: 'b@example.org', role: 'admin' }
        ]
    )
    assert.deepEqual(parseRoster('Email,Role\nmember@example.org,GM\n'), [{ email: 'member@example.org', role: 'gm' }])
    assert.deepEqual(parseRoster('Email,Role\nmember@example.org,Exec: Producer\n'), [
        { email: 'member@example.org', role: 'exec' }
    ])
})

test('the roster CLI and upload parser reject missing and invalid roles consistently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-roster-cli-'))
    try {
        for (const csv of [
            'Email\nmember@example.org\n',
            'Email,Role\nmember@example.org,Unknown\n',
            'Email,Role\nmember@example.org,GM\n'
        ]) {
            const filename = path.join(dir, 'roster.csv')
            fs.writeFileSync(filename, csv)
            let accepted = true
            try {
                parseRoster(csv)
            } catch {
                accepted = false
            }
            const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/check-roster.js'), filename], {
                encoding: 'utf8',
                timeout: 5000
            })
            assert.equal(result.status, accepted ? 0 : 1, result.stderr)
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
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
