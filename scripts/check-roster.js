// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const { parseRoster } = require('../src/membership/roster')

const filename = process.argv[2]
if (!filename) {
    console.error('Usage: npm run roster:check -- /path/to/eligible-members.csv')
    process.exit(2)
}

try {
    const rows = parseRoster(fs.readFileSync(filename, 'utf8'))
    console.log(`${rows.length} roster records checked; 0 issue(s).`)
} catch (error) {
    console.error(`Roster check failed: ${error.message}`)
    process.exitCode = 1
}
